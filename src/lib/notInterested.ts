/**
 * "Not interested" — the PURE half.
 *
 * No Convex, no fetch, no React. This is the rule that decides whether a
 * candidate the listener has already rejected is allowed back into a
 * recommendation row, and it is here rather than inline in the action so it
 * can be tested exhaustively without a database.
 *
 * WHY A HARD FILTER AND NOT A PENALTY. A penalty would leave the rejected
 * artist at a lower rank — which, on a row that shows six items, is still
 * shown. Someone who says "I'm not interested in this artist" and keeps seeing
 * that artist has been told no and ignored, which is worse than the feature
 * not existing. So an exclusion removes the candidate outright.
 *
 * The one deliberate exception is documented on `filterExcluded` below.
 */

export interface Exclusions {
  /** Track ids the listener rejected. */
  trackIds: string[];
  /** Artist keys, already reduced by `normaliseArtist`. */
  artistKeys: string[];
}

/** An empty set, so callers never have to null-check. */
export const NO_EXCLUSIONS: Exclusions = { trackIds: [], artistKeys: [] };

/** Anything the filter needs to know about a candidate. */
export interface ExcludableCandidate {
  id: string;
  artist?: string;
}

/**
 * Reduce an artist string to a comparison key.
 *
 * Duplicated here from the server on purpose: this module is the one the
 * scoring pipeline imports, and the server needs the same rule. Both are
 * exercised by tests against the same table of cases, so a divergence shows up
 * as a failing test rather than as exclusions that quietly stop applying.
 *
 * Lowercase, diacritics removed, a leading "the " dropped, punctuation gone.
 * "Björk", "bjork" and "Björk (Official)" must all collapse to one key or the
 * exclusion misses on whichever source spelled it differently.
 *
 * The bracketed noise words matter more than they look. YouTube titles carry
 * "(Official)", "(Topic)", "(Lyrics)", "(HD)" and a trailing "Vevo" on a
 * startling share of results, and a listener who excludes an artist from a
 * YouTube row must not then be shown that same artist from Jamendo, because
 * one side of the match is "bjork" and the other is "bjorkofficial". These are
 * the same tokens `cleanArtistName` removes when rendering, deliberately
 * mirrored rather than reinvented.
 */
export function artistKey(raw: string | null | undefined): string {
  if (!raw) return "";
  return (
    raw
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      // Bracketed qualifiers: "(official)", "[topic]", "(lyrics)", "(hd 1080p)".
      .replace(
        /(?:\(|\[)\s*(?:official|topic|audio|video|lyrics?|visualizer|hd|hq|remaster(?:ed)?|explicit)\b[^)\]]*(?:\)|\])/g,
        " ",
      )
      .replace(/\s+(?:topic|vevo)\s*$/g, " ")
      .replace(/^the\s+/, "")
      .replace(/[^a-z0-9]+/g, "")
      // A trailing "vevo"/"topic" is GLUED to the name in real channel
      // titles — "TaylorSwiftVEVO" has no space to match above, so removing
      // it only after punctuation is gone is what makes that channel compare
      // equal to "Taylor Swift". Without this, one source's spelling of an
      // artist silently escapes an exclusion (or an anchor filter).
      .replace(/(?:vevo|topic)$/, "")
  );
}

/** Is this one candidate excluded? */
export function isExcluded(
  candidate: ExcludableCandidate,
  exclusions: Exclusions | null | undefined,
): boolean {
  if (!exclusions) return false;
  if (candidate.id && exclusions.trackIds.includes(candidate.id)) return true;
  const key = artistKey(candidate.artist);
  return !!key && exclusions.artistKeys.includes(key);
}

/**
 * Drop every excluded candidate from a pool.
 *
 * THE ONE EXCEPTION, and it is deliberate. If excluding an artist would empty
 * a row completely, the row is returned UNTOUCHED rather than hidden. A
 * listener who blocks one artist and then finds Home has quietly lost a whole
 * section — or, worse, a brand-new account that has not indexed anything yet
 * gets an app that looks broken — has learned that "not interested" is a tool
 * for deleting features. Refusing to filter is the recoverable failure;
 * silently removing the product's main surface is not.
 *
 * With nothing excluded, the input is returned as-is, so the common case costs
 * one pass and allocates nothing.
 *
 * Use this when the result becomes something the listener SEES. For deciding
 * whether to add candidates to a pool, use `rejectExcluded` instead — see the
 * note there, because applying this function to that case reintroduces exactly
 * the bug it is designed to prevent.
 */
export function filterExcluded<T extends ExcludableCandidate>(
  candidates: T[],
  exclusions: Exclusions | null | undefined,
): T[] {
  if (!exclusions) return candidates;
  const hasTrack = exclusions.trackIds.length > 0;
  const hasArtist = exclusions.artistKeys.length > 0;
  if (!hasTrack && !hasArtist) return candidates;

  const kept = candidates.filter((c) => !isExcluded(c, exclusions));
  return kept.length > 0 ? kept : candidates;
}

/**
 * The same filter, but it is allowed to return nothing.
 *
 * This exists because the empty-row safety in `filterExcluded` is correct for a
 * rendered row and actively WRONG for a merge. Measured: with a single
 * incoming sound-alike by a rejected artist, `filterExcluded` sees an empty
 * result, concludes "filtering would empty this, so don't", and hands the
 * rejected artist straight back. One candidate is the worst possible number —
 * it is exactly the case where the safety misfires.
 *
 * The asymmetry is intentional and load-bearing:
 *   - "Should this ROW still be shown?"  -> `filterExcluded` (prefer a row the
 *     listener scrolls past over a section that vanished).
 *   - "Should these CANDIDATES be added?" -> `rejectExcluded` (a rejected
 *     artist must never be added, and an empty result simply means the merge
 *     is declined, leaving the pool untouched).
 */
export function rejectExcluded<T extends ExcludableCandidate>(
  candidates: T[],
  exclusions: Exclusions | null | undefined,
): T[] {
  if (!exclusions) return candidates;
  const hasTrack = exclusions.trackIds.length > 0;
  const hasArtist = exclusions.artistKeys.length > 0;
  if (!hasTrack && !hasArtist) return candidates;
  return candidates.filter((c) => !isExcluded(c, exclusions));
}
