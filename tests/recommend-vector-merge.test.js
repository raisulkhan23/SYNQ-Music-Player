import { describe, expect, test } from "bun:test";
import { applyExclusions, mergeExtra, poolIds } from "../src/lib/recoMerge.ts";
import { artistKey } from "../src/lib/notInterested.ts";
import { readSource } from "./helpers/tailwind-css.js";

/**
 * The recommender's new pool operations, executed.
 *
 * The action itself cannot be driven in this harness, and the reason is
 * structural rather than a missing fixture: `src/convex/_generated/api`
 * resolves every function through a deep proxy that hands back a NEW proxy on
 * every property access. So `api.x.y === api.x.y` is false, no property yields
 * a readable path, and a stub cannot tell `searchYoutube` from
 * `vectorCandidates`. Mocking the module is worse, not better: measured, a
 * mocked api makes `forYou` return an empty payload without making a single
 * call, so a test built on it asserts nothing.
 *
 * That is precisely why the merge logic was factored into `src/lib/recoMerge.ts`
 * — so the code the app runs is the code these tests run. The call sites in
 * `convex/recommend.ts` are asserted separately below; those assertions are
 * weaker by nature and are labelled as such rather than passed off as proof.
 */

const cand = (id, artist) => ({
  id,
  artist,
  title: `t-${id}`,
  duration: 200,
  thumbnail: "",
});
const ids = (pool) => pool.map((c) => c.id);

describe("vector candidates are added, not substituted", () => {
  const pool = [cand("yt-1", "Fine Artist")];
  const extra = [cand("vec-1", "Unknown Band"), cand("vec-2", "Also Unknown")];

  test("the merged pool contains both the search results and the sound-alikes", () => {
    const out = mergeExtra(pool, extra, null);
    expect(out).not.toBeNull();
    expect(out.added).toBe(2);
    expect(ids(out.pool).sort()).toEqual(["vec-1", "vec-2", "yt-1"]);
  });

  test("the original pool is not mutated", () => {
    const before = ids(pool);
    mergeExtra(pool, extra, null);
    expect(ids(pool)).toEqual(before);
  });

  test("a cold index returns null so the caller leaves the pool alone", () => {
    // The critical branch. Returning an empty merge instead would let
    // forYou emit a "Sounds like what you play" row filled with the very
    // text-search results it was meant to replace.
    expect(mergeExtra(pool, [], null)).toBeNull();
    expect(mergeExtra(pool, [], { trackIds: [], artistKeys: [] })).toBeNull();
  });

  test("an index whose every candidate is rejected is also a no-op", () => {
    // Better no row at all than a row full of things the listener refused.
    const out = mergeExtra(pool, [cand("vec-1", "Björk")], {
      trackIds: [],
      artistKeys: [artistKey("Bjork")],
    });
    expect(out).toBeNull();
  });
});

describe("a rejection beats the sound-alike index", () => {
  test("a rejected artist is not smuggled back in via similarity", () => {
    const pool = [cand("yt-1", "Fine Artist")];
    const out = mergeExtra(
      pool,
      [cand("vec-1", "Björk"), cand("vec-2", "Fine Artist")],
      { trackIds: [], artistKeys: [artistKey("Bjork")] },
    );
    expect(ids(out.usable)).toEqual(["vec-2"]);
    expect(ids(out.pool)).toContain("vec-2");
    expect(ids(out.pool)).not.toContain("vec-1");
  });

  test("a rejected track is not smuggled back in either", () => {
    const out = mergeExtra([cand("yt-1", "Fine")], [cand("vec-9", "Fine")], {
      trackIds: ["vec-9"],
      artistKeys: [],
    });
    expect(out).toBeNull();
  });
});

describe("applyExclusions is the single filter both callers share", () => {
  test("it removes a rejected track and keeps the rest", () => {
    const out = applyExclusions([cand("a", "X"), cand("b", "Y")], {
      trackIds: ["a"],
      artistKeys: [],
    });
    expect(ids(out)).toEqual(["b"]);
  });

  test("it is a no-op with no exclusions, and returns the same array", () => {
    const pool = [cand("a", "X")];
    expect(applyExclusions(pool, null)).toBe(pool);
    expect(applyExclusions(pool, { trackIds: [], artistKeys: [] })).toBe(pool);
  });

  test("poolIds answers membership for a whole pool at once", () => {
    expect(poolIds([cand("a", "X"), cand("b", "Y")])).toEqual(
      new Set(["a", "b"]),
    );
  });
});

describe("the action calls this code rather than reimplementing it", () => {
  // Weaker than the tests above by nature — these are assertions about the
  // source text, not about behaviour, and they are here only to catch the case
  // where the logic is correct but nobody wired it in. They cannot and do not
  // replace the behavioural coverage.
  const server = readSource("src/convex/recommend.ts");

  test("both forYou and nextTrack use the shared helpers", () => {
    const uses = server.match(/applyExclusions\(/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
    const merges = server.match(/mergeExtra\(/g) ?? [];
    expect(merges.length).toBeGreaterThanOrEqual(2);
  });

  test("neither handler filters inline any more", () => {
    // A second filtering implementation in the action is how the two paths
    // drift apart and one of them quietly stops honouring a rejection.
    expect(server).not.toContain("filterExcluded(");
  });

  test("a failed vector fetch yields an empty list, never a throw", () => {
    expect(server).toContain("return [];");
    expect(server).toContain("catch {");
  });

  test("the sound-alike row is fed by the vector seed, and only it", () => {
    const fn = server.slice(
      server.indexOf("function seedsForSection"),
      server.indexOf("function sectionEligibility"),
    );
    expect(fn).toContain('s.source === "vector_sound_alike"');
  });
});

describe("the vector index is only consulted when it can say something", () => {
  const vectors = readSource("src/convex/recommendVectors.ts");

  test("records with no playable id never become rows", () => {
    // A row the listener can click but that does nothing is worse than an
    // absent row, and the vector index can hold records with no YouTube id.
    expect(vectors).toContain(
      "if (!youtubeId || !title || duration <= 0) continue;",
    );
  });

  test("a cold index short-circuits before any similarity work", () => {
    expect(vectors).toContain("db.store.list({ limit: 1 })");
  });

  test("one failing seed does not abandon the others", () => {
    const idx = vectors.indexOf("catch {", vectors.indexOf("db.similar("));
    expect(idx).toBeGreaterThan(vectors.indexOf("db.similar("));
  });
});
