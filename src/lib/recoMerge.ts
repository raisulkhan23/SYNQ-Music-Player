/**
 * Candidate-pool operations for the recommender — PURE.
 *
 * These two operations are the whole of what the recommender does with its new
 * inputs, and they live here, outside the Convex action, for a specific
 * reason: the action cannot be driven in a test.
 *
 * `src/convex/_generated/api` resolves every function through a deep proxy that
 * returns a NEW proxy on every property access, so `api.x.y === api.x.y` is
 * false and there is no property that yields a readable path. A stub therefore
 * cannot tell "searchYoutube" from "vectorCandidates" by identity or by name.
 * Replacing the module with a mock does not help either: measured, it makes the
 * handler return an empty payload without making a single call, so a test built
 * on it asserts nothing at all.
 *
 * So the logic is factored out where it can actually be executed. These
 * functions are called by `forYou` and `nextTrack`; the tests run the same code
 * the app runs.
 */

import {
  filterExcluded,
  rejectExcluded,
  type Exclusions,
} from "./notInterested";
import type { RecoCandidate } from "./recommend";

/** The minimum a candidate needs for these operations. */
type PoolItem = Pick<RecoCandidate, "id" | "artist">;

/**
 * Drop every excluded candidate from a pool.
 *
 * Thin on purpose: all the interesting behaviour — including the deliberate
 * refusal to empty a row — lives in `filterExcluded`, which is tested
 * directly. This exists so the action has one obvious call site.
 */
export function applyExclusions<T extends PoolItem>(
  items: T[],
  exclusions: Exclusions | null | undefined,
): T[] {
  return filterExcluded(items, exclusions);
}

/**
 * Merge extra candidates in, or decline to touch the pool at all.
 *
 * Returns null when there is nothing worth adding. That is the important part:
 * when the vector index is cold, `forYou` must not rewrite its pool with an
 * empty merge, and must not emit a "Sounds like what you play" row that is
 * quietly filled with the text-search results it was supposed to replace.
 *
 * Exclusions are applied to the INCOMING candidates only, and STRICTLY. The
 * existing pool has already been filtered by the caller, so re-filtering it
 * here would let the empty-row safety fire against a pool this function does
 * not own — and with a single incoming candidate, that safety hands a rejected
 * artist straight back. See `rejectExcluded`.
 */
export function mergeExtra<T extends PoolItem>(
  pool: T[],
  extra: T[],
  exclusions: Exclusions | null | undefined,
): { pool: T[]; added: number; usable: T[] } | null {
  const usable = rejectExcluded(extra, exclusions);
  if (usable.length === 0) return null;
  return { pool: [...pool, ...usable], added: usable.length, usable };
}

/** Every id in a pool, for callers that need to check membership. */
export function poolIds<T extends PoolItem>(pool: T[]): Set<string> {
  return new Set(pool.map((item) => item.id));
}
