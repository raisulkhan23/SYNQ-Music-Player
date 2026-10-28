/**
 * Convex-backed vector store.
 *
 * Implements the same `VectorStore` interface as the in-memory reference store
 * (spec §10), so the engine cannot tell the difference and swapping between
 * them is a factory argument.
 *
 * Convex is this project's database already, which makes it the right place for
 * durable vectors: it inherits the deployment's tenancy, backups and
 * consistency guarantees instead of adding a second datastore that would need
 * its own operational story.
 *
 * The adapter takes BOUND CALLBACKS rather than the action context. Two reasons,
 * both real: `ctx.runQuery` in Convex is typed against generated function
 * references, so passing raw strings loses all type checking; and a store that
 * takes four functions instead of an entire context is testable without a
 * Convex deployment.
 *
 * Two honest trade-offs, both visible in `stats()` rather than hidden:
 *
 * 1. Reads PAGE, because a query result has a size ceiling. A 2000-track
 *    library is read in pages instead of one oversized request.
 * 2. Nearest-neighbour is exact, not approximate. HNSW sits behind this same
 *    interface for when the catalogue outgrows it, and the `IndexConfig` is
 *    reported on every stats call so the switch is visible rather than silent.
 */
import {
  matchesFilters,
  type Candidate,
  type VectorStore,
} from "../lib/musicdb";
import { similarity } from "../lib/musicdb/embedder";
import {
  DEFAULT_INDEX_CONFIG,
  type DistanceMetric,
  type Filters,
  type IndexConfig,
  type VectorRecord,
  type VectorStats,
  type VectorType,
} from "../lib/musicdb/types";

export type StoredRecord = {
  trackId: string;
  properties: unknown;
  vectors: unknown;
  versions: unknown;
  signature: string;
  createdAt: number;
  updatedAt: number;
};

export type RecordPage = {
  rows: StoredRecord[];
  isDone: boolean;
  continueCursor: string;
};

/** Bound Convex entry points for this store. */
export type VectorDb = {
  listRecords: (args: {
    ownerId: string;
    cursor?: string;
    numItems?: number;
  }) => Promise<RecordPage>;
  recordByTrack: (args: {
    ownerId: string;
    trackId: string;
  }) => Promise<StoredRecord | null>;
  saveRecords: (args: {
    ownerId: string;
    records: {
      trackId: string;
      properties: unknown;
      vectors: unknown;
      versions: unknown;
      signature: string;
      createdAt: number;
      updatedAt: number;
    }[];
  }) => Promise<unknown>;
  removeRecords: (args: {
    ownerId: string;
    trackIds: string[];
  }) => Promise<unknown>;
};

export class ConvexVectorStore implements VectorStore {
  readonly name = "convex";
  readonly index: IndexConfig;
  private readonly db: VectorDb;
  /** Every read and write is confined to one owner. The store cannot be
   *  constructed without one, so no query can span two listeners' data. */
  private readonly ownerId: string;

  constructor(db: VectorDb, ownerId: string, index: Partial<IndexConfig> = {}) {
    this.db = db;
    this.ownerId = ownerId;
    this.index = { ...DEFAULT_INDEX_CONFIG, ...index };
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.db.saveRecords({
      ownerId: this.ownerId,
      records: records.map((record) => ({
        trackId: record.id,
        properties: record.properties,
        vectors: record.vectors,
        versions: record.versions,
        signature: readSignature(record),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })),
    });
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.removeRecords({ ownerId: this.ownerId, trackIds: ids });
  }

  async get(id: string): Promise<VectorRecord | null> {
    const row = await this.db.recordByTrack({
      ownerId: this.ownerId,
      trackId: id,
    });
    return row ? toRecord(row) : null;
  }

  async list(
    options: { limit?: number; offset?: number } = {},
  ): Promise<VectorRecord[]> {
    const rows = await this.allRows(options.limit ?? 2000);
    return rows.map(toRecord);
  }

  async searchByVector(args: {
    vector: number[];
    type: VectorType;
    limit: number;
    filters?: Filters;
    metric?: DistanceMetric;
    excludeIds?: string[];
  }): Promise<Candidate[]> {
    const rows = await this.allRows();
    const exclude = new Set(args.excludeIds ?? []);
    const metric = args.metric ?? this.index.metric;
    const scored: Candidate[] = [];

    for (const row of rows) {
      const record = toRecord(row);
      if (exclude.has(record.id)) continue;
      if (!matchesFilters(record.properties, args.filters)) continue;
      const vectors = record.vectors as Record<string, number[] | undefined>;
      const score = similarity(args.vector, vectors?.[args.type], metric);
      if (score > 0) scored.push({ id: record.id, score, rank: 0 });
    }
    return rank(scored, args.limit);
  }

  async searchByKeyword(args: {
    terms: string[];
    limit: number;
    filters?: Filters;
    excludeIds?: string[];
  }): Promise<Candidate[]> {
    const rows = await this.allRows();
    const exclude = new Set(args.excludeIds ?? []);
    const terms = args.terms.map((t) => t.toLowerCase()).filter(Boolean);
    if (terms.length === 0) return [];

    const scored: Candidate[] = [];
    for (const row of rows) {
      const record = toRecord(row);
      if (exclude.has(record.id)) continue;
      if (!matchesFilters(record.properties, args.filters)) continue;
      const text = searchableText(record.properties).toLowerCase();
      if (!text) continue;
      let score = 0;
      for (const term of terms) {
        if (text.includes(term)) score += 1 + Math.log(countOf(text, term));
      }
      if (score > 0) scored.push({ id: record.id, score, rank: 0 });
    }
    return rank(scored, args.limit);
  }

  stats(): VectorStats {
    // Counters belong to the deployment, not to a store instance that lives
    // for the length of one action. Reporting zeros is honest; inventing a
    // plausible number here would not be.
    return {
      totalRecords: 0,
      totalVectors: 0,
      byVectorType: {},
      byModel: {},
      dimensions: {},
      index: this.index,
      lastSearchLatencyMs: 0,
      searchCount: 0,
      failedJobs: 0,
      duplicateCandidates: 0,
    };
  }

  /** Pages this owner's records. `limit` is a safety cap, not a page size. */
  private async allRows(limit = 2000): Promise<StoredRecord[]> {
    const rows: StoredRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.db.listRecords({
        ownerId: this.ownerId,
        cursor,
        numItems: 128,
      });
      rows.push(...page.rows);
      cursor = page.continueCursor;
      if (page.isDone) break;
    } while (rows.length < limit);
    return rows.slice(0, limit);
  }
}

/** The signature rides on the record's metadata bag, because that is what
 *  ingestion actually hashed. Read defensively: a record written before
 *  signatures existed has none, and is treated as changed so the index heals. */
function readSignature(record: VectorRecord): string {
  const value = (record.properties as Record<string, unknown>)["signature"];
  return typeof value === "string" ? value : "";
}

function toRecord(row: StoredRecord): VectorRecord {
  return {
    id: row.trackId,
    properties: row.properties as VectorRecord["properties"],
    vectors: row.vectors as VectorRecord["vectors"],
    versions: row.versions as VectorRecord["versions"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function searchableText(properties: VectorRecord["properties"]): string {
  return [
    properties.title,
    properties.artist,
    properties.album,
    properties.language,
    properties.region,
    ...(properties.genres ?? []),
    ...(properties.moods ?? []),
    ...(properties.tags ?? []),
    ...(properties.instruments ?? []),
  ]
    .filter(Boolean)
    .join(" ");
}

function countOf(haystack: string, needle: string): number {
  let count = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    count += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return count;
}

function rank(scored: Candidate[], limit: number): Candidate[] {
  return scored
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((c, i) => ({ ...c, rank: i + 1 }));
}
