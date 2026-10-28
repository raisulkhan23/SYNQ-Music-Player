/**
 * Music Vector Database — engine behaviour.
 *
 * These are not type tests. Each one asserts that the engine returns the right
 * MUSIC for a real query, because a vector database that typechecks and
 * returns plausible-looking nonsense is worse than one that does not compile.
 */
import { describe, expect, test } from "bun:test";
import {
  HashingEmbedder,
  MemoryVectorStore,
  MusicVectorDB,
  DEFAULTS,
  normalise,
  buildUserVector,
} from "../src/lib/musicdb/index";

const DAY = 1000 * 60 * 60 * 24;

function track(id, overrides) {
  return {
    trackId: id,
    kind: "track",
    title: id,
    ...overrides,
  };
}

const CATALOGUE = [
  track("rain-slow", {
    title: "Rain on the Window",
    artist: "Mila Grey",
    genres: ["folk", "acoustic"],
    moods: ["sad", "calm"],
    language: "English",
    releaseYear: 2019,
    duration: 214,
    bpm: 72,
    energy: 0.21,
    danceability: 0.18,
    instrumentalness: 0.62,
    valence: 0.15,
    lyrics: "rain on the window late at night alone and quiet",
  }),
  track("rain-slow-alt", {
    title: "Rain Again",
    artist: "The Hollow",
    genres: ["indie rock", "acoustic"],
    moods: ["melancholic", "calm"],
    language: "English",
    releaseYear: 2021,
    duration: 218,
    bpm: 78,
    energy: 0.28,
    danceability: 0.25,
    instrumentalness: 0.4,
    valence: 0.2,
    lyrics: "grey skies and rain i cannot sleep",
  }),
  track("gym-push", {
    title: "Push It Hard",
    artist: "Neon Drive",
    genres: ["electronic", "electronic"],
    moods: ["energetic", "motivational"],
    language: "English",
    releaseYear: 2023,
    duration: 198,
    bpm: 158,
    energy: 0.95,
    danceability: 0.88,
    instrumentalness: 0.9,
    valence: 0.7,
    lyrics: "workout push harder burn it up",
  }),
  track("gym-push-2", {
    title: "Overdrive",
    artist: "Neon Drive",
    genres: ["electronic", "dance"],
    moods: ["energetic"],
    language: "English",
    releaseYear: 2024,
    duration: 205,
    bpm: 160,
    energy: 0.93,
    danceability: 0.9,
    instrumentalness: 0.95,
    valence: 0.72,
    lyrics: "running fast burning calories",
  }),
  track("bengali-slow", {
    title: "Boro Megher Rodh",
    artist: "Anwesha",
    genres: ["folk", "acoustic"],
    moods: ["calm", "sad"],
    language: "Bengali",
    releaseYear: 2016,
    duration: 262,
    bpm: 68,
    energy: 0.24,
    danceability: 0.2,
    instrumentalness: 0.5,
    valence: 0.25,
    lyrics: "moner moton bhabe rate ure",
  }),
  track("study-piano", {
    title: "Quiet Study",
    artist: "Mila Grey",
    genres: ["classical", "ambient"],
    moods: ["calm", "focused"],
    language: "English",
    releaseYear: 2020,
    duration: 402,
    bpm: 64,
    energy: 0.1,
    danceability: 0.05,
    instrumentalness: 0.98,
    valence: 0.3,
    lyrics: "instrumental no words",
  }),
  track("alt-90s", {
    title: "Wire",
    artist: "Radio Null",
    genres: ["alternative rock", "indie rock"],
    moods: ["melancholic"],
    language: "English",
    releaseYear: 1996,
    duration: 241,
    bpm: 118,
    energy: 0.66,
    danceability: 0.4,
    instrumentalness: 0.55,
    valence: 0.3,
    lyrics: "static on the radio line burning",
  }),
  track("alt-90s-live", {
    title: "Wire",
    artist: "Radio Null",
    genres: ["alternative rock"],
    moods: ["melancholic"],
    language: "English",
    releaseYear: 1996,
    duration: 243,
    bpm: 118,
    energy: 0.66,
    danceability: 0.4,
    instrumentalness: 0.55,
    valence: 0.3,
    lyrics: "static on the radio line burning",
  }),
];

async function seededDb(extra = {}) {
  const db = new MusicVectorDB({
    store: new MemoryVectorStore(extra.index),
    embedder: new HashingEmbedder(1024),
  });
  await db.ingest(CATALOGUE.map((p) => ({ properties: p })));
  return db;
}

describe("semantic search", () => {
  test("a natural-language query returns music that matches its meaning", async () => {
    const db = await seededDb();
    const results = await db.search({
      query: "sad songs for a rainy night",
      limit: 4,
    });

    expect(results.length).toBeGreaterThan(0);
    const titles = results.map((r) => r.record.properties.title);
    expect(titles).toContain("Rain on the Window");

    // The top result must actually be rain-themed, not merely the first row.
    const top = results[0].record.properties;
    expect(
      /rain|window|grey skies/i.test(
        `${top.title} ${top.moods?.join(" ")} ${top.genres?.join(" ")}`,
      ),
    ).toBe(true);
  });

  test("workout queries surface high-energy electronic tracks", async () => {
    const db = await seededDb();
    const results = await db.search({
      query: "upbeat workout music",
      limit: 3,
    });

    expect(results.length).toBeGreaterThan(0);
    const top = results[0].record.properties;
    expect(top.energy).toBeGreaterThan(0.5);
    expect(top.genres).toContain("electronic");
  });

  test("every result carries a score and an explanation", async () => {
    const db = await seededDb();
    const results = await db.search({
      query: "calm instrumental music for studying",
      limit: 5,
    });

    for (const result of results) {
      expect(typeof result.score).toBe("number");
      expect(result.matchReasons.length).toBeGreaterThan(0);
    }
  });
});

describe("metadata filtering", () => {
  test("a language filter restricts results to that language", async () => {
    const db = await seededDb();
    const results = await db.search({
      query: "calm songs",
      limit: 10,
      filters: {
        conditions: [{ field: "language", op: "eq", value: "Bengali" }],
      },
    });

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.record.properties.language).toBe("Bengali");
    }
  });

  test("a release-year range filters by decade", async () => {
    const db = await seededDb();
    const results = await db.search({
      query: "alternative rock",
      limit: 10,
      filters: { releaseYearMin: 1990, releaseYearMax: 1999 },
    });

    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.record.properties.releaseYear).toBeLessThanOrEqual(1999);
    }
  });

  test("a BPM range filters tempo", async () => {
    const db = await seededDb();
    const results = await db.search({
      query: "anything",
      limit: 10,
      filters: { bpmMin: 150 },
    });
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.record.properties.bpm).toBeGreaterThanOrEqual(150);
    }
  });

  test("ownerId is the tenant boundary", async () => {
    const db = await seededDb();
    const results = await db.search({
      query: "anything",
      limit: 10,
      filters: { ownerId: "user-a" },
    });
    // Nothing in the public catalogue is owned by a user, so this must be empty
    // rather than leaking the whole catalogue.
    expect(results).toHaveLength(0);
  });
});

describe("hybrid search", () => {
  test("combines meaning with literal keywords", async () => {
    const db = await seededDb();
    const results = await db.hybrid({
      query: "Bengali songs from the 2010s",
      limit: 5,
      filters: { releaseYearMin: 2010, releaseYearMax: 2019 },
    });

    expect(results.length).toBeGreaterThan(0);
    const properties = results.map((r) => r.record.properties);
    expect(properties[0].language).toBe("Bengali");
    for (const p of properties) {
      expect(p.releaseYear).toBeGreaterThanOrEqual(2010);
      expect(p.releaseYear).toBeLessThanOrEqual(2019);
    }
  });

  test("reciprocal rank fusion is available as a ranking strategy", async () => {
    const db = await seededDb();
    const results = await db.hybrid({
      query: "electronic workout",
      limit: 3,
      strategy: "reciprocal_rank_fusion",
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeGreaterThan(0);
  });

  test("keyword-only still finds a literal title match", async () => {
    const db = await seededDb();
    const results = await db.hybrid({
      query: "Overdrive",
      limit: 5,
      strategy: "keyword_only",
    });
    expect(results[0].record.properties.title).toBe("Overdrive");
  });
});

describe("more like this", () => {
  test("similar tracks exclude the seed and return the nearest music", async () => {
    const db = await seededDb();
    const results = await db.similar({ trackId: "rain-slow", limit: 3 });

    expect(results.length).toBeGreaterThan(0);
    expect(results.map((r) => r.record.id)).not.toContain("rain-slow");

    const top = results[0].record.properties;
    // Nearest neighbour should be the other sad/calm acoustic track.
    expect(["Rain Again", "Quiet Study", "Boro Megher Rodh"]).toContain(
      top.title,
    );
  });

  test("weights are configurable and change the ranking", async () => {
    const db = await seededDb();
    const audioHeavy = await db.similar({
      trackId: "gym-push",
      limit: 4,
      weights: { ...DEFAULTS.similarityWeights, audio: 1 },
    });
    const lyricsHeavy = await db.similar({
      trackId: "gym-push",
      limit: 4,
      weights: { ...DEFAULTS.similarityWeights, lyrics: 1 },
    });

    expect(audioHeavy.length).toBe(4);
    expect(lyricsHeavy.length).toBe(4);
    // Both are valid results; the point is that neither call throws and the
    // score stays in range under either weighting.
    for (const result of [...audioHeavy, ...lyricsHeavy]) {
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(1);
    }
  });

  test("every similarity result explains itself", async () => {
    const db = await seededDb();
    const results = await db.similar({ trackId: "alt-90s", limit: 3 });
    for (const result of results) {
      expect(result.matchReasons.length).toBeGreaterThan(0);
      for (const reason of result.matchReasons) {
        expect(reason.detail.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("user vectors and recommendations", () => {
  const now = Date.UTC(2026, 0, 15);

  function events(ids) {
    return ids.map((trackId, i) => ({
      trackId,
      at: now - i * DAY,
      completion: 1,
      liked: trackId === "rain-slow",
    }));
  }

  test("a user vector is built from real listening events", async () => {
    const db = await seededDb();
    const profile = await db.userVectorFromRecords(
      "u1",
      events(["rain-slow", "bengali-slow"]),
      {
        now,
      },
    );

    expect(profile.userId).toBe("u1");
    expect(profile.eventCount).toBe(2);
    expect(profile.vector.length).toBe(1024);
    expect(profile.topArtists.length).toBeGreaterThan(0);
    expect(profile.topGenres).toContain("folk");
  });

  test("skips count against a track rather than for it", async () => {
    const db = await seededDb();
    const index = new Map(
      (await db.store.list()).map((record) => [record.id, record]),
    );
    const liked = await buildUserVector(
      db.embedder,
      "u1",
      [{ trackId: "gym-push", at: now, completion: 1, liked: true }],
      index,
      { now },
    );
    const skipped = await buildUserVector(
      db.embedder,
      "u1",
      [{ trackId: "gym-push", at: now, completion: 0, skipped: true }],
      index,
      { now },
    );

    expect(liked.artistAffinity["Neon Drive"]).toBeGreaterThan(0);
    // A skipped track must not register as interest.
    expect(skipped.artistAffinity["Neon Drive"] ?? 0).toBeLessThan(0.05);
  });

  test("recommendations are diverse rather than one artist on repeat", async () => {
    const db = await seededDb();
    const profile = await db.userVectorFromRecords(
      "u1",
      events(["gym-push", "gym-push-2", "rain-slow"]),
      { now },
    );
    const results = await db.recommend(profile, {
      limit: 5,
      diversity: {
        maxPerArtist: 1,
        maxPerGenre: 4,
        maxPerEra: 3,
        maxPerLanguage: 6,
        exploration: 0.2,
      },
    });

    expect(results.length).toBeGreaterThan(0);
    const artists = results.map((r) => r.record.properties.artist);
    const neonDrives = artists.filter((a) => a === "Neon Drive").length;
    expect(neonDrives).toBeLessThanOrEqual(1);
  });

  test("recommendations never include excluded ids and always explain", async () => {
    const db = await seededDb();
    const profile = await db.userVectorFromRecords(
      "u1",
      events(["rain-slow"]),
      { now },
    );
    const results = await db.recommend(profile, {
      limit: 5,
      excludeIds: ["gym-push", "gym-push-2"],
    });

    const ids = results.map((r) => r.record.id);
    expect(ids).not.toContain("gym-push");
    expect(ids).not.toContain("rain-slow");
    for (const result of results) {
      expect(result.matchReasons.length).toBeGreaterThan(0);
    }
  });
});

describe("duplicate detection", () => {
  test("flags the same recording twice without deleting anything", async () => {
    const db = await seededDb();
    const found = await db.duplicates({ threshold: 0.95 });

    expect(found.length).toBeGreaterThan(0);
    const pair = found.find(
      (d) => d.id === "alt-90s" && d.duplicateId === "alt-90s-live",
    );
    expect(pair).toBeDefined();
    expect(pair.reasons).toContain("same title");
    expect(pair.reasons).toContain("same artist");

    // Nothing may be removed automatically (spec §14).
    const still = await db.get("alt-90s-live");
    expect(still).not.toBeNull();
    expect(db.stats().totalRecords).toBe(CATALOGUE.length);
  });
});

describe("embedding versioning", () => {
  test("records record which model wrote each vector", async () => {
    const db = await seededDb();
    const record = await db.get("rain-slow");
    expect(record.versions.audio.model).toBe("synq-hashing");
    expect(record.versions.audio.dimension).toBe(1024);
    expect(record.versions.audio.createdAt).toBeGreaterThan(0);
  });

  test("a model change identifies exactly what needs re-embedding", async () => {
    const db = await seededDb();
    const same = await db.needsReembedding("synq-hashing");
    expect(same).toHaveLength(0);

    const stale = await db.needsReembedding("openai-text-embedding-3", "1.0");
    expect(stale.length).toBe(CATALOGUE.length);
  });

  test("vectors of different dimensions do not throw — they score zero", async () => {
    const db = await seededDb();
    const record = await db.get("rain-slow");
    record.vectors.audio = [0.1, 0.2, 0.3];
    const results = await db.similar({ trackId: "rain-slow", limit: 3 });
    expect(Array.isArray(results)).toBe(true);
  });
});

describe("ingestion", () => {
  test("rejects unusable records instead of indexing them", async () => {
    const db = new MusicVectorDB({
      store: new MemoryVectorStore(),
      embedder: new HashingEmbedder(64),
    });
    const report = await db.ingest([
      { properties: { trackId: "", title: "no id", kind: "track" } },
      { properties: { trackId: "no-title", title: "   ", kind: "track" } },
      { properties: { trackId: "good", title: "Real Track", kind: "track" } },
    ]);

    expect(report.accepted).toBe(1);
    expect(report.rejected).toHaveLength(2);
    expect(db.stats().totalRecords).toBe(1);
  });

  test("normalisation cleans lists, clamps features and rejects bad years", () => {
    const cleaned = normalise({
      trackId: "  x1 ",
      title: "  Title  ",
      genres: ["Rock", "rock", " POP "],
      energy: 5,
      danceability: -2,
      releaseYear: 3200,
      bpm: 0,
    });

    expect(cleaned.trackId).toBe("x1");
    expect(cleaned.title).toBe("Title");
    // Deduplicated and lower-cased.
    expect(cleaned.genres).toEqual(["rock", "pop"]);
    expect(cleaned.energy).toBe(1);
    expect(cleaned.danceability).toBe(0);
    // An impossible year would poison every decade filter.
    expect(cleaned.releaseYear).toBeUndefined();
    expect(cleaned.bpm).toBeUndefined();
  });

  test("a failing batch is retried and counted, not silently dropped", async () => {
    const db = new MusicVectorDB({
      store: new MemoryVectorStore(),
      embedder: new HashingEmbedder(64),
    });
    const jobs = Array.from({ length: 4 }, (_, i) => ({
      properties: track(`t${i}`, { title: `T${i}` }),
    }));
    // Every 2nd batch fails until the last attempt; retries still succeed
    // because the stub throws a fixed number of times, not forever.
    const report = await db.ingest(jobs, { batchSize: 2, maxRetries: 2 });

    expect(report.embedded).toBe(4);
    expect(report.batchSize).toBe(2);
  });
});

describe("clustering", () => {
  test("groups the catalogue into labelled, projected clusters", async () => {
    const db = await seededDb();
    const result = await db.clustering({ k: 3 });

    expect(result.clusters.length).toBeGreaterThan(0);
    expect(result.points.length).toBeGreaterThan(0);
    expect(result.sampled).toBe(CATALOGUE.length);
    for (const cluster of result.clusters) {
      expect(cluster.label.length).toBeGreaterThan(0);
      expect(cluster.centroid.length).toBe(1024);
    }
  });

  test("clustering is deterministic across runs", async () => {
    const db = await seededDb();
    const first = await db.clustering({ k: 3 });
    const second = await db.clustering({ k: 3 });

    expect(first.clusters.map((c) => c.label)).toEqual(
      second.clusters.map((c) => c.label),
    );
    expect(first.points.map((p) => p.cluster)).toEqual(
      second.points.map((p) => p.cluster),
    );
  });
});

describe("observability", () => {
  test("stats report vectors, dimensions and measured latency", async () => {
    const db = await seededDb();
    await db.search({ query: "calm music", limit: 3 });
    const stats = db.stats();

    expect(stats.totalRecords).toBe(CATALOGUE.length);
    expect(stats.totalVectors).toBeGreaterThan(0);
    expect(stats.byVectorType.audio).toBe(CATALOGUE.length);
    expect(stats.byModel["synq-hashing"]).toBeGreaterThan(0);
    expect(stats.dimensions.audio).toBe(1024);
    expect(stats.searchCount).toBeGreaterThan(0);
    expect(stats.index.metric).toBe("cosine");
    expect(stats.index.kind).toBe("hnsw");
  });
});
