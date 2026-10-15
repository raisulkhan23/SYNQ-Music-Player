import { describe, expect, test } from 'vitest';
import { readSource } from "./helpers/tailwind-css.js";
// queueOrder.ts is dependency-free.
import { shuffleList } from "../src/lib/queueOrder.ts";

/**
 * Page-level "Play all" / "Shuffle all".
 *
 * Two separate defects made these buttons misbehave:
 *
 * 1. The rest of the list was passed as the track's `alternatives` rather than
 *    as the queue. `alternatives` is only reached for when playback FAILS, so
 *    the queue ended up one track long and the other rows came out as random
 *    error-recovery swaps.
 * 2. Every "Shuffle" button reached for the app's global shuffle preference.
 *    That is a sticky, persisted mode, so one press left shuffle on and the
 *    plain "Play all" beside it played in random order from then on.
 */

const store = readSource("src/store/player.ts");
const recent = readSource("src/pages/Recent.tsx");
const liked = readSource("src/pages/Liked.tsx");
const home = readSource("src/pages/Home.tsx");
const playlistDetail = readSource("src/pages/PlaylistDetail.tsx");

const pages = {
  Recent: recent,
  Liked: liked,
  Home: home,
  PlaylistDetail: playlistDetail,
};

describe("playListOrdered", () => {
  test("the store exposes an ordered playback path", () => {
    expect(store).toContain(
      "playListOrdered: (track: Playable, list: Playable[]) => void;",
    );
    expect(store).toContain(
      "const playListOrdered = (track: Playable, list: Playable[]) => {",
    );
  });

  test("both entry points share one queue builder", () => {
    // Duplicating the "find the track, prepend it if missing" logic is how the
    // two paths drifted in the first place.
    expect(store).toContain("const playResolved = (");
    expect(store).toContain("playResolved(track, list, true)");
    expect(store).toContain("playResolved(track, list, false)");
  });

  test("only the shuffle-respecting path reorders around the track", () => {
    expect(store).toContain(
      "if (respectShuffle && get().shuffle && queue.length > 1) {",
    );
  });
});

describe("no page flicks the global shuffle switch", () => {
  for (const [name, source] of Object.entries(pages)) {
    test(`${name} does not call startShuffle()`, () => {
      // startShuffle() sets a persisted app-wide preference. A page button
      // doing that as a side effect is the bug, not the fix.
      expect(source).not.toContain("startShuffle()");
    });
  }

  test("the four pages order their own list instead", () => {
    for (const source of Object.values(pages)) {
      expect(source).toContain("playListOrdered");
    }
  });
});

describe("Recent", () => {
  test("the rest of the list is the queue, not the track's alternatives", () => {
    const fn = recent.slice(recent.indexOf("const play = (item: YtItem"));
    // `toPlayableYoutube`'s third argument is `alternatives` — other uploads of
    // the SAME song. Handing it the rest of the history is what made the
    // player wander through the list at random.
    expect(fn).toContain(
      "const queue = rest.filter((r) => r.id !== item.id).map(toPlayableFromItem)",
    );
    expect(fn).toContain(
      "const alternatives = found.filter((f) => f.id !== best.id)",
    );
    // Nothing derived from `rest` may reach toPlayableYoutube's third
    // argument any more — that argument is the recovery list, not the queue.
    expect(fn).not.toContain("r.id !== best.id");
  });

  test("every play path hands the queue over", () => {
    const fn = recent.slice(recent.indexOf("const play = (item: YtItem"));
    expect(fn).toContain("start(snapshotToPlayable(entry), queue)");
    expect(fn).toContain(
      "start(\n          toPlayableYoutube(best, `https://youtu.be/${best.id}`, alternatives),\n          queue,\n        )",
    );
  });

  test("shuffle reorders the whole list, head included", () => {
    // Shuffling only the tail left the most recent song always playing first.
    const fn = recent.slice(recent.indexOf("const playAll = "));
    expect(fn).toContain(
      "const ordered = shuffled ? shuffleList(items) : items;",
    );
    expect(fn).toContain("play(head, ordered.slice(1), true)");
    expect(fn).not.toContain("items.slice(1)");
  });

  test("Play all stays in order", () => {
    const fn = recent.slice(recent.indexOf("const playAll = "));
    expect(fn).toContain("shuffled ? shuffleList(items) : items");
  });
});

describe("shuffleList", () => {
  test("returns a new array and leaves the input alone", () => {
    const input = [1, 2, 3, 4, 5];
    const out = shuffleList(input);
    expect(out).not.toBe(input);
    expect(input).toEqual([1, 2, 3, 4, 5]);
  });

  test("is a permutation — nothing added, nothing lost", () => {
    const input = ["a", "b", "c", "d", "e", "f", "g"];
    expect([...shuffleList(input)].sort()).toEqual([...input].sort());
  });

  test("handles the degenerate sizes without throwing", () => {
    expect(shuffleList([])).toEqual([]);
    expect(shuffleList([1])).toEqual([1]);
  });

  test("actually reorders a long list", () => {
    const input = Array.from({ length: 50 }, (_, i) => i);
    const out = shuffleList(input);
    // Astronomically unlikely to be identity, and a no-op shuffle would be a
    // silently broken "Shuffle all".
    expect(out).not.toEqual(input);
  });
});
