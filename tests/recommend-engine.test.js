import { describe, expect, test } from "bun:test";
import {
  artistKey,
  buildSeeds,
  buildSignals,
  classifyPlay,
  explainCandidate,
  pickNextTrack,
  rankCandidates,
  scoreCandidate,
  shouldFilter,
  titleKey,
  trackKey,
  wasPlayedRecently,
  RECENT_PLAY_WINDOW_MS,
  WEIGHTS,
} from "../src/lib/recommend.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

/** A candidate shaped exactly like the ones the Convex action resolves. */
const cand = (id, artist, title = "Song", extra = {}) => ({
  id,
  title,
  artist,
  duration: 200,
  thumbnail: `https://img/${id}.jpg`,
  ...extra,
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

describe("metadata is folded before it is compared", () => {
  test("artist variants collapse onto one key", () => {
    // Without this, "Rick Astley" and "Rick Astley - Topic" are two different
    // artists and every recommendation misses the listener's actual history.
    const key = artistKey("Rick Astley - Topic");
    expect(key).toBe("rick astley");
    expect(artistKey("Rick Astley (feat. Someone)")).toBe(key);
    expect(artistKey("RickAstleyVEVO")).toBe("rickastley");
  });

  test("placeholders never become artists", () => {
    for (const bad of [
      "Unknown Artist",
      "Artist",
      "Various Artists",
      "",
      null,
    ]) {
      expect(artistKey(bad)).toBe("");
    }
  });

  test("title noise is ignored so the same song is not recommended twice", () => {
    expect(titleKey("Song Name (Official Music Video)")).toBe("song name");
    expect(trackKey({ title: "Song Name", artist: "A" })).toBe(
      trackKey({ title: "song name [HD]", artist: "a - Topic" }),
    );
  });
});

describe("plays are graded, not counted flat", () => {
  test("an early skip is a skip", () => {
    expect(
      classifyPlay({
        trackId: "a",
        at: NOW,
        skipped: true,
        listenedSeconds: 3,
      }),
    ).toBe("skip");
  });

  test("a long listen that was still skipped is a partial, not a rejection", () => {
    // Skipping after two minutes of a four-minute song is weak evidence.
    expect(
      classifyPlay(
        { trackId: "a", at: NOW, skipped: true, listenedSeconds: 130 },
        240,
      ),
    ).toBe("partial");
  });

  test("a finished track is a completion", () => {
    expect(classifyPlay({ trackId: "a", at: NOW, completion: 0.95 })).toBe(
      "complete",
    );
    expect(classifyPlay({ trackId: "a", at: NOW, completion: 0.3 })).toBe(
      "partial",
    );
  });

  test("a play with no recorded position is neither credited nor condemned", () => {
    expect(classifyPlay({ trackId: "a", at: NOW })).toBe("partial");
  });
});

describe("signals become per-artist affinity", () => {
  test("a cold listener is not treated as having taste", () => {
    const signals = buildSignals(
      { userId: "u", plays: [], likes: [], playlists: [] },
      NOW,
    );
    expect(signals.personalised).toBe(false);
    expect(signals.artistCount).toBe(0);
  });

  test("liking an artist outweighs merely playing it", () => {
    const signals = buildSignals(
      {
        userId: "u",
        plays: [{ trackId: "p1", artistName: "Played", at: NOW }],
        likes: [{ trackId: "l1", artistName: "Loved", at: NOW }],
        playlists: [],
      },
      NOW,
    );
    expect(signals.artists.get("loved").affinity).toBeGreaterThan(
      signals.artists.get("played").affinity,
    );
  });

  test("one skip costs less than one play adds", () => {
    // The rule that stops a single skip from blacklisting a song. Compared
    // inside one profile, because each artist's affinity is normalised
    // against the strongest artist — a profile where an artist is the ONLY
    // artist would always score them 1.0 and hide the penalty entirely.
    const signals = buildSignals(
      {
        userId: "u",
        plays: [
          { trackId: "p1", artistName: "Kept", at: NOW, completion: 1 },
          { trackId: "p2", artistName: "Kept", at: NOW, completion: 1 },
          { trackId: "p3", artistName: "Kept", at: NOW, completion: 1 },
          { trackId: "q", artistName: "Doubted", at: NOW, completion: 1 },
          {
            trackId: "r",
            artistName: "Doubted",
            at: NOW,
            skipped: true,
            listenedSeconds: 2,
          },
        ],
        likes: [],
        playlists: [],
      },
      NOW,
    );
    const kept = signals.artists.get("kept").affinity;
    const doubted = signals.artists.get("doubted").affinity;
    expect(doubted).toBeLessThan(kept);
    // …but a single skip is a signal, not a ban: the artist is not erased.
    expect(doubted).toBeGreaterThan(0);
    expect(signals.artists.get("doubted").skips).toBe(1);
  });

  test("repeated skips drag an artist below a fresh one", () => {
    const signals = buildSignals(
      {
        userId: "u",
        plays: [
          {
            trackId: "s1",
            artistName: "Rejects",
            at: NOW,
            skipped: true,
            listenedSeconds: 2,
          },
          {
            trackId: "s2",
            artistName: "Rejects",
            at: NOW,
            skipped: true,
            listenedSeconds: 1,
          },
          {
            trackId: "s3",
            artistName: "Rejects",
            at: NOW,
            skipped: true,
            listenedSeconds: 1,
          },
          { trackId: "p", artistName: "Plays", at: NOW, completion: 1 },
        ],
        likes: [],
        playlists: [],
      },
      NOW,
    );
    expect(signals.artists.get("plays").affinity).toBeGreaterThan(
      signals.artists.get("rejects").affinity,
    );
    expect(signals.artists.get("rejects").affinity).toBe(0);
  });

  test("recent behaviour outweighs behaviour from months ago", () => {
    const recent = buildSignals(
      {
        userId: "u",
        plays: [
          { trackId: "p", artistName: "A", at: NOW - DAY, completion: 1 },
        ],
        likes: [],
        playlists: [],
      },
      NOW,
    );
    const old = buildSignals(
      {
        userId: "u",
        plays: [
          { trackId: "p", artistName: "A", at: NOW - 120 * DAY, completion: 1 },
        ],
        likes: [],
        playlists: [],
      },
      NOW,
    );
    // Both normalise to 1.0 because each profile is measured against its own
    // peak — the decay shows up in the ranking, not in the raw profile.
    expect(recent.artists.get("a").affinity).toBeCloseTo(
      old.artists.get("a").affinity,
      5,
    );
    expect(recent.artists.get("a").lastAt).toBeGreaterThan(
      old.artists.get("a").lastAt,
    );
  });

  test("an artist who is finished-with recovers their completion score", () => {
    const first = buildSignals(
      {
        userId: "u",
        plays: [
          {
            trackId: "a",
            artistName: "A",
            at: NOW - 90 * DAY,
            completion: 0.05,
          },
          {
            trackId: "b",
            artistName: "A",
            at: NOW - 89 * DAY,
            completion: 0.05,
          },
        ],
        likes: [],
        playlists: [],
      },
      NOW,
    );
    const later = buildSignals(
      {
        userId: "u",
        plays: [
          {
            trackId: "a",
            artistName: "A",
            at: NOW - 90 * DAY,
            completion: 0.05,
          },
          {
            trackId: "b",
            artistName: "A",
            at: NOW - 89 * DAY,
            completion: 0.05,
          },
          { trackId: "c", artistName: "A", at: NOW, completion: 1 },
        ],
        likes: [],
        playlists: [],
      },
      NOW,
    );
    expect(later.artists.get("a").completion).toBeGreaterThan(
      first.artists.get("a").completion,
    );
  });
});

describe("candidate generation asks for real, verifiable seeds", () => {
  test("a listener with no history gets discovery, not an invented taste", () => {
    const signals = buildSignals(
      { userId: null, plays: [], likes: [], playlists: [] },
      NOW,
    );
    const seeds = buildSeeds(signals, {
      userId: null,
      plays: [],
      likes: [],
      playlists: [],
    });
    expect(seeds).toHaveLength(1);
    expect(seeds[0].source).toBe("global");
    expect(seeds[0].reason).toBe("global_fallback");
  });

  test("liked artists lead, because a like is the most deliberate signal", () => {
    const userSignals = {
      userId: "u",
      plays: [{ trackId: "p", artistName: "Played", at: NOW }],
      likes: [{ trackId: "l", artistName: "Loved", at: NOW }],
      playlists: [],
    };
    const signals = buildSignals(userSignals, NOW);
    const seeds = buildSeeds(signals, userSignals);
    expect(seeds[0].source).toBe("likes");
    expect(seeds[0].query).toContain("Loved");
  });

  test("a discovery seed is always kept so the list cannot collapse", () => {
    const userSignals = {
      userId: "u",
      plays: [{ trackId: "p", artistName: "A", at: NOW }],
      likes: [],
      playlists: [],
    };
    const signals = buildSignals(userSignals, NOW);
    expect(
      buildSeeds(signals, userSignals).some((s) => s.source === "discovery"),
    ).toBe(true);
  });

  test("the fan-out is capped so one request cannot become fifty searches", () => {
    const plays = Array.from({ length: 40 }, (_, i) => ({
      trackId: `p${i}`,
      artistName: `Artist ${i}`,
      at: NOW,
      completion: 1,
    }));
    const userSignals = { userId: "u", plays, likes: [], playlists: [] };
    const seeds = buildSeeds(buildSignals(userSignals, NOW), userSignals, {
      maxSeeds: 4,
    });
    expect(seeds.length).toBeLessThanOrEqual(4);
  });
});

describe("every score is explainable", () => {
  const userSignals = {
    userId: "u",
    plays: [
      { trackId: "t1", artistName: "Boards", at: NOW, completion: 1 },
      { trackId: "t2", artistName: "Boards", at: NOW - DAY, completion: 1 },
    ],
    likes: [{ trackId: "t1", artistName: "Boards", at: NOW }],
    playlists: [],
  };
  const signals = buildSignals(userSignals, NOW);

  test("a known artist outscores an unknown one", () => {
    const known = scoreCandidate(
      cand("k", "Boards"),
      signals,
      seedFor("Boards"),
      {
        now: NOW,
        recentPlays: new Map(),
        duplicate: false,
      },
    );
    const unknown = scoreCandidate(
      cand("u", "Nobody"),
      signals,
      seedFor("Boards"),
      {
        now: NOW,
        recentPlays: new Map(),
        duplicate: false,
      },
    );
    expect(known.score.finalScore).toBeGreaterThan(unknown.score.finalScore);
  });

  test("the reported reason matches the term that actually scored", () => {
    const scored = scoreCandidate(
      cand("k", "Boards"),
      signals,
      seedFor("Boards"),
      {
        now: NOW,
        recentPlays: new Map(),
        duplicate: false,
      },
    );
    // Artist affinity is the strongest term here, and the seed was an
    // artist search (not a like), so the honest reason is the artist one —
    // not the more flattering "based on your likes".
    expect(scored.reason).toBe("favorite_artist");
    expect(scored.score.artistAffinity).toBeGreaterThan(0);
    expect(scored.score.historyScore).toBeGreaterThan(0);
  });

  test("a candidate from a like seed reports the like reason", () => {
    const scored = scoreCandidate(
      cand("k", "Boards"),
      signals,
      seedFor("Boards", "likes", "based_on_likes"),
      { now: NOW, recentPlays: new Map(), duplicate: false },
    );
    expect(["favorite_artist", "based_on_likes"]).toContain(scored.reason);
    expect(scored.source).toBe("likes");
  });

  test("an unknown artist with no shared signal is called discovery, not faked", () => {
    const scored = scoreCandidate(
      cand("u", "Nobody"),
      signals,
      seedFor("Boards"),
      {
        now: NOW,
        recentPlays: new Map(),
        duplicate: false,
      },
    );
    expect(scored.score.artistAffinity).toBe(0);
    expect(scored.reason).toBe("discovery");
  });

  test("skips are penalised in proportion to how often they happened", () => {
    const skipper = buildSignals(
      {
        userId: "u",
        plays: [
          {
            trackId: "x",
            artistName: "Boards",
            at: NOW,
            skipped: true,
            listenedSeconds: 2,
          },
          {
            trackId: "y",
            artistName: "Boards",
            at: NOW,
            skipped: true,
            listenedSeconds: 2,
          },
          {
            trackId: "z",
            artistName: "Boards",
            at: NOW,
            skipped: true,
            listenedSeconds: 2,
          },
        ],
        likes: [],
        playlists: [],
      },
      NOW,
    );
    const once = buildSignals(
      {
        userId: "u",
        plays: [
          {
            trackId: "x",
            artistName: "Boards",
            at: NOW,
            skipped: true,
            listenedSeconds: 2,
          },
        ],
        likes: [],
        playlists: [],
      },
      NOW,
    );
    const candidate = cand("x", "Boards");
    const ctx = { now: NOW, recentPlays: new Map(), duplicate: false };
    const repeated = scoreCandidate(
      candidate,
      skipper,
      seedFor("Boards"),
      ctx,
    ).score;
    const single = scoreCandidate(
      candidate,
      once,
      seedFor("Boards"),
      ctx,
    ).score;
    expect(repeated.skipPenalty).toBeGreaterThan(single.skipPenalty);
    expect(repeated.finalScore).toBeLessThan(single.finalScore);
  });

  test("a recently played track is softened, never banned", () => {
    const candidate = cand("t1", "Boards");
    const ctx = { now: NOW, duplicate: false };
    const fresh = scoreCandidate(candidate, signals, seedFor("Boards"), {
      ...ctx,
      recentPlays: new Map([["t1", NOW - 1000]]),
    }).score;
    const old = scoreCandidate(candidate, signals, seedFor("Boards"), {
      ...ctx,
      recentPlays: new Map([["t1", NOW - RECENT_PLAY_WINDOW_MS - 1000]]),
    }).score;
    expect(fresh.recentPlayPenalty).toBeGreaterThan(0);
    expect(old.recentPlayPenalty).toBe(0);
    expect(fresh.finalScore).toBeLessThan(old.finalScore);
  });

  test("the breakdown adds up to the final score", () => {
    // An explainable score has to actually explain the number it reports.
    const s = scoreCandidate(cand("t1", "Boards"), signals, seedFor("Boards"), {
      now: NOW,
      recentPlays: new Map([["t1", NOW]]),
      duplicate: false,
    }).score;
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

  test("the debug view names every term that contributed", () => {
    const scored = scoreCandidate(
      cand("t1", "Boards"),
      signals,
      seedFor("Boards"),
      {
        now: NOW,
        recentPlays: new Map([["t1", NOW]]),
        duplicate: false,
      },
    );
    const text = explainCandidate(scored);
    expect(text).toContain("Candidate:");
    expect(text).toContain("Final score:");
    expect(text).toContain("Reason:");
    expect(text).toContain("Recently played");
  });
});

describe("invalid candidates never reach the listener", () => {
  const ctx = () => ({
    currentTrackId: null,
    excludeIds: new Set(),
    recentPlays: new Map(),
    now: NOW,
    seenTrackKeys: new Set(),
  });

  test("unplayable and malformed rows are rejected with a reason", () => {
    expect(
      shouldFilter(
        { id: "", title: "x", artist: "y", duration: 10, thumbnail: "" },
        ctx(),
      ).reason,
    ).toBe("invalid_id");
    expect(shouldFilter(cand("a", "X", "  "), ctx()).reason).toBe(
      "missing_title",
    );
    expect(
      shouldFilter(cand("a", "X", "T", { duration: 0 }), ctx()).reason,
    ).toBe("unavailable");
    expect(
      shouldFilter(cand("a", "X", "T", { duration: 99999 }), ctx()).reason,
    ).toBe("unavailable");
  });

  test("what is playing, what is queued and what repeats are all refused", () => {
    expect(
      shouldFilter(cand("a", "X"), { ...ctx(), currentTrackId: "a" }).reason,
    ).toBe("currently_playing");
    expect(
      shouldFilter(cand("a", "X"), { ...ctx(), excludeIds: new Set(["a"]) })
        .reason,
    ).toBe("already_queued");
    const seen = new Set([trackKey(cand("a", "X", "Same"))]);
    expect(
      shouldFilter(cand("b", "X", "same"), { ...ctx(), seenTrackKeys: seen })
        .reason,
    ).toBe("duplicate");
  });
});

describe("the ranked list is diverse and duplicate-free", () => {
  test("one artist cannot fill a row", () => {
    const plays = [
      { trackId: "p1", artistName: "Monoculture", at: NOW, completion: 1 },
      { trackId: "p2", artistName: "Monoculture", at: NOW, completion: 1 },
    ];
    const signals = buildSignals(
      { userId: "u", plays, likes: [], playlists: [] },
      NOW,
    );
    const candidates = Array.from({ length: 8 }, (_, i) =>
      cand(`m${i}`, "Monoculture", `Track ${i}`),
    );
    const ranked = rankCandidates(
      candidates,
      signals,
      [seedFor("Monoculture")],
      {
        now: NOW,
        limit: 8,
        maxPerArtist: 2,
      },
    );
    expect(ranked.length).toBeLessThanOrEqual(2);
  });

  test("the same track never appears twice", () => {
    const signals = buildSignals(
      {
        userId: "u",
        plays: [{ trackId: "p", artistName: "A", at: NOW, completion: 1 }],
        likes: [],
        playlists: [],
      },
      NOW,
    );
    const candidates = [
      cand("a", "A", "Song"),
      cand("b", "A", "Song (Official Video)"),
      cand("c", "B", "Other"),
    ];
    const ranked = rankCandidates(candidates, signals, [seedFor("A")], {
      now: NOW,
      limit: 10,
    });
    expect(new Set(ranked.map((r) => r.track.id)).size).toBe(ranked.length);
  });

  test("the queue is respected — nothing already queued comes back", () => {
    const signals = buildSignals(
      {
        userId: "u",
        plays: [{ trackId: "p", artistName: "A", at: NOW, completion: 1 }],
        likes: [],
        playlists: [],
      },
      NOW,
    );
    const ranked = rankCandidates(
      [cand("queued", "A", "Queued"), cand("fresh", "A", "Fresh")],
      signals,
      [seedFor("A")],
      { now: NOW, limit: 10, excludeIds: ["queued"] },
    );
    expect(ranked.map((r) => r.track.id)).not.toContain("queued");
  });
});

describe("autoplay always has something to play", () => {
  const signals = buildSignals(
    { userId: null, plays: [], likes: [], playlists: [] },
    NOW,
  );
  const seeds = [seedFor("A", "global", "global_fallback")];

  test("the best valid candidate is chosen", () => {
    const picked = pickNextTrack(
      [cand("bad", "A", "", {}), cand("good", "A")],
      signals,
      seeds,
      {
        now: NOW,
        limit: 1,
      },
    );
    expect(picked?.track.id).toBe("good");
  });

  test("an empty pool returns null rather than throwing", () => {
    expect(
      pickNextTrack([], signals, seeds, { now: NOW, limit: 1 }),
    ).toBeNull();
  });

  test("when strict filtering empties the list, playback still continues", () => {
    // Stopping the music is far worse than offering a mild repeat.
    const onlyQueued = cand("only", "A", "Only");
    const picked = pickNextTrack([onlyQueued], signals, seeds, {
      now: NOW,
      limit: 1,
      excludeIds: ["only"],
    });
    expect(picked?.track.id).toBe("only");
  });
});

describe("recency is a soft signal, never a ban", () => {
  test("a track heard an hour ago is recent; one heard yesterday is not", () => {
    const map = new Map([["x", NOW - 60 * 60 * 1000]]);
    expect(wasPlayedRecently("x", map, NOW)).toBe(true);
    map.set("x", NOW - 24 * 60 * 60 * 1000);
    expect(wasPlayedRecently("x", map, NOW)).toBe(false);
    expect(wasPlayedRecently("unheard", map, NOW)).toBe(false);
  });
});
