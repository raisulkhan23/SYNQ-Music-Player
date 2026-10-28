// Relative, not the `@/` alias: this module is imported by the Convex action
// beside it, and the Convex bundler does not resolve path aliases.
import type { ImportFailure } from "./importModel";

/**
 * Jamendo: SYNQ's one source of ACTUAL AUDIO.
 *
 * Every other catalog SYNQ reads — Spotify, Apple Music, Tidal — hands over
 * titles, artists and artwork and then refuses to hand over a single sample of
 * sound, so a track imported from any of them plays by resolving its title
 * against YouTube. Jamendo is different: it is a Creative Commons music
 * platform whose entire purpose is being embedded in other people's apps, and
 * it publishes a stream URL per track. That makes it the only provider here
 * that can be a real playback source rather than a metadata source.
 *
 * This file is PURE: no fetch, no env access, no Convex. The action in
 * `convex/jamendo.ts` does the I/O and the env read; everything here is
 * normalisation and error mapping, so the parts that are easy to get wrong
 * (a missing `audio` field, a single with no album, a quota wall) are unit
 * testable without a network or a key.
 */

/** Jamendo track ids are numeric strings; they are NOT the ids SYNQ queues on. */
export interface JamendoTrack {
  /** Jamendo's own id, used to build the share link and to de-duplicate. */
  jamendoId: string;
  title: string;
  artistName: string;
  /** Empty for a single — Jamendo leaves `album_name` blank, and inventing
   *  "Single" here would be a fabricated value (see `toPlayableYoutube`). */
  albumName: string;
  coverUrl: string;
  /** The stream URL. This is the whole reason this source exists. */
  audioUrl: string;
  /** Seconds. */
  duration: number;
  /** Creative Commons licence URL, verbatim from the API. Attribution is a
   *  licence condition, not a nicety, so it is carried rather than dropped. */
  licenseUrl: string;
  /** Genres/instruments/vartags, flattened. Feeds the vector DB. */
  tags: string[];
  /** Direct link to the track on Jamendo — where a listener goes to support
   *  the artist. */
  shareUrl: string;
  /**
   * Whether the ARTIST has released this track for download.
   *
   * This is the one flag in the whole app that can authorize a download, and
   * it used to be parsed straight off the API response and thrown away. Keeping
   * it is what lets the UI decide whether to offer a Download action at all;
   * the server still re-verifies it independently (see `convex/downloads.ts`),
   * because a client-side flag is a hint, never an authority.
   */
  downloadAllowed: boolean;
}

/** The shape Jamendo actually returns, after the envelope is unwrapped. */
interface RawTrack {
  id?: string | number;
  name?: string;
  artist_name?: string;
  album_name?: string;
  image?: string;
  album_image?: string;
  audio?: string;
  duration?: string | number;
  license_ccurl?: string;
  shareurl?: string;
  shorturl?: string;
  audiodownload_allowed?: boolean;
  musicinfo?: {
    tags?: { genres?: string[]; instruments?: string[]; vartags?: string[] };
  };
}

/**
 * Turn one raw track into a Playable-shaped candidate, or drop it.
 *
 * Returns null for anything that cannot actually be PLAYED. A Jamendo result
 * with no `audio` URL is worse than no result at all: it renders as a row the
 * user can click and then nothing happens, which reads as a broken player
 * rather than as an unavailable track. Dropping it keeps the list honest.
 */
export function normalizeTrack(raw: RawTrack): JamendoTrack | null {
  const id = raw.id == null ? "" : String(raw.id);
  const audio = typeof raw.audio === "string" ? raw.audio.trim() : "";
  if (!id || !audio) return null;
  // Defensive: only real http(s) stream URLs are ever handed to the <audio>
  // element, whatever the API claims.
  if (!/^https?:\/\//i.test(audio)) return null;

  const info = raw.musicinfo?.tags ?? {};
  const tags = [
    ...(info.genres ?? []),
    ...(info.instruments ?? []),
    ...(info.vartags ?? []),
  ]
    .map((t) => String(t).trim())
    .filter(Boolean);

  return {
    jamendoId: id,
    title: (raw.name ?? "").trim(),
    artistName: (raw.artist_name ?? "").trim(),
    albumName: (raw.album_name ?? "").trim(),
    // `image` is the album image for album tracks and always present; a single
    // has an empty `album_image`, so this is the correct field to prefer.
    coverUrl: (raw.image || raw.album_image || "").trim(),
    audioUrl: audio,
    duration: Math.max(0, Math.round(Number(raw.duration) || 0)),
    licenseUrl: (raw.license_ccurl ?? "").trim(),
    tags,
    shareUrl: (raw.shareurl || raw.shorturl || "").trim(),
    // Strictly `=== true`. An absent or non-boolean value means the provider did
    // not say yes, and "probably fine" is exactly the reasoning that turns a
    // licence boundary into a bug.
    downloadAllowed: raw.audiodownload_allowed === true,
  };
}

/**
 * Normalise a whole page, dropping unplayable rows and de-duplicating.
 *
 * The caller asks for `groupby=artist_id` so a search for "love" does not
 * return nine tracks by the same artist, but that is a hint and not a
 * guarantee, so the duplicate check is done here too — keyed on
 * artist+title+duration, because the same track legitimately appears once as a
 * single and once on an album.
 */
export function normalizeTracks(raws: unknown): JamendoTrack[] {
  if (!Array.isArray(raws)) return [];
  const seen = new Set<string>();
  const out: JamendoTrack[] = [];
  for (const raw of raws as RawTrack[]) {
    const track = normalizeTrack(raw ?? {});
    if (!track) continue;
    const key = `${track.artistName}|${track.title}|${track.duration}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(track);
  }
  return out;
}

/** Jamendo wraps every response in an envelope, and a failure is a 200. */
export interface JamendoEnvelope {
  headers?: {
    status?: string;
    code?: number | string;
    error_message?: string;
    results_count?: number;
  };
  results?: unknown[];
}

/**
 * Jamendo reports errors INSIDE a 200 response.
 *
 * This is the single most important thing to know about the API: an invalid
 * client_id, a rate-limit wall and a successful empty search all come back
 * with HTTP 200. Code that only checks `res.ok` sees a working integration
 * that silently returns nothing, forever. `unwrap` is where that is caught.
 */
export function unwrap(body: unknown): {
  ok: boolean;
  results: RawTrack[];
  failure: ImportFailure | null;
} {
  const env = (body ?? {}) as JamendoEnvelope;
  const headers = env.headers;
  // A MISSING envelope is a failure, not a success with no results.
  //
  // This is the subtle one. Defaulting `status` to "success" would make every
  // malformed, proxied or HTML-error body come back as a clean empty search —
  // which is precisely the silent-death failure this function exists to
  // prevent. Only an explicit `status: "success"` with `code: 0` is a success.
  const ok =
    !!headers &&
    headers.status === "success" &&
    String(headers.code ?? "0") === "0";

  if (!ok) {
    const raw = String(headers?.error_message ?? "").toLowerCase();
    // Jamendo's own message is the only signal here, so match on it rather
    // than guessing from a status code that is always 200.
    const looksLikeQuota =
      raw.includes("rate") ||
      raw.includes("quota") ||
      raw.includes("too many") ||
      raw.includes("limit");
    // No message at all means the body was not a Jamendo envelope — a proxy
    // error page, a truncated response, an HTML 200. That is a network-shaped
    // problem, so it must not be reported as "your API key is wrong".
    const unrecognisable = raw.length === 0;
    return {
      ok: false,
      results: [],
      failure: looksLikeQuota
        ? {
            code: "rate-limited",
            message: "Jamendo is rate-limiting this app right now.",
            retryable: true,
            hint: "Free Jamendo keys allow a limited number of calls per day. Try again in a few minutes.",
          }
        : unrecognisable
          ? networkFailure()
          : {
              code: "not-configured",
              message: "Jamendo rejected the app's API key.",
              retryable: false,
              hint: "Check JAMENDO_CLIENT_ID in your environment matches the app on devportal.jamendo.com.",
            },
    };
  }

  return {
    ok: true,
    results: (env.results ?? []) as RawTrack[],
    failure: null,
  };
}

/**
 * No API key: a first-class, actionable state rather than a raw 401.
 *
 * Same rule as the Tidal importer — a deployment without credentials has to
 * be able to say exactly which variable is missing, because nobody can guess.
 */
export function notConfiguredFailure(): ImportFailure {
  return {
    code: "not-configured",
    message: "Jamendo isn't connected to this deployment yet.",
    retryable: false,
    hint: "Add JAMENDO_CLIENT_ID (free, from devportal.jamendo.com) to the server environment.",
  };
}

/** A network failure, kept distinct from a quota wall. */
export function networkFailure(): ImportFailure {
  return {
    code: "network",
    message: "Couldn't reach Jamendo.",
    retryable: true,
    hint: "Check your connection and try again.",
  };
}

/** A 429 that arrived as a real HTTP status rather than an envelope. */
export function httpQuotaFailure(): ImportFailure {
  return {
    code: "rate-limited",
    message: "Jamendo is rate-limiting this app right now.",
    retryable: true,
    hint: "Free Jamendo keys allow a limited number of calls per day. Try again in a few minutes.",
  };
}

/** A search that legitimately matched nothing — not an error. */
export function emptyResult(): ImportFailure {
  return {
    code: "empty",
    message: "No Jamendo tracks matched that.",
    retryable: true,
    hint: "Try a genre, a mood, or an artist name.",
  };
}
