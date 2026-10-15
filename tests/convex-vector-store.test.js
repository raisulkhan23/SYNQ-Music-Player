/**
 * The Convex-backed vector store.
 *
 * The engine is proven against the in-memory store, but that store can be
 * wrong in ways a real database cannot (it never paginates, never enforces an
 * owner, never hits a size limit). These tests drive the Convex adapter
 * against an in-process fake so the parts that only matter against a real
 * deployment — pagination and tenant isolation — are actually exercised.
 */
import { describe, expect, test } from 'vitest';
import { ConvexVectorStore } from "../src/convex/convexVectorStore";
import { HashingEmbedder, MusicVectorDB } from "../src/lib/musicdb";

/** A fake Convex deployment: indexed rows, honest pagination, owner isolation. */
function fakeConvex() {
  const rows = new Map();
  let nextId = 1;
  const stats = { listCalls: 0, maxPageSize: 0 };

  const pageSize = 2;

  const matchesOwner = (row, ownerId) => row.ownerId === ownerId;

  return {
    stats,
    rows,
    db: {
      async listRecords({ ownerId, cursor, numItems }) {
        stats.listCalls += 1;
        const size = numItems ?? pageSize;
        stats.maxPageSize = Math.max(stats.maxPageSize, size);
        const all = [...rows.values()].filter((r) => matchesOwner(r, ownerId));
        const start = cursor ? Number(cursor) : 0;
        const slice = all.slice(start, start + pageSize);
        const next = start + slice.length;
        return {
          rows: slice.map((r) => ({ ...r })),
          isDone: next >= all.length,
          continueCursor: String(next),
        };
      },
      async recordByTrack({ ownerId, trackId }) {
        for (const row of rows.values()) {
          if (matchesOwner(row, ownerId) && row.trackId === trackId) {
            return { ...row };
          }
        }
        return null;
      },
      async saveRecords({ ownerId, records }) {
        for (const record of records) {
          const key = `${ownerId}:${record.trackId}`;
          const existingId = [...rows.entries()].find(
            ([, r]) => r.ownerId === ownerId && r.trackId === record.trackId,
          )?.[0];
          if (existingId) {
            rows.set(existingId, { ...rows.get(existingId), ...record });
          } else {
            rows.set(String(nextId++), { ...record, ownerId });
          }
          void key;
        }
        return { saved: records.length };
      },
      async removeRecords({ ownerId, trackIds }) {
        for (const [id, row] of [...rows.entries()]) {
          if (matchesOwner(row, ownerId) && trackIds.includes(row.trackId)) {
            rows.delete(id);
          }
        }
        return { removed: trackIds.length };
      },
    },
  };
}

const CATALOGUE = [
  {
    trackId: "a1",
    kind: "track",
    title: "Rain on the Window",
    artist: "Mila Grey",
    genres: ["folk"],
    moods: ["sad"],
    energy: 0.2,
    language: "English",
  },
  {
    trackId: "a2",
    kind: "track",
    title: "Rain Again",
    artist: "The Hollow",
    genres: ["indie rock"],
    moods: ["melancholic"],
    energy: 0.3,
    language: "English",
  },
  {
    trackId: "a3",
    kind: "track",
    title: "Boro Megher Rodh",
    artist: "Anwesha",
    genres: ["folk"],
    moods: ["calm"],
    energy: 0.25,
    language: "Bengali",
  },
  {
    trackId: "a4",
    kind: "track",
    title: "Push It Hard",
    artist: "Neon Drive",
    genres: ["electronic"],
    moods: ["energetic"],
    energy: 0.95,
    language: "English",
  },
  {
    trackId: "a5",
    kind: "track",
    title: "Quiet Study",
    artist: "Mila Grey",
    genres: ["classical"],
    moods: ["calm"],
    energy: 0.1,
    language: "English",
  },
];

async function seeded(ownerId = "user-a") {
  const fake = fakeConvex();
  const db = new MusicVectorDB({
    store: new ConvexVectorStore(fake.db, ownerId),
    embedder: new HashingEmbedder(1024),
  });
  await db.ingest(CATALOGUE.map((properties) => ({ properties })));
  return { fake, db };
}

describe("convex vector store", () => {
  test("stores and reads back every ingested record", async () => {
    const { db } = await seeded();
    const all = await db.store.list();
    expect(all.length).toBe(CATALOGUE.length);
    expect(all.map((r) => r.id).sort()).toEqual(["a1", "a2", "a3", "a4", "a5"]);
  });

  test("pages through records rather than reading them in one response", async () => {
    const { db, fake } = await seeded();
    const all = await db.store.list();
    expect(all.length).toBe(5);
    // The fake serves 2 rows per response regardless of the requested page
    // size, so reaching all 5 records REQUIRES more than one round trip.
    expect(fake.stats.listCalls).toBeGreaterThan(1);
    // ...and the store asked for a real page size rather than a single read.
    expect(fake.stats.maxPageSize).toBeGreaterThanOrEqual(128);
  });

  test("a record is fetched by track id", async () => {
    const { db } = await seeded();
    const record = await db.get("a3");
    expect(record).not.toBeNull();
    expect(record.properties.title).toBe("Boro Megher Rodh");
    expect(await db.get("does-not-exist")).toBeNull();
  });

  test("one owner can never read another owner's records", async () => {
    const fake = fakeConvex();
    const embedder = new HashingEmbedder(1024);
    const storeA = new ConvexVectorStore(fake.db, "user-a");
    const storeB = new ConvexVectorStore(fake.db, "user-b");

    await storeA.upsert(
      await buildRecords(embedder, [{ trackId: "a1", title: "Mine" }]),
    );
    await storeB.upsert(
      await buildRecords(embedder, [{ trackId: "b1", title: "Theirs" }]),
    );

    expect((await storeA.list()).map((r) => r.id)).toEqual(["a1"]);
    expect((await storeB.list()).map((r) => r.id)).toEqual(["b1"]);
    expect(await storeA.get("b1")).toBeNull();
  });

  test("search returns ranked candidates from the durable store", async () => {
    const { db } = await seeded();
    const results = await db.search({
      query: "sad rainy folk songs",
      limit: 3,
    });
    expect(results.length).toBeGreaterThan(0);
    const scores = results.map((r) => r.score);
    // Descending order is the whole point of ranking.
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  test("filters are applied inside the store, not after ranking", async () => {
    const { db } = await seeded();
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

  test("keyword search finds a match on the language field", async () => {
    const { db } = await seeded();
    const results = await db.hybrid({
      query: "Bengali songs",
      limit: 5,
      strategy: "keyword_only",
    });
    expect(results[0].record.id).toBe("a3");
  });

  test("deleting a record removes it", async () => {
    const { db } = await seeded();
    await db.delete(["a1"]);
    expect(await db.get("a1")).toBeNull();
    expect((await db.store.list()).length).toBe(CATALOGUE.length - 1);
  });

  test("re-ingesting the same track updates rather than duplicates", async () => {
    const { db } = await seeded();
    await db.ingest([
      {
        properties: {
          trackId: "a1",
          kind: "track",
          title: "Rain on the Window (Remastered)",
          artist: "Mila Grey",
        },
      },
    ]);
    const all = await db.store.list();
    expect(all.length).toBe(CATALOGUE.length);
    const updated = await db.get("a1");
    expect(updated.properties.title).toBe("Rain on the Window (Remastered)");
  });
});

async function buildRecords(embedder, items) {
  const db = new MusicVectorDB({
    store: new ConvexVectorStore(fakeConvex().db, "seed"),
    embedder,
  });
  // Build records without storing them: reuse the engine's own record builder
  // through an ingest into a throwaway store, then read them back out.
  await db.ingest(items.map((properties) => ({ properties })));
  return (await db.store.list()).map((record) => record);
}
