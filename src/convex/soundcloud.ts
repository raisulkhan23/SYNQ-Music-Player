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
 * client) and the resolved CDN URL is streamed to the browser through the
 * same `/audio-proxy` route the Piped streams use.
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
 * - HLS-only tracks are refused rather than returned as something the player
 *   will choke on. A progressive MP3 exists for the vast majority of the
 *   catalogue; for the rest, silence with an explanation beats a broken
 *   element.
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

async function fetchJson(
  url: string,
  timeoutMs = 10_000,
): Promise<Record<string, unknown> | Array<unknown> | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": WEB_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown> | Array<unknown>;
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
  /** SoundCloud caps how many downloads an artist may give away. */
  hasDownloadsLeft: boolean;
  policy: string | null;
}

/**
 * One track's record, for the download pipeline's server-side grant check.
 *
 * Exposed (not private like the search internals) because
 * `convex/downloads.ts` must re-verify `downloadable` itself before handing
 * out any file — the same re-verification rule Jamendo's
 * `audiodownload_allowed` follows.
 */
export async function fetchSoundcloudTrackRecord(
  numericId: string,
): Promise<ScTrackRecord | null> {
  if (!/^\d{6,}$/.test(numericId)) return null;
  const raw = await apiGet(`/tracks/${numericId}`);
  if (!isRecord(raw)) return null;
  const mapped = mapTrack(raw);
  const downloadsRaw = isRecord(raw.downloads) ? raw.downloads : undefined;
  return {
    id: String(num(raw.id) ?? numericId),
    title: mapped?.title ?? str(raw.title) ?? "",
    artist: mapped?.artist ?? "",
    durationMs: mapped?.durationMs ?? 0,
    artwork: mapped?.artwork ?? "",
    permalinkUrl: mapped?.permalinkUrl ?? "",
    downloadable: raw.downloadable === true,
    hasDownloadsLeft: downloadsRaw
      ? downloadsRaw.current !== undefined
        ? Number(downloadsRaw.current) > 0
        : true
      : false,
    policy: str(raw.policy) ?? null,
  };
}

/**
 * The signed URL of one track's ORIGINAL uploaded file.
 *
 * `/tracks/{id}/download` is SoundCloud's own grant fulfilment endpoint: it
 * responds with `{ redirectUrl }` pointing at the artist-uploaded file, for
 * tracks whose `downloadable` flag is set. This is the authorized source the
 * download pipeline pulls from — never the stream transcode, which SYNQ only
 * has permission to stream.
 */
export async function fetchSoundcloudDownloadUrl(
  numericId: string,
): Promise<string | null> {
  if (!/^\d{6,}$/.test(numericId)) return null;
  const cid = await ensureClientId();
  const json = await fetchJson(
    `${API}/tracks/${numericId}/download?client_id=${cid}`,
  );
  const url = isRecord(json) ? str(json.redirectUrl) : undefined;
  return url && url.startsWith("https://") ? url : null;
}

/** One authenticated API GET, refreshing the client_id once on failure. */
async function apiGet(path: string): Promise<unknown | null> {
  let cid = await ensureClientId();
  let json = await fetchJson(`${API}${path}${path.includes("?") ? "&" : "?"}client_id=${cid}`);
  if (json === null) {
    cid = await ensureClientId(true);
    json = await fetchJson(`${API}${path}${path.includes("?") ? "&" : "?"}client_id=${cid}`);
  }
  return json;
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
  /** The CDN MP3 URL, ready to be proxied to the browser. */
  url: string;
  /** Always false: HLS-only tracks are refused, not returned. */
  isHls: boolean;
  /** How the stream was found (for diagnostics). */
  via: "transcoding" | "search-fallback";
}

/**
 * Resolve one track to a progressive (byte-range-able) MP3 URL.
 *
 * `trackId` must be the numeric SoundCloud id carried on the wire as a
 * string. When a queue entry lost its id (a stale cache row), pass
 * `fallbackQuery` and the resolver finds a full-length match by search — the
 * same repair path melo's `resolveByQuery` provides.
 */
export const resolveSoundcloudStream = action({
  args: {
    trackId: v.string(),
    fallbackQuery: v.optional(v.string()),
  },
  handler: async (ctx, { trackId, fallbackQuery }): Promise<ScStreamResult> => {
    const id = trackId.trim().replace(/^sc:/, "");
    if (!/^\d{6,}$/.test(id) && !fallbackQuery) {
      throw new ConvexError("That is not a SoundCloud track id");
    }

    const key = cacheKey("soundcloud", "streamUrl", {
      id: id || (fallbackQuery ?? ""),
    });
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

      const resolveFromTrack = async (
        trackIdNumeric: string,
      ): Promise<string | null> => {
        const raw = await apiGet(`/tracks/${trackIdNumeric}`);
        if (!isRecord(raw)) return null;
        // A SNIP track resolved directly must not come back as the song.
        if (str(raw.policy) === "SNIP") return null;
        const transcodings = Array.isArray(raw.transcodings)
          ? raw.transcodings
          : [];
        // Progressive first: a plain MP3 the <audio> element and the download
        // pipeline can both consume. HLS is refused, not converted.
        for (const t of transcodings) {
          if (!isRecord(t) || !isRecord(t.format)) continue;
          if (str(t.format.protocol) !== "progressive") continue;
          const pollUrl = str(t.url);
          if (!pollUrl) continue;
          const cid = await ensureClientId();
          const auth = str(raw.track_authorization);
          const sep = pollUrl.includes("?") ? "&" : "?";
          const poll = await fetchJson(
            `${pollUrl}${sep}client_id=${cid}${auth ? `&track_authorization=${auth}` : ""}`,
          );
          const url = isRecord(poll) ? str(poll.url) : undefined;
          if (url) return url;
        }
        return null;
      };

      if (/^\d{6,}$/.test(id)) {
        const url = await resolveFromTrack(id);
        if (url) return { url, isHls: false, via: "transcoding" as const };
      }

      // Repair path: match by query, refusing previews and sub-30s uploads —
      // the same duration rule melo applies so a jingle cannot stand in for
      // the song.
      const query = fallbackQuery?.trim();
      if (!query) {
        throw new ConvexError(
          "SoundCloud couldn't provide this track (no progressive stream).",
        );
      }
      const searchJson = await apiGet(
        `/search/tracks?q=${encodeURIComponent(query)}&limit=6&linked_partitioning=0`,
      );
      const collection = isRecord(searchJson) ? searchJson.collection : searchJson;
      const candidates = Array.isArray(collection) ? collection : [];
      for (const raw of candidates) {
        const track = mapTrack(raw);
        if (!track || track.durationMs <= 30_000) continue;
        const url = await resolveFromTrack(track.id);
        if (url) return { url, isHls: false, via: "search-fallback" as const };
      }
      throw new ConvexError(
        "SoundCloud couldn't provide a playable stream for this track.",
      );
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
