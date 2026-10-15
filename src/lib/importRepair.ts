/**
 * Repairing imported playlists — PURE decision logic.
 *
 * WHY THIS FILE EXISTS. A playlist imported from Spotify/Apple/Tidal lands in
 * the library as title + artist and nothing else. The detail screen rendered
 * exactly that, so every imported playlist looked broken in the same three
 * ways: an empty black box where the cover art goes, `0:00` where the length
 * goes, and a row that could not be played without a search. 107 songs, 107
 * black boxes.
 *
 * Two separate causes, and this module owns the second one:
 *
 *  1. `saveImported` wrote `coverUrl: ""` unconditionally, discarding artwork
 *     the importers had already normalised. Fixed where the data is written.
 *
 *  2. Playlists imported BEFORE that still have no cover and no duration in
 *     the database, and no migration is going to conjure artwork for a
 *     catalogue entry we only know the name of. The only honest source for a
 *     real cover, a real length and a real playable id is the song itself, so
 *     SYNQ looks it up — `title artist` on YouTube — and writes back what it
 *     actually found. Nothing is invented: a row that cannot be matched keeps
 *     its honest "unknown" state.
 *
 * The rule this module enforces, and the reason it is worth its own file:
 * a repair is applied only when the match is genuinely the same song. A wrong
 * cover and a wrong length on a row that also plays the wrong song is worse
 * than the black box, because it looks fixed.
 *
 * PURE, so the whole decision is testable without a browser, a network or a
 * deployment.
 */

import { matchScore } from "./playbackFallback";
import { isRetryableStatus, type TrackStatus } from "./eligibility";

/** One row of an imported playlist, as stored on the playlist document. */
export interface ImportedRow {
  id: string;
  title: string;
  artist: string;
  coverUrl: string;
  duration: number;
  youtubeId?: string;
  /** Import lifecycle status. See `lib/eligibility`. */
  status?: TrackStatus;
}

/**
 * The fields `mergeRepairs` reads off a stored row — and no more.
 *
 * `status` is a plain string here on purpose. A playlist document keeps
 * whatever an older or newer build wrote onto `trackSnapshots` (see
 * `convex/schema.ts`), so a signature demanding the `TrackStatus` union would
 * refuse the very rows this function exists to repair. `ImportedRow`, whose
 * status IS the union, stays assignable, so the client-side callers keep their
 * narrowing.
 */
export interface RepairableRow {
  id: string;
  coverUrl: string;
  duration: number;
  youtubeId?: string;
  status?: string;
}

/** A YouTube search result, reduced to the fields a repair can use. */
export interface RepairCandidate {
  id: string;
  title: string;
  artist: string;
  duration: number;
  thumbnail: string;
}

/** What a successful match writes back onto the playlist. */
export interface RepairResult {
  id: string;
  youtubeId: string;
  duration: number;
  thumbnail: string;
}

/**
 * Below this the result is a different song that happens to share a name.
 * Same threshold the discovery resolver uses, and for the same reason: the
 * listener hears music and concludes the app worked.
 */
export const MIN_REPAIR_MATCH = 0.5;

/**
 * How much better the winner must be than the runner-up before it is allowed to
 * be applied without asking.
 *
 * A remix, a live version and the studio cut of one song all score within a few
 * hundredths of each other, and picking between them by a rounding difference is
 * exactly how an import "succeeds" and plays the wrong recording. When two
 * candidates are this close the row is left AMBIGUOUS and a human chooses.
 */
export const AMBIGUOUS_MATCH_MARGIN = 0.12;

/** How many alternatives an ambiguous row offers to choose between. */
export const MAX_MATCH_CANDIDATES = 4;

/**
 * Confidence-ranked candidates for one row, strongest first.
 *
 * Deterministic: ties break on the candidate's own id, so repeating the same
 * import cannot produce a different ordering and therefore cannot produce a
 * different automatic match.
 */
export function rankRepairCandidates(
  row: Pick<ImportedRow, "title" | "artist">,
  candidates: readonly RepairCandidate[],
): Array<{ candidate: RepairCandidate; score: number }> {
  const scored: Array<{ candidate: RepairCandidate; score: number }> = [];
  for (const candidate of candidates) {
    if (!candidate?.id) continue;
    // No length means the repair cannot fix the very thing it was called to
    // fix, and an unidentified upload is not something we can write back.
    if (!candidate.duration || candidate.duration <= 0) continue;
    scored.push({
      candidate,
      score: matchScore(
        { title: row.title, artist: row.artist },
        { title: candidate.title, artist: candidate.artist },
      ),
    });
  }
  return scored.sort(
    (a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id),
  );
}

/**
 * Whether the best candidate is clear enough to apply on its own.
 *
 * Returns the winner, or null when the row needs a human: nothing confident
 * enough, or two confident candidates too close to separate.
 */
export function decideRepair(
  row: Pick<ImportedRow, "title" | "artist">,
  candidates: readonly RepairCandidate[],
):
  | { outcome: "match"; candidate: RepairCandidate }
  | { outcome: "ambiguous" }
  | { outcome: "none" } {
  const ranked = rankRepairCandidates(row, candidates);
  const best = ranked[0];
  if (!best || best.score < MIN_REPAIR_MATCH) return { outcome: "none" };
  const runnerUp = ranked[1];
  if (
    runnerUp &&
    runnerUp.score >= MIN_REPAIR_MATCH &&
    best.score - runnerUp.score < AMBIGUOUS_MATCH_MARGIN
  ) {
    return { outcome: "ambiguous" };
  }
  return { outcome: "match", candidate: best.candidate };
}

/**
 * How many tracks one server call may look up.
 *
 * Bounded because each track is a full YouTube search: unbounded means one
 * request fans out into hundreds and is killed by the caller's timeout,
 * which loses the whole batch including the repairs that already succeeded.
 */
export const REPAIR_BATCH_SIZE = 6;

/**
 * How many batches the client keeps in flight.
 *
 * ONE, and this is measured rather than cautious. Live against the
 * deployment, two InnerTube searches issued at the same time come back
 * `{"items": []}` while the identical two queries run one after the other
 * return full result sets. YouTube throttles the burst, so every concurrent
 * batch resolves nothing — which is indistinguishable from "this song does
 * not exist" and leaves the playlist permanently unrepaired while looking
 * like the repair is working.
 */
export const REPAIR_CONCURRENCY = 1;

/**
 * Pause between the searches inside one repair pass, in milliseconds.
 *
 * Measured, and the number is a floor rather than a guess. YouTube throttles
 * this IP: repeated bursts come back with `{"items": []}` instead of an
 * error, so a repair pass that keeps hammering it both fails to repair
 * anything AND degrades the listener's own searches. A slow, self-limiting
 * pass is the only honest option.
 */
export const REPAIR_SEARCH_GAP_MS = 3_000;

/**
 * How many times one row may be searched within a single pass.
 *
 * Roughly half of all searches from this IP come back empty regardless of
 * pacing, and the empties are not the same rows twice — so a second attempt
 * after a pause recovers most of what the first one lost. Three is where the
 * curve flattens; beyond that the pass is just taking up someone's quota.
 */
export const REPAIR_SEARCH_ATTEMPTS = 3;

/**
 * How many batches one visit will run.
 *
 * A 107-track playlist is 18 batches. Eight is a deliberate ceiling: enough
 * to visibly fix a playlist in the background, few enough that opening one
 * page never turns into two minutes of upstream traffic.
 */
export const REPAIR_MAX_PASSES = 8;

/**
 * Consecutive passes that returned nothing before the pass gives up.
 *
 * Two in a row is treated as "we are being throttled" rather than "these
 * songs do not exist", and the pass stops instead of continuing to hammer an
 * upstream that has already said no. The next visit picks up where this one
 * stopped, because repaired rows drop out of the backlog on their own.
 */
export const REPAIR_EMPTY_STREAK_LIMIT = 2;

/**
 * True when this row is still worth looking up.
 *
 * Any one of the three missing fields is enough. A row with a `youtubeId` but no
 * cover still renders a black box, and a row with a cover but no length still
 * shows `0:00` — so this is deliberately not "is it playable".
 *
 * THE STATUS CHECK IS BUG FIX, NOT A REFINEMENT. Without it a row that upstream
 * had already answered — "no such song", "no confident match", "this is a
 * remix and there are four of them" — counted as unfinished for ever, so the
 * playlist re-searched the same fifty rows on every single visit, the header
 * announced "Looking up artwork and track lengths…" for ever, and the pass that
 * should have moved on to the rest of the list never did. A settled answer is
 * not a pending question.
 */
export function needsRepair(row: ImportedRow): boolean {
  if (!row.title.trim()) return false;
  if (!isRetryableStatus(row.status)) return false;
  // "Already has a source" is a PRESENCE check, not `isPlayable`.
  //
  // The two are not the same question and conflating them broke this function's
  // contract: `isPlayable` also validates that an id LOOKS like a video id, so a
  // row carrying a source this build does not recognise — a provider id, a
  // legacy id, anything that is not 11 base64 characters — would have been
  // declared unplayable and routed straight back into the search queue on every
  // visit, for ever, next to a row that already has a working stream. Presence
  // is what this function is about: does it have a source, a cover and a
  // length? Whether that source is playable is `isPlayable`'s question, asked
  // at the queue boundary where the answer actually decides something.
  if (row.youtubeId?.trim()) {
    // Has a source: only the presentation fields can still be missing.
    return !row.coverUrl?.trim() || !(row.duration > 0);
  }
  return true;
}

/** What to search YouTube for. Artist omitted when the import had none. */
export function repairQuery(
  row: Pick<ImportedRow, "title" | "artist">,
): string {
  return `${row.title} ${row.artist ?? ""}`.replace(/\s+/g, " ").trim();
}

/**
 * The upload that is actually this row's song, or null.
 *
 * Returns null rather than the best available result: a cover from a
 * different song, a length from a different song and audio from a different
 * song is a row that lies convincingly, which is the failure mode this whole
 * repair is meant to remove.
 */
export function pickRepair(
  row: Pick<ImportedRow, "title" | "artist">,
  candidates: readonly RepairCandidate[],
): RepairCandidate | null {
  const decision = decideRepair(row, candidates);
  return decision.outcome === "match" ? decision.candidate : null;
}

/**
 * Fold repairs into a playlist's snapshots.
 *
 * Additive only. A repair never overwrites a field that already holds a real
 * value, so a partially-completed repair pass can be re-run safely and a
 * late-arriving search result cannot blank out good data.
 *
 * Returns the SAME array reference when nothing changed, which is what lets
 * the mutation skip the write (and the re-render) entirely.
 */
export function mergeRepairs<T extends RepairableRow>(
  snapshots: readonly T[],
  repairs: readonly RepairResult[],
): T[] {
  if (repairs.length === 0) return snapshots as T[];
  const byId = new Map(repairs.map((repair) => [repair.id, repair]));
  let changed = false;
  const next = snapshots.map((snapshot) => {
    const repair = byId.get(snapshot.id);
    if (!repair) return snapshot;
    const coverUrl = snapshot.coverUrl?.trim()
      ? snapshot.coverUrl
      : repair.thumbnail;
    const duration =
      snapshot.duration > 0 ? snapshot.duration : repair.duration;
    const youtubeId = snapshot.youtubeId ?? repair.youtubeId;
    if (
      coverUrl === snapshot.coverUrl &&
      duration === snapshot.duration &&
      youtubeId === snapshot.youtubeId
    ) {
      return snapshot;
    }
    changed = true;
    return { ...snapshot, coverUrl, duration, youtubeId } as T;
  });
  return changed ? next : (snapshots as T[]);
}

/**
 * The next slice of rows worth looking up.
 *
 * Called repeatedly by the client as repairs land, so it has to be a pure
 * function of the CURRENT rows: rows already repaired drop out on their own
 * and the pass terminates without a cursor to keep in sync.
 */
export function nextRepairBatch(
  rows: readonly ImportedRow[],
  size = REPAIR_BATCH_SIZE,
): ImportedRow[] {
  return rows.filter(needsRepair).slice(0, Math.max(1, size));
}

/** True when there is nothing left to look up. */
export function repairComplete(rows: readonly ImportedRow[]): boolean {
  return rows.every((row) => !needsRepair(row));
}

/** Count of rows the library is still missing artwork, length or a video id. */
export function repairBacklog(rows: readonly ImportedRow[]): number {
  return rows.reduce((total, row) => total + (needsRepair(row) ? 1 : 0), 0);
}

/**
 * Split the outstanding rows into the batches one pass will look up.
 *
 * `concurrency` is 1 by default and that is deliberate — see
 * `REPAIR_CONCURRENCY`. It stays a parameter so the splitting logic is
 * testable at any width, and so a future transport that CAN parallelise
 * without being throttled has one line to change.
 */
export function chunkRepairBatches(
  rows: readonly ImportedRow[],
  size = REPAIR_BATCH_SIZE,
  concurrency = REPAIR_CONCURRENCY,
): ImportedRow[][] {
  const batches: ImportedRow[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    batches.push(rows.slice(i, i + size));
    if (batches.length >= Math.max(1, concurrency)) break;
  }
  return batches;
}
