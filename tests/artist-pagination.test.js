import { describe, expect, test } from "bun:test";
import {
  MAX_RELEASE_PAGES,
  MAX_TRACKLIST_PAGES,
  readReleaseGrid,
  readTracklist,
} from "../src/lib/artistPagination.ts";

/**
 * Pagination is where "the complete discography" is actually won or lost.
 *
 * The release grid and the tracklist both arrive one page at a time with a
 * continuation token. These tests drive the real readers against fake pages:
 * more than the old three-page cap, duplicate rows across pages, a repeated
 * token, an explicit end-of-list message, and a multi-page album with
 * legitimate alternate versions.
 */

// --- fake provider pages, in the shapes the parsers read --------------------

function releaseRow(id, title, subtitle = "Album • 2020") {
  return {
    musicTwoRowItemRenderer: {
      title: { runs: [{ text: title }] },
      subtitle: { runs: [{ text: subtitle }] },
      navigationEndpoint: { browseEndpoint: { browseId: id } },
    },
  };
}

function releasePage(rows, cursor) {
  return {
    contents: {
      sectionListRenderer: {
        contents: [
          {
            gridRenderer: {
              items: [
                ...rows.map((row) => releaseRow(...row)),
                ...(cursor
                  ? [
                      {
                        continuationItemRenderer: {
                          continuationEndpoint: {
                            continuationCommand: { token: cursor },
                          },
                        },
                      },
                    ]
                  : []),
              ],
            },
          },
        ],
      },
    },
  };
}

function endPage() {
  return {
    contents: {
      messageRenderer: { text: { runs: [{ text: "You've reached the end" }] } },
    },
  };
}

function trackRow(videoId, title, artist = "Artist", album = "Album") {
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
            text: { runs: [{ text: artist }] },
          },
        },
        {
          musicResponsiveListItemFlexColumnRenderer: {
            text: { runs: [{ text: album }] },
          },
        },
      ],
      fixedColumns: [
        {
          musicResponsiveListItemFixedColumnRenderer: {
            text: { runs: [{ text: "3:20" }] },
          },
        },
      ],
    },
  };
}

function trackPage(rows, cursor) {
  return {
    contents: {
      sectionListRenderer: {
        contents: [
          {
            musicResponsiveListItemRenderer: undefined,
            items: [
              ...rows.map((row) => trackRow(...row)),
              ...(cursor
                ? [
                    {
                      continuationItemRenderer: {
                        continuationEndpoint: {
                          continuationCommand: { token: cursor },
                        },
                      },
                    },
                  ]
                : []),
            ],
          },
        ],
      },
    },
  };
}

// --- release grid -----------------------------------------------------------

describe("an artist's release grid is followed to the end", () => {
  test("more than three pages are read, not just the first three", async () => {
    // The old production cap was three pages. An artist with a long singles
    // catalogue lost everything after page three with no indication.
    const pages = [
      releasePage([["MPREa1", "One"]], "c1"),
      releasePage([["MPREa2", "Two"]], "c2"),
      releasePage([["MPREa3", "Three"]], "c3"),
      releasePage([["MPREa4", "Four"]], "c4"),
      releasePage([["MPREa5", "Five"]], "c5"),
      releasePage([["MPREa6", "Six"]]),
    ];
    let next = 0;
    const result = await readReleaseGrid(
      async () => pages[next++],
      async () => pages[next++],
    );
    expect(result.pages).toBe(6);
    expect(result.complete).toBe(true);
    expect(result.releases.map((r) => r.id)).toEqual([
      "MPREa1",
      "MPREa2",
      "MPREa3",
      "MPREa4",
      "MPREa5",
      "MPREa6",
    ]);
  });

  test("the same release returned on two pages is one release", async () => {
    const pages = [
      releasePage([["MPREdup", "Same"], ["MPREb", "Other"]], "c1"),
      releasePage([["MPREdup", "Same"]], "c2"),
      releasePage([], "c3"),
    ];
    let next = 0;
    const result = await readReleaseGrid(
      async () => pages[next++],
      async () => pages[next++],
    );
    expect(result.releases).toHaveLength(2);
    expect(result.complete).toBe(true);
  });

  test("reaching the safety ceiling is reported as incomplete", async () => {
    const result = await readReleaseGrid(
      async () => releasePage([["MPREa", "A"]], "c1"),
      async () => releasePage([["MPREb", "B"]], "c2"),
      2,
    );
    expect(result.pages).toBe(2);
    expect(result.complete).toBe(false);
    expect(result.releases).toHaveLength(2);
  });

  test("the provider's end message is a real end, not a failure", async () => {
    const result = await readReleaseGrid(
      async () => releasePage([["MPREa", "A"]], "c1"),
      async () => endPage(),
    );
    expect(result.complete).toBe(true);
    expect(result.releases).toHaveLength(1);
  });

  test("a token that repeats itself cannot loop forever", async () => {
    let calls = 0;
    const result = await readReleaseGrid(
      async () => releasePage([["MPREa", "A"]], "same"),
      async () => {
        calls += 1;
        return releasePage([["MPREb", "B"]], "same");
      },
      10,
    );
    expect(calls).toBeLessThanOrEqual(1);
    expect(result.complete).toBe(false);
  });

  test("the default ceiling is large enough for a real discography", () => {
    // 24 pages of up to 100 releases is a ceiling against a malformed loop,
    // not a display limit.
    expect(MAX_RELEASE_PAGES).toBeGreaterThanOrEqual(20);
    expect(MAX_TRACKLIST_PAGES).toBeGreaterThanOrEqual(20);
  });
});

// --- tracklist --------------------------------------------------------------

describe("a release's entire tracklist is read", () => {
  const fetchFrom = (pages) => async ({ cursor }) => {
    const index = cursor ? Number(cursor) : 0;
    return pages[index];
  };

  test("every page is followed, and every track keeps its own id", async () => {
    const pages = [
      { tracks: [
        { videoId: "v1", title: "One", artists: ["A"], duration: 200, index: 1 },
        { videoId: "v2", title: "Two", artists: ["A"], duration: 190, index: 2 },
      ], nextCursor: "1" },
      { tracks: [
        { videoId: "v3", title: "Three", artists: ["A"], duration: 180, index: 3 },
      ], nextCursor: "2" },
      { tracks: [
        { videoId: "v4", title: "Four", artists: ["A"], duration: 170, index: 4 },
      ], nextCursor: null },
    ];
    const tracks = await readTracklist(fetchFrom(pages), "MPRErel", () => false);
    expect(tracks.map((t) => t.videoId)).toEqual(["v1", "v2", "v3", "v4"]);
  });

  test("legitimate versions stay distinct; only the same recording collapses", async () => {
    const pages = [
      { tracks: [
        { videoId: "studio", title: "Song", artists: ["A"], duration: 200, index: 1 },
        { videoId: "live", title: "Song (Live)", artists: ["A"], duration: 260, index: 2 },
        { videoId: "acoustic", title: "Song (Acoustic)", artists: ["A"], duration: 210, index: 3 },
      ], nextCursor: "1" },
      { tracks: [
        // The same studio recording seen again on the next page.
        { videoId: "studio", title: "Song", artists: ["A"], duration: 200, index: 1 },
      ], nextCursor: null },
    ];
    const tracks = await readTracklist(fetchFrom(pages), "MPRErel", () => false);
    expect(tracks.map((t) => t.videoId)).toEqual(["studio", "live", "acoustic"]);
  });

  test("a repeated cursor stops instead of requesting the same page forever", async () => {
    let calls = 0;
    const tracks = await readTracklist(
      async () => {
        calls += 1;
        return {
          tracks: [
            { videoId: `v${calls}`, title: `T${calls}`, artists: ["A"], duration: 100, index: calls },
          ],
          nextCursor: "loop",
        };
      },
      "MPRErel",
      () => false,
    );
    expect(calls).toBeLessThanOrEqual(2);
    expect(tracks.length).toBeLessThanOrEqual(2);
  });

  test("the ceiling bounds a pathological release", async () => {
    let pages = 0;
    const tracks = await readTracklist(
      async () => {
        pages += 1;
        return {
          tracks: [
            { videoId: `v${pages}`, title: `T${pages}`, artists: ["A"], duration: 100, index: pages },
          ],
          nextCursor: `c${pages}`,
        };
      },
      "MPRErel",
      () => false,
      3,
    );
    expect(pages).toBe(3);
    expect(tracks).toHaveLength(3);
  });

  test("cancellation stops before another request is made", async () => {
    let calls = 0;
    let cancelled = false;
    const tracks = await readTracklist(
      async () => {
        calls += 1;
        cancelled = true;
        return {
          tracks: [
            { videoId: "v1", title: "One", artists: ["A"], duration: 100, index: 1 },
          ],
          nextCursor: "1",
        };
      },
      "MPRErel",
      () => cancelled,
    );
    expect(calls).toBe(1);
    expect(tracks).toHaveLength(1);
  });
});
