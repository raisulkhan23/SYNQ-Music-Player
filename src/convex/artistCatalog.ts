import { ConvexError, v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { TTL, cacheKey, dedupeRequest, takeRateSlot } from "./providerCache";
import { browseMusic, searchMusicArtists } from "./youtube";
import {
  parseAlbumMeta,
  parseArtistHeader,
  parseArtistSearch,
  parseReleaseTracks,
  type BrowseRelease,
  type BrowseTrack,
} from "../lib/musicBrowse";
import { MAX_RELEASE_PAGES, readReleaseGrid } from "../lib/artistPagination";

/**
 * The artist catalogue, from the endpoint that actually has one.
 *
 * WHY THIS EXISTS
 * ---------------
 * `searchYoutube` answers "what are the most relevant recordings for this
 * string". Its shelf holds roughly twenty rows, its order is a popularity
 * blend, and it exposes no albums, no release types and no tracklists. The
 * artist page was built on it, so "the artist" was really "ten search rows" —
 * for an artist like Taylor Swift that is a rounding error against a
 * discography of albums, singles, EPs, live records and re-recordings.
 *
 * YouTube Music's `browse` endpoint is a different question with a different
 * answer:
 *
 *   browse(MPAD<artistId>)  → the artist's release grid (albums AND singles,
 *                             up to 100 in one page, each with `MPREb_…` ids,
 *                             a provider type and a year)
 *   browse(MPREb_…)         → that release's complete tracklist
 *   browse(continuation)    → the next page, when there is one
 *
 * Everything below is cached, rate-limited and de-duplicated through the same
 * `providerCache` primitives search already uses, so a discography costs one
 * request per release *ever*, not one per visit.
 *
 * HONESTY RULES
 * -------------
 * - The provider may genuinely stop: the release grid's continuation answers
 *   with an end-of-list message. That is reported as `complete: true` rather
 *   than as a page that failed.
 * - If the page cap is hit before the provider says it is done, the result is
 *   `truncated: true` — never silently "complete".
 * - A failed browse throws, so the caller can show a retry instead of an empty
 *   artist.
 */

/** A resolved artist identity. */
export interface ResolvedArtist {
  found: boolean;
  artistId?: string;
  name?: string;
  exact?: boolean;
  thumbnail?: string;
  description?: string;
  audience?: string;
  alternatives?: Array<{ artistId: string; name: string }>;
}

/** One artist's release list, with its completeness stated. */
export interface ReleasesResult {
  releases: BrowseRelease[];
  complete: boolean;
  truncated: boolean;
  pages: number;
  empty: boolean;
}

/**
 * Version of the resolve/parse pipeline, mixed into the cache key.
 *
 * A cache entry stores the *output* of the parsers, so a parser fix does not
 * reach anyone who already has an entry: the `{found:false}` written by a
 * broken parser outlives the fix and the artist page stays empty for the whole
 * TTL. Bumping this invalidates those entries in one deploy instead of
 * requiring a manual database purge.
 *
 * Bump it whenever `parseArtistSearch` or the shape of `ResolvedArtist`
 * changes.
 */
export const ARTIST_CACHE_VERSION = 2;

/**
 * Version of the release-grid cache namespace.
 *
 * A cached `ReleasesResult` is the OUTPUT of the pagination loop, so a paging
 * fix cannot reach anyone holding an entry written by the old, short cap: the
 * incomplete list keeps being served for the whole 12h TTL. Bump this whenever
 * the release-list pipeline changes so those entries are left behind.
 */
export const CATALOG_CACHE_VERSION = 3;

/** Safety ceiling on release-grid pages followed in one call. */
export { MAX_RELEASE_PAGES };

/** Provider request body for a release grid page. */
async function browsePage(body: Record<string, unknown>) {
  const slot = takeRateSlot("youtube:browse");
  if (!slot.allowed) {
    throw new ConvexError(
      "YouTube Music is rate-limiting this app right now — try again in a moment.",
    );
  }
  return await browseMusic(body);
}

/**
 * Turn a display name into a stable artist id.
 *
 * The id is the whole point: `UC…` identifies one artist, so two artists with
 * the same display name can no longer be mixed into one page, and a typo
 * account cannot inherit somebody else's catalogue.
 */
export const resolveArtist = action({
  args: { name: v.string() },
  handler: async (ctx, { name }): Promise<ResolvedArtist> => {
    const query = name.trim();
    if (!query) return { found: false };

    const key = cacheKey("youtube", "artist", {
      name: query.toLowerCase(),
      v: ARTIST_CACHE_VERSION,
    });
    const cached = (await ctx.runQuery(api.providerCache.cacheGet, { key })) as {
      value: ResolvedArtist;
    } | null;
    if (cached) return cached.value;

    const result: ResolvedArtist = await dedupeRequest(key, async () => {
      const search = await searchMusicArtists(query);
      const matches = parseArtistSearch(search);
      if (matches.length === 0) return { found: false };

      // Prefer an exact (case/punctuation-insensitive) name match; otherwise
      // the provider's own top result, flagged as inexact so the UI can be
      // clear that it is a best match rather than a verified identity.
      const normalise = (value: string) =>
        value
          .normalize("NFKD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
          .replace(/[^\p{L}\p{N}]+/gu, " ")
          .trim();
      const wanted = normalise(query);
      const exact = matches.find((entry) => normalise(entry.name) === wanted);
      const chosen = exact ?? matches[0];

      let header: { thumbnail?: string; description?: string } = {};
      try {
        header = parseArtistHeader(await browsePage({ browseId: chosen.artistId }));
      } catch {
        // Artwork and blurb are decoration; failing to read them must not make
        // the artist unresolvable.
      }

      return {
        found: true,
        artistId: chosen.artistId,
        name: chosen.name,
        exact: Boolean(exact),
        thumbnail: header.thumbnail,
        description: header.description,
        /** Provider-reported audience line, e.g. "441M monthly audience". */
        audience: chosen.subtitle.replace(/^artist\s*•\s*/i, "").trim() || undefined,
        alternatives: matches.slice(0, 5).map((entry) => ({
          artistId: entry.artistId,
          name: entry.name,
        })),
      };
    });

    // A NEGATIVE RESULT IS NOT A FACT ABOUT THE ARTIST.
    //
    // "found: false" comes from an empty search shelf, which the provider also
    // returns for a throttled or malformed request. Caching that for a day is
    // how a transient miss turned into an artist page with no catalogue at all
    // — recovered only by waiting out the TTL. Negatives get the short search
    // TTL so a retry can succeed within the same session.
    await ctx.runMutation(internal.providerCache.cachePut, {
      key,
      value: result,
      provider: "youtube",
      ttlSeconds: result.found ? TTL.artist : TTL.search,
    });
    return result;
  },
});

/**
 * Every release the provider lists for one artist.
 *
 * The artist page's own carousels show ten albums and ten singles; their
 * "show all" button points at a single combined grid (`MPAD…`) that carries
 * the whole release list. That grid is what this follows, page by page, until
 * the provider ends the list or the page cap is reached.
 */
export const artistReleases = action({
  args: { artistId: v.string() },
  handler: async (ctx, { artistId }): Promise<ReleasesResult> => {
    const id = artistId.trim();
    if (!id.startsWith("UC")) {
      throw new ConvexError("That artist id is not a YouTube Music artist id");
    }

    const key = cacheKey("youtube", "artistCatalog", {
      artistId: id,
      v: CATALOG_CACHE_VERSION,
    });
    const cached = (await ctx.runQuery(api.providerCache.cacheGet, { key })) as {
      value: ReleasesResult;
    } | null;
    if (cached) return cached.value;

    const result: ReleasesResult = await dedupeRequest(key, async () => {
      const artist = await browsePage({ browseId: id });

      // The grid ids live on the carousels' "more" buttons. Albums and
      // "Singles & EPs" usually point at the SAME combined grid; the set
      // deduplicates that rather than fetching it twice.
      const gridIds = new Set<string>();
      const walk = (node: unknown): void => {
        if (node == null || typeof node !== "object") return;
        if (Array.isArray(node)) {
          for (const child of node) walk(child);
          return;
        }
        const carousel = (node as Record<string, unknown>)
          .musicCarouselShelfRenderer as Record<string, unknown> | undefined;
        const header = (carousel?.header as Record<string, unknown> | undefined)
          ?.musicCarouselShelfBasicHeaderRenderer as
          | Record<string, unknown>
          | undefined;
        const more = (header?.moreContentButton as Record<string, unknown> | undefined)
          ?.buttonRenderer as Record<string, unknown> | undefined;
        const browseId = (
          (more?.navigationEndpoint as Record<string, unknown> | undefined)
            ?.browseEndpoint as Record<string, unknown> | undefined
        )?.browseId;
        if (typeof browseId === "string" && browseId.startsWith("MPAD")) {
          gridIds.add(browseId);
        }
        for (const value of Object.values(node as Record<string, unknown>)) {
          walk(value);
        }
      };
      walk(artist);

      const releases: BrowseRelease[] = [];
      const seen = new Set<string>();
      let pages = 0;
      // Per-grid, and sticky. The old code reset this to `false` whenever ANY
      // grid ended cleanly, so a second grid that hit the page cap was reported
      // as a complete discography — a silent truncation, which is exactly what
      // this flag exists to prevent.
      let truncated = false;

      for (const gridId of gridIds) {
        const remaining = MAX_RELEASE_PAGES - pages;
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        const grid = await readReleaseGrid(
          () => browsePage({ browseId: gridId }),
          (cursor) => browsePage({ continuation: cursor }),
          remaining,
        );
        pages += grid.pages;
        if (!grid.complete) truncated = true;
        for (const release of grid.releases) {
          if (seen.has(release.id)) continue;
          seen.add(release.id);
          releases.push(release);
        }
      }

      return {
        releases,
        /** Provider said there is nothing further, for every grid. */
        complete: !truncated,
        /** Some grid still offered more when the safety ceiling was reached. */
        truncated,
        pages,
        /** True when the artist page exposed no release grid at all. */
        empty: releases.length === 0,
      };
    });

    await ctx.runMutation(internal.providerCache.cachePut, {
      key,
      value: result,
      provider: "youtube",
      // A truncated answer is cached only briefly: it may be the best available
      // now, but a retry should be able to extend it rather than have the
      // partial list pinned for half a day.
      ttlSeconds: result.complete ? TTL.artistCatalog : TTL.search,
    });
    return result;
  },
});

/**
 * One page of a release's tracklist.
 *
 * `cursor` continues a long tracklist; without it, the release's first page is
 * returned. Every page is cached against its own key, so scrolling a large
 * album back and forth costs one request per page rather than one per render.
 */
export const releaseTracks = action({
  args: { releaseId: v.string(), cursor: v.optional(v.string()) },
  handler: async (
    ctx,
    { releaseId, cursor },
  ): Promise<{
    tracks: BrowseTrack[];
    nextCursor: string | null;
    meta: ReturnType<typeof parseAlbumMeta>;
    firstPage: boolean;
  }> => {
    const id = releaseId.trim();
    const continuation = cursor?.trim();
    if (!id && !continuation) {
      throw new ConvexError("A release id or a continuation token is required");
    }

    const key = continuation
      ? cacheKey("youtube", "releaseTracks", { cursor: continuation })
      : cacheKey("youtube", "releaseTracks", { releaseId: id });
    const cached = await ctx.runQuery(api.providerCache.cacheGet, { key });
    if (cached) {
      return cached.value as {
        tracks: BrowseTrack[];
        nextCursor: string | null;
        meta: ReturnType<typeof parseAlbumMeta>;
        firstPage: boolean;
      };
    }

    const result = await dedupeRequest(key, async () => {
      const data = continuation
        ? await browsePage({ continuation })
        : await browsePage({ browseId: id });
      const parsed = parseReleaseTracks(data);
      return {
        tracks: parsed.tracks,
        // An end-of-list message carries no rows and no cursor: report the
        // list as finished instead of pointing at a page that will never
        // arrive.
        nextCursor: parsed.tracks.length === 0 ? null : parsed.nextCursor,
        meta: continuation ? { kind: "other" as const } : parseAlbumMeta(data),
        firstPage: !continuation,
      };
    });

    await ctx.runMutation(internal.providerCache.cachePut, {
      key,
      value: result,
      provider: "youtube",
      ttlSeconds: TTL.collection,
    });
    return result;
  },
});
