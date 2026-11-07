import { describe, expect, test } from "bun:test";

import {
  parseYrc,
  parseEnhancedLrc,
  activeWordIndex,
  wordFill,
} from "../src/lib/yrcParse.ts";

/**
 * The karaoke layer's parsers. These are the components that decide whether a
 * word highlight is a FACT (real per-word timings off the wire) or a FABRICATION
 * (inferred) — the suite pins that the fabrication paths do not exist.
 */

const YRC_SAMPLE = [
  "[offset:0]",
  "[12345,6789](12345,120,0)你(12465,180,0)好(12645,300,0)世(12945,400,0)界",
  "[22000,4500](22000,150,0)Hel(22150,150,0)lo(22300,2000,0) world",
].join("\n");

describe("parseYrc (NetEase word timings)", () => {
  test("milliseconds become seconds, words keep their spans", () => {
    const lines = parseYrc(YRC_SAMPLE);
    expect(lines).toHaveLength(2);
    expect(lines[0].t).toBeCloseTo(12.345, 3);
    expect(lines[0].words[0]).toEqual({
      text: "你",
      t0: 12.345,
      t1: 12.465,
    });
    expect(lines[0].text).toBe("你好世界");
    expect(lines[0].end).toBeCloseTo(19.134, 3);
  });

  test("every word's t1 is strictly after its t0", () => {
    const lines = parseYrc(YRC_SAMPLE);
    for (const line of lines) {
      for (const word of line.words) {
        expect(word.t1).toBeGreaterThan(word.t0);
      }
    }
  });

  test("a line header with no word groups is dropped, not rendered empty", () => {
    const lines = parseYrc("[1000,2000]\n[3000,500](3000,500,0)word");
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("word");
  });

  test("malformed payloads return empty — never throw", () => {
    expect(parseYrc(null)).toEqual([]);
    expect(parseYrc("")).toEqual([]);
    expect(parseYrc("not lyrics at all")).toEqual([]);
    expect(parseYrc("[broken\n[999,100](999,50,0)ok")).toHaveLength(1);
  });

  test("lines come out time-sorted regardless of source order", () => {
    const lines = parseYrc(
      "[20000,1000](20000,1000,0)later\n[5000,1000](5000,1000,0)earlier",
    );
    expect(lines[0].text).toBe("earlier");
    expect(lines[1].text).toBe("later");
  });
});

describe("parseEnhancedLrc", () => {
  test("inline <mm:ss.xx> stamps become per-word spans", () => {
    const lines = parseEnhancedLrc(
      "[01:23.45] <01:23.45>Words <01:24.10>follow\n[01:26.00] Plain line",
    );
    expect(lines).toHaveLength(2);
    expect(lines[0].words).toEqual([
      { text: "Words", t0: 83.45, t1: 84.1 },
      { text: "follow", t0: 84.1, t1: 86 },
    ]);
  });

  test("a line without word stamps degrades to one whole-line word", () => {
    const lines = parseEnhancedLrc("[01:00.00] Plain line");
    expect(lines[0].words).toHaveLength(1);
    expect(lines[0].words[0].text).toBe("Plain line");
  });

  test("instrumental markers are not lyrics", () => {
    const lines = parseEnhancedLrc("[00:10.00] [instrumental]");
    expect(lines).toEqual([]);
  });
});

describe("karaoke helpers", () => {
  const line = parseYrc("[1000,2000](1000,1000,0)one(2000,1000,0)two")[0];

  test("activeWordIndex is the last started word", () => {
    expect(activeWordIndex(line, 0.5)).toBe(-1);
    expect(activeWordIndex(line, 1.5)).toBe(0);
    expect(activeWordIndex(line, 2.5)).toBe(1);
  });

  test("wordFill is a clamped 0..1 progression", () => {
    expect(wordFill(line.words[0], 0.5)).toBe(0);
    expect(wordFill(line.words[0], 1.5)).toBeCloseTo(0.5, 5);
    expect(wordFill(line.words[0], 5)).toBe(1);
  });
});
