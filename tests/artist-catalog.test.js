import { describe, expect, test } from "bun:test";
import {
  POPULAR_LIMIT,
  buildCatalog,
  buildReleases,
  isFeaturedOnly,
  matchesRelease,
  releaseKind,
  releaseKey,
  releasesByKind,
  splitCredit,
  artistKey,
  artistMatches,
} from "../src/lib/artistCatalog.ts";
import { readSource } from "./helpers/tailwind-css.js";
import {
  CATALOG_PAGE_QUERIES,
  catalogPage,
  catalogQueries,
} from "../src/lib/artistQueries.ts";

/**
 * The artist page used to answer "who is this artist?" with one search shelf and
 * then label the first ten rows "Popular". These tests pin the two things that
 * were actually wrong: identity (a name is not an id) and coverage (one query
 * is not a catalogue).
 */

const track = (id, artist, extra = {}) => ({
  id,
  title: `Song ${id}`,
  artist,
  duration: 200,
  thumbnail: `https://img/${id}.jpg`,
  ...extra,
});

describe("artist identity is a credit, not a name match", () => {
  test("a primary credit matches", () => {
    expect(artistMatches(track("a", "Alan Walker"), "Alan Walker")).toBe(true);
  });

  test("case, accents and punctuation do not split one artist", () => {
    expect(artistMatches(track("a", "ROSALÍA"), "Rosalia")).toBe(true);
    expect(artistMatches(track("a", "AC/DC"), "AC DC")).toBe(true);
  });

  test("a different artist with a similar name is NOT the same artist", () => {
    // The bug name-matching alone causes: every "Daya" row on the page belonged
    // to whoever was called "Dayawave".
    expect(artistMatches(track("a", "Dayawave"), "Daya")).toBe(false);
    expect(artistMatches(track("a", "Adele"), "Adel")).toBe(false);
  });

  test("a listed collaboration is a primary credit for both artists", () => {
    const item = track("a", "Calvin Harris, Dua Lipa");
    expect(artistMatches(item, "Calvin Harris")).toBe(true);
    expect(artistMatches(item, "Dua Lipa")).toBe(true);
    expect(isFeaturedOnly(item, "Dua Lipa")).toBe(false);
  });

  test("a feat. artist is a guest, not a release by them", () => {
    const item = track("a", "The Chainsmokers feat. Daya");
    expect(artistMatches(item, "The Chainsmokers")).toBe(true);
    expect(isFeaturedOnly(item, "The Chainsmokers")).toBe(false);
    expect(artistMatches(item, "Daya")).toBe(true);
    expect(isFeaturedOnly(item, "Daya")).toBe(true);
  });

  test("a bracketed feature is attributed the same way", () => {
    const { primary, featured } = splitCredit("Alan Walker (feat. Ava Max)");
    expect(primary).toEqual(["Alan Walker"]);
    expect(featured).toEqual(["Ava Max"]);
  });

  test("an ampersand inside a real artist name is not a separator", () => {
    // Splitting on "&" turned Simon & Garfunkel into two artists and dropped
    // every one of their tracks from their own page.
    const item = track("a", "Simon & Garfunkel");
    expect(artistMatches(item, "Simon & Garfunkel")).toBe(true);
    expect(artistMatches(item, "Simon")).toBe(false);
  });

  test("an empty or unknown credit matches nobody", () => {
    expect(artistKey("")).toBe("");
    // The sentinel for "no credit" is not an identity: otherwise every
    // uncredited track would collect under one artist page.
    expect(artistKey("Unknown artist")).toBe("");
    expect(artistMatches(track("a", "Unknown artist"), "Unknown artist")).toBe(false);
    expect(artistMatches(track("a", "Anyone"), "")).toBe(false);
  });
});

describe("a catalogue is assembled from every real row, once", () => {
  test("the same track from two queries is counted once", () => {
    const rows = [track("a", "Hozier"), track("a", "Hozier")];
    const { catalog } = buildCatalog(rows, "Hozier");
    expect(catalog).toHaveLength(1);
  });

  test("provider order is preserved, so Popular is the provider's ranking", () => {
    const rows = ["1", "2", "3"].map((id) => track(id, "Hozier"));
    const { catalog, popular } = buildCatalog(rows, "Hozier");
    expect(catalog.map((i) => i.id)).toEqual(["1", "2", "3"]);
    expect(popular.map((i) => i.id)).toEqual(["1", "2", "3"]);
  });

  test("Popular is a capped view, not the catalogue", () => {
    const rows = Array.from({ length: 25 }, (_, i) => track(`t${i}`, "Hozier"));
    const { catalog, popular } = buildCatalog(rows, "Hozier");
    expect(catalog).toHaveLength(25);
    expect(popular).toHaveLength(POPULAR_LIMIT);
  });

  test("other artists' rows are excluded, not filed under this one", () => {
    const rows = [
      track("a", "Hozier"),
      track("b", "Hozier Tribute Band"),
      track("c", "Someone Else"),
    ];
    const { catalog } = buildCatalog(rows, "Hozier");
    expect(catalog.map((i) => i.id)).toEqual(["a"]);
  });

  test("guest appearances are kept apart from the artist's own catalogue", () => {
    const rows = [
      track("own", "Hozier"),
      track("guest", "Noah Kahan feat. Hozier"),
    ];
    const { catalog, featured } = buildCatalog(rows, "Hozier");
    expect(catalog.map((i) => i.id)).toEqual(["own"]);
    expect(featured.map((i) => i.id)).toEqual(["guest"]);
    // A feature is not a release by the artist and must not invent one.
    expect(buildReleases(catalog)).toHaveLength(0);
  });

  test("unplayable rows (no duration) are not shown as available", () => {
    const rows = [track("a", "Hozier"), track("b", "Hozier", { duration: 0 })];
    expect(buildCatalog(rows, "Hozier").catalog.map((i) => i.id)).toEqual(["a"]);
  });

  test("an empty catalogue is empty, not a fabricated one", () => {
    const { catalog, popular, releases, featured } = buildCatalog([], "Hozier");
    expect(catalog).toEqual([]);
    expect(popular).toEqual([]);
    expect(releases).toEqual([]);
    expect(featured).toEqual([]);
  });
});

describe("releases are grouped the way the provider labels them", () => {
  test("tracks reporting one album become one release", () => {
    const releases = buildReleases([
      track("a", "Hozier", { album: "Hozier" }),
      track("b", "Hozier", { album: "Hozier" }),
    ]);
    expect(releases).toHaveLength(1);
    expect(releases[0].album).toBe("Hozier");
    expect(releases[0].items).toHaveLength(2);
  });

  test("a track with no album never becomes a release", () => {
    expect(buildReleases([track("a", "Hozier")])).toEqual([]);
  });

  test("a deluxe edition stays a separate release", () => {
    // `normaliseAlbumName` folds these together, which is right for matching a
    // song to an album and wrong for a discography: the tracklists differ.
    const releases = buildReleases([
      track("a", "Hozier", { album: "Wasteland, Baby!" }),
      track("b", "Hozier", { album: "Wasteland, Baby! (Deluxe)" }),
    ]);
    expect(releases).toHaveLength(2);
    expect(releaseKey("Wasteland, Baby!")).not.toBe(
      releaseKey("Wasteland, Baby! (Deluxe)"),
    );
  });

  test("a remaster of the same album is folded, since nothing is added", () => {
    const releases = buildReleases([
      track("a", "The Beatles", { album: "Abbey Road" }),
      track("b", "The Beatles", { album: "Abbey Road (Remastered)" }),
    ]);
    expect(releases).toHaveLength(1);
    expect(releases[0].items).toHaveLength(2);
  });

  test("release kind comes from the label, never from a guess", () => {
    expect(releaseKind("Hozier")).toBe("album");
    expect(releaseKind("Take Me to Church - Single")).toBe("single");
    expect(releaseKind("Eat Your Young - EP")).toBe("ep");
    expect(releaseKind("Live at the BBC")).toBe("live");
    expect(releaseKind("Greatest Hits")).toBe("compilation");
    expect(releaseKind("")).toBe("other");
    expect(releaseKind(undefined)).toBe("other");
  });

  test("categories are ordered and empty ones are dropped", () => {
    const releases = buildReleases([
      track("a", "X", { album: "An Album" }),
      track("b", "X", { album: "A Single - Single" }),
    ]);
    const groups = releasesByKind(releases);
    expect(groups.map((g) => g.kind)).toEqual(["album", "single"]);
    expect(groups.map((g) => g.label)).toEqual(["Albums", "Singles"]);
  });
});

describe("an album page opens the edition that was asked for", () => {
  test("the exact edition matches", () => {
    const item = track("a", "Michael Jackson", {
      album: "Thriller (Deluxe Edition)",
    });
    expect(matchesRelease(item, "Thriller (Deluxe Edition)")).toBe(true);
  });

  test("the standard edition is a different release", () => {
    const item = track("a", "Michael Jackson", { album: "Thriller" });
    expect(matchesRelease(item, "Thriller (Deluxe Edition)")).toBe(false);
  });

  test("a row with no album never counts as an edition", () => {
    expect(matchesRelease(track("a", "X"), "Anything")).toBe(false);
    expect(matchesRelease(track("a", "X", { album: "Anything" }), "")).toBe(
      false,
    );
  });

  test("the album page tries the exact edition before the loose match", () => {
    // Strict-first is what keeps a deluxe page from silently becoming the
    // standard tracklist. The fallback exists, and it is labelled on screen.
    const album = readSource("src/pages/Album.tsx");
    expect(album).toMatch(/matchesRelease\(item, route\.album\)/);
    expect(album.indexOf("matchesRelease(item, route.album)")).toBeLessThan(
      album.indexOf("matchesAlbum(item, wanted)"),
    );
    expect(album).toMatch(/mixedEditions/);
  });
});

describe("the catalogue is read from releases, not from a query plan", () => {
  const artist = readSource("src/pages/Artist.tsx");
  const hook = readSource("src/hooks/useArtistCatalog.ts");
  const server = readSource("src/convex/artistCatalog.ts");

  test("the page reads the artist's release list, not a search shelf", () => {
    expect(artist).toMatch(/useArtistCatalog\(/);
    expect(hook).toMatch(/resolveArtist/);
    expect(hook).toMatch(/artistReleases/);
    expect(hook).toMatch(/releaseTracks/);
  });

  test("release grids are followed page by page, with a stated end", () => {
    // The paging loop lives in a pure module so it can be driven against fake
    // pages (see `artist-pagination.test.js`); the action must USE it rather
    // than keeping another, shorter loop of its own.
    expect(server).toMatch(/readReleaseGrid/);
    expect(server).toMatch(/truncated/);
    expect(server).toMatch(/CATALOG_CACHE_VERSION/);
    const pagination = readSource("src/lib/artistPagination.ts");
    expect(pagination).toMatch(/isEndMessage/);
    expect(pagination).toMatch(/complete: true/);
    expect(pagination).toMatch(/complete: false/);
  });

  test("tracklists follow continuation tokens and stop when they run out", () => {
    // The reader is shared by the artist page and the album page, and its
    // paging rules are exercised directly in `artist-pagination.test.js`.
    expect(hook).toMatch(/readTracklist/);
    expect(server).toMatch(/readReleaseGrid/);
    const pagination = readSource("src/lib/artistPagination.ts");
    expect(pagination).toMatch(/nextCursor/);
    expect(pagination).toMatch(/MAX_TRACKLIST_PAGES/);
    expect(pagination).toMatch(/seenCursors/);
  });

  test("tracklist reads are bounded, not one request per release at once", () => {
    expect(hook).toMatch(/TRACKLIST_CONCURRENCY = 3/);
    expect(hook).toMatch(/TRACKLIST_BATCH/);
    expect(hook).toMatch(/Math\.min\(TRACKLIST_CONCURRENCY, pending\.length\)/);
  });

  test("a refused catalogue is reported, not rendered as an empty artist", () => {
    expect(server).toMatch(/Throwing|throw new ConvexError/);
    expect(artist).toMatch(/tracklists couldn/);
    expect(artist).toMatch(/catalog\.truncated/);
  });

  test("a stale response cannot land on a different artist", () => {
    expect(hook).toMatch(/nameRef\.current !== artistName/);
    expect(hook).toMatch(/cancelled = true/);
  });

  test("an unresolved artist is not cached as fact for a day", () => {
    // "found: false" comes from an empty shelf, which the provider also returns
    // for a throttled or malformed request. Caching that with the 24h artist TTL
    // is how a single bad parse left the artist page empty long after the fix
    // shipped; the negative now expires on the short search TTL.
    expect(server).toMatch(/result\.found \? TTL\.artist : TTL\.search/);
  });

  test("the resolve cache key is versioned, so a bad entry cannot outlive a fix", () => {
    expect(server).toMatch(/ARTIST_CACHE_VERSION/);
    expect(server).toMatch(/v: ARTIST_CACHE_VERSION/);
  });
});

describe("the catalogue is fetched in pages, not in one arbitrary limit", () => {
  test("the first query is the plain artist name", () => {
    // Its order is the provider's ranking, which is what Popular draws from.
    expect(catalogQueries("Hozier")[0]).toBe("Hozier");
  });

  test("the plan asks more than one question", () => {
    const plan = catalogQueries("Hozier");
    expect(plan.length).toBeGreaterThan(CATALOG_PAGE_QUERIES);
    // Albums, singles, EPs and live releases are each a separate question,
    // which is how the discography gets past one search shelf.
    const joined = plan.join(" | ");
    for (const term of ["albums", "singles", "EP", "live", "remix", "featuring"]) {
      expect(joined).toContain(term);
    }
  });

  test("the plan has no duplicate queries", () => {
    const plan = catalogQueries("Hozier");
    expect(new Set(plan).size).toBe(plan.length);
  });

  test("pages advance through the plan and report when it is exhausted", () => {
    const first = catalogPage("Hozier", 0);
    expect(first.queries).toHaveLength(CATALOG_PAGE_QUERIES);
    expect(first.hasMore).toBe(true);

    const plan = catalogQueries("Hozier");
    const seen = [];
    let page = 0;
    let hasMore = true;
    while (hasMore && page < 20) {
      const step = catalogPage("Hozier", page);
      seen.push(...step.queries);
      hasMore = step.hasMore;
      page += 1;
    }
    // Every query is reachable by paging, and only by paging.
    expect(seen).toEqual(plan);
    expect(hasMore).toBe(false);
  });

  test("a page past the end is empty rather than a repeat of the last one", () => {
    const beyond = catalogPage("Hozier", 99);
    expect(beyond.queries).toEqual([]);
    expect(beyond.hasMore).toBe(false);
  });

  test("a nonsense page number does not skip or crash", () => {
    expect(catalogPage("Hozier", -3).queries).toEqual(
      catalogPage("Hozier", 0).queries,
    );
    expect(catalogPage("Hozier", Number.NaN).queries).toEqual(
      catalogPage("Hozier", 0).queries,
    );
  });

  test("an empty artist has no plan at all", () => {
    expect(catalogQueries("   ")).toEqual([]);
    expect(catalogPage("", 0)).toEqual({ queries: [], hasMore: false });
  });
});

describe("the artist page exposes the whole catalogue and no Follow control", () => {
  const artist = readSource("src/pages/Artist.tsx");
  const store = readSource("src/store/player.ts");

  test("Follow is gone, with no leftover state or handler", () => {
    // The button was an account action with no effect on the catalogue; it is
    // removed rather than replaced with another subscription control.
    expect(artist).not.toMatch(/\bFollow\b|\bFollowing\b/);
    expect(artist).not.toMatch(/followedArtists|toggleFollowArtist/);
    expect(store).not.toMatch(/followedArtists/);
    expect(store).not.toMatch(/toggleFollowArtist/);
  });

  test("no silent 200-song ceiling or 50-song Play sample", () => {
    // Both were literal slices: the page said "all songs" while hiding the
    // rest, and Play quietly queued only the first fifty.
    expect(artist).not.toMatch(/slice\(0,\s*200\)/);
    expect(artist).not.toMatch(/catalogItems\.slice\(0,\s*50\)/);
    expect(artist).toMatch(/songLimit/);
    expect(artist).toMatch(/more songs/);
  });

  test("Play queues every loaded track, not a sample", () => {
    expect(artist).toMatch(/catalogItems\.length > 0 \? catalogItems : searchView\.popular/);
  });

  test("a truncated discography is labelled as incomplete", () => {
    expect(artist).toMatch(/discography may be incomplete/);
    expect(artist).toMatch(/catalog\.truncated/);
  });
});
