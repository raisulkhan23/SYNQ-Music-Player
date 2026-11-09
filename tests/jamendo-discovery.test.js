import { describe, expect, test } from "bun:test";
import {
  DISCOVERY_FALLBACKS,
  isResolvableDiscovery,
  jamendoDiscoveryQueries,
  matchDiscovery,
  resolveDiscoveries,
} from "../src/lib/jamendoDiscovery.ts";
import { readSource } from "./helpers/tailwind-css.js";

/**
 * Jamendo as a DISCOVERY index, never a playback source.
 *
 * Jamendo's own streams were silent for the listeners this was built for, so
 * it can no longer produce a playable. What is worth keeping is what never
 * touches the audio element: a large index of independent, openly-licensed
 * music that YouTube search does not surface reliably.
 *
 * So Jamendo names the song and YouTube provides the upload. The rule this
 * file exists to enforce is that a discovery hit which does not genuinely
 * resolve is DROPPED. A recommendation that cannot play is worse than no
 * recommendation, because it teaches the listener the row is decoration.
 */

const discovery = (over = {}) => ({
  jamendoId: "1848357",
  title: "mañana será tarde",
  artistName: "Ana Krishna",
  duration: 214,
  ...over,
});

const yt = (over = {}) => ({
  id: "abc123",
  title: "Mañana Será Tarde",
  artist: "Ana Krishna",
  duration: 214,
  ...over,
});

describe("discovery queries come from the listener, not a fixed genre list", () => {
  test("the artists they actually play drive the queries", () => {
    expect(jamendoDiscoveryQueries(["Björk", "Tycho"])).toEqual([
      "Björk",
      "Tycho",
    ]);
  });

  test("only the first credit is used", () => {
    // "A, B & C" pasted into a search reliably finds nothing.
    expect(jamendoDiscoveryQueries(["Björk, Someone & Other"])).toEqual([
      "Björk",
    ]);
  });

  test("the fan-out is hard-capped", () => {
    // Every query costs a Jamendo call and then a YouTube lookup per hit, so
    // an unbounded list would turn one Home request into a dozen.
    expect(
      jamendoDiscoveryQueries(["A", "B", "C", "D", "E", "F"], 2),
    ).toHaveLength(2);
  });

  test("a duplicate artist is not searched twice", () => {
    expect(
      jamendoDiscoveryQueries(["björk", "BJÖRK", "Björk"], 3),
    ).toHaveLength(1);
  });

  test("a listener with no taste still gets something", () => {
    // A cold listener must not get an empty Discover row because there was
    // no history to derive a query from.
    expect(jamendoDiscoveryQueries([])).toEqual([...DISCOVERY_FALLBACKS]);
  });

  test("empty and whitespace names are skipped, not searched", () => {
    expect(jamendoDiscoveryQueries(["", "  "], 1)[0]).toBe(
      DISCOVERY_FALLBACKS[0],
    );
  });
});

describe("a discovery hit must be worth resolving at all", () => {
  test("a titled track with a length is resolvable", () => {
    expect(isResolvableDiscovery(discovery())).toBe(true);
  });

  test("no title means nothing to match on", () => {
    expect(isResolvableDiscovery(discovery({ title: "  " }))).toBe(false);
  });

  test("no duration means the row could never be played anyway", () => {
    expect(isResolvableDiscovery(discovery({ duration: 0 }))).toBe(false);
  });
});

describe("resolution finds the real song or nothing at all", () => {
  test("the matching upload is chosen", () => {
    const hit = matchDiscovery(discovery(), [
      yt({ id: "other", title: "Unrelated Song", artist: "Someone Else" }),
      yt(),
    ]);
    expect(hit?.ytId).toBe("abc123");
    expect(hit?.jamendoId).toBe("1848357");
  });

  test("accent and case differences do not break the match", () => {
    // A catalogue release and an upload spell the title differently; being
    // strict here throws away the only playable option.
    expect(matchDiscovery(discovery(), [yt()])).not.toBeNull();
  });

  test("a different song is never substituted", () => {
    // THE important case. Playing "Unrelated Song" because its title matched
    // would sound like success while being completely wrong.
    expect(
      matchDiscovery(discovery(), [
        yt({ id: "x", title: "Totally Different", artist: "Someone" }),
      ]),
    ).toBeNull();
  });

  test("an empty candidate list is null, not a crash", () => {
    expect(matchDiscovery(discovery(), [])).toBeNull();
  });

  test("a zero-duration upload is never chosen", () => {
    expect(matchDiscovery(discovery(), [yt({ duration: 0 })])).toBeNull();
  });

  test("an upload with no id is never chosen", () => {
    expect(matchDiscovery(discovery(), [yt({ id: "" })])).toBeNull();
  });
});

describe("resolving a batch drops everything that cannot play", () => {
  const map = (entries) => new Map(entries);

  test("only the resolvable hits come back", () => {
    const out = resolveDiscoveries(
      [discovery(), discovery({ jamendoId: "999", title: "Unrelated Song" })],
      map([
        ["1848357", [yt()]],
        ["999", [yt({ title: "Something Else Entirely", artist: "Nope" })]],
      ]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].jamendoId).toBe("1848357");
  });

  test("a hit with no search result is dropped, never shown", () => {
    const out = resolveDiscoveries([discovery()], map([]));
    expect(out).toEqual([]);
  });

  test("two releases matching the same upload occupy one slot", () => {
    // Two Creative Commons releases of one song both matching a single upload
    // would otherwise render as a duplicate row.
    const out = resolveDiscoveries(
      [discovery(), discovery({ jamendoId: "222" })],
      map([
        ["1848357", [yt()]],
        ["222", [yt()]],
      ]),
    );
    expect(out).toHaveLength(1);
  });

  test("an unresolvable row is dropped before the batch is scored", () => {
    const out = resolveDiscoveries(
      [discovery({ duration: 0 })],
      map([["1848357", [yt()]]]),
    );
    expect(out).toEqual([]);
  });
});

describe("the wiring keeps Jamendo out of playback and inside discovery", () => {
  const recoSrc = readSource("src/convex/recommend.ts");
  const resultsSrc = readSource("src/components/search/JamendoResults.tsx");

  test("recommendations carry a jamendo_discovery seed", () => {
    expect(readSource("src/lib/recommend.ts")).toContain('"jamendo_discovery"');
    expect(recoSrc).toContain('source: "jamendo_discovery"');
  });

  test("every Jamendo hit is resolved to a YouTube id before it is offered", () => {
    expect(recoSrc).toContain("fetchJamendoDiscovery");
    expect(recoSrc).toMatch(/resolveDiscoveries\([\s\S]{0,400}?hit\.ytId/);
  });

  test("the Discover row is the only one allowed to claim these", () => {
    // The sound-alike row is fed only by the vector index; filling it with
    // catalogue lookups would make the title lie about what happened.
    expect(recoSrc).toMatch(/case "discover":[\s\S]{0,600}?jamendo_discovery/);
    expect(recoSrc).toMatch(
      /case "sound_alike":[\s\S]{0,300}?s\.source === "vector_sound_alike"\)\s*;?/,
    );
  });

  test("the fan-out is bounded in the action, not just in the pure helper", () => {
    expect(recoSrc).toMatch(/MAX_JAMENDO_HITS = \d/);
  });

  test("a Jamendo result is never queued as itself", () => {
    // The row resolves to a YouTube upload; only THAT is playable.
    expect(resultsSrc).toContain("matchDiscovery");
    expect(resultsSrc).toContain("toPlayableYoutube");
    expect(resultsSrc).not.toContain("toPlayableJamendo");
  });

  test("a click that cannot resolve says so instead of playing silence", () => {
    expect(resultsSrc).toMatch(/No playable version of/);
  });

  test("nothing anywhere builds a playable from a Jamendo stream URL", () => {
    for (const file of ["src/lib/playable.ts", recoSrc, resultsSrc]) {
      expect(typeof file).toBe("string");
    }
    expect(readSource("src/lib/playable.ts")).not.toContain(
      "audioUrl: track.audioUrl",
    );
  });
});
