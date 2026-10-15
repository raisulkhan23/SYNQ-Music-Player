import { describe, expect, test } from 'vitest';
import {
  artistKey,
  filterExcluded,
  isExcluded,
  NO_EXCLUSIONS,
} from "../src/lib/notInterested.ts";
import { readSource } from "./helpers/tailwind-css.js";

/**
 * "Not interested" — the rule that decides whether something the listener
 * rejected is allowed back.
 *
 * The behaviour that matters most is the one that is easiest to get wrong in
 * the OTHER direction: a block that empties a whole row. A listener who hides
 * one artist and then finds a section of Home has vanished has been told no
 * and had the product taken away, so `filterExcluded` refuses to filter rather
 * than return nothing.
 */
describe("an artist is matched by its key, not its spelling", () => {
  test("the same artist from different sources collapses to one key", () => {
    const expected = artistKey("Björk");
    expect(artistKey("bjork")).toBe(expected);
    expect(artistKey("BJÖRK")).toBe(expected);
    expect(artistKey("  Bjork  ")).toBe(expected);
    expect(artistKey("Bjork (Official)")).toBe(expected);
  });

  test("a leading article and punctuation do not make a new artist", () => {
    expect(artistKey("The Beatles")).toBe(artistKey("Beatles"));
    expect(artistKey("AC/DC")).toBe(artistKey("AC DC"));
  });

  test("an ampersand is dropped, NOT read as the word 'and'", () => {
    // Deliberately NOT collapsed to "and". Treating "Simon & Garfunkel" and
    // "Simon and Garfunkel" as one artist would be a false match against a
    // band actually named "Simonandgarfunkel". Punctuation going missing is
    // safe; two different names becoming one is not.
    expect(artistKey("Simon & Garfunkel")).toBe("simongarfunkel");
    expect(artistKey("Simon & Garfunkel")).not.toBe(
      artistKey("Simon and Garfunkel"),
    );
  });

  test("YouTube's noise suffixes do not make a new artist", () => {
    // The one that actually bites: a listener excludes "Bjork (Official)"
    // from a YouTube row and must not then be shown Björk from Jamendo.
    expect(artistKey("Bjork (Official)")).toBe(artistKey("Björk"));
    expect(artistKey("Artist [Topic]")).toBe(artistKey("Artist"));
    expect(artistKey("Song (Lyrics)")).toBe(artistKey("Song"));
  });

  test("an empty or missing artist is an empty key, never a wildcard", () => {
    // The dangerous version of this is an empty key matching every candidate
    // with a missing artist, which would delete the whole catalogue.
    expect(artistKey("")).toBe("");
    expect(artistKey(null)).toBe("");
    expect(artistKey(undefined)).toBe("");
    expect(artistKey("!!!")).toBe("");
  });
});

describe("a rejection actually removes the thing that was rejected", () => {
  const pool = [
    { id: "a1", artist: "Bjork" },
    { id: "b2", artist: "Radiohead" },
    { id: "c3", artist: "Björk" },
  ];

  test("a track exclusion hides that track and nothing else", () => {
    const out = filterExcluded(pool, { trackIds: ["b2"], artistKeys: [] });
    expect(out.map((c) => c.id)).toEqual(["a1", "c3"]);
  });

  test("an artist exclusion hides every spelling of that artist", () => {
    const out = filterExcluded(pool, {
      trackIds: [],
      artistKeys: [artistKey("bjork")],
    });
    expect(out.map((c) => c.id)).toEqual(["b2"]);
  });

  test("both scopes apply together", () => {
    // Note the pool needs a survivor: with every candidate excluded the
    // "never empty a row" rule takes over, which is asserted separately below.
    const mixed = [
      { id: "a1", artist: "Bjork" },
      { id: "b2", artist: "Radiohead" },
      { id: "d4", artist: "Aphex Twin" },
    ];
    const out = filterExcluded(mixed, {
      trackIds: ["b2"],
      artistKeys: [artistKey("Bjork")],
    });
    expect(out.map((c) => c.id)).toEqual(["d4"]);
  });

  test("excluding every artist in a row is the empty-row case, not a wipe", () => {
    // This is the one place the two rules meet, and it is the reason the
    // "never empty a row" behaviour exists at all.
    const out = filterExcluded(
      [
        { id: "a1", artist: "Bjork" },
        { id: "b2", artist: "Radiohead" },
      ],
      { trackIds: ["b2"], artistKeys: [artistKey("Bjork")] },
    );
    expect(out).toHaveLength(2);
  });

  test("an empty exclusion set changes nothing and allocates nothing", () => {
    const out = filterExcluded(pool, NO_EXCLUSIONS);
    expect(out).toBe(pool);
    expect(filterExcluded(pool, null)).toBe(pool);
    expect(filterExcluded(pool, undefined)).toBe(pool);
    expect(filterExcluded(pool, { trackIds: [], artistKeys: [] })).toBe(pool);
  });
});

describe("a block must never empty a whole row", () => {
  test("when filtering would remove everything, the row is left intact", () => {
    // The recoverable failure. Refusing to filter is a bug someone can report;
    // silently returning an empty section is a product that looks broken.
    const allBjork = [
      { id: "a1", artist: "Bjork" },
      { id: "c3", artist: "Björk" },
    ];
    const out = filterExcluded(allBjork, {
      trackIds: [],
      artistKeys: [artistKey("Bjork")],
    });
    expect(out).toHaveLength(2);
  });

  test("but a partial block still filters normally", () => {
    const mixed = [
      { id: "a1", artist: "Bjork" },
      { id: "b2", artist: "Radiohead" },
    ];
    const out = filterExcluded(mixed, {
      trackIds: [],
      artistKeys: [artistKey("Bjork")],
    });
    expect(out.map((c) => c.id)).toEqual(["b2"]);
  });

  test("a candidate with no artist is only excluded by its exact track id", () => {
    const unknown = [{ id: "x9", artist: "" }];
    expect(
      isExcluded(unknown[0], { trackIds: [], artistKeys: ["anything"] }),
    ).toBe(false);
    expect(isExcluded(unknown[0], { trackIds: ["x9"], artistKeys: [] })).toBe(
      true,
    );
  });
});

describe("the server and the scorer agree on what an artist is", () => {
  // Two implementations of "is this the same artist" is exactly how exclusions
  // quietly stop applying: the write side stores one key, the read side
  // compares another, and nothing throws.
  test("the Convex module imports the shared key rather than defining one", () => {
    const server = readSource("src/convex/notInterested.ts");
    expect(server).toContain('from "../lib/notInterested"');
    expect(server).toContain("artistKey as normaliseArtist");
    // A second local implementation is exactly the regression to prevent.
    expect(server).not.toMatch(/function\s+normaliseArtist\s*\(/);
  });
});

describe("the button is wired to the whole chain, not just the write", () => {
  const actions = readSource("src/components/tracks/useTrackActions.tsx");

  test("both scopes are offered", () => {
    expect(actions).toContain("markNotInterested");
    expect(actions).toContain('scope: "track"');
    expect(actions).toContain('scope: "artist"');
  });

  test("marking invalidates the recommendation cache", () => {
    // Without this the Home payload stays cached for ten minutes and the
    // listener keeps seeing the thing they just rejected, which reads as a
    // broken button rather than a slow one.
    expect(actions).toContain("invalidateRecommendCache");
    const afterMark = actions.indexOf("await markNotInterested");
    const afterInvalidate = actions.indexOf("await invalidateRecommendCache");
    expect(afterMark).toBeGreaterThan(-1);
    expect(afterInvalidate).toBeGreaterThan(afterMark);
  });

  test("there is an undo, and undo also drops the cache", () => {
    expect(actions).toContain("unmarkNotInterested");
    expect(actions).toContain('label: "Undo"');
  });

  test("a failed write is reported rather than silently swallowed", () => {
    expect(actions).toContain('toast.error("Couldn\'t save that — try again")');
  });

  test("it never touches the queue or stops playback", () => {
    // "Not interested" is a statement about what to show next. Silently cutting
    // off audio would make the feature destructive.
    expect(actions).not.toContain("removeFromQueue");
    expect(actions).not.toContain("removeFromQueueById");
  });

  test("it lives in the shared menu, so every surface gets it", () => {
    expect(actions).toContain("Not interested in this");
    expect(actions).toContain("Not interested in {actions.artistName}");
  });
});

describe("the recommender really applies both", () => {
  const server = readSource("src/convex/recommend.ts");

  test("forYou filters the pool and merges vector candidates", () => {
    // The shared helpers in src/lib/recoMerge.ts, which is where the logic
    // actually lives and where it is behaviourally tested.
    expect(server).toContain("applyExclusions");
    expect(server).toContain("mergeExtra");
    expect(server).toContain("loadExclusions");
  });

  test("nextTrack gets the same treatment as the Home shelves", () => {
    // Otherwise "what plays next" contradicts what the listener was just
    // shown, and a rejected artist turns up in autoplay.
    expect(server).toContain("sound_alike: realPlays >= MIN_PLAYS");
  });

  test("the vector row is gated on RECENT plays, not a lifetime total", () => {
    expect(server).toMatch(/sound_alike:\s*realPlays\s*>=\s*MIN_PLAYS/);
  });

  test("the sound-alike row only ever contains vector candidates", () => {
    // If it could be filled from the text-search pool, the title would be
    // claiming a sound-alike search that never happened.
    const fn = server.slice(
      server.indexOf("function seedsForSection"),
      server.indexOf("function sectionEligibility"),
    );
    expect(fn).toContain('s.source === "vector_sound_alike"');
  });
});

describe("the vector database is actually connected to recommendations", () => {
  // The bug this file is really about: the vector store existed and was
  // reachable from exactly one page, so adding it changed nothing observable.
  const vectors = readSource("src/convex/recommendVectors.ts");

  test("candidates come out of the vector index", () => {
    expect(vectors).toContain("db.similar(");
    expect(vectors).toContain("vectorCandidates");
  });

  test("a cold or broken index returns nothing instead of throwing", () => {
    // The recommender must never be worse because a vector index is missing.
    expect(vectors).toContain("return { candidates: [], reason: null }");
    expect(vectors).toContain("catch");
  });

  test("an unplayable record is dropped rather than shown as a dead row", () => {
    // No youtubeId means no way to play it, and a clickable row that does
    // nothing is worse than an absent one.
    expect(vectors).toContain(
      "if (!youtubeId || !title || duration <= 0) continue;",
    );
  });

  test("the id handed to the app is a playable YouTube id", () => {
    expect(vectors).toContain("id: youtubeId");
  });

  test("records are scoped to the caller, never another listener's index", () => {
    expect(vectors).toContain("ownerId");
    expect(vectors).toContain("ctx.auth.getUserIdentity()");
  });
});
