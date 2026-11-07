import {
  findContinuation,
  isEndMessage,
  parseReleaseGrid,
  parseReleaseTracks,
  type BrowseRelease,
  type BrowseTrack,
} from "./musicBrowse";

/**
 * Pure paging rules for the artist catalogue.
 *
 * The Convex action used to keep its own release-grid loop and the hook kept
 * its own tracklist loop. Two loops written at two different times drift: one
 * grows a dedupe set, the other forgets; one bounds its pages, the other trusts
 * the provider. Both loops must obey the SAME rules, and those rules must be
 * testable without a network — so they live here, as pure functions over an
 * injected "read one page" function.
 *
 * The injected reader is `(body) => Promise<page data>`: the Convex action
 * binds it to the rate-limited `browsePage`, tests bind it to fake pages.
 */

/** Hard cap on release-grid pages followed for one artist, per call. */
export const MAX_RELEASE_PAGES = 3;

/** Bounded: a malformed cursor that never advances must not loop forever. */
export const MAX_TRACKLIST_PAGES = 4;

/** Shape every read-page function must satisfy. */
export type ReadBrowsePage = (body: Record<string, unknown>) => Promise<unknown>;

/** Result of following one artist's release grid to its stated end. */
export interface ReleaseGridResult {
  releases: BrowseRelease[];
  /** Provider said there is nothing further. */
  complete: boolean;
  /** We stopped at the page cap with more still offered. */
  truncated: boolean;
  /** Provider requests made (for cache/diagnostics). */
  pages: number;
  /** True when the artist page exposed no release grid at all. */
  empty: boolean;
  /** Continuation tokens already followed, so a repeating token cannot loop. */
  seenCursors: string[];
}

/**
 * Follow an artist's release grid(s) page by page, deduplicating by release id.
 *
 * The artist page's carousels point at one combined grid (`MPAD…`) — albums
 * and "Singles & EPs" usually share it, and the `gridIds` set deduplicates
 * that. Paging stops on the first of: an explicit end-of-list message, a page
 * with no cursor, a page with no rows, or `MAX_RELEASE_PAGES`.
 */
export async function readReleaseGrid(
  readPage: ReadBrowsePage,
  gridIds: string[],
): Promise<ReleaseGridResult> {
  const releases: BrowseRelease[] = [];
  const seen = new Set<string>();
  const seenCursors: string[] = [];
  let truncated = gridIds.length > 0;
  let pages = 0;

  for (const gridId of gridIds) {
    let page: unknown = await readPage({ browseId: gridId });
    pages += 1;
    for (;;) {
      const parsed = parseReleaseGrid(page);
      for (const release of parsed.releases) {
        if (seen.has(release.id)) continue;
        seen.add(release.id);
        releases.push(release);
      }
      const cursor = parsed.nextCursor;
      if (!cursor || seenCursors.includes(cursor) || pages >= MAX_RELEASE_PAGES) {
        // Either the provider has nothing left (its continuation answers with
        // an end-of-list message) or we stopped at the cap.
        if (!cursor || seenCursors.includes(cursor)) truncated = false;
        break;
      }
      seenCursors.push(cursor);
      page = await readPage({ continuation: cursor });
      pages += 1;
      if (isEndMessage(page)) {
        truncated = false;
        break;
      }
      const nextPage = parseReleaseGrid(page);
      if (nextPage.releases.length === 0) {
        truncated = false;
        break;
      }
    }
  }

  // The stated end: the provider said there is nothing further.
  const stated: ReleaseGridResult = {
    releases,
    complete: true,
    truncated: false,
    pages,
    /** True when the artist page exposed no release grid at all. */
    empty: releases.length === 0,
    seenCursors,
  };
  if (truncated) {
    // We stopped at the page cap with more still offered — the one state
    // that must never be presented as complete.
    return { ...stated, complete: false, truncated: true };
  }
  return stated;
}

/** Result of following one release's tracklist to its stated end. */
export interface TracklistResult {
  tracks: BrowseTrack[];
  /** Cursor to continue from, or null when the provider (honestly) ended. */
  nextCursor: string | null;
  /** Provider requests made. */
  pages: number;
  /** True when we stopped at MAX_TRACKLIST_PAGES with a cursor still offered. */
  truncated: boolean;
  /** Continuation tokens already followed. */
  seenCursors: string[];
}

/**
 * Follow one release's tracklist through its continuation tokens.
 *
 * `readPage` receives `{ browseId }` for the first call and `{ continuation }`
 * for every later one — the same shapes the Convex `releaseTracks` action
 * accepts. A token that repeats (a provider quirk) is treated as the end
 * rather than as a new page, so a broken cursor cannot loop forever.
 */
export async function readTracklistPages(
  readPage: ReadBrowsePage,
  releaseId: string,
): Promise<TracklistResult> {
  const tracks: BrowseTrack[] = [];
  const seenCursors: string[] = [];
  let truncated = false;
  let pages = 0;
  let cursor: string | null = null;

  for (;;) {
    const page: unknown = cursor
      ? await readPage({ continuation: cursor })
      : await readPage({ browseId: releaseId });
    pages += 1;
    const parsed = parseReleaseTracks(page);
    tracks.push(...parsed.tracks);
    // An end-of-list message carries no rows and no cursor: report the list
    // as finished instead of pointing at a page that will never arrive.
    const next = parsed.tracks.length === 0 ? null : findContinuation(page);
    if (!next || seenCursors.includes(next) || pages >= MAX_TRACKLIST_PAGES) {
      if (next && seenCursors.includes(next)) {
        truncated = false; // repeating token — treat as the end, not a cap hit
      } else if (next && pages >= MAX_TRACKLIST_PAGES) {
        truncated = true;
      }
      cursor = null;
      break;
    }
    seenCursors.push(next);
    cursor = next;
  }

  const seen = new Set<string>();
  return {
    tracks: tracks.filter((track) => {
      if (!track.videoId || seen.has(track.videoId)) return false;
      seen.add(track.videoId);
      return true;
    }),
    nextCursor: cursor,
    pages,
    truncated,
    seenCursors,
  };
}
