// ---------------------------------------------------------------------------
// THE one rule about what may enter a playback queue.
//
// WHY THIS FILE EXISTS. SYNQ kept three different answers to "is this a real
// song?" in three places, and they could disagree:
//
//  - a playlist row with a snapshot and a CORRUPTED (or synthetic) `youtubeId`
//    looked playable, was accepted by the player, produced no sound at all,
//    and still advanced the queue and wrote the play to listening history;
//  - the shuffle path fell back to picking row `i` and played whatever it
//    landed on, including an imported row that had never been matched;
//  - everything in `playlists.trackSnapshots` looked alike, so nothing
//    distinguished "a verified recording" from "metadata looking for one".
//
// An imported playlist is METADATA. Importing 107 song names says nothing
// about whether SYNQ can play those 107 songs — so a row is only ever handed
// to the player when something VERIFIED is behind it: a well-formed YouTube
// video id, a real stream URL, or a downloaded local copy.
//
// Pure: no DOM, no network, no store — so the rule is executable in a test
// rather than described in a comment. The import/repair lifecycle lives in
// `ImportSection`/`resolveImported`; this file only decides what those rows
// are allowed to DO. (A title alone is never enough, and neither is an
// arbitrary `id`: a synthetic `import:<origin>|…` key identifies a
// spreadsheet row, not a recording.)
// ---------------------------------------------------------------------------

/** A YouTube video id is exactly 11 URL-safe base64 characters. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Hosts and schemes that the `<audio>` element can genuinely stream.
 *
 * Kept as a list rather than a regex alternation so the reason a URL counts is
 * readable at the call site. `blob:` is the OPFS copy of a downloaded track
 * and is as playable as any network URL; `"stream"` is the app's own
 * single-audio-deck placeholder for "resolve it live".
 */
const STREAM_MARKERS = [
  "audio-proxy",
  "googlevideo",
  "videoplayback",
  "piped",
  "odycdn",
];

/** True when a URL is something the audio element can actually stream. */
export function isStreamUrl(url: string | null | undefined): boolean {
  if (typeof url !== "string") return false;
  const value = url.trim();
  if (!value) return false;
  if (value === "stream") return true;
  if (value.startsWith("blob:")) return true;
  if (STREAM_MARKERS.some((marker) => value.includes(marker))) return true;
  // A non-YouTube direct URL (a catalog track) also plays via the element.
  return /^https?:\/\/.+\.(mp3|m4a|aac|ogg|opus|wav|flac|webm|mp4)(\?|$)/i.test(
    value,
  );
}

/** The fields the rule reads. Deliberately structural, not a named class. */
export interface PlaybackCandidate {
  id?: string | null;
  /** The verified playable id. Absent on a metadata-only imported row. */
  youtubeId?: string | null;
  /** A direct stream URL, when the track has one. */
  audioUrl?: string | null;
  title?: string | null;
}

/**
 * Can this track enter a playback queue?
 *
 * Returns false unless there is a VERIFIED playable source behind the row.
 * The check order matters: a nameless row is not a song (the player's own
 * rendering relies on a title being present), and a malformed id is not a
 * recording — trusting a string to be a video id is what produced the
 * "looks playable, plays nothing" rows this rule exists to stop.
 */
export function isPlayable(
  candidate: PlaybackCandidate | null | undefined,
): boolean {
  if (!candidate) return false;
  if (typeof candidate.title === "string" && !candidate.title.trim()) {
    return false;
  }
  if (isStreamUrl(candidate.audioUrl ?? undefined)) return true;
  return VIDEO_ID_RE.test(String(candidate.youtubeId ?? "").trim());
}

/**
 * Keep only the playable entries, preserving order.
 *
 * `select` exists so this can be applied to rows whose playable fields live
 * somewhere other than the top level, without every caller re-implementing
 * the projection (and getting it subtly different).
 */
export function filterPlayable<T>(
  items: readonly T[],
  select: (
    item: T,
  ) => PlaybackCandidate | null | undefined = (item) =>
    item as unknown as PlaybackCandidate,
): T[] {
  const out: T[] = [];
  for (const item of items) {
    if (isPlayable(select(item))) out.push(item);
  }
  return out;
}
