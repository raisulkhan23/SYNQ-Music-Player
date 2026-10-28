import { ConvexError, v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import {
  TTL,
  cacheKey,
  dedupeRequest,
  takeRateSlot,
} from "./providerCache";
import {
  MIN_POOL_COVERAGE,
  bestPoolCoverage,
  broadFallbackOrder,
  rankSearchResults,
} from "../lib/searchRelevance";

// ---------------------------------------------------------------------------
// SYNQ audio source resolver.
// Talks to YouTube InnerTube / YouTube Music to search for music and to
// resolve a direct, playable audio stream for a video. No external keys
// required — the public INNERTUBE key below is embedded in every YouTube
// client.
// ---------------------------------------------------------------------------

export interface YtItem {
  id: string;
  title: string;
  artist: string;
  duration: number;
  thumbnail: string;
  /** Album when the source reports one; absent means unknown, never guessed. */
  album?: string;
  /** Jamendo release provenance for discovery-resolved rows (download only). */
  jamendoId?: string;
}

const API = "https://www.youtube.com/youtubei/v1/";
const REQUEST_TIMEOUT_MS = 10_000;
const INNERTUBE_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

// ---------------------------------------------------------------------------
// Authorized session support.
//
// YouTube answers `player` requests from a cloud IP with
// `LOGIN_REQUIRED — Sign in to confirm you're not a bot`, and it does that for
// the large majority of real tracks: measured 0/6 resolutions on 3 of 4
// popular videos, against 6/6 on the fourth. It is a demand for
// authentication, not a verdict on the content, so the fix is to authenticate.
//
// Two headers are needed together, which is what every working YouTube client
// sends and what a bare request is missing:
//
//   Cookie        the account's session cookies
//   Authorization SAPISIDHASH <unix_ts>_<sha1(ts + " " + SAPISID + " " + origin)>
//
// Sending only the cookie is not enough: InnerTube treats the pair as proof
// the request really came from that signed-in browser, and without the hash a
// cookie alone is treated as anonymous.
//
// WHERE THE SECRET LIVES. `YOUTUBE_COOKIE` is read from the server environment
// and never leaves the backend — no action returns it, and it is deliberately
// not echoed into any error or failure message. Paste it through the API Keys
// UI; it must not be committed.
//
// WHEN IT IS ABSENT this is all inert: the header is simply omitted and
// behaviour is exactly as before, so an unconfigured deployment degrades to the
// anonymous path instead of breaking.
// ---------------------------------------------------------------------------

/** The account's `Cookie` header value, or "" when not configured. */
function youtubeCookieHeader(): string {
  const raw = process.env.YOUTUBE_COOKIE;
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * The SID to build the hash from, preferring the classic name.
 *
 * `SAPISID` is what the hash is defined over, but a session exported from a
 * modern browser is not guaranteed to include it, and the `__Secure-3PSID` /
 * `__Secure-1PSID` pair is the same credential under its newer names. Falling
 * back to those means a correctly-pasted session is not silently reduced to
 * "cookies but no proof" — the failure mode that looks like a working setup
 * and is not.
 *
 * Returns the cookie's NAME only; the value never leaves this module.
 */
function hashKeyName(cookie: string): string | null {
  for (const name of ["SAPISID", "__Secure-3PSID", "__Secure-1PSID"]) {
    if (new RegExp(`(?:^|;\\s*)${name}=`).test(cookie)) return name;
  }
  return null;
}

/**
 * `SAPISIDHASH` proof for the configured session, or "" when there is no SID
 * to prove. SHA-1 via Web Crypto, which the Convex runtime provides.
 */
async function sapisidAuthHeader(
  cookie: string,
  origin: string,
): Promise<string> {
  const name = hashKeyName(cookie);
  if (!name) return "";
  const sid = cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1];
  if (!sid) return "";
  const ts = Math.floor(Date.now() / 1000);
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(`${ts} ${sid} ${origin}`),
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `SAPISIDHASH ${ts}_${hex}`;
}

/** The auth headers for a request, or `{}` when no session is configured. */
async function authHeaders(origin: string): Promise<Record<string, string>> {
  const cookie = youtubeCookieHeader();
  if (!cookie) return {};
  const authorization = await sapisidAuthHeader(cookie, origin);
  return {
    Cookie: cookie,
    ...(authorization ? { Authorization: authorization } : {}),
  };
}

interface InnerTubeClient {
  /** X-Youtube-Client-Name header value */
  id: string;
  clientName: string;
  clientVersion: string;
  userAgent: string;
  extra?: Record<string, unknown>;
}

// WEB — reliable for `search`, returns the twoColumnSearchResultsRenderer
// shape the parser below expects.
const WEB: InnerTubeClient = {
  id: "1",
  clientName: "WEB",
  clientVersion: "2.20240801.01.00",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
};

// ---------------------------------------------------------------------------
// Clients that are GONE, and why they are not coming back.
//
// ANDROID (id 3), IOS (id 5) and WEB_EMBEDDED (id 56) used to be the workhorses
// here — they returned unencrypted stream URLs from `player` with no session.
// YouTube has since closed them off. Probed live against the `player`
// endpoint, all three now answer `HTTP 400` — the request itself is rejected,
// before any playability question is even asked:
//
//     ANDROID        HTTP 400
//     IOS            HTTP 400
//     WEB_EMBEDDED   HTTP 400
//
// TVHTML5_SIMPLY_EMBEDDED_PLAYER (id 85) is refused in its own words:
//
//     ERROR — YouTube is no longer supported in this application or device
//
// These are STRUCTURAL rejections, not the IP-reputation bot-check. They
// return the same result from a residential connection, a different cloud
// region, and a different moment, so no amount of rotating IPs or retrying
// revives them. Keeping them in the client list was pure cost: each one is a
// full HTTPS round trip to youtube.com that is guaranteed to fail before the
// next client is even tried, so every dead client added latency to every
// unresolvable track and delayed the browser-side fallback that does work.
//
// Their definitions are deleted rather than merely unreferenced, so the next
// person does not "restore" a rotation that cannot resolve anything.
// ---------------------------------------------------------------------------

const MWEB: InnerTubeClient = {
  id: "2",
  clientName: "MWEB",
  clientVersion: "2.20240801.01.00",
  userAgent:
    "Mozilla/5.0 (iPad; CPU OS 16_7_10 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
};

// Android VR (Daydream) client — currently the ONLY client that still answers
// `player` with real audio formats. It survives where ANDROID/IOS no longer do,
// which is why the stream rotation below is built around it.
const ANDROID_VR: InnerTubeClient = {
  id: "28",
  clientName: "ANDROID_VR",
  clientVersion: "1.60.19",
  userAgent:
    "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12; eureka-user Build/SQ3A.220605.009.A1) gzip",
  extra: { androidSdkVersion: 31, osName: "Android", osVersion: "12" },
};

/**
 * Raw `browse` request against YouTube Music.
 *
 * Exported for `artistCatalog.ts`, which needs the artist → releases →
 * tracklist endpoints. Those are only served by the WEB_REMIX client, and they
 * use the same authorized session as search, so the transport lives here rather
 * than being duplicated (a second copy would drift on headers, timeout or auth
 * and silently start returning empty pages).
 */
export async function browseMusic(
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${MUSIC_API}browse?prettyPrint=false`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": MUSIC_CLIENT.userAgent,
      "X-Goog-Api-Key": INNERTUBE_KEY,
      "X-Youtube-Client-Name": MUSIC_CLIENT.id,
      "X-Youtube-Client-Version": MUSIC_CLIENT.clientVersion,
      Origin: "https://music.youtube.com",
      "X-Origin": "https://music.youtube.com",
      Referer: "https://music.youtube.com/",
      ...(await authHeaders("https://music.youtube.com")),
    },
    body: JSON.stringify({
      context: {
        client: {
          hl: "en",
          gl: "US",
          clientName: MUSIC_CLIENT.clientName,
          clientVersion: MUSIC_CLIENT.clientVersion,
        },
      },
      ...body,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new ConvexError(`YouTube Music browse returned ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Artist-filtered search. `params` is the documented "Artists" filter, which
 * keeps podcasts, covers and unrelated videos out of the identity lookup.
 */
export async function searchMusicArtists(
  query: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${MUSIC_API}search?prettyPrint=false`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": MUSIC_CLIENT.userAgent,
      "X-Goog-Api-Key": INNERTUBE_KEY,
      "X-Youtube-Client-Name": MUSIC_CLIENT.id,
      "X-Youtube-Client-Version": MUSIC_CLIENT.clientVersion,
      Origin: "https://music.youtube.com",
      "X-Origin": "https://music.youtube.com",
      Referer: "https://music.youtube.com/",
      ...(await authHeaders("https://music.youtube.com")),
    },
    body: JSON.stringify({
      context: {
        client: {
          hl: "en",
          gl: "US",
          clientName: MUSIC_CLIENT.clientName,
          clientVersion: MUSIC_CLIENT.clientVersion,
        },
      },
      query,
      params: ARTIST_SEARCH_PARAMS,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new ConvexError(`YouTube Music API returned ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** InnerTube's "Artists" search filter, base64-encoded by YouTube itself. */
export const ARTIST_SEARCH_PARAMS = "EgWKAQIgAWoKEAkQChAFEAMQBA%3D%3D";

async function innerTube(
  endpoint: string,
  client: InnerTubeClient,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}${endpoint}?prettyPrint=false`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": client.userAgent,
      "X-Goog-Api-Key": INNERTUBE_KEY,
      "X-Youtube-Client-Name": client.id,
      "X-Youtube-Client-Version": client.clientVersion,
      Origin: "https://www.youtube.com",
      "X-Origin": "https://www.youtube.com",
      // Present only when YOUTUBE_COOKIE is configured; see authHeaders.
      ...(await authHeaders("https://www.youtube.com")),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new ConvexError(`YouTube API returned ${res.status}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

const clientContext = (client: InnerTubeClient) => ({
  client: {
    hl: "en",
    gl: "US",
    userAgent: client.userAgent,
    clientName: client.clientName,
    clientVersion: client.clientVersion,
    ...client.extra,
  },
});

/** Parse a "H:MM:SS" / "MM:SS" / "SS" length string into seconds. */
function parseLength(raw?: string): number {
  if (!raw) return 0;
  const parts = raw.split(":").map((p) => Number(p) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] ?? 0;
}

const CREATOR_NAME_PLACEHOLDER_RE =
  /^(?:unknown artist|artist|song|video|single|album|ep|music|official|unknown|topic|records?|music video|official video|official audio|lyrics?)$/i;

function cleanCreatorName(value: unknown): string {
  if (typeof value !== "string") return "Unknown artist";
  const name = value
    .replace(/\s+/g, " ")
    .replace(
      /(?:\(|\[)(?:official|topic|audio|video|lyrics?|visualizer|hd|hq)[^\])]*(?:\)|\])/gi,
      "",
    )
    .replace(/\s+(?:topic|vevo)$/i, "")
    .trim();
  if (
    !name ||
    CREATOR_NAME_PLACEHOLDER_RE.test(name) ||
    !/[\p{L}\p{N}]/u.test(name)
  ) {
    return "Unknown artist";
  }
  return name;
}

function firstCreatorName(title: string, ...values: unknown[]): string {
  const titleKey = normalizeMatchText(title);
  for (const value of values) {
    const raw = cleanCreatorName(value);
    if (raw === "Unknown artist") continue;
    const candidates = raw
      .split(/\s*(?:[•·|]|\s+[-–—]\s+)\s*/i)
      .map((part) => part.replace(/^[\s\-–—|·]+|[\s\-–—|·]+$/g, "").trim())
      .filter(Boolean);
    for (const candidate of candidates) {
      if (
        CREATOR_NAME_PLACEHOLDER_RE.test(candidate) ||
        !/[\p{L}\p{N}]/u.test(candidate)
      )
        continue;
      if (normalizeMatchText(candidate) !== titleKey) return candidate;
    }
  }
  return "Unknown artist";
}

function cleanTrackTitle(value: string): string {
  let title = value.replace(/\s+/g, " ").trim();
  const suffixPatterns = [
    /\s+[-–—]\s+music\s+for\s+.*$/i,
    /\s+[-–—|]\s*(?:official\s+)?(?:music\s+video|music\s+audio|audio|lyrics?|visualizer)\s*$/i,
    /\s*(?:\(|\[)\s*(?:official\s+)?(?:music\s+video|music\s+audio|audio|lyrics?|visualizer)\s*(?:\)|\])\s*$/i,
  ];
  for (const pattern of suffixPatterns)
    title = title.replace(pattern, "").trim();
  return title || value.trim();
}

// Loose structural helpers — InnerTube responses are deeply nested and typed
// as unknown, so we traverse defensively.
// NOTE: numeric segments index LISTS ("tabs" → [tab]) and string segments
// read object keys — the old helper only handled dicts, so paths like
// ["tabs", "0", ...] silently returned undefined and musicSearch always
// returned zero results (the home sections never loaded).
const get = (obj: unknown, path: (string | number)[]): unknown =>
  path.reduce<unknown>((acc, key) => {
    if (typeof key === "number") {
      return Array.isArray(acc) && key < acc.length ? acc[key] : undefined;
    }
    if (
      acc &&
      typeof acc === "object" &&
      key in (acc as Record<string, unknown>)
    ) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);

function extractSearchResults(data: Record<string, unknown>): YtItem[] {
  const out: YtItem[] = [];
  const sections = get(data, [
    "contents",
    "twoColumnSearchResultsRenderer",
    "primaryContents",
    "sectionListRenderer",
    "contents",
  ]);
  if (!Array.isArray(sections)) return out;

  for (const section of sections) {
    const items = get(section, ["itemSectionRenderer", "contents"]);
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const vr = get(item, ["videoRenderer"]) as
        | Record<string, unknown>
        | undefined;
      const videoId = vr ? (vr.videoId as string | undefined) : undefined;
      if (!videoId) continue;

      const title =
        (get(vr, ["title", "runs", 0, "text"]) as string) ??
        (get(vr, ["title", "simpleText"]) as string) ??
        "Untitled";
      const artist = firstCreatorName(
        title,
        get(vr, ["ownerText", "runs", 0, "text"]),
        get(vr, ["longBylineText", "runs", 0, "text"]),
      );
      const lengthText = get(vr, ["lengthText", "simpleText"]) as
        | string
        | undefined;
      const thumbs = get(vr, ["thumbnail", "thumbnails"]);
      const thumbnail = Array.isArray(thumbs)
        ? ((thumbs[thumbs.length - 1] as { url?: string })?.url ?? "")
        : "";

      out.push({
        id: videoId,
        title: cleanTrackTitle(title),
        artist,
        duration: parseLength(lengthText),
        thumbnail,
      });
      if (out.length >= 10) return out;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Music-only search (YouTube Music).
// Uses the YouTube Music InnerTube endpoint with the WEB_REMIX client, which
// exclusively serves music content — no vlogs, podcasts, uploads, etc.
// ---------------------------------------------------------------------------

const MUSIC_CLIENT: InnerTubeClient = {
  id: "67",
  clientName: "WEB_REMIX",
  clientVersion: "1.20240801.01.00",
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
};

const MUSIC_API = "https://music.youtube.com/youtubei/v1/";

/**
 * Did YouTube Music actually answer with a music shelf?
 *
 * The bot-check interstitial comes back as HTTP 200 with perfectly valid JSON
 * and no results structure at all. Without this probe, "we could not reach
 * YouTube" and "this song does not exist" produce the identical empty list, and
 * the page then confidently claims a song does not exist when in fact the
 * lookup never ran.
 */
function musicSearchAnswered(data: Record<string, unknown>): boolean {
  const contents = get(data, [
    "contents",
    "tabbedSearchResultsRenderer",
    "tabs",
    0,
    "tabRenderer",
    "content",
    "sectionListRenderer",
    "contents",
  ]);
  if (!Array.isArray(contents)) return false;
  // A present-but-EMPTY shelf is NOT an answer. This is the exact shape
  // returned to Convex's egress IP: HTTP 200, valid JSON, a music shelf that
  // contains zero rows. Treating it as a real answer is what made the page
  // confidently report "no results found" for songs that do exist.
  return contents.some((section) => {
    const shelf = get(section, ["musicShelfRenderer", "contents"]);
    return Array.isArray(shelf) && shelf.length > 0;
  });
}

/**
 * `answered` distinguishes "YouTube Music replied and had nothing" from
 * "YouTube Music never replied usefully". Callers must never present the
 * second case to the user as "no results found".
 */
async function musicSearch(
  query: string,
): Promise<{ items: YtItem[]; answered: boolean }> {
  const res = await fetch(`${MUSIC_API}search?prettyPrint=false`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": MUSIC_CLIENT.userAgent,
      "X-Goog-Api-Key": INNERTUBE_KEY,
      "X-Youtube-Client-Name": MUSIC_CLIENT.id,
      "X-Youtube-Client-Version": MUSIC_CLIENT.clientVersion,
      Origin: "https://music.youtube.com",
      "X-Origin": "https://music.youtube.com",
      Referer: "https://music.youtube.com/",
      // The same authorized session, hashed against the Music origin.
      ...(await authHeaders("https://music.youtube.com")),
    },
    body: JSON.stringify({
      context: {
        client: {
          hl: "en",
          gl: "US",
          clientName: MUSIC_CLIENT.clientName,
          clientVersion: MUSIC_CLIENT.clientVersion,
        },
      },
      query,
      // Songs-shelf filter: restricts results to YouTube Music's "Songs"
      // shelf — proper studio tracks/album versions, not random videos.
      params: "Eg-KAQwIARAAGAAgACgAMABqChAEEAMQBBApEAU",
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok)
    throw new ConvexError(`YouTube Music API returned ${res.status}`);
  const data = (await res.json()) as Record<string, unknown>;
  return {
    items: extractMusicResults(data),
    answered: musicSearchAnswered(data),
  };
}

/**
 * Heuristics that reject anything that is not a real music track:
 * - duration must be between 30s and 15 min (filters streams, mixes, livesets)
 * - title/owner must not look like a podcast, interview, mix, etc.
 */
// Match phrases, not isolated words. Song titles and artist names legitimately
// contain words such as "army", "troop", "sports", and "highlights"; rejecting
// those words by themselves made valid catalog tracks disappear.
const GAMING_CONTENT_RE =
  /\b(clash of clans|coc|gameplay|video game|mobile game|walkthrough|let'?s play|inferno tower|inferno dragon|super witch|new troops?|max troops?|max single|all max troop|home village|builder base|base layout|attack strategy|defen[cs]e strategy|super troops?|hog rider|barbarian|archer queen|spell caster)\b/i;
const NON_MUSIC_RE =
  /\b(podcast|episode|interview|full album|mix(?:ed)? by|megamix|dj set|live set|1 hour|10 hours|hours of|asmr|reaction|tutorial|karaoke|cover\s*\?*|how to deal with|football highlights?|soccer highlights?|basketball highlights?|sports highlights?|match highlights?|game highlights?|wta|atp|nba|nfl|ufc|formula 1|grand prix|china open|press conference|breaking news|news update|match review|match result|transfer news|sports news)\b/i;

export function isMusicTrack(item: YtItem): boolean {
  if (item.duration > 0 && (item.duration < 30 || item.duration > 900))
    return false;
  const hay = `${item.title} ${item.artist}`;
  return !GAMING_CONTENT_RE.test(hay) && !NON_MUSIC_RE.test(hay);
}

// Lyric/lo-fi uploads are a separate source, not interchangeable with the
// YouTube Music Songs shelf. These helpers deliberately require a real music
// marker, a song-like duration, and a close match to the user's query so a
// video that merely mentions a song can never leak into this list.
const MUSIC_VIDEO_MARKER_RE =
  /\b(lyrics?|lyrical|lofi|lo-fi|music\s*video|official\s*(audio|video))\b/i;
const QUERY_NOISE_RE =
  /\b(song|songs|music|track|video|official|lyrics?|lyrical|lofi|lo-fi|remix|version|full|album|audio)\b/i;

function normalizeMatchText(value: string): string {
  return value
    .toLocaleLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function queryTerms(query: string): string[] {
  return normalizeMatchText(query)
    .split(" ")
    .map((term) => term.trim())
    .filter((term) => term.length > 1 && !QUERY_NOISE_RE.test(term));
}

/** Strict gate for the supplemental lyric/lo-fi source. */
export function isLyricVideoTrack(item: YtItem, query: string): boolean {
  if (!isMusicTrack(item)) return false;
  // Unknown-length results are not safe to classify from title text alone.
  if (item.duration < 30 || item.duration > 900) return false;
  const haystack = normalizeMatchText(`${item.title} ${item.artist}`);
  if (!MUSIC_VIDEO_MARKER_RE.test(`${item.title} ${item.artist}`)) return false;

  const terms = queryTerms(query);
  if (terms.length === 0) return false;
  const matches = terms.filter((term) => haystack.includes(term)).length;
  // Song-title searches are normally short, so require every meaningful term.
  // For longer searches, allow a small amount of artist/title noise without
  // accepting a result that shares only one generic word.
  return terms.length <= 6
    ? matches === terms.length
    : matches >= Math.ceil(terms.length * 0.7);
}

/** Deduplicate by video id and by normalized title + artist. */
export function dedupeMusicItems(items: YtItem[]): YtItem[] {
  const seenIds = new Set<string>();
  const seenTracks = new Set<string>();
  return items.filter((item) => {
    const trackKey = `${normalizeMatchText(item.title)}|${normalizeMatchText(item.artist)}`;
    if (seenIds.has(item.id) || seenTracks.has(trackKey)) return false;
    seenIds.add(item.id);
    seenTracks.add(trackKey);
    return true;
  });
}

function hasMusicEvidence(item: YtItem): boolean {
  return (
    item.duration >= 30 &&
    item.duration <= 900 &&
    MUSIC_VIDEO_MARKER_RE.test(`${item.title} ${item.artist}`)
  );
}

const DISCOVERY_QUERY_RE =
  /\b(songs?|music|hits|mix|playlist|chill|happy|sad|energetic|focus|workout|party|sleep|romantic|nostalgic|pop|rock|jazz|classical|ambient|funk|metal|country|reggaeton|afrobeats|k[\s-]?pop|indie|electronic|lo-fi|r\s*(?:&|and)\s*b|hip-hop)\b/i;

const DISCOVERY_SEEDS: Array<[RegExp, string[]]> = [
  [/\bk[\s-]?pop\b/i, ["BLACKPINK songs", "TWICE songs", "Stray Kids songs"]],
  [
    /\bpop\b/i,
    ["Taylor Swift songs", "Dua Lipa songs", "Olivia Rodrigo songs"],
  ],
  [
    /\bhip[\s-]?hop\b/i,
    ["Kendrick Lamar songs", "Drake songs", "Nicki Minaj songs"],
  ],
  [/\brock\b/i, ["Foo Fighters songs", "Queen songs", "Nirvana songs"]],
  [
    /\br\s*(?:&|and)\s*b\b/i,
    ["SZA songs", "The Weeknd songs", "Daniel Caesar songs"],
  ],
  [/\belectronic\b/i, ["Daft Punk songs", "Justice songs", "Disclosure songs"]],
  [
    /\bindie\b/i,
    ["Phoebe Bridgers songs", "Tame Impala songs", "Arctic Monkeys songs"],
  ],
  [
    /\bjazz\b/i,
    ["Miles Davis songs", "Ella Fitzgerald songs", "Kamasi Washington songs"],
  ],
  [
    /\bclassical\b/i,
    ["Ludwig van Beethoven songs", "Mozart songs", "Chopin songs"],
  ],
  [/\blo[\s-]?fi\b/i, ["Lofi Girl songs", "KSW songs", "Lofi beats songs"]],
  [/\bmetal\b/i, ["Metallica songs", "Slipknot songs", "Iron Maiden songs"]],
  [
    /\bcountry\b/i,
    ["Morgan Wallen songs", "Luke Combs songs", "Maren Morris songs"],
  ],
  [/\breggaeton\b/i, ["Bad Bunny songs", "Karol G songs", "J Balvin songs"]],
  [/\bafrobeats\b/i, ["Burna Boy songs", "Wizkid songs", "Tems songs"]],
  [
    /\bambient\b/i,
    ["Brian Eno songs", "Max Richter songs", "Marconi Union songs"],
  ],
  [/\bfunk\b/i, ["Jamiroquai songs", "Vulfpeck songs", "The Meters songs"]],
  [
    /\bchill\b/i,
    ["Frank Ocean songs", "Daniel Caesar songs", "Khruangbin songs"],
  ],
  [
    /\bhappy\b/i,
    ["Pharrell Williams songs", "Olivia Rodrigo songs", "Dua Lipa songs"],
  ],
  [
    /\bsad\b/i,
    ["Billie Eilish songs", "Lana Del Rey songs", "The National songs"],
  ],
  [
    /\benergetic\b/i,
    ["Imagine Dragons songs", "The Killers songs", "Arctic Monkeys songs"],
  ],
  [
    /\bfocus\b/i,
    ["Ludovico Einaudi songs", "Max Richter songs", "Ólafur Arnalds songs"],
  ],
  [/\bworkout\b/i, ["Kendrick Lamar songs", "Drake songs", "Doja Cat songs"]],
  [/\bparty\b/i, ["Dua Lipa songs", "Doja Cat songs", "Kylie Minogue songs"]],
  [
    /\bsleep\b/i,
    ["Norah Jones songs", "Billie Eilish songs", "Bon Iver songs"],
  ],
  [/\bromantic\b/i, ["Adele songs", "The Weeknd songs", "SZA songs"]],
  [
    /\bnostalgic\b/i,
    ["Fleetwood Mac songs", "The Weeknd songs", "Tame Impala songs"],
  ],
  // Generic terms that DISCOVERY_QUERY_RE recognises but that had no
  // artist-backed seeds. Without these, "worldwide music hits" or "viral songs
  // this week" entered the discovery branch, found zero seeds, then fell
  // through to a literal search that could never match — so the mix silently
  // returned nothing.
  //
  // These are LAST on purpose. `discoverySeedQueries` round-robins across
  // matching groups in array order, so a broad term sitting first would win
  // every round and make unrelated mixes ("electronic…", "retro synth pop…",
  // "top hits today") all return the SAME artist — the exact
  // all-mixes-sound-the-same behaviour this list exists to avoid.
  [/\bviral\b/i, ["Sabrina Carpenter songs", "Chappell Roan songs", "Tate McRae songs"]],
  [/\bworldwide\b/i, ["Coldplay songs", "Imagine Dragons songs", "OneRepublic songs"]],
  [/\bacoustic\b/i, ["José González songs", "Iron & Wine songs", "Ben Howard songs"]],
  [/\bhits?\b/i, ["Hozier songs", "Billie Eilish songs", "Post Malone songs"]],
];

/**
 * Artist-backed seed queries for a category/mood request. A broad query can
 * match several groups at once ("indie pop" matches `indie` and `pop`), so the
 * seeds are round-robined across the matching groups instead of concatenated.
 * Concatenation let the caller's `slice` cap cut off the second genre almost
 * entirely, which is exactly the variety a broad genre request is asking for.
 */
export const DISCOVERY_SEED_LIMIT = 4;

export function discoverySeedQueries(
  query: string,
  limit = DISCOVERY_SEED_LIMIT,
): string[] {
  const groups = DISCOVERY_SEEDS.filter(([pattern]) => pattern.test(query))
    .map(([, categorySeeds]) => categorySeeds)
    .filter((seeds) => seeds.length > 0);
  if (groups.length === 0) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (
    let round = 0;
    round < Math.max(...groups.map((seeds) => seeds.length));
    round++
  ) {
    for (const seeds of groups) {
      const seed = seeds[round];
      if (seed && !seen.has(seed)) {
        seen.add(seed);
        out.push(seed);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

function matchesSearchQuery(item: YtItem, query: string): boolean {
  const terms = normalizeMatchText(query)
    .split(" ")
    .filter((term) => term.length > 1 && !QUERY_NOISE_RE.test(term));
  if (terms.length === 0) return false;
  const result = normalizeMatchText(`${item.title} ${item.artist}`);
  const matches = terms.filter((term) => result.includes(term)).length;
  // Broad discovery searches are category requests, not exact title queries.
  // Requiring every term made useful fallbacks such as "pop music hits" fail
  // because the returned metadata naturally does not contain the word
  // "hits". Exact song/artist searches remain strict.
  if (DISCOVERY_QUERY_RE.test(query)) return matches > 0;
  return matches === terms.length;
}

/**
 * Gate for the regular-web fallback. A close query match plus a song-length
 * duration is useful even when an otherwise valid upload has no "official
 * audio" wording in its title/channel. Contextual non-music filters above keep
 * this permissive without reintroducing the broad gaming/sports false positives.
 */
export function isPrimaryMusicResult(item: YtItem, query: string): boolean {
  if (!isMusicTrack(item) || item.duration < 30 || item.duration > 900)
    return false;
  return matchesSearchQuery(item, query);
}

function extractMusicResults(data: Record<string, unknown>): YtItem[] {
  const out: YtItem[] = [];
  const others: YtItem[] = [];
  const seen = new Set<string>();
  // Songs/videos first — playlists, albums and artists don't play as a single
  // track and used to fill the results, pushing real songs out of the list.
  const push = (entry: (YtItem & { kind?: "song" | "other" }) | null) => {
    if (!entry || seen.has(entry.id)) return;
    seen.add(entry.id);
    if (entry.kind === "other") others.push(entry);
    else out.push(entry);
  };

  const sections = get(data, [
    "contents",
    "tabbedSearchResultsRenderer",
    "tabs",
    0,
    "tabRenderer",
    "content",
    "sectionListRenderer",
    "contents",
  ]);
  const flat = Array.isArray(sections)
    ? sections
    : get(data, ["contents", "sectionListRenderer", "contents"]);
  if (!Array.isArray(flat)) return out;

  for (const section of flat) {
    // Legacy shape: a dedicated songs shelf.
    const shelf = get(section, ["musicShelfRenderer", "contents"]);
    if (Array.isArray(shelf)) {
      for (const item of shelf) {
        const renderer = get(item, ["musicResponsiveListItemRenderer"]) as
          | Record<string, unknown>
          | undefined;
        if (renderer) {
          const entry = parseMusicListItem(renderer);
          if (entry) push(entry);
        }
        if (out.length >= 20) break;
      }
      if (out.length >= 20) break;
      continue;
    }

    // Current shape (2026+): results arrive as a list of
    // itemSectionRenderer blocks, each wrapping one
    // musicResponsiveListItemRenderer — plus a musicCardShelfRenderer top
    // result. The old parser only read musicShelfRenderer, so every search
    // silently returned zero items and the home sections never loaded.
    const card = get(section, ["musicCardShelfRenderer"]);
    if (card && typeof card === "object") {
      const entry = parseMusicCardShelf(card as Record<string, unknown>);
      // Top-result cards do not carry reliable song metadata. Do not let a
      // sports/news upload enter the music catalog just because YouTube
      // Music placed it in the search response.
      if (entry && hasMusicEvidence(entry)) push(entry);
    }
    const isrItems = get(section, ["itemSectionRenderer", "contents"]);
    if (Array.isArray(isrItems)) {
      for (const item of isrItems) {
        const renderer = get(item, ["musicResponsiveListItemRenderer"]) as
          | Record<string, unknown>
          | undefined;
        if (renderer) {
          const entry = parseMusicListItem(renderer);
          if (entry) push(entry);
        }
        if (out.length >= 20) break;
      }
      if (out.length >= 20) break;
    }
  }
  // Not enough typed single tracks — only top up with rows that carry an
  // explicit music marker. Untyped rows are deliberately not promoted: that
  // was the path that previously let unrelated videos into music search.
  for (const o of others) {
    if (out.length >= 20) break;
    if (hasMusicEvidence(o)) out.push(o);
  }
  return out.filter(isMusicTrack).slice(0, 10);
}

/**
 * One musicResponsiveListItemRenderer → YtItem, or null when the row isn't a
 * directly playable single track (playlists/artists have no watch videoId).
 * Reads the videoId from every place YouTube puts it: playlistItemData, the
 * overlay play button's watchEndpoint, or the row's navigationEndpoint.
 * Also classifies the row: YouTube puts the type ("Song"/"Video"/"Playlist"…)
 * as the first subtitle run of column 1.
 */
export function parseMusicListItem(
  renderer: Record<string, unknown>,
): (YtItem & { kind: "song" | "other" }) | null {
  const videoId =
    (get(renderer, ["playlistItemData", "videoId"]) as string | undefined) ??
    (get(renderer, [
      "overlay",
      "musicItemThumbnailOverlayRenderer",
      "content",
      "musicPlayButtonRenderer",
      "playNavigationEndpoint",
      "watchEndpoint",
      "videoId",
    ]) as string | undefined) ??
    (get(renderer, ["navigationEndpoint", "watchEndpoint", "videoId"]) as
      | string
      | undefined);
  if (!videoId) return null;

  const flex = get(renderer, ["flexColumns"]);
  if (!Array.isArray(flex)) return null;
  const runsOf = (col: unknown) =>
    (get(col, ["musicResponsiveListItemFlexColumnRenderer", "text", "runs"]) as
      | Array<{ text?: string }>
      | undefined) ?? [];
  const textOf = (col: unknown) => runsOf(col)[0]?.text ?? "";
  const title = cleanTrackTitle(textOf(flex[0]) || "Untitled");
  // Column 1 interleaves metadata and separator runs. Depending on the
  // response shape it can be [artist, " • ", album, " • ", duration] or
  // [type, " • ", artist, " • ", duration], so separators must never be
  // mistaken for the artist.
  const runs =
    (get(flex[1], [
      "musicResponsiveListItemFlexColumnRenderer",
      "text",
      "runs",
    ]) as Array<{ text?: string }> | undefined) ?? [];
  const metaRuns = runs
    .map((run) => run.text?.trim() ?? "")
    .filter((value) => value && !/^[•·,&]+$/.test(value));
  const typePattern =
    /^(song|video|playlist|album|artist|episode|short|music video|live performance|single|ep)$/i;
  const typeIndex = metaRuns.findIndex((value) => typePattern.test(value));
  const artistIndex = typeIndex >= 0 ? typeIndex + 1 : 0;
  const typeRun = typeIndex >= 0 ? metaRuns[typeIndex] : "";
  // The Songs shelf often omits the explicit "Song" metadata run and returns
  // only [artist, album, duration]. Worse, the column the type run is expected
  // in frequently holds the ALBUM title instead ("Charlie Puth", "Nine Track
  // Mind", "3:38"), so the text heuristic below cannot see a "Song" marker
  // and classified every album track as "other" — which `extractMusicResults`
  // then discarded, leaving YouTube Music search permanently empty.
  //
  // `musicVideoType` is the authoritative signal and is what actually
  // decides this: ATV is an album track, OMV an official music video,
  // OFFICIAL_SOURCE_MUSIC a topic/audio row. All three ARE songs. UGC rows
  // (covers, lyric videos, reaction uploads) are not, and the old
  // promotion path for them stays closed.
  const musicVideoType = String(
    get(renderer, [
      "flexColumns",
      0,
      "musicResponsiveListItemFlexColumnRenderer",
      "text",
      "runs",
      0,
      "navigationEndpoint",
      "watchEndpoint",
      "watchEndpointMusicSupportedConfigs",
      "watchEndpointMusicConfig",
      "musicVideoType",
    ]) ??
    get(renderer, [
      "navigationEndpoint",
      "watchEndpoint",
      "watchEndpointMusicSupportedConfigs",
      "watchEndpointMusicConfig",
      "musicVideoType",
    ]) ??
    "",
  );
  const isCatalogTrack =
    musicVideoType === "MUSIC_VIDEO_TYPE_ATV" ||
    musicVideoType === "MUSIC_VIDEO_TYPE_OMV" ||
    musicVideoType === "MUSIC_VIDEO_TYPE_OFFICIAL_SOURCE_MUSIC";
  const kind: "song" | "other" = isCatalogTrack
    ? "song"
    : typeRun === "" || /^(playlist|album|artist|episode)$/i.test(typeRun)
      ? "other"
      : "song";
  const artist = firstCreatorName(
    title,
    metaRuns[artistIndex],
    get(renderer, ["subtitle", "runs", 0, "text"]),
    get(renderer, ["longBylineText", "runs", 0, "text"]),
  );
  const durationMatch = [...metaRuns]
    .reverse()
    .find((value) => /^\d{1,2}:\d{2}(:\d{2})?$/.test(value));
  const durationRaw = durationMatch ?? textOf(flex[2]) ?? "";

  // Album, when YouTube actually reports one. The subtitle column packs
  // [type?, artist, album, year, duration], so the album is the run right
  // after the artist that is neither a duration, a bare year, a view count
  // nor another metadata label. When nothing qualifies it stays undefined —
  // the recommendation engine needs to know an album is unknown rather than
  // assume a value it cannot verify.
  const isNoise = (value: string) =>
    !value ||
    /^\d{1,2}:\d{2}(:\d{2})?$/.test(value) ||
    /^(19|20)\d{2}$/.test(value) ||
    typePattern.test(value) ||
    /views?$/i.test(value) ||
    /^\d[\d,]*$/i.test(value);
  const albumCandidate = metaRuns.find(
    (value, index) => index > artistIndex && !isNoise(value),
  );
  const album =
    albumCandidate && albumCandidate.toLowerCase() !== artist.toLowerCase()
      ? albumCandidate
      : undefined;

  const thumbs = get(renderer, [
    "thumbnail",
    "musicThumbnailRenderer",
    "thumbnail",
    "thumbnails",
  ]);
  const thumbnail = Array.isArray(thumbs)
    ? ((thumbs[thumbs.length - 1] as { url?: string })?.url ?? "")
    : "";

  return {
    id: videoId,
    title,
    artist,
    duration: parseLength(durationRaw),
    thumbnail,
    ...(album ? { album } : {}),
    kind,
  };
}

/** The musicCardShelfRenderer "Top result" card → YtItem (song only). */
function parseMusicCardShelf(card: Record<string, unknown>): YtItem | null {
  const videoId =
    (get(card, ["onTap", "watchEndpoint", "videoId"]) as string | undefined) ??
    (get(card, [
      "buttons",
      0,
      "buttonRenderer",
      "command",
      "watchEndpoint",
      "videoId",
    ]) as string | undefined);
  if (!videoId) return null;

  const title = cleanTrackTitle(
    (get(card, ["title", "runs", 0, "text"]) as string | undefined) ??
      (get(card, [
        "header",
        "musicCardShelfHeaderBasicRenderer",
        "title",
        "runs",
        0,
        "text",
      ]) as string | undefined) ??
      "Top result",
  );
  // Subtitle runs pack artist • song • year.
  const subtitle =
    (get(card, ["subtitle", "runs"]) as Array<{ text?: string }> | undefined) ??
    [];
  const parts = subtitle
    .map((r) => r.text ?? "")
    .join("")
    .split("•")
    .map((s) => s.trim());
  const artist = firstCreatorName(title, parts[0], parts[1]);
  const durationText =
    (get(card, ["lengthText", "simpleText"]) as string | undefined) ??
    parts.find((part) => /^\d{1,2}:\d{2}(?::\d{2})?$/.test(part)) ??
    "";

  const thumbs = get(card, [
    "thumbnail",
    "musicThumbnailRenderer",
    "thumbnail",
    "thumbnails",
  ]);
  const thumbnail = Array.isArray(thumbs)
    ? ((thumbs[thumbs.length - 1] as { url?: string })?.url ?? "")
    : "";

  return {
    id: videoId,
    title,
    artist,
    duration: parseLength(durationText),
    thumbnail,
  };
}

/**
 * Search YouTube for music. Uses the YouTube Music endpoint so ONLY music
 * tracks are ever returned — no podcasts, vlogs, mixes, or other videos.
 */
/**
 * Cached, deduplicated, rate-limited entry point for music search. Callers use
 * this; `searchYoutubeDirect` below is the worker it wraps.
 *
 *  - CACHE: two searches for one query, a re-render, or backing into a result
 *    already seen each cost a full InnerTube round trip against an upstream
 *    that rate limits by datacenter IP.
 *  - DEDUPE: concurrent identical queries collapse to one upstream call, so
 *    strict-mode double effects and double taps cannot double the load.
 *  - RATE BUDGET: a retry storm is refused locally, not forwarded.
 *
 * The cache returns exactly the value that was returned when the row was
 * written — it does not recompute. InnerTube's own response is not
 * deterministic between identical calls (shelves come back with different
 * contents), so a cached result can differ from a fresh one. That is the
 * accepted trade for a ten-minute metadata cache, and it is why the TTL is
 * short.
 *
 * `failed` is cached alongside `items` so a caller can never read a stale
 * empty list as a real "no results"; failures are cached for a minute, long
 * enough to stop a dead upstream being hammered, short enough that the error
 * clears promptly.
 */
export const searchYoutube = action({
  args: { query: v.string() },
  handler: async (
    ctx,
    { query },
  ): Promise<{ items: YtItem[]; failed: boolean }> => {
    const q = query.trim();
    if (!q) return { items: [], failed: false };

    const key = cacheKey("youtube", "search", { query: q.toLowerCase() });

    const cached = await ctx.runQuery(api.providerCache.cacheGet, { key });
    if (cached) return cached.value as { items: YtItem[]; failed: boolean };

    const slot = takeRateSlot("youtube:search");
    if (!slot.allowed) {
      // A genuine "we could not answer", so it reports `failed`. Returning
      // empty items with failed:false would read as "no such song exists".
      return { items: [], failed: true };
    }

    const result = await dedupeRequest(key, () =>
      ctx.runAction(api.youtube.searchYoutubeDirect, { query: q }),
    );

    await ctx.runMutation(internal.providerCache.cachePut, {
      key,
      value: result,
      provider: "youtube",
      ttlSeconds: result.failed ? 60 : TTL.search,
    });

    return result;
  },
});

export const searchYoutubeDirect = action({
  args: { query: v.string() },
  handler: async (
    _ctx,
    { query },
  ): Promise<{ items: YtItem[]; failed: boolean }> => {
    if (!query.trim()) return { items: [], failed: false };

    // Category/mood searches are discovery requests, not literal title
    // searches. Prefer concrete artist-backed seeds BEFORE the broad shelf
    // response: YouTube Music often answers "K-pop songs" with soundtrack or
    // animation tracks even though it has plenty of actual K-pop songs.
    // These are intentionally NOT re-ranked against the raw query — a genre
    // request is not a title, so scoring it against literal tokens would throw
    // the whole shelf away.
    if (DISCOVERY_QUERY_RE.test(query) && discoverySeedQueries(query).length > 0) {
      // Run the artist-backed seeds CONCURRENTLY, not one after another. A
      // broad genre query can match several seed groups at once ("indie pop"
      // matches both `indie` and `pop`), so the sequential version chained up
      // to six YouTube Music requests — long enough to blow the caller's
      // request timeout, which is why "Play something random" kept failing.
      const seeds = discoverySeedQueries(query);
      const settled = await Promise.allSettled(
        seeds.map((seedQuery) => musicSearch(seedQuery)),
      );
      const seeded = settled.flatMap((result) =>
        result.status === "fulfilled" ? result.value.items : [],
      );
      const combined = dedupeMusicItems(seeded).slice(0, 10);
      if (combined.length > 0) return { items: combined, failed: false };
    }

    // Preferred: YouTube Music — returns real studio tracks (Songs shelf),
    // never random YouTube videos.
    //
    // `catalogAnswered` tracks ONLY the YouTube Music catalogue source. It is
    // deliberately NOT reset by the video fallback below: the plain web
    // fallback answers a different question ("what videos exist") and its
    // results are "[Official Video]" uploads, not a music catalogue. Letting it
    // clear this flag is what made the page claim a song did not exist while
    // the real problem was that the catalogue was unreachable.
    let catalogAnswered = false;
    try {
      const response = await musicSearch(query);
      // Only trust this when YouTube Music actually returned a shelf. The
      // bot-check interstitial is a 200 with valid JSON but no results
      // structure, and treating it as an answer is what let the page claim a
      // song did not exist.
      catalogAnswered = response.answered;
      if (response.items.length > 0 && catalogAnswered) {
        // Relevance ranking (src/lib/searchRelevance.ts). YouTube Music's own
        // order is a popularity/recency blend, not an answer to the question
        // that was asked: it regularly returned a lyric upload or an unrelated
        // video above the exact song for queries like "we dont talk anymore".
        const ranked = rankSearchResults(response.items, query, 20).map(
          (r) => r.item,
        );
        if (ranked.length > 0) return { items: ranked, failed: false };
        // The strict relevance gate rejected everything in the pool. Relax
        // progressively over the pool we ALREADY fetched — version words
        // dropped, same threshold — rather than issuing a second network
        // request or falling back to unrelated popular content.
        const relaxed = broadFallbackOrder(response.items, query, 10);
        if (relaxed.length > 0) return { items: relaxed, failed: false };
        // Still nothing. A shelf in which not one query word appears anywhere
        // was never an answer to this query — the source returned a generic
        // list. Reporting that as "no results found" is the lie that made an
        // unreachable catalogue look like a song that does not exist.
        const answeredTheQuestion =
          bestPoolCoverage(response.items, query) >= MIN_POOL_COVERAGE;
        return { items: [], failed: !answeredTheQuestion };
      }
    } catch {
      // fall through to the video-filter retry below
    }

    // Fallback: regular YouTube search restricted to the "video" result type,
    // with the same non-music heuristics.
    let webItems: YtItem[] = [];
    try {
      const data = await innerTube("search", WEB, {
        context: clientContext(WEB),
        query,
        params: "EgIQAQ%3D%3D",
      });
      // NOTE: `catalogAnswered` is intentionally left untouched here. See its
      // declaration above.
      // The fallback is only for a failed/empty YouTube Music response. It must
      // be stricter than the primary path: no duration-less or marker-less
      // uploads, otherwise a generic vlog can appear to be a song result.
      webItems = dedupeMusicItems(
        extractSearchResults(data).filter((item) =>
          isPrimaryMusicResult(item, query),
        ),
      );
    } catch {
      // every source is unreachable
    }

    if (webItems.length > 0) {
      const ranked = rankSearchResults(webItems, query, 20).map((r) => r.item);
      return {
        items:
          ranked.length > 0
            ? ranked
            : broadFallbackOrder(webItems, query, 10),
        // These are playable uploads, but if the catalogue never answered then
        // this list is not a trustworthy answer to the query and the caller
        // must say so.
        failed: !catalogAnswered,
      };
    }

    // Nothing matched anywhere.
    return { items: [], failed: !catalogAnswered };
  },
});

/**
 * Search only the lyric/lo-fi music-video category. The user's query stays
 * unchanged everywhere else; this action derives a narrowly scoped YouTube
 * query internally and then applies a second, strict filter before returning
 * anything. Results are intentionally kept separate from `searchYoutube`.
 */
/**
 * Supplemental "lyric & lo-fi video" results, kept strictly separate from the
 * primary Songs results.
 *
 * `failed` exists because this action used to swallow every failure into
 * `{ items: [] }`. An empty list and an unreachable YouTube were then the same
 * value, and the page — which hides the section when there is nothing to show —
 * made the whole Lyric & lo-fi section silently disappear on any transient
 * error. To a listener that is indistinguishable from the feature having been
 * deleted, and there was no way to retry. The two cases are now reported
 * separately so the UI can say which one happened.
 */
export const searchLyricVideos = action({
  args: { query: v.string() },
  handler: async (
    _ctx,
    { query },
  ): Promise<{ items: YtItem[]; failed: boolean }> => {
    const rawQuery = query.trim();
    if (!rawQuery) return { items: [], failed: false };

    // This derived string is used ONLY for this supplemental action. It is
    // never written back to the input, search history, analytics, or the
    // primary YouTube Music request.
    const videoQuery = `${rawQuery} (lyric video OR lyrics OR lofi OR lo-fi OR music video)`;
    try {
      const data = await innerTube("search", WEB, {
        context: clientContext(WEB),
        query: videoQuery,
        params: "EgIQAQ%3D%3D",
      });
      const items = dedupeMusicItems(
        extractSearchResults(data).filter((item) =>
          isLyricVideoTrack(item, rawQuery),
        ),
      );
      // Ranked by the same engine as the primary results so the closest lyric
      // upload leads the section, and so a lyric upload can never sit above the
      // canonical track the user actually asked for.
      const ranked = rankSearchResults(items, rawQuery, 8).map((r) => r.item);
      return { items: ranked, failed: false };
    } catch {
      return { items: [], failed: true };
    }
  },
});

/**
 * Display metadata for a YouTube video id, used by shared track links.
 *
 * A share link is just `/t/<videoId>` — the id alone identifies the song, so
 * nothing else is carried in the URL. That means the landing page has to look
 * the title/artist/art up from the id, which is what this does. Deliberately a
 * separate call from `resolveStream`: a link is opened by someone who may
 * never be able to play the audio (region blocked, bot-checked), and they
 * still deserve a correct title on the page.
 *
 * Public and unauthenticated on purpose — the recipient of a shared link is
 * not signed in. Returns null for an id that does not resolve, so the caller
 * can show a "not found" state instead of rendering a blank row.
 */
export const trackMeta = action({
  args: { videoId: v.string() },
  handler: async (
    _ctx,
    { videoId },
  ): Promise<{
    id: string;
    title: string;
    artist: string;
    coverUrl: string;
    duration: number;
  } | null> => {
    // Cheap and key-free: oembed answers for any public video with a title,
    // author and thumbnail, and does not care about the datacenter bot-check
    // that bites the InnerTube clients below.
    try {
      const res = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(
          `https://www.youtube.com/watch?v=${videoId}`,
        )}&format=json`,
        { signal: AbortSignal.timeout(6_000) },
      );
      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        const title = typeof data.title === "string" ? data.title.trim() : "";
        if (title) {
          return {
            id: videoId,
            title,
            artist:
              typeof data.author_name === "string" && data.author_name.trim()
                ? data.author_name.trim()
                : "Unknown artist",
            // oembed hands back a 480px thumbnail; the `hqdefault` path is a
            // stable square fallback when it omits one.
            coverUrl:
              typeof data.thumbnail_url === "string" && data.thumbnail_url
                ? data.thumbnail_url
                : `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
            // oembed carries no duration. 0 lets the player fill in the real
            // length once the stream is loaded, instead of freezing a guess.
            duration: 0,
          };
        }
      }
    } catch {
      /* fall through to InnerTube */
    }

    // Fallback: InnerTube. A video that fails the bot-check can still return
    // its videoDetails, which is enough to label the page.
    // ANDROID_VR first, then MWEB. The three structurally-dead clients that
    // used to sit between them (TV_EMBEDDED, ANDROID, IOS) are gone — see the
    // note by their former definitions. WEB is kept here because it is the one
    // client that reliably serves `player` METADATA even when streams are
    // refused, so it is a genuine last chance for a title.
    for (const client of [ANDROID_VR, MWEB, WEB]) {
      try {
        const data = await innerTube("player", client, {
          context: clientContext(client),
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
          thirdParty: { embedUrl: "https://www.youtube.com" },
        });
        const details = get(data, ["videoDetails"]) as
          | Record<string, unknown>
          | undefined;
        const title =
          typeof details?.title === "string" ? details.title.trim() : "";
        if (!title) continue;
        const seconds = Number(details?.lengthSeconds);
        return {
          id: videoId,
          title,
          artist:
            typeof details?.author === "string" && details.author.trim()
              ? details.author.trim()
              : "Unknown artist",
          coverUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          duration: Number.isFinite(seconds) && seconds > 0 ? seconds : 0,
        };
      } catch {
        continue;
      }
    }

    return null;
  },
});

/**
 * Resolve a direct, playable audio stream URL for a YouTube video. Tries
 * several clients in order and picks the highest-quality audio-only format.
 * Always resolves (never throws) — when no stream is available it returns
 * { url: null, reason, youtubeUrl } so the UI can link out instead.
 */
/**
 * Reports whether the authorized-session wiring actually works, without ever
 * returning a single character of the secret.
 *
 * This exists because `Cookie` is a FORBIDDEN header name in the Fetch spec:
 * a runtime is entitled to strip it silently, in which case every cookie we
 * "sent" was dropped and the bot-check would persist with no error anywhere to
 * say why. A build that compiles and a deployment that succeeds both look
 * exactly like a working one. So the only honest check is to send a cookie to
 * an endpoint that reflects what it received.
 *
 * Returns booleans and counts ONLY. No cookie, no token, no header value.
 */
export const authStatus = action({
  args: {},
  handler: async (): Promise<{
    configured: boolean;
    /** A SAPISIDHASH-able SID is present, under whichever of the three names. */
    hashKeyFound: boolean;
    /** Which cookie NAME was used, or null. The NAME only, never its value. */
    hashKeyName: string | null;
    cookieHeaderTransmitted: boolean;
    probeStatus: number;
    detail: string;
  }> => {
    const cookie = youtubeCookieHeader();
    const hashKey = hashKeyName(cookie);
    const hashKeyFound = hashKey !== null;

    // A marker that is obviously not a credential, used only to see whether a
    // Cookie header set here survives the trip. Deliberately run whether or
    // not a session is configured: whether the runtime can send the header at
    // all is a property of the RUNTIME, and is worth knowing before a secret
    // is pasted in on the assumption that it will be transmitted.
    const probe = "synq_header_probe=1";
    let transmitted = false;
    let probeStatus = 0;
    let detail = "";

    try {
      const res = await fetch("https://httpbin.org/anything", {
        headers: { Cookie: probe },
        signal: AbortSignal.timeout(10_000),
      });
      probeStatus = res.status;
      const body = (await res.text()) as string;
      transmitted = body.includes("synq_header_probe=1");
      detail = transmitted
        ? "Cookie header reaches the network"
        : "Cookie header was STRIPPED by the runtime — the session cannot work";
    } catch (e) {
      detail = `probe failed: ${e instanceof Error ? e.message : "unknown"}`;
    }

    if (!cookie) {
      detail += " | YOUTUBE_COOKIE is not set, resolving anonymously";
    } else if (!hashKeyFound) {
      detail +=
        " | no SAPISID / __Secure-3PSID / __Secure-1PSID found, so no SAPISIDHASH proof is sent and the session will be treated as anonymous";
    }

    return {
      configured: !!cookie,
      hashKeyFound,
      hashKeyName: hashKey,
      cookieHeaderTransmitted: transmitted,
      probeStatus,
      detail,
    };
  },
});

export const resolveStream = action({
  args: {
    videoId: v.string(),
    /** "high" (default) picks the best bitrate; "low" prefers ≤ 96kbps for slow connections. */
    quality: v.optional(v.union(v.literal("high"), v.literal("low"))),
  },
  handler: async (
    _ctx,
    { videoId, quality = "high" },
  ): Promise<{
    url: string | null;
    title: string;
    reason?: string;
    youtubeUrl?: string;
  }> => {
    let lastError: string | undefined;
    let lastTitle: string | undefined;
    let lastYoutubeUrl: string | undefined;

    // ANDROID_VR is the only client left that returns stream URLs at all, and
    // MWEB is the only other one YouTube still evaluates rather than rejecting
    // outright. The dead ones are gone: each was a guaranteed-fail HTTPS round
    // trip that delayed the browser-side Piped fallback on every unresolvable
    // track. See the note where those clients used to be defined.
    for (const client of [ANDROID_VR, MWEB]) {
      try {
        const data = await innerTube("player", client, {
          context: clientContext(client),
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
          // Third-party embed params required by the TV embedded client.
          thirdParty: { embedUrl: "https://www.youtube.com" },
        });

        const status = get(data, ["playabilityStatus", "status"]) as
          | string
          | undefined;
        if (status && status !== "OK") {
          lastTitle =
            (get(data, ["videoDetails", "title"]) as string) ??
            `YouTube video ${videoId}`;
          lastError =
            (get(data, ["playabilityStatus", "reason"]) as string) ??
            `Playback unavailable (${status})`;
          lastYoutubeUrl = `https://youtu.be/${videoId}`;
          continue;
        }

        const videoTitle =
          (get(data, ["videoDetails", "title"]) as string) ?? undefined;
        if (videoTitle) lastTitle = videoTitle;

        const adaptive = get(data, ["streamingData", "adaptiveFormats"]);
        const base = get(data, ["streamingData", "formats"]);
        const formats = [
          ...(Array.isArray(adaptive) ? adaptive : []),
          ...(Array.isArray(base) ? base : []),
        ].filter(
          (f): f is Record<string, unknown> =>
            !!f &&
            typeof f === "object" &&
            typeof (f as Record<string, unknown>).url === "string" &&
            typeof (f as Record<string, unknown>).mimeType === "string" &&
            ((f as Record<string, unknown>).mimeType as string).startsWith(
              "audio/",
            ),
        );

        const sorted = formats.sort(
          (a, b) => (b.bitrate as number) - (a.bitrate as number),
        ) as Array<Record<string, unknown>>;
        // Network-aware: on "low", take the smallest stream that's still ≥ 48kbps.
        const best =
          quality === "low"
            ? ([...sorted]
                .reverse()
                .find((f) => (f.bitrate as number) >= 48000) ??
              sorted[sorted.length - 1])
            : sorted[0];

        if (best?.url) {
          return {
            url: best.url as string,
            title: videoTitle ?? "YouTube audio",
          };
        }

        // Player returned OK but no audio formats — treat as unavailable.
        lastTitle = videoTitle ?? `YouTube video ${videoId}`;
        lastError = "No audio stream available for this video";
        lastYoutubeUrl = `https://youtu.be/${videoId}`;
      } catch (error) {
        lastError =
          error instanceof Error ? error.message : "Stream resolution failed";
      }
    }

    return {
      url: null,
      title: lastTitle ?? `YouTube video ${videoId}`,
      reason: lastError ?? "No playable audio stream found for this video",
      youtubeUrl: lastYoutubeUrl ?? `https://youtu.be/${videoId}`,
    };
  },
});

// ---------------------------------------------------------------------------
// Playlist import (YouTube / YouTube Music).
//
// The importer used to be CSV-only, which made a two-click YouTube playlist
// take a Takeout export plus a file picker. InnerTube already serves the
// contents of a public playlist through the SAME public endpoint `search`
// uses, so the track list can be read directly from the share link with no
// OAuth app, no user token and no key.
//
// Deliberately a pure fetch: it returns the parsed rows and the caller hands
// them to the `playlists.saveImported` mutation, which is where the
// signed-in check and the ownership rules live. An unauthenticated caller can
// therefore read a public playlist (harmless — anyone can view it on
// YouTube) but can never write one.
// ---------------------------------------------------------------------------

/** One row of an imported playlist, in the shape saveImported expects. */
export interface ImportedRow {
  title: string;
  artist: string;
  duration?: number;
}

export interface PlaylistBrowseResult {
  name: string;
  tracks: ImportedRow[];
  /** Token for the next page of a long playlist, when there is one. */
  continuation: string | null;
  /** Playlists over this length are refused rather than silently truncated. */
  tooLong: boolean;
}

/** A playlist longer than this is a "mix"/"radio" seed, not a real list. */
export const MAX_IMPORT_TRACKS = 500;

function textOf(value: unknown): string {
  const direct = get(value, ["simpleText"]) as string | undefined;
  if (direct) return direct;
  const runs = get(value, ["runs"]);
  if (Array.isArray(runs)) {
    return runs
      .map((r) => (get(r, ["text"]) as string) ?? "")
      .join("")
      .trim();
  }
  return "";
}

/**
 * Depth-bounded search for the first node under `key`.
 *
 * InnerTube reshuffles the browse response between client versions, so the
 * exact path to the playlist list is not something to hard-code. Walking the
 * tree for a known renderer name survives those moves; the depth cap keeps a
 * malformed response from turning into an unbounded walk.
 */
function findRenderer(node: unknown, key: string, depth: number): unknown {
  if (depth <= 0 || !node || typeof node !== "object") return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findRenderer(child, key, depth - 1);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  const record = node as Record<string, unknown>;
  if (key in record) return record[key];
  for (const child of Object.values(record)) {
    const hit = findRenderer(child, key, depth - 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * Parse an InnerTube `browse` response for a playlist page.
 *
 * Pure and exported so the shape handling is testable without a network call.
 * Rows missing a video id, a title, or a usable artist are dropped: a playlist
 * full of "Watch on YouTube" promos is better imported short than not at all.
 */
export function extractPlaylistBrowse(
  data: Record<string, unknown>,
): PlaylistBrowseResult {
  const header =
    get(data, ["header", "playlistHeaderRenderer"]) ??
    get(data, ["metadata", "playlistMetadataRenderer"]) ??
    get(data, ["sidebar", "playlistSidebarRenderer"]);
  const name =
    textOf(get(header, ["title"])) ||
    textOf(
      get(header, ["items", 0, "playlistSidebarPrimaryInfoRenderer", "title"]),
    ) ||
    "Imported playlist";

  const list = findRenderer(data, "playlistVideoListRenderer", 16);
  const contents = get(list, ["contents"]);
  const tracks: ImportedRow[] = [];
  let tooLong = false;

  if (Array.isArray(contents)) {
    for (const entry of contents) {
      const vr = get(entry, ["playlistVideoRenderer"]) as
        | Record<string, unknown>
        | undefined;
      if (!vr) continue;
      const videoId = vr.videoId as string | undefined;
      if (!videoId) continue;

      const rawTitle =
        textOf(vr.title) || (get(vr, ["title", "simpleText"]) as string) || "";
      const title = cleanTrackTitle(rawTitle);
      if (!title) continue;

      const artist = firstCreatorName(
        title,
        get(vr, ["shortBylineText"]),
        get(vr, ["longBylineText"]),
        get(vr, ["shortBylineText", "runs", 0, "text"]),
      );
      if (artist === "Unknown artist") continue;

      const seconds = Number(vr.lengthSeconds);
      const duration =
        Number.isFinite(seconds) && seconds > 0
          ? seconds
          : parseLength(
              (get(vr, ["lengthText", "simpleText"]) as string) ||
                textOf(vr.lengthText) ||
                undefined,
            ) || undefined;

      tracks.push({ title, artist, duration });
      if (tracks.length > MAX_IMPORT_TRACKS) {
        tooLong = true;
        break;
      }
    }
  }

  const continuations = get(list, ["continuations"]);
  const continuation =
    (Array.isArray(continuations)
      ? continuations
          .map(
            (c) =>
              get(c, ["nextContinuationData", "continuation"]) as
                | string
                | undefined,
          )
          .find(Boolean)
      : undefined) ??
    (get(list, [
      "continuations",
      0,
      "reloadContinuationData",
      "continuation",
    ]) as string | undefined) ??
    undefined;

  return { name, tracks, continuation: continuation ?? null, tooLong };
}

/**
 * Read a public YouTube / YouTube Music playlist by id.
 *
 * `browseId` is the bare list id prefixed with "VL" for playlists, which is
 * how InnerTube addresses them. Long playlists are paged with the continuation
 * token so a 500-song list imports whole instead of stopping at the first
 * ~100 rows the response happens to carry.
 */
export const importPlaylistById = action({
  args: { playlistId: v.string() },
  handler: async (
    _ctx,
    { playlistId },
  ): Promise<{
    name: string;
    origin: string;
    tracks: ImportedRow[];
    partial: boolean;
  }> => {
    const id = playlistId.trim().replace(/^VL/, "");
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
      throw new ConvexError("That doesn't look like a YouTube playlist ID");
    }

    let data = await innerTube("browse", MUSIC_CLIENT, {
      context: clientContext(MUSIC_CLIENT),
      browseId: `VL${id}`,
    });
    const first = extractPlaylistBrowse(data);

    const tracks: ImportedRow[] = [...first.tracks];
    let continuation = first.continuation;
    let name = first.name;
    // Up to 4 extra pages (~500 rows) — enough for a real playlist without
    // letting a "mix everything" radio seed run forever.
    for (let page = 0; page < 4 && continuation; page++) {
      if (tracks.length >= MAX_IMPORT_TRACKS) break;
      try {
        data = await innerTube("browse", MUSIC_CLIENT, {
          context: clientContext(MUSIC_CLIENT),
          continuation,
        });
      } catch {
        break;
      }
      const next = extractPlaylistBrowse(data);
      if (next.name && next.name !== "Imported playlist") name = next.name;
      for (const row of next.tracks) {
        if (tracks.length >= MAX_IMPORT_TRACKS) break;
        const dupe = tracks.some(
          (t) => t.title === row.title && t.artist === row.artist,
        );
        if (!dupe) tracks.push(row);
      }
      continuation = next.continuation;
    }

    if (tracks.length === 0) {
      throw new ConvexError(
        "That playlist looks private, empty, or unavailable — try a public playlist link",
      );
    }

    return {
      name: name || "Imported playlist",
      origin: "YouTube Music",
      tracks,
      partial: tracks.length >= MAX_IMPORT_TRACKS,
    };
  },
});
