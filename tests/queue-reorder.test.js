import { describe, expect, test } from "bun:test";
import { moveQueueRow, queueReorderKeys } from "../src/lib/queueOrder";
import { readSource } from "./helpers/tailwind-css.js";

const panelSource = readSource("src/components/player/QueuePanel.tsx");
const storeSource = readSource("src/store/player.ts");

const rows = (ids) => ids.map((id) => ({ id }));

describe("queueReorderKeys", () => {
  test("gives every row a unique value", () => {
    const keys = queueReorderKeys(rows(["a", "b", "c"]));
    expect(new Set(keys).size).toBe(3);
  });

  test("stays unique when the queue holds the same track twice", () => {
    // Duplicate values make Framer Motion stack the two rows on top of each
    // other, so a bare track id is not usable as a reorder value.
    const keys = queueReorderKeys(rows(["a", "b", "a"]));
    expect(new Set(keys).size).toBe(3);
  });

  test("survives a reorder so rows animate instead of remounting", () => {
    const before = rows(["a", "b", "c", "d"]);
    const keys = queueReorderKeys(before);
    // Same tracks, new order.
    const after = [before[2], before[0], before[3], before[1]];
    const afterKeys = queueReorderKeys(after);
    // The multiset of keys is unchanged, so React keeps the same row mounted.
    expect([...afterKeys].sort()).toEqual([...keys].sort());
    expect(afterKeys).not.toEqual(keys);
  });

  test("keeps a duplicated track's keys stable across a reorder", () => {
    const before = rows(["a", "a", "b"]);
    const after = rows(["b", "a", "a"]);
    expect([...queueReorderKeys(after)].sort()).toEqual(
      [...queueReorderKeys(before)].sort(),
    );
  });
});

describe("moveQueueRow", () => {
  const keys = queueReorderKeys(rows(["a", "b", "c"]));

  test("moves a row up", () => {
    expect(moveQueueRow(keys, 2, 1)).toEqual([keys[0], keys[2], keys[1]]);
  });

  test("moves a row down", () => {
    expect(moveQueueRow(keys, 0, 1)).toEqual([keys[1], keys[0], keys[2]]);
  });

  test("rejects out-of-bounds and no-op moves", () => {
    expect(moveQueueRow(keys, 0, -1)).toBeNull();
    expect(moveQueueRow(keys, 0, 3)).toBeNull();
    expect(moveQueueRow(keys, -1, 0)).toBeNull();
    expect(moveQueueRow(keys, 2, 2)).toBeNull();
  });

  test("does not mutate the input", () => {
    const before = [...keys];
    moveQueueRow(keys, 0, 2);
    expect(keys).toEqual(before);
  });
});

describe("queue reorder wiring", () => {
  // The up/down arrows and drag both funnel through `handleReorder`, which has
  // to hand the store the list it actually rendered. Without that second
  // argument the store cannot tell a real reorder from a stale render, so it
  // discarded every change and the controls did nothing at all.
  test("handleReorder passes the rendered list as the store's base", () => {
    expect(panelSource).toMatch(/reorderUpcoming\(reordered, upcoming\)/);
  });

  test("reorder keys are not derived from the row index", () => {
    // An index-based value changes on every move, which remounts the rows and
    // kills the reorder animation.
    expect(panelSource).not.toMatch(/\$\{track\.id\}#\$\{/);
    expect(panelSource).toMatch(/queueReorderKeys\(upcoming\)/);
  });

  test("rows are keyed by the stable reorder value", () => {
    expect(panelSource).toMatch(/key=\{upcomingKeys\[rowIndex\]\}/);
  });

  test("the store validates staleness against base, not the new order", () => {
    expect(storeSource).toMatch(/reorderUpcoming: \(upcoming, base\)/);
    expect(storeSource).toMatch(/!Array\.isArray\(base\)/);
  });

  test("reordering preserves history and the current track", () => {
    // A reorder must splice into the existing queue, not rebuild it as
    // [current, ...upcoming], which used to drop played tracks and reset the
    // play position.
    expect(storeSource).toMatch(
      /const queue = \[\.\.\.state\.queue\.slice\(0, start\), \.\.\.upcoming\]/,
    );
  });
});
