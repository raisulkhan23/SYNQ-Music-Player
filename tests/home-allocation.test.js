import { describe, expect, test } from "bun:test";
import { allocateSections, recordingKey } from "../src/lib/homeShelves.ts";
import { readSource } from "./helpers/tailwind-css.js";

/**
 * Home showed the same songs in New releases, Discover something new, Right now
 * and Sounds of <season>. Each shelf ran its own generic query and rendered its
 * own first six rows, so four nearly-identical lists appeared stacked down the
 * page. These tests pin the coordinator that replaced that.
 */

const song = (id, title, artist = "Artist", album = "Album") => ({
  id,
  title,
  artist,
  album,
  duration: 200,
  thumbnail: `https://img/${id}.jpg`,
});

describe("one recording appears on Home once", () => {
  test("a song returned by two sections is kept by the first", () => {
    const shared = song("t1", "Too Sweet", "Hozier");
    const [first, second] = allocateSections(
      [
        { id: "releases", items: [shared, song("t2", "Bed Chem", "Sabrina Carpenter")] },
        { id: "seasonal", items: [shared, song("t3", "Birds of a Feather", "Billie Eilish")] },
      ],
      { minPerSection: 1 },
    );
    expect(first.items.map((item) => item.id)).toEqual(["t1", "t2"]);
    expect(second.items.map((item) => item.id)).toEqual(["t3"]);
  });

  test("the same recording under a different video id is still one song", () => {
    // Two uploads of one hit is exactly what the page showed twice.
    const [first, second] = allocateSections(
      [
        { id: "a", items: [song("upload1", "Too Sweet", "Hozier")] },
        { id: "b", items: [song("upload2", "Too Sweet", "Hozier")] },
      ],
      { minPerSection: 1 },
    );
    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(0);
  });

  test("legitimate alternate versions are preserved", () => {
    // A live recording is a different recording, and its own title says so.
    const [first, second] = allocateSections(
      [
        { id: "a", items: [song("studio", "Willow", "Taylor Swift", "evermore")] },
        {
          id: "b",
          items: [
            song("live", "Willow (Live)", "Taylor Swift", "The Eras Tour"),
            song("acoustic", "Willow (Acoustic)", "Taylor Swift", "Willow - Single"),
          ],
        },
      ],
      { minPerSection: 1 },
    );
    expect(first.items).toHaveLength(1);
    expect(second.items.map((item) => item.id)).toEqual(["live", "acoustic"]);
  });

  test("a recording reserved without an album is still blocked", () => {
    // History and a search row report the same song under different album
    // labels (a reissue, a deluxe edition), so the album cannot be what
    // decides. This is how Anti-Hero ended up in both "On repeat" and
    // "Right now": the ids differed and the album strings differed.
    const reserved = new Set([
      "t-old",
      recordingKey({ title: "Anti-Hero", artist: "Taylor Swift" }),
    ]);
    const [section] = allocateSections(
      [
        {
          id: "time",
          items: [
            song("t-new", "Anti-Hero", "Taylor Swift", "Midnights (3am Edition)"),
            song("t-other", "Karma", "Taylor Swift", "Midnights"),
          ],
        },
      ],
      { minPerSection: 1, reserved },
    );
    expect(section.items.map((item) => item.id)).toEqual(["t-other"]);
  });

  test("recordings already visible elsewhere on the page are reserved", () => {
    const reserved = new Set(["t1", recordingKey(song("t9", "Espresso", "Sabrina Carpenter"))]);
    const [section] = allocateSections(
      [
        {
          id: "releases",
          items: [
            song("t1", "Too Sweet", "Hozier"),
            song("t9", "Espresso", "Sabrina Carpenter"),
            song("t3", "Birds of a Feather", "Billie Eilish"),
          ],
        },
      ],
      { minPerSection: 1, reserved },
    );
    expect(section.items.map((item) => item.id)).toEqual(["t3"]);
  });
});

describe("a section is dropped rather than padded", () => {
  test("fewer than the minimum removes the row entirely", () => {
    const [section] = allocateSections(
      [{ id: "a", items: [song("t1", "One", "X")] }],
      { minPerSection: 3 },
    );
    expect(section.items).toEqual([]);
  });

  test("the minimum is counted AFTER allocation, not before", () => {
    // Three items in, but two are duplicates of an earlier section: the row
    // would have shown a single card, so it is dropped.
    const [first, second] = allocateSections(
      [
        {
          id: "a",
          items: [
            song("t1", "A1", "X"),
            song("t2", "A2", "X"),
            song("t3", "A3", "X"),
          ],
        },
        {
          id: "b",
          items: [
            song("t1", "A1", "X"),
            song("t2", "A2", "X"),
            song("t4", "B1", "Y"),
          ],
        },
      ],
      { minPerSection: 3 },
    );
    expect(first.items).toHaveLength(3);
    expect(second.items).toEqual([]);
  });

  test("no filler is invented to reach the minimum", () => {
    const [section] = allocateSections([{ id: "a", items: [] }], {
      minPerSection: 3,
    });
    expect(section.items).toEqual([]);
  });

  test("a small but sufficient pool is returned in full", () => {
    const [section] = allocateSections(
      [{ id: "a", items: [song("t1", "A", "X"), song("t2", "B", "X"), song("t3", "C", "X")] }],
      { minPerSection: 3 },
    );
    expect(section.items).toHaveLength(3);
  });
});

describe("a refresh is not a carbon copy", () => {
  test("the rotation offset changes which candidates lead", () => {
    const items = Array.from({ length: 6 }, (_, index) =>
      song(`t${index}`, `Song ${index}`, `Artist ${index}`),
    );
    const [plain] = allocateSections([{ id: "a", items }], {
      minPerSection: 1,
      perSection: 3,
      offset: 0,
    });
    const [rotated] = allocateSections([{ id: "a", items }], {
      minPerSection: 1,
      perSection: 3,
      offset: 3,
    });
    expect(plain.items.map((item) => item.id)).toEqual(["t0", "t1", "t2"]);
    expect(rotated.items.map((item) => item.id)).toEqual(["t3", "t4", "t5"]);
  });

  test("rotation still spends every candidate before repeating one", () => {
    const items = [song("t1", "A", "X"), song("t2", "B", "X")];
    const [first] = allocateSections([{ id: "a", items }], {
      minPerSection: 1,
      offset: 1,
    });
    expect(first.items.map((item) => item.id)).toEqual(["t2", "t1"]);
  });

  test("an empty pool is not a crash", () => {
    const [section] = allocateSections([{ id: "a", items: [] }], { offset: 7 });
    expect(section.items).toEqual([]);
  });
});

describe("Home uses the coordinator instead of per-section slices", () => {
  const home = readSource("src/pages/Home.tsx");

  test("sections render the allocated list", () => {
    expect(home).toMatch(/allocateSections\(/);
    expect(home).toMatch(/discovery\.discover\.map/);
    expect(home).toMatch(/discovery\.timeOfDay\.map/);
    expect(home).toMatch(/discovery\.seasonal\.map/);
    // The recency shelf is no longer a search result: provider search carries
    // no release dates, so "New releases" came from the artist catalogue's
    // dated release list instead.
    expect(home).toMatch(/shelf-new-from-artists/);
    expect(home).toMatch(/release\.year/);
    expect(home).toMatch(/artistReleases/);
  });

  test("each shelf asks a different question", () => {
    // Four phrasings of "popular" returned one pool of ten songs four times.
    expect(home).toMatch(/DISCOVERY_SEEDS/);
    expect(home).toMatch(/TIME_SEEDS/);
    expect(home).toMatch(/SEASON_SEEDS/);
    expect(home).not.toMatch(/query: "new music friday"/);
    expect(home).not.toMatch(/\$\{timeLabel\} music hits/);
    expect(home).not.toMatch(/\$\{season\} hits/);
  });

  test("a failed shelf offers a retry instead of vanishing", () => {
    expect(home).toMatch(/remoteFailures/);
    expect(home).toMatch(/ShelfRetry/);
    expect(home).toMatch(/retryShelves/);
  });

  test("the queries no longer fire concurrently", () => {
    // Concurrent InnerTube searches return empty shelves from this deployment.
    expect(home).not.toMatch(/Promise\.all\(\s*remoteQueries/);
    expect(home).toMatch(/HOME_SHELF_GAP_MS/);
  });

  test("each query keeps a pool, not six rows", () => {
    expect(home).toMatch(/HOME_POOL_SIZE/);
    expect(home).toMatch(/items\.slice\(0, HOME_POOL_SIZE\)/);
  });

  test("a section the allocator emptied is not rendered", () => {
    expect(home).toMatch(/discovery\.seasonal\.length === 0/);
    expect(home).toMatch(/discovery\.discover\.length === 0/);
  });
});
