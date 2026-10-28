/**
 * The questions worth asking the provider about one artist.
 *
 * Kept free of imports on purpose: `src/convex/youtube.ts` bundles this file,
 * and Convex functions can only rely on plain relative modules — importing the
 * `@/`-aliased YouTube helpers from here would drag the whole browser-side
 * metadata layer into the server bundle.
 *
 * A single search shelf is roughly twenty rows, so one query can never be an
 * artist's catalogue. Each entry below is a DIFFERENT question; the first is
 * the plain artist name, whose order is the provider's own ranking and is what
 * the Popular section is drawn from. Nothing here promises that every real
 * release is reachable — only that we stop asking one question and pretending
 * the answer was everything.
 */

/** How many rows the Popular section shows before All songs takes over. */
export const POPULAR_LIMIT = 10;

/**
 * How many provider queries one catalogue page runs.
 *
 * Three is a deliberate ceiling: these run sequentially against an upstream
 * that answers a burst with silence, so a page must stay short enough to finish
 * inside one request. Paging is what makes a larger catalogue reachable.
 */
export const CATALOG_PAGE_QUERIES = 3;

/** Pause between two catalogue queries — same reasoning as the repair path. */
export const CATALOG_QUERY_GAP_MS = 400;

/** The full, ordered query plan for one artist. */
export function catalogQueries(artist: string): string[] {
  const name = (artist ?? "").trim();
  if (!name) return [];
  return [
    name,
    `${name} songs`,
    `${name} top tracks`,
    `${name} albums`,
    `${name} singles`,
    `${name} EP`,
    `${name} live`,
    `${name} deluxe edition`,
    `${name} remix`,
    `${name} acoustic`,
    `${name} featuring`,
    `${name} compilation`,
  ];
}

/**
 * One page of that plan plus whether another page exists.
 *
 * `hasMore` comes from the plan itself, never from "the last page looked
 * short", so the UI can honestly say everything available has been loaded.
 */
export function catalogPage(
  artist: string,
  page: number,
): { queries: string[]; hasMore: boolean } {
  const plan = catalogQueries(artist);
  const safePage = Number.isFinite(page) ? Math.max(0, Math.floor(page)) : 0;
  const start = safePage * CATALOG_PAGE_QUERIES;
  const queries = plan.slice(start, start + CATALOG_PAGE_QUERIES);
  return { queries, hasMore: start + queries.length < plan.length };
}
