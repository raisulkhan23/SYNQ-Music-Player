/**
 * THE one rule about what may enter a playback queue.
 *
 * WHY THIS FILE EXISTS. SYNQ kept three different answers to "is this a real
 * song?" in three places, and they disagreed:
 *
 *  - the playlist detail screen built its "play all" queue from any row with a
 *    YouTube id, but its shuffle fell back to `rows[i]` and played whatever it
 *    landed on, including an imported row that had never been matched;
 *  - the recommendation engine received imported rows as ordinary queue
 *    candidates, because everything in `playlists.trackSnapshots` looked alike
 *    to it;
 *  - the player store accepted any object with a `youtubeId` field — which an
 *    imported row does not have, so it "played" a synthetic id like
 *    `import:spotify|bjork|...`, produced no sound at all, and still advanced
 *    the queue and wrote the play to listening history.
 *
 * An imported playlist is METADATA. `My Spotify Library` importing 107 song
 * names says nothing about whether SYNQ can play those 107 songs — Spotify's
 * API has no audio endpoint for third-party apps, so each one is a separate
 * lookup, and some of them will never resolve. Treating "a row exists in the
 * database" as "a song can be played" is what turned a metadata import into a
 * queue full of silence and a shuffle that skipped through it.
 *
 * So: one predicate, one status vocabulary, used by every caller. Pure, with no
 * DOM, no network and no store, so the rule is executable in a test rather than
 * described in a comment.
 */

/**
 * Where a row is in the import/resolution lifecycle.
 *
 * These are deliberately NOT one boolean. "We have not looked yet", "we looked
 * and there are several plausible matches", "we looked and there is nothing"
 * and "the lookup broke" need to be told apart, because they lead to different
 * actions and different words on screen — and because a single `loading` flag
 * is exactly how a playlist ends up stuck saying "Looking up artwork and track
 * lengths…" for ever. A flag with no terminal state has no way to finish.
 */
export type TrackStatus =
  /** Imported, not looked up yet. Retryable, and free to retry. */
  | "pending"
  /** A lookup is in flight for this row right now. */
  | "resolving"
  /** Matched to a verified playable source. The ONLY status that plays. */
  | "playable"
  /** Several plausible matches; needs a human to choose. Never auto-played. */
  | "ambiguous"
  /** Looked up and no playable source exists for this song. */
  | "unavailable"
  /** Metadata is real and useful, but there is no verified audio source. */
  | "metadata_only"
  /** The lookup itself failed (network, rate limit, timeout). Retryable. */
  | "failed";

/** Statuses that may never enter a queue, a shuffle, radio or history. */
const UNPLAYABLE_STATUSES: ReadonlySet<TrackStatus> = new Set<TrackStatus>([
  "pending",
  "resolving",
  "ambiguous",
  "unavailable",
  "metadata_only",
  "failed",
]);

/**
 * Statuses worth trying again later. Everything else is a settled answer and
 * re-asking would only spend the upstream quota that the rows still open need.
 */
const RETRYABLE_STATUSES: ReadonlySet<TrackStatus> = new Set<TrackStatus>([
  "pending",
  "failed",
]);

export function isRetryableStatus(status: TrackStatus | null | undefined): boolean {
  return status === null || status === undefined
    ? true
    : RETRYABLE_STATUSES.has(status);
}

export function isUnplayableStatus(
  status: TrackStatus | null | undefined,
): boolean {
  return status !== null && status !== undefined && UNPLAYABLE_STATUSES.has(status);
}

/** A YouTube video id is exactly 11 URL-safe base64 characters. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Hosts and schemes that the `<audio>` element can genuinely stream.
 *
 * Kept as a list rather than a regex alternation so the reason a URL counts is
 * readable at the call site. `blob:` is the OPFS copy of a downloaded track and
 * is as playable as any network URL.
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
  /** Import lifecycle status. Absent on tracks that were never imported. */
  status?: TrackStatus | null;
}

/**
 * Can this track enter a playback queue?
 *
 * Returns false unless there is a VERIFIED playable source. A title alone is
 * never enough, and neither is an `id`: an imported row's id is a synthetic
 * `import:<origin>|…` key that identifies a spreadsheet row, not a recording.
 * Handing that to the player is the bug this predicate exists to stop — it
 * looks playable, it is accepted, and it produces silence.
 *
 * The status check comes first so a row that upstream answered "unavailable"
 * for can never be rescued by a stale id left on the document.
 */
export function isPlayable(candidate: PlaybackCandidate | null | undefined): boolean {
  if (!candidate) return false;
  if (isUnplayableStatus(candidate.status)) return false;
  if (typeof candidate.title === "string" && !candidate.title.trim()) {
    // A nameless row is not a song; the store's own idle checks rely on a
    // title being present to render anything at all.
    return false;
  }
  if (isStreamUrl(candidate.audioUrl ?? undefined)) return true;
  return VIDEO_ID_RE.test(String(candidate.youtubeId ?? "").trim());
}

/**
 * Keep only the playable entries, preserving order.
 *
 * `select` exists so this can be applied to rows whose playable fields live
 * somewhere other than the top level, without every caller re-implementing the
 * projection (and getting it subtly different).
 */
export function filterPlayable<T>(
  items: readonly T[],
  select: (item: T) => PlaybackCandidate | null | undefined = (item) =>
    item as unknown as PlaybackCandidate,
): T[] {
  const out: T[] = [];
  for (const item of items) {
    if (isPlayable(select(item))) out.push(item);
  }
  return out;
}

/** Counts for the honest import summary. All values are calculated. */
export interface EligibilitySummary {
  total: number;
  playable: number;
  /** Rows that still need a lookup: absent from the source of truth or pending. */
  unresolved: number;
  /** Rows upstream settled on and cannot play. */
  unavailable: number;
  /** Rows needing a human decision between several matches. */
  ambiguous: number;
}

export function summarizeEligibility(
  rows: readonly (PlaybackCandidate & { status?: TrackStatus | null })[],
): EligibilitySummary {
  let playable = 0;
  let unresolved = 0;
  let unavailable = 0;
  let ambiguous = 0;
  for (const row of rows) {
    if (isPlayable(row)) {
      playable += 1;
      continue;
    }
    if (row.status === "ambiguous") {
      ambiguous += 1;
      continue;
    }
    if (row.status === "unavailable" || row.status === "metadata_only") {
      unavailable += 1;
      continue;
    }
    // pending / resolving / failed / no status at all: still open, so it is
    // counted as work remaining rather than as a settled failure.
    unresolved += 1;
  }
  return { total: rows.length, playable, unresolved, unavailable, ambiguous };
}

/**
 * The status to store for a row, derived from what the last lookup found.
 *
 * Written in ONE place so the client and the backend cannot disagree about what
 * "answered with no match" means for a row's state.
 */
export function statusForLookup(input: {
  /** True when a confident match was found and written back. */
  matched: boolean;
  /** True when upstream answered at all (even with no usable match). */
  answered: boolean;
  /** True when the answer was an error rather than an empty result set. */
  errored?: boolean;
}): TrackStatus {
  if (input.matched) return "playable";
  if (input.errored) return "failed";
  // An answer with no confident match is a settled "we cannot play this".
  if (input.answered) return "unavailable";
  // Nothing came back at all: we are being throttled, or the network went away.
  // Deliberately NOT "unavailable" — that would mark a whole playlist finished
  // because one burst was rate-limited.
  return "pending";
}

/**
 * A plain sentence for the playlist header.
 *
 * The old text was one fixed global string shown whenever any row was
 * unfinished, which is why 107 unresolved songs read identically to 1 — and why
 * it looked stuck: nothing about it ever changed as work completed.
 */
export function describeProgress(summary: EligibilitySummary): string | null {
  const { total, playable, unresolved, unavailable, ambiguous } = summary;
  if (total === 0) return null;

  const parts: string[] = [];
  if (unresolved > 0) {
    const done = Math.max(0, total - unresolved);
    parts.push(`Resolving ${done} of ${total} tracks`);
  } else if (playable > 0) {
    parts.push(
      `${playable} playable ${playable === 1 ? "track" : "tracks"}`,
    );
  }

  const attention = unavailable + ambiguous;
  if (attention > 0) {
    parts.push(ambiguous > 0 ? `${ambiguous} need a match` : `${attention} unavailable`);
  }
  if (parts.length === 0) return null;
  return parts.join(" · ");
}
