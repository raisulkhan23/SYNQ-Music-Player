import { describe, expect, test } from "bun:test";
import { readSource } from "./helpers/tailwind-css.js";
import {
  albumPath,
  artistPath,
  groupByAlbum,
  matchesAlbum,
  normaliseAlbumName,
  parseAlbumRoute,
  uniqueTracks,
} from "../src/lib/artistLinks.ts";

/** A track shaped like a YtItem, with only the fields the helpers read. */
const track = (id, artist, album, extra = {}) => ({
  id,
  title: `Song ${id}`,
  artist,
  album,
  duration: 200,
  thumbnail: `https://img/${id}.jpg`,
  ...extra,
});

// The helpers call cleanArtistName, which strips a trailing " - Topic" style
// suffix and other decorations. These tests use plain names, so the cleaned
// value is the name itself.
describe("normaliseAlbumName", () => {
  test("folds case, punctuation and spacing", () => {
    expect(normaliseAlbumName("Rumours")).toBe("rumours");
    expect(normaliseAlbumName("  Rumours  ")).toBe("rumours");
    expect(normaliseAlbumName("Abbey Road!")).toBe("abbey road");
  });

  test("drops remastered/deluxe/expanded decorations", () => {
    expect(normaliseAlbumName("Abbey Road (Remastered)")).toBe("abbey road");
    expect(normaliseAlbumName("Abbey Road (Deluxe Edition)")).toBe(
      "abbey road",
    );
    expect(normaliseAlbumName("Abbey Road [Expanded]")).toBe("abbey road");
  });

  test("drops format words and bracketed junk", () => {
    expect(normaliseAlbumName("The Album")).toBe("the");
    expect(normaliseAlbumName("Fearless (Expanded Edition)")).toBe("fearless");
    expect(normaliseAlbumName("Single")).toBe("");
  });

  test("treats two spellings of one album as equal", () => {
    const a = normaliseAlbumName("Abbey Road (Remastered)");
    const b = normaliseAlbumName("abbey road");
    expect(a).toBe(b);
  });

  test("keeps genuinely different albums apart", () => {
    expect(normaliseAlbumName("Rumours")).not.toBe(normaliseAlbumName("Tusk"));
  });

  test("missing album normalises to empty, not a placeholder", () => {
    expect(normaliseAlbumName(null)).toBe("");
    expect(normaliseAlbumName(undefined)).toBe("");
    expect(normaliseAlbumName("")).toBe("");
  });
});

describe("artistPath", () => {
  test("builds a path from a real artist name", () => {
    expect(artistPath("Rick Astley")).toBe("/artist/Rick%20Astley");
  });

  test("encodes characters that would break the route", () => {
    expect(artistPath("AC/DC")).toBe("/artist/AC%2FDC");
    expect(artistPath("Simon & Garfunkel")).toBe(
      "/artist/Simon%20%26%20Garfunkel",
    );
  });

  test("trims surrounding whitespace", () => {
    expect(artistPath("  Fleetwood Mac  ")).toBe("/artist/Fleetwood%20Mac");
  });

  test("refuses to invent a link for a missing or placeholder artist", () => {
    // A link to /artist/Unknown%20artist would render a page that can never
    // resolve, so no link is produced at all.
    expect(artistPath(null)).toBeNull();
    expect(artistPath(undefined)).toBeNull();
    expect(artistPath("")).toBeNull();
    expect(artistPath("   ")).toBeNull();
    expect(artistPath("Unknown artist")).toBeNull();
  });
});

describe("albumPath", () => {
  test("builds a path when both halves are real", () => {
    expect(albumPath("Fleetwood Mac", "Rumours")).toBe(
      "/album/Fleetwood%20Mac/Rumours",
    );
  });

  test("requires an artist", () => {
    expect(albumPath(null, "Rumours")).toBeNull();
    expect(albumPath("", "Rumours")).toBeNull();
    expect(albumPath("Unknown artist", "Rumours")).toBeNull();
  });

  test("requires an album", () => {
    expect(albumPath("Fleetwood Mac", null)).toBeNull();
    expect(albumPath("Fleetwood Mac", "   ")).toBeNull();
  });

  test("refuses the synthetic Single album", () => {
    // A track with no album is filed under "Single" upstream. Linking that
    // would build an album page that can only ever be a lie.
    expect(albumPath("Rick Astley", "Single")).toBeNull();
  });

  test("encodes both halves", () => {
    expect(albumPath("AC/DC", "Back in Black")).toBe(
      "/album/AC%2FDC/Back%20in%20Black",
    );
  });
});

describe("parseAlbumRoute", () => {
  test("round-trips a path built by albumPath", () => {
    const path = albumPath("Fleetwood Mac", "Rumours");
    const [artistParam, albumParam] = path
      .split("/")
      .slice(2)
      .map(decodeURIComponent);
    expect(parseAlbumRoute(artistParam, albumParam)).toEqual({
      artist: "Fleetwood Mac",
      album: "Rumours",
    });
  });

  test("takes names as react-router already decoded them", () => {
    // react-router v7 percent-decodes each path segment while matching, so
    // the params handed to the page are already the display names. Decoding
    // them a second time crashed the app on any name containing "%".
    expect(parseAlbumRoute("Simon & Garfunkel", "Bookends")).toEqual({
      artist: "Simon & Garfunkel",
      album: "Bookends",
    });
    expect(parseAlbumRoute("50% Hits", "100% Pure Love")).toEqual({
      artist: "50% Hits",
      album: "100% Pure Love",
    });
  });

  test("returns null for a truncated or hand-typed URL", () => {
    // The page must show an honest empty state rather than searching for
    // the string "undefined".
    expect(parseAlbumRoute("Fleetwood Mac", undefined)).toBeNull();
    expect(parseAlbumRoute(undefined, "Rumours")).toBeNull();
    expect(parseAlbumRoute("", "Rumours")).toBeNull();
    expect(parseAlbumRoute("Fleetwood Mac", "  ")).toBeNull();
  });

  test("returns null for placeholder halves", () => {
    expect(parseAlbumRoute("Unknown artist", "Rumours")).toBeNull();
    expect(parseAlbumRoute("Rick Astley", "Single")).toBeNull();
  });
});

describe("groupByAlbum", () => {
  test("groups tracks by the album they actually report", () => {
    const groups = groupByAlbum([
      track("a1", "Fleetwood Mac", "Rumours"),
      track("a2", "Fleetwood Mac", "Rumours"),
      track("b1", "Fleetwood Mac", "Tusk"),
    ]);
    expect(groups).toHaveLength(2);
    const rumours = groups.find((g) => g.album === "Rumours");
    expect(rumours?.items.map((i) => i.id)).toEqual(["a1", "a2"]);
    expect(rumours?.artist).toBe("Fleetwood Mac");
  });

  test("drops tracks that report no album instead of filing them under a placeholder", () => {
    const groups = groupByAlbum([
      track("a1", "Rick Astley", undefined),
      track("a2", "Rick Astley", "Whenever You Need Somebody"),
    ]);
    // The album-less track must not create a group, and must not be added to
    // a real one either.
    expect(groups).toHaveLength(1);
    expect(groups[0].items.map((i) => i.id)).toEqual(["a2"]);
  });

  test("treats empty and whitespace albums as missing", () => {
    const groups = groupByAlbum([
      track("a1", "Rick Astley", ""),
      track("a2", "Rick Astley", "   "),
    ]);
    expect(groups).toEqual([]);
  });

  test("folds two spellings of one album into a single group", () => {
    const groups = groupByAlbum([
      track("a1", "The Beatles", "Abbey Road (Remastered)"),
      track("a2", "The Beatles", "abbey road"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].items).toHaveLength(2);
  });

  test("keeps same-named albums by different artists apart", () => {
    const groups = groupByAlbum([
      track("a1", "The Beatles", "Greatest Hits"),
      track("b1", "Sparklehorse", "Greatest Hits"),
    ]);
    expect(groups).toHaveLength(2);
  });

  test("deduplicates a track that appears twice in one album", () => {
    const groups = groupByAlbum([
      track("a1", "The Beatles", "Abbey Road"),
      track("a1", "The Beatles", "Abbey Road"),
    ]);
    expect(groups[0].items).toHaveLength(1);
  });

  test("orders the fullest album first", () => {
    const groups = groupByAlbum([
      track("a1", "The Beatles", "Tusk"),
      track("b1", "The Beatles", "Rumours"),
      track("b2", "The Beatles", "Rumours"),
    ]);
    expect(groups.map((g) => g.album)).toEqual(["Rumours", "Tusk"]);
  });

  test("returns nothing for an empty list", () => {
    expect(groupByAlbum([])).toEqual([]);
  });
});

describe("matchesAlbum", () => {
  test("matches a track that reports the album", () => {
    const item = track("a1", "The Beatles", "Abbey Road");
    expect(matchesAlbum(item, "Abbey Road")).toBe(true);
  });

  test("matches across remaster and case decorations", () => {
    const item = track("a1", "The Beatles", "Abbey Road (Remastered)");
    expect(matchesAlbum(item, "abbey road")).toBe(true);
  });

  test("does not match a track from a different album", () => {
    const item = track("a1", "The Beatles", "Let It Be");
    expect(matchesAlbum(item, "Abbey Road")).toBe(false);
  });

  test("rejects a track that reports no album", () => {
    // The important case: absence of album data is not a match. Showing such a
    // track on an album page would be fabricating a tracklist.
    const item = track("a1", "The Beatles", undefined);
    expect(matchesAlbum(item, "Abbey Road")).toBe(false);
    expect(matchesAlbum(track("a2", "X", ""), "Abbey Road")).toBe(false);
  });

  test("does not match an album name that normalises to nothing", () => {
    expect(matchesAlbum(track("a1", "X", "Single"), "Single")).toBe(false);
  });
});

describe("uniqueTracks", () => {
  test("keeps the first occurrence of a repeated id", () => {
    const out = uniqueTracks([
      track("a1", "X", "A", { title: "first" }),
      track("a1", "X", "A", { title: "second" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("first");
  });

  test("preserves order and keeps distinct tracks", () => {
    const out = uniqueTracks([
      track("a1", "X", "A"),
      track("a2", "X", "A"),
      track("a3", "X", "A"),
    ]);
    expect(out.map((i) => i.id)).toEqual(["a1", "a2", "a3"]);
  });
});

// ── Source-level guarantees for the two pages ────────────────────────────────

const artistSrc = readSource("src/pages/Artist.tsx");
const albumSrc = readSource("src/pages/Album.tsx");
const mediaCardSrc = readSource("src/components/tracks/MediaCard.tsx");
const mainSrc = readSource("src/main.tsx");
const homeSrc = readSource("src/pages/Home.tsx");

describe("routes", () => {
  test("artist and album routes are registered", () => {
    // JSX attributes, and Prettier reflows them onto separate lines, so match
    // whitespace loosely rather than pinning the formatting.
    expect(mainSrc).toMatch(/path=\s*"\/artist\/:artist"/);
    expect(mainSrc).toMatch(/path=\s*"\/album\/:artist\/:album"/);
  });

  test("both pages load through the guarded lazy loader, inside the boundary", () => {
    // Routes are lazy for bundle size, but they must go through `lazyRoute`,
    // which races the fetch against a timeout. A route chunk whose deps 404
    // after a dev-server restart used to leave the listener on "Loading..."
    // forever, with only a manual refresh recovering it — the guard turns that
    // into a rejection the PageBoundary below can render as a retry card.
    expect(mainSrc).toMatch(
      /const Artist = lazyRoute\(\(\) => import\("\.\/pages\/Artist\.tsx"\)\);/,
    );
    expect(mainSrc).toMatch(
      /const Album = lazyRoute\(\(\) => import\("\.\/pages\/Album\.tsx"\)\);/,
    );
    // No bare static import left behind — that would silently re-inflate the
    // entry chunk.
    expect(mainSrc).not.toMatch(
      /^import (Artist|Album) from "\.\/pages\/(Artist|Album)\.tsx";/m,
    );
  });

  test("both routes sit inside the authenticated group", () => {
    // The artist/album pages are a signed-in surface: they must be wrapped by
    // the same RequireAuth + AppShell route as Home so a signed-out visitor is
    // sent to /auth with this path preserved, not shown the page.
    const groupStart = mainSrc.indexOf("<RequireAuth>");
    const groupEnd = mainSrc.indexOf('path="/support"');
    const group = mainSrc.slice(groupStart, groupEnd);
    expect(group).toMatch(/path=\s*"\/artist\/:artist"/);
    expect(group).toMatch(/path=\s*"\/album\/:artist\/:album"/);
    // PageBoundary composes the error boundary around the existing Suspense
    // boundary, so a failing page no longer unwinds the whole app.
    expect(group).toMatch(/<PageBoundary>/);
  });

  test("both pages read their route params", () => {
    expect(artistSrc).toMatch(/params\s*\.\s*artist/);
    expect(albumSrc).toMatch(/params\s*\.\s*artist/);
    expect(albumSrc).toMatch(/params\s*\.\s*album/);
  });
});

describe("artist page", () => {
  test("only lists tracks whose cleaned artist matches the page", () => {
    // A search for an artist name returns other people's songs; showing them
    // here would be the same fabrication the engine refuses to make.
    expect(artistSrc).toMatch(/cleanArtistName\(/);
    expect(artistSrc).toMatch(/===\s*owned/);
  });

  test("filters out unusable results", () => {
    expect(artistSrc).toMatch(/duration\s*>\s*0/);
    expect(artistSrc).toMatch(/uniqueTracks\(/);
  });

  test("offers radio and search from the header", () => {
    expect(artistSrc).toMatch(/startRadio\(/);
    expect(artistSrc).toMatch(/Link[\s\S]{0,400}?\/search/);
  });

  test("the discography comes from the artist's real release list", () => {
    // The page no longer derives albums from search rows. It reads the artist's
    // release list (grouped by the provider's own release type) and hydrates
    // each release's tracklist.
    expect(artistSrc).toMatch(/useArtistCatalog\(/);
    expect(artistSrc).toMatch(/catalog\.releases/);
    expect(artistSrc).toMatch(/releaseGroups/);
  });

  test("popular is a view of the catalogue, not the whole catalogue", () => {
    // The bug this pins: the page kept ten rows and called them the artist.
    // Popular is now explicitly the source's ranking over search results, while
    // Songs/Discography come from the release catalogue.
    expect(artistSrc).toMatch(/searchView\.popular/);
    expect(artistSrc).toMatch(/catalogItems/);
    expect(artistSrc).toMatch(/artistCatalog/);
  });

  test("shuffle uses the wider catalogue, not the Popular subset", () => {
    // "Artist Shuffle" must queue everything retrieved, not ten ranked rows.
    expect(artistSrc).toMatch(/shuffleAll\(/);
    expect(artistSrc).toMatch(/shuffleAll\(\s*catalogItems\.length > 0/);
  });

  test("an unresolvable artist shows a message rather than a blank page", () => {
    expect(artistSrc).toMatch(/couldn&apos;t find|We couldn't find/i);
  });

  test("does not render an empty related shelf", () => {
    expect(artistSrc).toMatch(/hidden=\{[^}]*related[^}]*length === 0/);
  });

  test("a self-titled release keeps its artist credit", () => {
    // "Taylor Swift" (the 2006 album) is released by Taylor Swift. The song-row
    // disambiguation drops a candidate that equals the row's title, which is
    // right for songs and wrong for albums — it made every self-titled record
    // render "Unknown artist" in the discography.
    expect(mediaCardSrc).toMatch(/variant === "playlist"[\s\S]{0,120}cleanArtistName\(item\.artist\)/);
  });

  test("stale results for a previous artist are not shown under a new name", () => {
    // Derived from a key match rather than a bare setState, so navigating from
    // one artist to another cannot paint the old payload.
    expect(artistSrc).toMatch(/result\?\.key === query/);
  });
});

describe("album page", () => {
  test("filters search results with the strict album match", () => {
    expect(albumSrc).toMatch(/matchesAlbum\(item, wanted\)/);
    expect(albumSrc).toMatch(/matchesAlbum\(item, route\.album\)/);
  });

  test("shows an honest empty state instead of a guessed tracklist", () => {
    expect(albumSrc).toMatch(/Tracklist unavailable/);
    expect(albumSrc).toMatch(/won&apos;t guess/);
  });

  test("the empty state offers a search fallback", () => {
    expect(albumSrc).toMatch(/Search instead/);
    expect(albumSrc).toMatch(/\/search\?q=/);
  });

  test("a malformed album link says the album was not found", () => {
    expect(albumSrc).toMatch(/Album not found/);
    expect(albumSrc).toMatch(/didn&apos;t include an album name/);
  });

  test("merges album-bearing entries out of play history", () => {
    expect(albumSrc).toMatch(/readPlayHistory\(\)/);
  });

  test("stale results for a previous album are not shown under a new name", () => {
    expect(albumSrc).toMatch(/requestKey/);
    expect(albumSrc).toMatch(/result\?\.key === requestKey/);
  });

  test("normalises the requested album before matching", () => {
    expect(albumSrc).toMatch(/normaliseAlbumName/);
  });
});

describe("recommendation cards link through", () => {
  test("MediaCard renders the artist as a real link", () => {
    expect(mediaCardSrc).toMatch(/artistPath\(/);
    expect(mediaCardSrc).toMatch(/<Link/);
  });

  test("MediaCard links the album when the track reports one", () => {
    expect(mediaCardSrc).toMatch(/albumPath\(/);
  });

  test("a card link does not also trigger the card's own click", () => {
    expect(mediaCardSrc).toMatch(/stopPropagation/);
  });

  test("the home artist shelf navigates to the artist page", () => {
    expect(homeSrc).toMatch(/artistPath\(/);
  });
});
