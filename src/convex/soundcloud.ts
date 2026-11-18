import { ConvexError, v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { TTL, cacheKey, dedupeRequest, takeRateSlot } from "./providerCache";

/**
 * SoundCloud as a FIRST-CLASS PLAYABLE SOURCE.
 *
 * Ported from the melo desktop player (`src/server/server.js`:
 * `refreshServerScClientId`, `searchSoundcloud`, `fetchDirectSoundCloudStreamServer`
 * — and the on-device port `SoundCloud.kt`), adapted to SYNQ's architecture:
 * the API is called from a Convex action (no CORS problem, no key in the
 * client). Progressive URLs use `/audio-proxy`; SoundCloud's signed HLS
 * manifests go straight to HLS.js on the existing audio deck, since proxying
 * the manifest would break its relative segment URLs.
 *
 * HOW AUTH WORKS (and why it is safe)
 * -----------------------------------
 * SoundCloud's public web client authenticates with a `client_id` embedded in
 * its own JavaScript bundles. The bootstrap fetches soundcloud.com's HTML,
 * takes the LAST asset bundles it references, and scrapes the 32-char id out
 * of each — then refreshes it when an API call comes back unauthenticated,
 * exactly as melo does. This is the same public id every browser running
 * soundcloud.com holds; no user credentials and no registered-app secret are
 * involved.
 *
 * HONESTY RULES
 * -------------
 * - A track with `policy: "SNIP"` is a 30-second preview. It is FILTERED OUT
 *   of search and REFUSED at resolve time — playing a preview as if it were
 *   the song is the exact fabrication this codebase refuses.
 * - Progressive MP3 is preferred when offered. Current uploads usually expose
 *   only HLS, which is returned with `isHls: true` and attached to the same
 *   audio deck through HLS.js — refusing it left valid tracks unplayable.
 */

/** A SoundCloud track, as the client sees it. */
export interface ScTrack {
  /** Numeric SoundCloud track id, carried on the wire as a string. */
  id: string;
  title: string;
  artist: string;
  /** Full-length milliseconds, as the API reports. */
  durationMs: number;
  artwork: string;
  permalinkUrl: string;
  /** True when the artist flagged it explicit. */
  explicit: boolean;
}

/** The client_id shipped with melo — refreshed from the site whenever it 401s. */
const DEFAULT_CLIENT_ID = "tHVbSbDP4TaoMbPppngv6Tdry83vNbMQ";

/** Module-level bootstrap state. Actions run in one isolate long enough that
 * a 30-minute in-memory cache saves the scrape on nearly every call, exactly
 * like melo's 30-minute freshness window. */
let clientId = DEFAULT_CLIENT_ID;
let clientIdRefreshedAt = 0;

const CLIENT_ID_TTL_MS = 30 * 60 * 1000;
const WEB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const API = "https://api-v2.soundcloud.com";

async function fetchText(url: string, timeoutMs = 10_000): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": WEB_UA, Accept: "text/html,*/*" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

interface JsonResponse {
  status: number;
  body: unknown;
}

async function fetchJsonResponse(
  url: string,
  timeoutMs = 10_000,
): Promise<JsonResponse | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": WEB_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* an error body may be empty or HTML */
    }
    return { status: res.status, body };
  } catch {
    return null;
  }
}

/**
 * Read the current public client_id out of the site's own bundles.
 *
 * Takes the LAST asset URLs the page references — melo measured that the id
 * lives in one of the final four bundles — and stops at the first hit.
 */
async function refreshClientId(): Promise<string> {
  const page = await fetchText("https://soundcloud.com/");
  if (!page) return clientId;
  const assetMatches = [
    ...page.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g),
  ].map((m) => m[1]);
  for (const asset of assetMatches.slice(-4)) {
    const code = await fetchText(asset, 15_000);
    if (!code) continue;
    const hit = code.match(/client_id[:=]\s*["']([a-zA-Z0-9]{32})["']/);
    if (hit?.[1]) {
      clientId = hit[1];
      clientIdRefreshedAt = Date.now();
      return clientId;
    }
  }
  return clientId;
}

async function ensureClientId(force = false): Promise<string> {
  if (!force && Date.now() - clientIdRefreshedAt < CLIENT_ID_TTL_MS) {
    return clientId;
  }
  return refreshClientId();
}

/** What the download pipeline needs to know about one track's grant. */
export interface ScTrackRecord {
  id: string;
  title: string;
  artist: string;
  durationMs: number;
  artwork: string;
  permalinkUrl: string;
  /** The artist's explicit download grant — the authority for a saved copy. */
  downloadable: boolean;
  /** The official API's own download resource; null unless granted. */
  downloadUrl: string | null;
  policy: string | null;
}

/**
 * OFFICIAL SoundCloud download API.
 *
 * Downloads do not use the public web client id above. That id identifies the
 * SoundCloud website, not a registered SYNQ application, and is therefore not
 * an acceptable credential for handing out files. The functions below use
 * OAuth 2.1 client credentials issued to a registered app whose Client ID and
 * Client Secret live only in the Convex server environment.
 *
 * If the credentials are absent, downloads are reported as not configured. No
 * attempt is made to substitute the playback scraper.
 */
const OFFICIAL_API = "https://api.soundcloud.com";
const OFFICIAL_TOKEN_URL = "https://secure.soundcloud.com/oauth/token";
let officialToken: string | null = null;
let officialTokenExpiresAt = 0;

function officialCredentials(): { id: string; secret: string } | null {
  const id = process.env.SOUNDCLOUD_CLIENT_ID?.trim();
  const secret = process.env.SOUNDCLOUD_CLIENT_SECRET?.trim();
  return id && secret ? { id, secret } : null;
}

/** SoundCloud deprecated numeric-only resource paths; the URN form is the
 * documented identifier. Colons are percent-encoded as normal path data. */
function officialTrackPath(numericId: string): string {
  return `/tracks/${encodeURIComponent(`soundcloud:tracks:${numericId}`)}`;
}

/**
 * Accept only the download resource the official API itself returned. The
 * track object's `download_url` is the authoritative endpoint for the artist's
 * granted original file; it is not a stream URL and it must not point at an
 * arbitrary host. Query strings are dropped so a legacy public `client_id` can
 * never ride along with the request.
 */
export function officialDownloadEndpoint(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  try {
    const url = new URL(/^https:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    if (url.protocol !== "https:" || url.hostname !== "api.soundcloud.com") {
      return null;
    }
    if (!/^\/tracks\/[^/]+\/download\/?$/.test(url.pathname)) return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function basicAuth(id: string, secret: string): string {
  const bytes = new TextEncoder().encode(`${id}:${secret}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  // btoa is available in the Convex V8 runtime.
  return btoa(binary);
}

async function officialAccessToken(force = false): Promise<string | null> {
  const credentials = officialCredentials();
  if (!credentials) return null;
  if (!force && officialToken && Date.now() < officialTokenExpiresAt) {
    return officialToken;
  }
  try {
    const response = await fetch(OFFICIAL_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json; charset=utf-8",
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basicAuth(credentials.id, credentials.secret)}`,
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    const token = str(body.access_token);
    if (!token) return null;
    const expires = num(body.expires_in) ?? 3600;
    officialToken = token;
    // Renew a minute early rather than racing the exact expiry boundary.
    officialTokenExpiresAt = Date.now() + Math.max(60, expires - 60) * 1000;
    return token;
  } catch {
    return null;
  }
}

async function officialFetch(
  url: string,
  token: string,
  redirect: RequestRedirect = "follow",
): Promise<{ status: number; response: Response } | null> {
  try {
    const response = await fetch(url, {
      headers: { Authorization: `OAuth ${token}`, Accept: "application/json" },
      redirect,
      signal: AbortSignal.timeout(15_000),
    });
    return { status: response.status, response };
  } catch {
    return null;
  }
}

function officialGet(
  path: string,
  token: string,
  redirect: RequestRedirect = "follow",
) {
  return officialFetch(`${OFFICIAL_API}${path}`, token, redirect);
}

/** True when the deployment has a registered SoundCloud application. */
export function soundcloudDownloadsConfigured(): boolean {
  return officialCredentials() !== null;
}

/**
 * Read the artist's grant through the official API. Returns null when the
 * credentials are missing or the API cannot answer; callers must distinguish
 * not-configured from unauthorized before showing a refusal.
 */
export async function fetchOfficialSoundcloudTrackRecord(
  numericId: string,
): Promise<ScTrackRecord | null> {
  if (!/^\d{6,}$/.test(numericId)) return null;
  let token = await officialAccessToken();
  if (!token) return null;
  let result = await officialGet(officialTrackPath(numericId), token);
  if (result?.status === 401) {
    token = await officialAccessToken(true);
    if (!token) return null;
    result = await officialGet(officialTrackPath(numericId), token);
  }
  if (!result || !result.response.ok) return null;
  const raw = (await result.response.json()) as Record<string, unknown>;
  const mapped = mapTrack(raw);
  if (!mapped) return null;
  return {
    id: mapped.id,
    title: mapped.title,
    artist: mapped.artist,
    durationMs: mapped.durationMs,
    artwork: mapped.artwork,
    permalinkUrl: mapped.permalinkUrl,
    downloadable: raw.downloadable === true,
    downloadUrl: str(raw.download_url) ?? null,
    policy: str(raw.policy) ?? null,
  };
}

/**
 * Resolve the artist-uploaded file through the official download endpoint.
 * Handles both documented shapes: a redirect to the granted file and a JSON
 * `{ redirectUrl }` response.
 */
export async function fetchOfficialSoundcloudDownloadUrl(
  downloadUrl: string | null,
): Promise<string | null> {
  const endpoint = officialDownloadEndpoint(downloadUrl);
  if (!endpoint) return null;
  let token = await officialAccessToken();
  if (!token) return null;
  let result = await officialFetch(endpoint, token, "manual");
  if (result?.status === 401) {
    token = await officialAccessToken(true);
    if (!token) return null;
    result = await officialFetch(endpoint, token, "manual");
  }
  if (!result) return null;
  if (result.status >= 300 && result.status < 400) {
    const location = result.response.headers.get("location");
    return location && /^https:\/\//i.test(location) ? location : null;
  }
  if (!result.response.ok) return null;
  try {
    const body = (await result.response.json()) as Record<string, unknown>;
    const url = str(body.redirectUrl) ?? str(body.location);
    return url && /^https:\/\//i.test(url) ? url : null;
  } catch {
    return null;
  }
}

/** One authenticated API GET, keeping the status so failures stay specific. */
async function apiGetResponse(path: string): Promise<JsonResponse | null> {
  const request = async (): Promise<JsonResponse | null> => {
    const cid = await ensureClientId();
    return fetchJsonResponse(
      `${API}${path}${path.includes("?") ? "&" : "?"}client_id=${cid}`,
    );
  };
  let response = await request();
  // A stale public web client id is the one failure worth one retry.
  if (response && (response.status === 401 || response.status === 403)) {
    await ensureClientId(true);
    response = await request();
  }
  return response;
}

async function apiGet(path: string): Promise<unknown | null> {
  const response = await apiGetResponse(path);
  return response && response.status >= 200 && response.status < 300
    ? response.body
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function mapTrack(raw: unknown): ScTrack | null {
  if (!isRecord(raw)) return null;
  const id = num(raw.id);
  const title = str(raw.title);
  if (id === undefined || !title) return null;
  // A SNIP policy means "this entry is a 30-second preview". Hiding it beats
  // pretending the preview is the song.
  if (str(raw.policy) === "SNIP") return null;
  const user = isRecord(raw.user) ? raw.user : undefined;
  const artworkRaw = str(raw.artwork_url) ?? str(user?.avatar_url) ?? "";
  const artwork = artworkRaw.replace("/large", "/t500x500");
  const explicit =
    raw.explicit === true ||
    /\b(explicit)\b/i.test(title) ||
    /\b(explicit)\b/i.test(str(user?.username) ?? "");
  return {
    id: String(id),
    title,
    artist: str(user?.username) || "SoundCloud",
    durationMs: num(raw.duration) ?? 0,
    artwork,
    permalinkUrl: str(raw.permalink_url) ?? "",
    explicit,
  };
}

/**
 * Search SoundCloud for tracks. Cached through providerCache like every other
 * provider, rate-limited so a stuck loop cannot burn the public API.
 */
export const searchSoundcloud = action({
  args: { query: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { query, limit }): Promise<ScTrack[]> => {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const take = Math.min(50, Math.max(1, limit ?? 20));

    const key = cacheKey("soundcloud", "search", { q: trimmed, limit: take });
    const cached = (await ctx.runQuery(api.providerCache.cacheGet, { key })) as {
      value: ScTrack[];
    } | null;
    if (cached) return cached.value;

    const result = await dedupeRequest(key, async (): Promise<ScTrack[]> => {
      const slot = takeRateSlot("soundcloud:search");
      if (!slot.allowed) {
        throw new ConvexError(
          "SoundCloud search is rate-limited right now — try again in a moment.",
        );
      }
      const json = await apiGet(
        `/search/tracks?q=${encodeURIComponent(trimmed)}&limit=${take}&linked_partitioning=0`,
      );
      const collection = isRecord(json) ? json.collection : json;
      if (!Array.isArray(collection)) return [];
      const seen = new Set<string>();
      const tracks: ScTrack[] = [];
      for (const raw of collection) {
        const track = mapTrack(raw);
        if (!track || seen.has(track.id)) continue;
        seen.add(track.id);
        tracks.push(track);
      }
      return tracks;
    });

    await ctx.runMutation(internal.providerCache.cachePut, {
      key,
      value: result,
      provider: "soundcloud",
      ttlSeconds: TTL.search,
    });
    return result;
  },
});

/** Result of resolving one track's stream. */
export interface ScStreamResult {
  /** SoundCloud's public signed URL, ready for the player's audio deck. */
  url: string;
  /** True for an HLS manifest; the deck attaches it through HLS.js. */
  isHls: boolean;
}

/** Hosts SoundCloud itself uses to serve public media. */
export function soundcloudStreamUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    const allowed =
      host === "sndcdn.com" ||
      host.endsWith(".sndcdn.com") ||
      host === "soundcloud.cloud" ||
      host.endsWith(".soundcloud.cloud") ||
      host === "soundcloud.com" ||
      host.endsWith(".soundcloud.com");
    return allowed ? url.toString() : null;
  } catch {
    return null;
  }
}

export interface SoundcloudTranscoding {
  protocol: "progressive" | "hls";
  url: string;
}

/**
 * Pick the stream format to resolve, without fetching it.
 *
 * Progressive MP3 remains first choice because it is byte-range-able and
 * needs no extra player machinery. Most current uploads only expose `hls`, so
 * that is the valid second choice rather than a refusal. SoundCloud's highest
 * quality HLS rendition is listed first. SNIP previews are not streams of the
 * song and are excluded by the caller.
 */
export function pickSoundcloudTranscoding(
  raw: unknown,
): SoundcloudTranscoding | null {
  if (!isRecord(raw) || !isRecord(raw.media)) return null;
  // The live v2 track resource nests these under `media`.
  const transcodings = Array.isArray(raw.media.transcodings)
    ? raw.media.transcodings
    : null;
  if (!transcodings) return null;
  const candidates: SoundcloudTranscoding[] = [];
  for (const value of transcodings) {
    if (!isRecord(value) || !isRecord(value.format)) continue;
    const protocol = str(value.format.protocol);
    const url = str(value.url);
    if (!url || (protocol !== "progressive" && protocol !== "hls")) continue;
    candidates.push({ protocol, url });
  }
  return (
    candidates.find((candidate) => candidate.protocol === "progressive") ??
    candidates.find((candidate) => candidate.protocol === "hls") ??
    null
  );
}

/**
 * Resolve one SoundCloud track to a public progressive MP3 or HLS manifest.
 *
 * `trackId` must be the numeric SoundCloud id carried on the wire as a string.
 * There is deliberately no search fallback: a "closest" result is a different
 * recording, and silently replacing the track the listener chose is worse than
 * a clear resolution failure.
 */
export const resolveSoundcloudStream = action({
  args: {
    trackId: v.string(),
  },
  handler: async (ctx, { trackId }): Promise<ScStreamResult> => {
    const id = trackId.trim().replace(/^sc:/, "");
    if (!/^\d{6,}$/.test(id)) {
      throw new ConvexError("That is not a SoundCloud track id");
    }

    const key = cacheKey("soundcloud", "streamUrl", { id });
    const cached = (await ctx.runQuery(api.providerCache.cacheGet, { key })) as {
      value: ScStreamResult;
    } | null;
    if (cached) return cached.value;

    const result = await dedupeRequest(key, async (): Promise<ScStreamResult> => {
      const slot = takeRateSlot("soundcloud:resolve");
      if (!slot.allowed) {
        throw new ConvexError(
          "SoundCloud is rate-limiting this app right now — try again in a moment.",
        );
      }

      const trackResponse = await apiGetResponse(`/tracks/${id}`);
      if (!trackResponse || trackResponse.status < 200 || trackResponse.status >= 300) {
        const status = trackResponse?.status;
        if (status === 404) {
          throw new ConvexError(
            "This track is no longer available on SoundCloud.",
          );
        }
        if (status === 401 || status === 403) {
          throw new ConvexError(
            "SoundCloud requires authentication for this track, or it is restricted.",
          );
        }
        if (status !== undefined) {
          throw new ConvexError(
            "SoundCloud's stream is temporarily unavailable. Please try again.",
          );
        }
        throw new ConvexError(
          "Couldn't reach SoundCloud. Check your connection and try again.",
        );
      }
      const raw = trackResponse.body;
      if (!isRecord(raw)) {
        throw new ConvexError(
          "SoundCloud returned an unreadable response for this track.",
        );
      }
      if (str(raw.policy) === "SNIP") {
        throw new ConvexError(
          "That SoundCloud upload is a 30-second preview, not the full track.",
        );
      }
      const transcoding = pickSoundcloudTranscoding(raw);
      if (!transcoding) {
        throw new ConvexError(
          "This SoundCloud track uses an audio format SYNQ cannot play.",
        );
      }

      const pollUrl = soundcloudStreamUrl(transcoding.url);
      if (!pollUrl) {
        throw new ConvexError(
          "SoundCloud returned an invalid stream address.",
        );
      }
      const auth = str(raw.track_authorization);
      const requestStream = async (): Promise<JsonResponse | null> => {
        const cid = await ensureClientId();
        const sep = pollUrl.includes("?") ? "&" : "?";
        return fetchJsonResponse(
          `${pollUrl}${sep}client_id=${cid}${auth ? `&track_authorization=${encodeURIComponent(auth)}` : ""}`,
        );
      };
      let poll = await requestStream();
      if (poll && (poll.status === 401 || poll.status === 403)) {
        await ensureClientId(true);
        poll = await requestStream();
      }
      if (poll && (poll.status === 401 || poll.status === 403)) {
        throw new ConvexError(
          "SoundCloud requires authentication to stream this track.",
        );
      }
      if (!poll || poll.status < 200 || poll.status >= 300) {
        throw new ConvexError(
          "SoundCloud's stream is temporarily unavailable. Please try again.",
        );
      }
      const url = soundcloudStreamUrl(
        isRecord(poll.body) && typeof poll.body.url === "string"
          ? poll.body.url
          : null,
      );
      if (!url) {
        throw new ConvexError(
          "SoundCloud couldn't provide a playable stream for this track right now.",
        );
      }
      return { url, isHls: transcoding.protocol === "hls" };
    });

    await ctx.runMutation(internal.providerCache.cachePut, {
      key,
      value: result,
      provider: "soundcloud",
      // A resolved CDN URL is a bearer credential for the media itself — the
      // same short TTL the YouTube resolver uses. A lapsed signature costs
      // one re-resolve, never a broken session.
      ttlSeconds: TTL.streamUrl,
    });
    return result;
  },
});
