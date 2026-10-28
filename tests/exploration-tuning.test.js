import { describe, expect, test } from "bun:test";
import { readSource } from "./helpers/tailwind-css.js";
import {
  buildSeeds,
  buildSignals,
  buildTuning,
  rankCandidates,
  scoreCandidate,
  DEFAULT_EXPLORATION,
  WEIGHTS,
} from "../src/lib/recommend.ts";

const NOW = 1_800_000_000_000;

const cand = (id, artist, title = "Song") => ({
  id,
  title,
  artist,
  duration: 200,
  thumbnail: `https://img/${id}.jpg`,
});

const seedFor = (
  artist,
  source = "artists",
  reason = "because_you_listened",
) => ({
  query: `${artist} songs`,
  source,
  weight: 1,
  seed: `artist:${artist}`,
  reason,
});

/** A listener with real history, so both known and unknown candidates score. */
const listener = {
  userId: "u",
  plays: [
    { trackId: "t1", artistName: "Boards", at: NOW, completion: 1 },
    { trackId: "t2", artistName: "Boards", at: NOW, completion: 1 },
    { trackId: "t3", artistName: "Aphex Twin", at: NOW, completion: 1 },
  ],
  likes: [{ trackId: "t1", artistName: "Boards", at: NOW }],
  playlists: [],
};

const signals = buildSignals(listener, NOW);
const known = cand("k", "Boards", "Known");
const unknown = cand("u", "Stranger", "Unheard");

describe("the slider maps onto a real profile", () => {
  test("the default is the middle, and no preference means the middle", () => {
    expect(DEFAULT_EXPLORATION).toBe(50);
    expect(buildTuning(undefined).exploration).toBe(50);
    expect(buildTuning(null).exploration).toBe(50);
  });

  test("the value is clamped rather than trusted", () => {
    expect(buildTuning(-40).exploration).toBe(0);
    expect(buildTuning(400).exploration).toBe(100);
    expect(buildTuning(Number.NaN).exploration).toBe(50);
  });

  test("moving right means more discovery, less familiarity", () => {
    const low = buildTuning(0);
    const high = buildTuning(100);
    expect(high.discoveryBonus).toBeGreaterThan(low.discoveryBonus);
    expect(high.familiarityBonus).toBeLessThan(low.familiarityBonus);
    expect(high.discoverySeeds).toBeGreaterThan(low.discoverySeeds);
    // Pushing harder against an artist repeating is exploration too.
    expect(high.diversityPerRepeat).toBeLessThan(low.diversityPerRepeat);
  });

  test("neither end ever fully switches anything off", () => {
    const low = buildTuning(0);
    const high = buildTuning(100);
    // Discovery is never zero — a pure-familiarity setting that never
    // proposes anything new is the feedback loop the engine exists to avoid.
    expect(low.discoveryBonus).toBeGreaterThan(0);
    expect(low.discoverySeeds).toBeGreaterThanOrEqual(1);
    // And comfort keeps a floor, so "surprise me" is still music FOR them.
    expect(high.familiarityBonus).toBeGreaterThan(0);
  });
});

describe("the preference actually changes what is recommended", () => {
  const score = (item, exploration) =>
    scoreCandidate(item, signals, seedFor(item.artist), {
      now: NOW,
      recentPlays: new Map(),
      duplicate: false,
      tuning: buildTuning(exploration),
    });

  test("a high setting lifts unfamiliar artists toward the known ones", () => {
    const gap = (exploration) => {
      const knownScore = score(known, exploration).score.finalScore;
      const unknownScore = score(unknown, exploration).score.finalScore;
      return knownScore - unknownScore;
    };
    expect(gap(100)).toBeLessThan(gap(0));
  });

  test("the change is real, not a rounding artefact", () => {
    const low = score(unknown, 0).score.finalScore;
    const high = score(unknown, 100).score.finalScore;
    expect(high).toBeGreaterThan(low);
    expect(high - low).toBeGreaterThan(0.1);
  });

  test("a comfortable setting does not simply invert the ranking", () => {
    // Even fully "surprise me", a loved artist must still be competitive —
    // otherwise the control turns the app into noise.
    expect(score(known, 100).score.finalScore).toBeGreaterThan(0);
    expect(score(known, 0).score.finalScore).toBeGreaterThan(
      score(unknown, 0).score.finalScore,
    );
  });

  test("the slider is reported as its own term, not hidden in affinity", () => {
    // The raw affinity has to stay visible, or the debug view would claim a
    // number the engine never computed.
    const adventurous = score(known, 100).score;
    const comfortable = score(known, 0).score;
    expect(adventurous.artistAffinity).toBeCloseTo(
      comfortable.artistAffinity,
      6,
    );
    expect(adventurous.familiarityAdjustment).toBeLessThan(0);
    expect(comfortable.familiarityAdjustment).toBeGreaterThanOrEqual(0);
  });

  test("a full list leans more on unknown artists when exploring", () => {
    const list = [
      ...Array.from({ length: 6 }, (_, i) => cand(`k${i}`, "Boards", `B${i}`)),
      ...Array.from({ length: 6 }, (_, i) =>
        cand(`u${i}`, `Fresh ${i}`, `U${i}`),
      ),
    ];
    const unfamiliarShare = (exploration) => {
      const ranked = rankCandidates(list, signals, [seedFor("Boards")], {
        now: NOW,
        limit: 6,
        // Diversity caps are lifted on purpose: with them in play the per-
        // artist cap binds first and BOTH settings produce the same list, which
        // would hide the scoring effect this test is about.
        maxPerArtist: 50,
        maxPerAlbum: 50,
        tuning: buildTuning(exploration),
      });
      return (
        ranked.filter((entry) => entry.track.artist.startsWith("Fresh"))
          .length / ranked.length
      );
    };
    expect(unfamiliarShare(100)).toBeGreaterThan(unfamiliarShare(0));
  });

  test("the weights still describe the score with tuning applied", () => {
    const s = score(unknown, 75).score;
    const sum =
      s.artistAffinity * WEIGHTS.artistAffinity +
      s.familiarityAdjustment * WEIGHTS.artistAffinity +
      s.likeScore * WEIGHTS.likeScore +
      s.historyScore * WEIGHTS.historyScore +
      s.recencyScore * WEIGHTS.recencyScore +
      s.completionScore * WEIGHTS.completionScore +
      s.playlistScore * WEIGHTS.playlistScore +
      s.discoveryScore * WEIGHTS.discoveryScore +
      s.skipPenalty * WEIGHTS.skipPenalty +
      s.recentPlayPenalty * WEIGHTS.recentPlayPenalty +
      s.duplicatePenalty * WEIGHTS.duplicatePenalty;
    expect(sum).toBeCloseTo(s.finalScore, 6);
  });
});

describe("the preference reaches candidate generation too", () => {
  const manyArtists = {
    userId: "u",
    plays: Array.from({ length: 8 }, (_, i) => ({
      trackId: `p${i}`,
      artistName: `Artist ${i}`,
      at: NOW,
      completion: 1,
    })),
    likes: [],
    playlists: [],
  };
  const manySignals = buildSignals(manyArtists, NOW);

  test("a higher setting spends more of the search budget on discovery", () => {
    const count = (exploration) =>
      buildSeeds(manySignals, manyArtists, {
        maxSeeds: 6,
        tuning: buildTuning(exploration),
      }).filter((s) => s.source === "discovery").length;
    expect(count(100)).toBeGreaterThan(count(0));
  });

  test("discovery is never fully switched off", () => {
    const seeds = buildSeeds(manySignals, manyArtists, {
      maxSeeds: 6,
      tuning: buildTuning(0),
    });
    expect(seeds.some((s) => s.source === "discovery")).toBe(true);
  });

  test("the fan-out cap still holds at every setting", () => {
    for (const exploration of [0, 50, 100]) {
      expect(
        buildSeeds(manySignals, manyArtists, {
          maxSeeds: 4,
          tuning: buildTuning(exploration),
        }).length,
      ).toBeLessThanOrEqual(4);
    }
  });
});

describe("one preference drives both Home and autoplay", () => {
  const convex = readSource("src/convex/recommend.ts");
  const store = readSource("src/store/player.ts");
  const home = readSource("src/pages/Home.tsx");

  test("the server derives the same profile for both actions", () => {
    for (const action of ["export const forYou", "export const nextTrack"]) {
      const body = convex.slice(
        convex.indexOf(action),
        convex.indexOf(action) + 3000,
      );
      // The derivation itself was upgraded: `buildTuning` applied the stated
      // preference directly, and it is now `adaptiveTuning`, which corrects
      // that preference by how the listener actually responds. What this test
      // has always guarded is not the function's NAME — it is that both
      // actions derive their profile the SAME way, from the SAME preference,
      // so Home and autoplay cannot drift apart.
      expect(body).toContain(
        "adaptiveTuning(args.exploration, userSignals.plays)",
      );
    }
  });

  test("autoplay sends the stored preference", () => {
    expect(store).toMatch(
      /exploration: usePlayerStore\.getState\(\)\.exploration/,
    );
  });

  test("Home re-ranks when the slider moves", () => {
    expect(home).toMatch(/forYou\(\{ exploration \}\)/);
    expect(home).toMatch(/\[forYou, exploration, remoteRefreshToken\]/);
  });

  test("the preference is part of the cache identity", () => {
    // Without this, moving the slider would keep serving the payload cached
    // for the previous setting and the control would look broken.
    expect(convex).toContain("function cacheKeyFor");
    expect(convex).toMatch(/home:v1:\$\{Math\.round\(value \/ 20\)\}/);
    expect(convex).toContain("cacheKeyFor(args.exploration)");
  });

  test("the preference is device-local and never stored server-side", () => {
    const schema = readSource("src/convex/schema.ts");
    expect(schema).not.toContain("exploration");
    expect(store).toContain('EXPLORATION_KEY = "ss.exploration"');
  });
});

describe("the setting behaves like every other preference", () => {
  const store = readSource("src/store/player.ts");

  test("it is clamped and rounded on the way in", () => {
    expect(store).toMatch(
      /Math\.min\(100, Math\.max\(0, Math\.round\(value\)\)\)/,
    );
  });

  test("a blocked or corrupt stored value falls back to balanced", () => {
    expect(store).toContain("function readExploration");
    expect(store).toMatch(
      /if \(!Number\.isFinite\(raw\)\) return DEFAULT_EXPLORATION;/,
    );
  });

  test("it is written through the safe settings writer", () => {
    // A throw inside localStorage.setItem must not take the slider down with
    // it — that is the reason writeSetting exists.
    expect(store).toContain("writeSetting(EXPLORATION_KEY, String(next))");
  });
});

describe("the control is honest about what it does", () => {
  const ui = readSource("src/components/settings/ExplorationSection.tsx");

  test("it is a real slider with a real label", () => {
    expect(ui).toContain("<Slider");
    expect(ui).toContain('aria-label="Discover new music"');
    expect(ui).toMatch(/min=\{0\}/);
    expect(ui).toMatch(/max=\{100\}/);
  });

  test("it writes through the store, not its own copy of state", () => {
    expect(ui).toContain("setExploration");
    expect(ui).not.toContain("localStorage");
  });

  test("the description is banded, not an internal weight", () => {
    // "67% of the discovery weight" is meaningless to a listener.
    expect(ui).not.toMatch(/discoveryBonus|familiarityBonus/);
    expect(ui).toContain("function describe");
  });

  test("the balanced position is offered back", () => {
    expect(ui).toContain("Reset to balanced");
  });

  test("it follows the existing settings slider pattern", () => {
    const reference = readSource(
      "src/components/settings/CardTransparencySection.tsx",
    );
    expect(ui).toContain('from "@/components/ui/slider"');
    expect(ui).toContain("usePlayerStore");
    expect(reference).toContain('from "@/components/ui/slider"');
  });

  test("it is mounted in the settings dialog", () => {
    const dialog = readSource("src/components/settings/SettingsDialog.tsx");
    expect(dialog).toContain("<ExplorationSection />");
  });
});
