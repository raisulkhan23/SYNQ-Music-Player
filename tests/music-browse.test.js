import { describe, expect, test } from "bun:test";
import {
  findContinuation,
  isEndMessage,
  parseAlbumMeta,
  parseArtistHeader,
  parseArtistSearch,
  parseDuration,
  parseReleaseGrid,
  parseReleaseSubtitle,
  parseReleaseTracks,
} from "../src/lib/musicBrowse.ts";

/**
 * Fixtures below are trimmed copies of real YouTube Music `browse` responses,
 * captured from live calls while fixing this (Taylor Swift's artist id and
 * release grid). Keeping the real shapes — `musicTwoRowItemRenderer` for
 * releases, `musicResponsiveListItemRenderer` for tracks, `nextContinuationData`
 * for paging — is the point: the artist page was broken because the code
 * assumed a search shelf could describe a discography, not because a parser had
 * a typo.
 */

const text = (...runs) => ({ runs: runs.map((run) => ({ text: run })) });

function releaseRow(title, subtitle, browseId, withThumb = true) {
  return {
    musicTwoRowItemRenderer: {
      title: text(title),
      subtitle: text(subtitle),
      navigationEndpoint: {
        browseEndpoint: { browseId },
        watchPlaylistEndpoint: { playlistId: `OLAK5uy_${browseId}` },
      },
      ...(withThumb
        ? {
            thumbnail: {
              musicThumbnailRenderer: {
                thumbnail: { thumbnails: [{ url: "small.jpg" }, { url: "big.jpg" }] },
              },
            },
          }
        : {}),
    },
  };
}

/** Real rows separate credits with their own " • " run, as the API does. */
const runList = (values) =>
  values.flatMap((value, index) =>
    index === 0 ? [{ text: value }] : [{ text: " • " }, { text: value }],
  );

function trackRow(videoId, title, artists, album, duration) {
  return {
    musicResponsiveListItemRenderer: {
      flexColumns: [
        {
          musicResponsiveListItemFlexColumnRenderer: {
            text: {
              runs: [
                {
                  text: title,
                  navigationEndpoint: { watchEndpoint: { videoId } },
                },
              ],
            },
          },
        },
        {
          musicResponsiveListItemFlexColumnRenderer: {
            text: { runs: runList(artists) },
          },
        },
        { musicResponsiveListItemFlexColumnRenderer: { text: text(album) } },
      ],
      fixedColumns: [
        { musicResponsiveListItemFixedColumnRenderer: { text: text(duration) } },
      ],
    },
  };
}

const grid = (items, continuation) => ({
  contents: {
    singleColumnBrowseResultsRenderer: {
      tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ gridRenderer: { items } }] } } } }],
    },
  },
  ...(continuation
    ? { contents: { gridRenderer: { items, continuations: [{ nextContinuationData: { continuation } }] } } }
    : {}),
});

const continuationGrid = (items) => ({
  continuationContents: {
    sectionListContinuation: { contents: [{ itemSectionRenderer: { contents: items } }] },
  },
});

describe("a release grid is paged, never mistaken for the whole discography", () => {
  test("every release type the provider lists is kept", () => {
    const { releases } = parseReleaseGrid(
      grid([
        releaseRow("The Life of a Showgirl", "Album • 2025", "MPREb_album"),
        releaseRow("Patient Zero", "Single • 2026", "MPREb_single"),
        releaseRow("Take Me to Church EP", "EP • 2014", "MPREb_ep"),
        releaseRow("Live in America", "Live • 2015", "MPREb_live"),
      ]),
    );
    expect(releases).toHaveLength(4);
    expect(releases.map((release) => release.kind)).toEqual([
      "album",
      "single",
      "ep",
      "live",
    ]);
    // Singles are the exact thing the old page dropped.
    expect(releases.some((release) => release.kind === "single")).toBe(true);
  });

  test("the year comes from the provider, never from the title", () => {
    const { releases } = parseReleaseGrid(
      grid([releaseRow("1989 (Taylor's Version)", "Album • 2023", "MPREb_x")]),
    );
    expect(releases[0].year).toBe("2023");
  });

  test("deluxe editions stay separate releases", () => {
    const { releases } = parseReleaseGrid(
      grid([
        releaseRow("Midnights", "Album • 2022", "MPREb_std"),
        releaseRow("Midnights (3am Edition)", "Album • 2022", "MPREb_deluxe"),
      ]),
    );
    expect(releases).toHaveLength(2);
    expect(releases[0].id).not.toBe(releases[1].id);
  });

  test("a page with a continuation is not complete, and hands over the token", () => {
    const page = parseReleaseGrid(
      grid([releaseRow("A", "Album • 2020", "MPREb_a")], "TOKEN_PAGE_2"),
    );
    expect(page.releases).toHaveLength(1);
    expect(page.nextCursor).toBe("TOKEN_PAGE_2");
  });

  test("the continuation page's items parse the same way", () => {
    const page = parseReleaseGrid(
      continuationGrid([releaseRow("B", "Single • 2019", "MPREb_b")]),
    );
    expect(page.releases[0].title).toBe("B");
    expect(page.nextCursor).toBeNull();
  });

  test("a duplicate release across pages is returned once by the parser's caller contract", () => {
    // The parser reports what the page held; the action deduplicates by id,
    // which is why the id — not the title — is the key.
    const page = parseReleaseGrid(
      grid([
        releaseRow("Same", "Album • 2020", "MPREb_same"),
        releaseRow("Same", "Album • 2020", "MPREb_same"),
      ]),
    );
    expect(page.releases).toHaveLength(1);
  });

  test("the provider's end-of-list message is recognised", () => {
    // This is what the release grid's continuation actually returns once the
    // artist's releases run out — not an empty grid.
    const end = {
      continuationContents: {
        sectionListContinuation: {
          contents: [{ itemSectionRenderer: { contents: [{ messageRenderer: {} }] } }],
        },
      },
    };
    expect(isEndMessage(end)).toBe(true);
    expect(isEndMessage(continuationGrid([releaseRow("C", "Album • 2001", "MPREb_c")]))).toBe(false);
  });
});

describe("a release's own tracklist", () => {
  const album = {
    header: {
      musicResponsiveHeaderRenderer: {
        title: text("The Life of a Showgirl"),
        subtitle: text("Album", " • ", "2025"),
        secondSubtitle: text("12 songs", " • ", "44 minutes"),
        thumbnail: {
          musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: "cover.jpg" }] } },
        },
      },
    },
    contents: {
      musicShelfRenderer: {
        contents: [
          trackRow("vid1", "The Fate of Ophelia", ["Taylor Swift"], "The Life of a Showgirl", "3:46"),
          trackRow("vid2", "Elizabeth Taylor", ["Taylor Swift"], "The Life of a Showgirl", "3:38"),
        ],
      },
    },
  };

  test("tracks keep provider order, ids, credits and duration", () => {
    const { tracks } = parseReleaseTracks(album);
    expect(tracks.map((track) => track.videoId)).toEqual(["vid1", "vid2"]);
    expect(tracks[0].title).toBe("The Fate of Ophelia");
    expect(tracks[0].artists).toEqual(["Taylor Swift"]);
    expect(tracks[0].album).toBe("The Life of a Showgirl");
    expect(tracks[0].duration).toBe(226);
    expect(tracks[0].index).toBe(1);
  });

  test("a collaboration keeps both credits", () => {
    const { tracks } = parseReleaseTracks({
      contents: {
        musicShelfRenderer: {
          contents: [
            trackRow("vid", "Fortnight", ["Taylor Swift", "Post Malone"], "THE TORTURED POETS DEPARTMENT", "3:48"),
          ],
        },
      },
    });
    expect(tracks[0].artists).toEqual(["Taylor Swift", "Post Malone"]);
  });

  test("a repeated row inside one tracklist is not counted twice", () => {
    const row = trackRow("vid1", "Song", ["A"], "Album", "3:00");
    const { tracks } = parseReleaseTracks({
      contents: { musicShelfRenderer: { contents: [row, row] } },
    });
    expect(tracks).toHaveLength(1);
  });

  test("a long tracklist is paged with its own token", () => {
    const first = {
      contents: {
        musicShelfRenderer: {
          contents: [trackRow("v1", "One", ["A"], "Live Album", "3:00")],
          continuations: [{ nextContinuationData: { continuation: "TRACK_PAGE_2" } }],
        },
      },
    };
    expect(parseReleaseTracks(first).nextCursor).toBe("TRACK_PAGE_2");
    const second = parseReleaseTracks({
      continuationContents: {
        musicShelfContinuation: {
          contents: [trackRow("v2", "Two", ["A"], "Live Album", "3:10")],
        },
      },
    });
    expect(second.tracks[0].videoId).toBe("v2");
    expect(second.nextCursor).toBeNull();
  });

  test("the header reports the provider's year, type and track count", () => {
    const meta = parseAlbumMeta(album);
    expect(meta.title).toBe("The Life of a Showgirl");
    expect(meta.year).toBe("2025");
    expect(meta.kind).toBe("album");
    expect(meta.trackCount).toBe(12);
  });

  test("a release with no tracks is empty, not invented", () => {
    expect(parseReleaseTracks({}).tracks).toEqual([]);
    expect(parseReleaseTracks({}).nextCursor).toBeNull();
  });
});

describe("identity comes from an artist id, not a name", () => {
  test("artist rows expose the stable UC id", () => {
    const rows = parseArtistSearch({
      contents: [
        {
          musicShelfRenderer: {
            contents: [
              {
                musicResponsiveListItemRenderer: {
                  flexColumns: [
                    { musicResponsiveListItemFlexColumnRenderer: { text: text("Taylor Swift") } },
                    { musicResponsiveListItemFlexColumnRenderer: { text: text("Artist", " • ", "441M monthly audience") } },
                  ],
                  navigationEndpoint: { browseEndpoint: { browseId: "UCPC0L1d253x-KuMNwa05TpA" } },
                },
              },
            ],
          },
        },
      ],
    });
    expect(rows[0].artistId).toBe("UCPC0L1d253x-KuMNwa05TpA");
    expect(rows[0].name).toBe("Taylor Swift");
  });

  test("a non-artist result is never used as an artist id", () => {
    const rows = parseArtistSearch({
      contents: [
        {
          musicShelfRenderer: {
            contents: [
              {
                musicResponsiveListItemRenderer: {
                  flexColumns: [
                    { musicResponsiveListItemFlexColumnRenderer: { text: text("A playlist") } },
                  ],
                  navigationEndpoint: { browseEndpoint: { browseId: "VLPL123" } },
                },
              },
            ],
          },
        },
      ],
    });
    expect(rows).toEqual([]);
  });

  test("the header carries real artwork and the provider's blurb", () => {
    const header = parseArtistHeader({
      header: {
        musicImmersiveHeaderRenderer: {
          title: text("Taylor Swift"),
          description: text("New album out now."),
          foregroundThumbnail: {
            musicThumbnailRenderer: { thumbnail: { thumbnails: [{ url: "artist.jpg" }] } },
          },
        },
      },
    });
    expect(header.name).toBe("Taylor Swift");
    expect(header.thumbnail).toBe("artist.jpg");
    expect(header.description).toBe("New album out now.");
  });

  test("an unknown header yields no claimed metadata", () => {
    expect(parseArtistHeader({})).toEqual({});
  });
});

describe("small helpers the catalogue depends on", () => {
  test("durations parse, and an unknown one stays 0", () => {
    expect(parseDuration("3:46")).toBe(226);
    expect(parseDuration("1:02:03")).toBe(3723);
    expect(parseDuration("")).toBe(0);
    expect(parseDuration("Live")).toBe(0);
  });

  test("release subtitles are classified from the provider's own words", () => {
    expect(parseReleaseSubtitle("Album • 2025")).toEqual({ kind: "album", year: "2025" });
    expect(parseReleaseSubtitle("Single • 2026")).toEqual({ kind: "single", year: "2026" });
    expect(parseReleaseSubtitle("EP • 2019")).toEqual({ kind: "ep", year: "2019" });
    expect(parseReleaseSubtitle("Live • 2011")).toEqual({ kind: "live", year: "2011" });
    expect(parseReleaseSubtitle("Compilation • 2010")).toEqual({ kind: "compilation", year: "2010" });
    expect(parseReleaseSubtitle("")).toEqual({ kind: "other" });
  });

  test("no continuation token means the list ended", () => {
    expect(findContinuation({ contents: [] })).toBeNull();
    expect(
      findContinuation({
        contents: { continuations: [{ nextContinuationData: { continuation: "T" } }] },
      }),
    ).toBe("T");
  });
});
