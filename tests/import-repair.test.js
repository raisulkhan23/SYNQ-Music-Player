import { describe, expect, test } from 'vitest';
import {
  chunkRepairBatches,
  mergeRepairs,
  MIN_REPAIR_MATCH,
  needsRepair,
  nextRepairBatch,
  repairBacklog,
  repairComplete,
  repairQuery,
  pickRepair,
  REPAIR_BATCH_SIZE,
  REPAIR_EMPTY_STREAK_LIMIT,
  REPAIR_MAX_PASSES,
  REPAIR_SEARCH_ATTEMPTS,
  REPAIR_SEARCH_GAP_MS,
} from "../src/lib/importRepair.ts";
import { toStoredTracks } from "../src/lib/importModel.ts";
import { formatDuration } from "../src/lib/format.ts";
import { readSource } from "./helpers/tailwind-css.js";

/**
 * Imported playlists used to render as a grid of empty black boxes reading
 * `0:00`, because the importer had artwork and a duration and threw both away
 * on the way to the database, and a playlist imported before that fix still
 * has neither.
 *
 * Two halves to this: the write path (artwork is persisted now) and the repair
 * pass (older playlists look the song up and write back what they find). The
 * rule both halves obey is that a repair is only applied when the match is
 * genuinely the same song, because a wrong cover on a row that also plays the
 * wrong song looks fixed while being completely wrong.
 */

const row = (over = {}) => ({
  id: "import:spotify|ignite|alan walker",
  title: "Ignite",
  artist: "Alan Walker",
  coverUrl: "",
  duration: 0,
  ...over,
});

const yt = (over = {}) => ({
  id: "rsH1A1MX5_Q",
  title: "Ignite",
  artist: "Alan Walker",
  duration: 228,
  thumbnail: "https://i.ytimg.com/vi/rsH1A1MX5_Q/hq720.jpg",
  ...over,
});

describe("a row is only repaired when it is genuinely missing something", () => {
  test("no cover, no length, no video id — all three are missing", () => {
    expect(needsRepair(row())).toBe(true);
  });

  test("a missing cover alone is enough", () => {
    // Not "is it playable": a playable row with no cover still renders an
    // empty black box, which is the thing being fixed.
    expect(needsRepair(row({ youtubeId: "abc", duration: 228 }))).toBe(true);
  });

  test("a zero length alone is enough", () => {
    expect(needsRepair(row({ coverUrl: "c.jpg", youtubeId: "abc" }))).toBe(
      true,
    );
  });

  test("a complete row is left alone", () => {
    expect(
      needsRepair(row({ coverUrl: "c.jpg", duration: 228, youtubeId: "abc" })),
    ).toBe(false);
  });

  test("a row with no title is not looked up at all", () => {
    // Nothing to search for. Retrying it forever would burn upstream quota
    // on a request that can never succeed.
    expect(needsRepair(row({ title: "   " }))).toBe(false);
  });
});

describe("the search query is the row's own title and artist", () => {
  test("both, in that order", () => {
    expect(repairQuery({ title: "Ignite", artist: "Alan Walker" })).toBe(
      "Ignite Alan Walker",
    );
  });

  test("a missing artist does not leave a trailing space", () => {
    expect(repairQuery({ title: "Ignite", artist: "" })).toBe("Ignite");
  });

  test("import padding is collapsed", () => {
    expect(repairQuery({ title: "  Ignite  ", artist: " Alan  Walker " })).toBe(
      "Ignite Alan Walker",
    );
  });
});

describe("a repair only lands on the same song", () => {
  test("the matching upload is chosen", () => {
    expect(pickRepair(row(), [yt()])?.id).toBe("rsH1A1MX5_Q");
  });

  test("a different song is never substituted", () => {
    // THE important case. A cover from the wrong song is worse than no cover,
    // because it looks fixed.
    expect(
      pickRepair(row(), [
        yt({ id: "x", title: "Faded", artist: "Alan Walker" }),
      ]),
    ).toBeNull();
  });

  test("a title match with no artist match is still accepted", () => {
    // Catalogue releases and uploads spell the artist differently constantly;
    // being strict here throws away the only real option.
    expect(
      pickRepair(row(), [yt({ artist: "Alan Walker Official" })]),
    ).not.toBeNull();
  });

  test("no results is null, not a crash", () => {
    expect(pickRepair(row(), [])).toBeNull();
  });

  test("a zero-length upload is never chosen", () => {
    // It cannot fix the length, which is half the point of the pass.
    expect(pickRepair(row(), [yt({ duration: 0 })])).toBeNull();
  });

  test("an upload with no id is never chosen", () => {
    expect(pickRepair(row(), [yt({ id: "" })])).toBeNull();
  });

  test("the threshold is a half, not a shrug", () => {
    expect(MIN_REPAIR_MATCH).toBe(0.5);
  });
});

describe("merging a repair never damages what is already there", () => {
  test("an empty row is filled in", () => {
    const merged = mergeRepairs(
      [row()],
      [
        {
          id: row().id,
          youtubeId: "abc",
          duration: 228,
          thumbnail: "t.jpg",
        },
      ],
    );
    expect(merged[0]).toMatchObject({
      youtubeId: "abc",
      duration: 228,
      coverUrl: "t.jpg",
    });
  });

  test("an existing cover is never overwritten", () => {
    // A late-arriving search result must not blank out the artwork the
    // original import already had.
    const merged = mergeRepairs(
      [row({ coverUrl: "original.jpg", duration: 210 })],
      [
        {
          id: row().id,
          youtubeId: "abc",
          duration: 228,
          thumbnail: "other.jpg",
        },
      ],
    );
    expect(merged[0].coverUrl).toBe("original.jpg");
    expect(merged[0].duration).toBe(210);
  });

  test("an existing video id is kept", () => {
    const merged = mergeRepairs(
      [row({ youtubeId: "first", coverUrl: "c.jpg", duration: 228 })],
      [
        {
          id: row().id,
          youtubeId: "second",
          duration: 228,
          thumbnail: "t.jpg",
        },
      ],
    );
    expect(merged[0].youtubeId).toBe("first");
  });

  test("rows the repair does not mention are untouched", () => {
    const other = row({ id: "import:spotify|other|someone" });
    const merged = mergeRepairs(
      [row(), other],
      [
        {
          id: row().id,
          youtubeId: "abc",
          duration: 228,
          thumbnail: "t.jpg",
        },
      ],
    );
    expect(merged[1]).toBe(other);
  });

  test("a repair for an unknown id changes nothing at all", () => {
    const before = [row()];
    expect(
      mergeRepairs(before, [
        { id: "nope", youtubeId: "abc", duration: 1, thumbnail: "t.jpg" },
      ]),
    ).toBe(before);
  });

  test("no repairs means the same array back", () => {
    // Same reference, so the mutation can skip the write and the list does
    // not re-render for nothing.
    const before = [row()];
    expect(mergeRepairs(before, [])).toBe(before);
  });

  test("a repair that changes nothing returns the same array", () => {
    const before = [row({ coverUrl: "c.jpg", duration: 228, youtubeId: "a" })];
    expect(
      mergeRepairs(before, [
        {
          id: before[0].id,
          youtubeId: "a",
          duration: 228,
          thumbnail: "c.jpg",
        },
      ]),
    ).toBe(before);
  });
});

describe("the pass is bounded, paced, and stops when upstream says no", () => {
  const many = (n) =>
    Array.from({ length: n }, (_, i) =>
      row({
        id: `import:spotify|t${i}|a${i}`,
        title: `T${i}`,
        artist: `A${i}`,
      }),
    );

  test("only outstanding rows are queued", () => {
    const rows = [
      row({ id: "done", coverUrl: "c.jpg", duration: 1, youtubeId: "a" }),
      ...many(REPAIR_BATCH_SIZE + 2),
    ];
    expect(nextRepairBatch(rows)).toHaveLength(REPAIR_BATCH_SIZE);
  });

  test("a finished playlist queues nothing", () => {
    const rows = many(3).map((r) => ({
      ...r,
      coverUrl: "c.jpg",
      duration: 1,
      youtubeId: "a",
    }));
    expect(nextRepairBatch(rows)).toEqual([]);
    expect(repairComplete(rows)).toBe(true);
    expect(repairBacklog(rows)).toBe(0);
  });

  test("the backlog counts what is still missing", () => {
    expect(repairBacklog(many(4))).toBe(4);
  });

  test("a pass is one batch, never a burst", () => {
    // Measured: two concurrent InnerTube searches from this IP come back
    // empty, so a wider pass resolves nothing at all.
    expect(chunkRepairBatches(many(50))).toHaveLength(1);
  });

  test("the batch never exceeds what one call may look up", () => {
    for (const batch of chunkRepairBatches(many(50))) {
      expect(batch.length).toBeLessThanOrEqual(REPAIR_BATCH_SIZE);
    }
  });

  test("a split is ordered, so the visible top of the list fills first", () => {
    expect(chunkRepairBatches(many(9), 3, 3).map((b) => b.length)).toEqual([
      3, 3, 3,
    ]);
  });

  test("fewer rows than a batch is one short batch", () => {
    expect(chunkRepairBatches(many(2), 6, 3)).toHaveLength(1);
  });

  test("a search is retried, spaced, and a visit is capped", () => {
    expect(REPAIR_SEARCH_ATTEMPTS).toBeGreaterThan(1);
    expect(REPAIR_SEARCH_GAP_MS).toBeGreaterThan(0);
    expect(REPAIR_MAX_PASSES).toBeGreaterThan(0);
    expect(REPAIR_EMPTY_STREAK_LIMIT).toBeGreaterThan(0);
  });
});

describe("artwork survives the trip from the provider to the database", () => {
  test("a normalised track keeps its cover and album", () => {
    const stored = toStoredTracks([
      {
        title: "Ignite",
        artist: "Alan Walker",
        album: "Different World",
        artwork: "https://i.scdn.co/image/abc",
        duration: 228,
        source: "spotify",
      },
    ]);
    expect(stored[0].artwork).toBe("https://i.scdn.co/image/abc");
    expect(stored[0].album).toBe("Different World");
  });

  test("a track with no artwork stores none rather than an empty string", () => {
    const stored = toStoredTracks([
      { title: "x", artist: "y", source: "unknown" },
    ]);
    expect("artwork" in stored[0]).toBe(false);
  });

  test("the store accepts what the projection now sends", () => {
    const playlists = readSource("src/convex/playlists.ts");
    expect(playlists).toMatch(/artwork: v\.optional\(v\.string\(\)\)/);
    // and it is actually written, rather than accepted and dropped again
    expect(playlists).toMatch(/coverUrl:[\s\S]{0,80}track\.artwork/);
  });
});

describe("a missing duration is shown as unknown, not as zero", () => {
  test("a real length is formatted as before", () => {
    expect(formatDuration(228)).toBe("3:48");
  });

  test("zero is a dash, because '0:00' claims the song is empty", () => {
    expect(formatDuration(0)).toBe("—");
  });

  test("undefined is a dash", () => {
    expect(formatDuration(undefined)).toBe("—");
  });

  test("the row component uses the honest formatter", () => {
    const rowSrc = readSource("src/components/tracks/RemoteTrackRow.tsx");
    expect(rowSrc).toContain("formatDuration(item.duration)");
    expect(rowSrc).not.toMatch(/formatTime\(item\.duration\)/);
  });

  test("a row with no artwork renders a placeholder, not a broken image", () => {
    // `<img src="">` paints an empty transparent box, which is the black
    // square the whole screenshot was made of.
    const rowSrc = readSource("src/components/tracks/RemoteTrackRow.tsx");
    expect(rowSrc).toMatch(/item\.thumbnail\s*\?\s*\(/);
    expect(rowSrc).not.toMatch(/src=\{item\.thumbnail\}[^]*?[^]*?>\s*$/);
  });
});

describe("the playlist page repairs what it can and shows what it cannot", () => {
  const page = readSource("src/pages/PlaylistDetail.tsx");
  const server = readSource("src/convex/playlists.ts");

  test("opening the page starts a repair pass", () => {
    expect(page).toContain("resolveImportedTracks");
    expect(page).toContain("applyImportedRepairs");
  });

  test("only rows upstream actually answered are marked done", () => {
    // An empty search means throttled, not absent. Marking those done is how
    // a playlist ends up permanently "repaired" with nothing to show.
    expect(page).toContain("result.answered");
    expect(server).toContain("answered");
  });

  test("the pass backs off instead of hammering a throttled upstream", () => {
    expect(page).toMatch(/passes < REPAIR_MAX_PASSES/);
    expect(page).toMatch(/emptyStreak\s*>=\s*REPAIR_EMPTY_STREAK_LIMIT/);
  });

  test("upstream searches run one at a time with a pause", () => {
    // Promise.all over the searches resolved nothing at all, live.
    expect(server).not.toMatch(/Promise\.all\w*\([\s\S]{0,200}searchYoutube/);
    expect(server).toContain("REPAIR_SEARCH_GAP_MS");
  });

  test("a throttled search is retried rather than written off", () => {
    // Roughly half of all searches from this IP come back empty, and the
    // empties are not the same rows twice.
    expect(server).toMatch(
      /for \(let attempt = 0; attempt < REPAIR_SEARCH_ATTEMPTS/,
    );
    // and nothing short-circuits the retry on an empty response
    expect(server).toContain("if (items.length > 0) break;");
    expect(server).not.toMatch(/attempt[^\n]*\bbreak\b/);
  });

  test("the repair writes back through an authenticated mutation", () => {
    expect(server).toMatch(
      /applyImportedRepairs = mutation\([\s\S]{0,600}?requireUser\(ctx\)/,
    );
  });

  test("the hero shows the playlist's own covers, not an empty box", () => {
    expect(page).toContain("PlaylistCover");
    expect(page).toMatch(/<PlaylistCover urls=/);
  });
});
