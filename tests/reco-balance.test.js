import { describe, expect, test } from "bun:test";
import {
  artistKey,
  buildSeeds,
  buildSignals,
  DISCOVERY_ANCHOR_MIN_EVIDENCE,
} from "../src/lib/recommend.ts";
import {
  allocateWithBudget,
  blendDiscovery,
  capPerArtist,
  discoveryAnchors,
  excludeAnchors,
  DEFAULT_ARTIST_BUDGET,
  DEFAULT_MIN_PER_SECTION,
} from "../src/lib/recoBalance.ts";
// The COMPARISON key, which is what exclusions are stored with and what the
// balance rules match on. (`recommend.ts` exports a display-oriented variant.)
import { artistKey as cmpKey, filterExcluded } from "../src/lib/notInterested.ts";

const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** A candidate shaped exactly like the ones the Convex action resolves. */
const cand = (id, artist, title = "Song") => ({
  id,
  title,
  artist,
  duration: 200,
  thumbnail: `https://img/${id}.jpg`,
});

const play = (trackId, artistName, at = NOW) => ({
  trackId,
  artistName,
  at,
  completion: 1,
});

const user = (plays, extra = {}) => ({
  userId: "u",
  plays,
  likes: [],
  playlists: [],
  ...extra,
});

// ---------------------------------------------------------------------------
// Test A — the Taylor Swift dominance problem
// ---------------------------------------------------------------------------

describe("A — one play cannot define discovery", () => {
  const swiftOnly = user([play("ts1", "Taylor Swift")]);
  const signals = buildSignals(swiftOnly, NOW);

  test("a single play is not treated as an established artist", () => {
    const profile = signals.artists.get(artistKey("Taylor Swift"));
    expect(profile).toBeDefined();
    expect(profile.evidence).toBeLessThan(DISCOVERY_ANCHOR_MIN_EVIDENCE);
  });

  test("no discovery search is anchored on the artist from one play", () => {
    const seeds = buildSeeds(signals, swiftOnly, { maxSeeds: 6 });
    expect(seeds.some((s) => s.source === "discovery")).toBe(false);
    // …but the row is not switched off: broad exploration covers it.
    expect(seeds.some((s) => s.source === "broad_discovery")).toBe(true);
  });

  test("the provider answering with the anchor's catalogue cannot refill it", () => {
    // This is the exact failure: "new songs like Taylor Swift" coming back as
    // Taylor Swift. The anchors are removed from the RESULTS, so even a pool
    // that is entirely the anchor yields an empty related slice rather than a
    // row of one artist.
    const anchors = discoveryAnchors(signals.artists.values(), 3);
    const related = excludeAnchors(
      [
        cand("ts1", "Taylor Swift"),
        cand("ts2", "Taylor Swift - Topic"),
        cand("ts3", "TaylorSwiftVEVO"),
      ],
      anchors,
    );
    expect(related).toHaveLength(0);

    const row = blendDiscovery({
      related,
      adjacent: [cand("a1", "Phoebe Bridgers"), cand("a2", "MUNA")],
      broad: [cand("b1", "Big Thief"), cand("b2", "Japanese Breakfast")],
    });
    expect(row).toHaveLength(4);
    expect(row.every((item) => cmpKey(item.artist) !== cmpKey("Taylor Swift"))).toBe(
      true,
    );
    expect(new Set(row.map((item) => cmpKey(item.artist))).size).toBe(4);
  });

  test("the whole profile barely moves on one play", () => {
    expect(signals.confidence).toBeLessThan(0.35);
  });
});

// ---------------------------------------------------------------------------
// Test B — established preferences
// ---------------------------------------------------------------------------

describe("B — an established listener gets breadth, not one favourite", () => {
  const plays = [
    ...Array.from({ length: 4 }, (_, i) => play(`a${i}`, "Artist A")),
    ...Array.from({ length: 4 }, (_, i) => play(`b${i}`, "Artist B")),
    ...Array.from({ length: 3 }, (_, i) => play(`c${i}`, "Artist C")),
    ...Array.from({ length: 2 }, (_, i) => play(`d${i}`, "Artist D")),
  ];
  const signals = buildSignals(user(plays), NOW);

  test("the profile is confident and several artists are established", () => {
    expect(signals.confidence).toBeGreaterThan(0.6);
    const established = [...signals.artists.values()].filter(
      (p) => p.evidence >= DISCOVERY_ANCHOR_MIN_EVIDENCE,
    );
    expect(established.length).toBeGreaterThanOrEqual(3);
  });

  test("discovery anchors come from the strongest artists, capped", () => {
    const anchors = discoveryAnchors(signals.artists.values(), 2);
    expect(anchors.size).toBe(2);
    expect(anchors.has(cmpKey("Artist A"))).toBe(true);
    expect(anchors.has(cmpKey("Artist D"))).toBe(false);
  });

  test("no artist can take more than the page-wide budget", () => {
    const pool = Array.from({ length: 30 }, (_, i) =>
      cand(`x${i}`, i % 2 === 0 ? "Artist A" : "Artist B"),
    );
    const allocated = allocateWithBudget(
      [
        { id: "for_you", pool },
        { id: "from_artists", pool },
      ],
      {
        perSection: 14,
        minPerSection: 2,
        maxPerArtistTotal: DEFAULT_ARTIST_BUDGET,
        sectionArtistCap: { for_you: 3, from_artists: 2 },
      },
    );
    const all = allocated.flatMap((section) => section.items);
    const perArtist = new Map();
    for (const item of all) {
      const key = cmpKey(item.artist);
      perArtist.set(key, (perArtist.get(key) ?? 0) + 1);
    }
    for (const count of perArtist.values()) {
      expect(count).toBeLessThanOrEqual(DEFAULT_ARTIST_BUDGET);
    }
    // Two artists cannot fill a page: the second shelf is honestly empty
    // rather than padded.
    expect(allocated[0].items.length).toBeGreaterThan(0);
    expect(allocated[1].items.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test C — limited history
// ---------------------------------------------------------------------------

describe("C — thin history is not over-read", () => {
  test("confidence rises with evidence and never claims certainty early", () => {
    const one = buildSignals(user([play("p", "A")]), NOW);
    const four = buildSignals(
      user(Array.from({ length: 4 }, (_, i) => play(`p${i}`, "A"))),
      NOW,
    );
    const twelve = buildSignals(
      user(Array.from({ length: 12 }, (_, i) => play(`p${i}`, `A${i % 4}`))),
      NOW,
    );
    expect(one.confidence).toBeLessThan(four.confidence);
    expect(four.confidence).toBeLessThan(twelve.confidence);
    expect(twelve.confidence).toBe(1);
  });

  test("breadth alone can anchor discovery, depth is not the only route", () => {
    // Eight artists, one play each: no single artist is established, but the
    // direction is clear enough to explore from the strongest of them.
    const broad = user(
      Array.from({ length: 8 }, (_, i) => play(`p${i}`, `Artist ${i}`)),
    );
    const signals = buildSignals(broad, NOW);
    expect(signals.confidence).toBeGreaterThanOrEqual(0.5);
    const seeds = buildSeeds(signals, broad, { maxSeeds: 6 });
    expect(seeds.some((s) => s.source === "discovery")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test D — insufficient provider results
// ---------------------------------------------------------------------------

describe("D — a thin provider is topped up from other real sources", () => {
  test("two related results do not make a two-card row", () => {
    const row = blendDiscovery({
      related: [cand("r1", "Artist One"), cand("r2", "Artist Two")],
      adjacent: [cand("a1", "Artist Three"), cand("a2", "Artist Four")],
      broad: [cand("b1", "Artist Five"), cand("b2", "Artist Six")],
    });
    expect(row.length).toBeGreaterThan(2);
    expect(new Set(row.map((item) => cmpKey(item.artist))).size).toBe(6);
  });

  test("when there is genuinely nothing, the row stays short — never padded", () => {
    const row = blendDiscovery({
      related: [cand("r1", "Only Artist")],
      adjacent: [],
      broad: [],
    });
    expect(row).toHaveLength(1);
  });

  test("a duplicate id arriving from two providers is used once", () => {
    const row = blendDiscovery({
      related: [cand("same", "Artist One")],
      adjacent: [cand("same", "Artist One")],
      broad: [cand("other", "Artist Two")],
    });
    expect(row.filter((item) => item.id === "same")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Test E — negative feedback
// ---------------------------------------------------------------------------

describe("E — explicit rejection outranks a skip", () => {
  test("a disliked artist is removed from the pool outright", () => {
    const pool = [
      cand("1", "Rejected Artist"),
      cand("2", "Fine Artist"),
    ];
    const kept = filterExcluded(pool, {
      trackIds: [],
      artistKeys: [cmpKey("Rejected Artist")],
    });
    expect(kept.map((item) => item.artist)).toEqual(["Fine Artist"]);
  });

  test("an ordinary skip lowers affinity without banning the artist", () => {
    // One skip must not become a permanent exclusion: the artist stays in the
    // profile (so they can recover) while a played artist outranks them.
    const skipped = buildSignals(
      user([
        { trackId: "s1", artistName: "Skipped Artist", at: NOW, skipped: true, listenedSeconds: 3 },
        play("p1", "Played Artist"),
      ]),
      NOW,
    );
    const skippedProfile = skipped.artists.get(artistKey("Skipped Artist"));
    const playedProfile = skipped.artists.get(artistKey("Played Artist"));
    expect(skippedProfile).toBeDefined();
    expect(skippedProfile.affinity).toBeLessThan(playedProfile.affinity);
    expect(skippedProfile.interactions).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test F — cross-shelf duplicates
// ---------------------------------------------------------------------------

describe("F — one recording appears once across Home", () => {
  test("the same id in two shelves is spent by the first", () => {
    const shared = cand("dup", "Artist One");
    const allocated = allocateWithBudget(
      [
        { id: "for_you", pool: [shared, cand("x", "Artist Two")] },
        { id: "discover", pool: [shared, cand("y", "Artist Three")] },
      ],
      { perSection: 10, minPerSection: 1, maxPerArtistTotal: 5 },
    );
    expect(allocated[0].items.map((i) => i.id)).toContain("dup");
    expect(allocated[1].items.map((i) => i.id)).not.toContain("dup");
  });

  test("the same song under different ids is recognised by title and artist", () => {
    // Providers hand the same recording back under different ids (a reissue,
    // an "official audio" upload). Identity is title + artist, not the id.
    const allocated = allocateWithBudget(
      [
        { id: "for_you", pool: [cand("id1", "Artist One", "Willow")] },
        { id: "discover", pool: [cand("id2", "Artist One", "Willow (Official Audio)")] },
      ],
      { perSection: 10, minPerSection: 1, maxPerArtistTotal: 5 },
    );
    expect(allocated[1].items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test G — determinism (the client half of "no full regeneration")
// ---------------------------------------------------------------------------

describe("G — the same inputs produce the same page", () => {
  test("ranking and allocation are pure", () => {
    const signals = buildSignals(
      user(Array.from({ length: 6 }, (_, i) => play(`p${i}`, `Artist ${i}`))),
      NOW,
    );
    const seedsA = buildSeeds(signals, user([]), { maxSeeds: 6 });
    const seedsB = buildSeeds(signals, user([]), { maxSeeds: 6 });
    expect(seedsA).toEqual(seedsB);

    const pools = [
      { id: "for_you", pool: [cand("1", "A"), cand("2", "B"), cand("3", "C")] },
      { id: "from_artists", pool: [cand("4", "D"), cand("5", "E")] },
    ];
    expect(allocateWithBudget(pools, { perSection: 2, minPerSection: 1 })).toEqual(
      allocateWithBudget(pools, { perSection: 2, minPerSection: 1 }),
    );
  });
});

// ---------------------------------------------------------------------------
// Test H — different users stay different
// ---------------------------------------------------------------------------

describe("H — two listeners get two different pages", () => {
  const rock = buildSignals(
    user(Array.from({ length: 6 }, (_, i) => play(`r${i}`, "Rock Band"))),
    NOW,
  );
  const jazz = buildSignals(
    user(Array.from({ length: 6 }, (_, i) => play(`j${i}`, "Jazz Trio"))),
    NOW,
  );

  test("their anchors differ", () => {
    expect([...discoveryAnchors(rock.artists.values(), 1)]).toEqual([
      cmpKey("Rock Band"),
    ]);
    expect([...discoveryAnchors(jazz.artists.values(), 1)]).toEqual([
      cmpKey("Jazz Trio"),
    ]);
  });

  test("their discovery searches differ", () => {
    const rockSeeds = buildSeeds(rock, user([]), { maxSeeds: 6 });
    const jazzSeeds = buildSeeds(jazz, user([]), { maxSeeds: 6 });
    expect(rockSeeds.map((s) => s.query)).not.toEqual(
      jazzSeeds.map((s) => s.query),
    );
  });
});

// ---------------------------------------------------------------------------
// Test I — guest listeners
// ---------------------------------------------------------------------------

describe("I — a guest is never given a fabricated taste", () => {
  test("no plays means no profile and one honest global seed", () => {
    const empty = buildSignals(user([]), NOW);
    expect(empty.personalised).toBe(false);
    expect(empty.confidence).toBe(0);
    const seeds = buildSeeds(empty, user([]), { maxSeeds: 6 });
    expect(seeds).toHaveLength(1);
    expect(seeds[0].source).toBe("global");
    expect(seeds[0].reason).toBe("global_fallback");
  });
});

// ---------------------------------------------------------------------------
// The rules themselves
// ---------------------------------------------------------------------------

describe("the balance rules", () => {
  test("capPerArtist keeps the first N by an artist, preserving order", () => {
    const capped = capPerArtist(
      [cand("1", "A"), cand("2", "B"), cand("3", "A"), cand("4", "A")],
      1,
    );
    expect(capped.map((i) => i.id)).toEqual(["1", "2"]);
  });

  test("anchors are matched through the engine's artist normalisation", () => {
    const anchors = new Set([cmpKey("Taylor Swift")]);
    const kept = excludeAnchors(
      [
        cand("1", "Taylor Swift"),
        cand("2", "Taylor Swift - Topic"),
        cand("3", "TaylorSwiftVEVO"),
        cand("4", "Sabrina Carpenter"),
      ],
      anchors,
    );
    expect(kept.map((i) => i.id)).toEqual(["4"]);
  });

  test("the discovery blend follows its 60/25/15 starting weights", () => {
    const make = (prefix, count) =>
      Array.from({ length: count }, (_, i) => cand(`${prefix}${i}`, `${prefix} Artist ${i}`));
    const row = blendDiscovery({
      related: make("r", 20),
      adjacent: make("a", 20),
      broad: make("b", 20),
    });
    const of = (prefix) => row.filter((item) => item.id.startsWith(prefix)).length;
    // 14 slots: 8 related / 4 adjacent / 2 broad, ±1 for the remainder round.
    expect(of("r")).toBeGreaterThan(of("a"));
    expect(of("a")).toBeGreaterThan(of("b"));
    expect(row).toHaveLength(14);
  });

  test("a shelf below its floor is dropped rather than shown half-empty", () => {
    const allocated = allocateWithBudget(
      [
        {
          id: "for_you",
          pool: [
            cand("1", "A"),
            cand("2", "B"),
            cand("3", "C"),
            cand("4", "D"),
          ],
        },
        { id: "discover", pool: [cand("5", "E"), cand("6", "F")] },
      ],
      { perSection: 14, minPerSection: DEFAULT_MIN_PER_SECTION },
    );
    expect(allocated[0].items).toHaveLength(4);
    expect(allocated[1].items).toHaveLength(0);
  });

  test("the headline row may show three where a discovery row may not", () => {
    const allocated = allocateWithBudget(
      [
        { id: "for_you", pool: [cand("1", "A"), cand("2", "B"), cand("3", "C")] },
      ],
      { perSection: 14, minPerSection: 4, sectionMin: { for_you: 3 } },
    );
    expect(allocated[0].items).toHaveLength(3);
  });
});
