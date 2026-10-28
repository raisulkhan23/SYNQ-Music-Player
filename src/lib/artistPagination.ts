import {
  isEndMessage,
  parseReleaseGrid,
  type BrowseRelease,
  type BrowseTrack,
} from "./musicBrowse";

/**
 * Following an artist's discography to its actual end.
 *
 * The provider answers a release grid with up to a page of releases plus a
 * continuation token. Stopping at a fixed page count is how a discography
 * became "the first N releases": the page is honest about the rows it has, but
 * it is not the catalogue. These readers follow the token until the provider
 * says there is nothing left, with a hard ceiling that exists only to stop a
 * malformed, self-repeating token from looping forever.
 *
 * Kept dependency-free and free of Convex context so the paging rules can be
 * tested against fake pages instead of the live provider.
 */

/** Safety ceiling on release-grid pages for one artist, not a display limit. */
export const MAX_RELEASE_PAGES = 24;

/** Safety ceiling on one release's tracklist pages. */
export const MAX_TRACKLIST_PAGES = 24;

export interface ReleaseGridRead {
  releases: BrowseRelease[];
  /** The provider ended the list (not just "we stopped"). */
  complete: boolean;
  /** Requests made, including the first page. */
  pages: number;
}

/**
 * Read one release grid from its first page to the end.
 *
 * `complete: false` means the ceiling was hit with the provider still offering
 * more — the caller must surface that rather than presenting a partial list as
 * the whole discography.
 */
export async function readReleaseGrid(
  fetchFirst: () => Promise<unknown>,
  fetchContinuation: (cursor: string) => Promise<unknown>,
  maxPages: number = MAX_RELEASE_PAGES,
): Promise<ReleaseGridRead> {
  const releases: BrowseRelease[] = [];
  const seen = new Set<string>();
  const seenCursors = new Set<string>();
  let pages = 0;

  const collect = (page: unknown): void => {
    for (const release of parseReleaseGrid(page).releases) {
      if (seen.has(release.id)) continue;
      seen.add(release.id);
      releases.push(release);
    }
  };

  let page = await fetchFirst();
  pages += 1;
  for (;;) {
    // An end-of-list response carries a message and no rows. It is a real
    // answer, not a failed page.
    if (isEndMessage(page)) return { releases, complete: true, pages };
    collect(page);
    const cursor = parseReleaseGrid(page).nextCursor;
    if (!cursor) return { releases, complete: true, pages };
    // A token that repeats itself would fetch the same page forever.
    if (seenCursors.has(cursor)) return { releases, complete: false, pages };
    if (pages >= maxPages) return { releases, complete: false, pages };
    seenCursors.add(cursor);
    page = await fetchContinuation(cursor);
    pages += 1;
  }
}

/**
 * Read one release's complete tracklist.
 *
 * Same contract as the release grid: follow the token, stop on the provider's
 * end, and keep a ceiling for a malformed loop. Version differences survive
 * because identity is the provider's recording id (`videoId`), never the title:
 * a live take and the studio take are two rows, while the same recording seen
 * twice is one.
 */
export async function readTracklist(
  fetchPage: (args: {
    releaseId: string;
    cursor?: string;
  }) => Promise<{ tracks: BrowseTrack[]; nextCursor: string | null }>,
  releaseId: string,
  isCancelled: () => boolean,
  maxPages: number = MAX_TRACKLIST_PAGES,
): Promise<BrowseTrack[]> {
  const all: BrowseTrack[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    if (isCancelled()) return all;
    const result = await fetchPage({
      releaseId,
      ...(cursor ? { cursor } : {}),
    });
    all.push(...result.tracks);
    const next = result.nextCursor;
    if (!next) break;
    if (seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
  }

  const seen = new Set<string>();
  return all.filter((track) => {
    if (!track.videoId || seen.has(track.videoId)) return false;
    seen.add(track.videoId);
    return true;
  });
}
