import { describe, expect, test } from "bun:test";
import { readSource } from "./helpers/tailwind-css.js";

const storeSource = readSource("src/store/player.ts");
const importSource = readSource("src/lib/importPlaylist.ts");

describe("stored preferences cannot put the UI and playback in disagreement", () => {
  test("repeat is validated, not cast", () => {
    // `as RepeatMode` accepted anything left in localStorage. The button
    // renders as active for any value that isn't "off", while end-of-track
    // handling only acts on the exact strings "all" and "one" — so a corrupt
    // value lit the button up and then behaved as if repeat were off.
    expect(storeSource).toMatch(
      /const storedRepeat = localStorage\.getItem\("ss\.repeat"\);/,
    );
    expect(storeSource).toMatch(
      /storedRepeat === "all" \|\| storedRepeat === "one" \? storedRepeat : "off"/,
    );
    expect(storeSource).not.toMatch(
      /localStorage\.getItem\("ss\.repeat"\) as RepeatMode/,
    );
  });

  test("cycling always lands on a real mode", () => {
    // `order.indexOf` returns -1 for an unknown value, so a corrupt value
    // would have silently become "off" on the first press instead of
    // reporting the mode it was actually in.
    expect(storeSource).toMatch(
      /const order: RepeatMode\[\] = \["off", "all", "one"\];/,
    );
    const cycle = storeSource.slice(
      storeSource.indexOf("const cycleRepeat = () => {"),
      storeSource.indexOf("const setRate = (rate: number) => {"),
    );
    // Persisted through the guarded writer, so a blocked/full localStorage
    // cannot leave the repeat button lit while playback behaves as "off".
    expect(cycle).toMatch(/writeSetting\("ss\.repeat", next\)/);
    expect(cycle).toMatch(/set\(\{ repeat: next \}\)/);
  });
});

describe("the import parser reads column roles from the header", () => {
  test("no data value is ever tested against header keywords", () => {
    // This single expression is the bug: it matched column CONTENTS against
    // /title|track|song|video/, so a row whose artist was named "Video Games"
    // had that column promoted to the title. Whitespace-tolerant, because
    // Prettier wraps these arrow bodies differently as the file is edited.
    expect(importSource).not.toMatch(
      /findIndex\(\s*\(c, i\) =>[\s\S]{0,120}?\/title\|track\|song\|video\/i\.test\(c/,
    );
    expect(importSource).toMatch(/let headerCols: string\[\] \| null = null;/);
    expect(importSource).toMatch(
      /headerCols = splitCsvLine\(line\)\.map\(\(c\) => c\.toLowerCase\(\)\);/,
    );
    // The roles are read off the header names.
    expect(importSource).toMatch(
      /headerCols\.findIndex\(\(h\) =>\s*\/title\|track name\|song\|video\/i\.test\(h\)/,
    );
    expect(importSource).toMatch(
      /headerCols\.findIndex\(\(h\) =>\s*\/artist\|channel\|album artist\/i\.test\(h\)/,
    );
  });
});
