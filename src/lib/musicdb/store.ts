/**
 * Vector storage — the provider boundary (spec §10).
 *
 * `VectorStore` is the only thing in the system that knows how vectors are
 * held. Search, ranking and recommendations speak this interface, so moving
 * from this in-memory reference implementation to Weaviate, Qdrant, pgvector
 * or Milvus means writing one adapter and changing one factory call.
 *
 * The interface is deliberately shaped around ANN (spec §11): a store returns
 * CANDIDATES by vector and by keyword, and the engine fuses them. A store that
 * could only do exhaustive search would not be a drop-in for HNSW, and a store
 * that fused results itself would put the ranking strategy inside the database,
 * where it could not be tuned from the admin panel.
 */

import { similarity } from "./embedder";
import {
  DEFAULT_INDEX_CONFIG,
  type DistanceMetric,
  type Filters,
  type IndexConfig,
  type MusicProperties,
  type VectorRecord,
  type VectorStats,
  type VectorType,
} from "./types";

/** A candidate from a nearest-neighbour or keyword pass. */
export type Candidate = {
  id: string;
  score: number;
  /** 1-based rank within this sub-search, kept for fusion debugging. */
  rank: number;
};

export interface VectorStore {
  readonly name: string;
  readonly index: IndexConfig;

  upsert(records: VectorRecord[]): Promise<void>;
  delete(ids: string[]): Promise<void>;
  get(id: string): Promise<VectorRecord | null>;
  list(options?: { limit?: number; offset?: number }): Promise<VectorRecord[]>;
  /** Filters applied first, then nearest-neighbour over `type`. */
  searchByVector(args: {
    vector: number[];
    type: VectorType;
    limit: number;
    filters?: Filters;
    metric?: DistanceMetric;
    excludeIds?: string[];
  }): Promise<Candidate[]>;
  /** Keyword/full-text pass for hybrid search (spec §5). */
  searchByKeyword(args: {
    terms: string[];
    limit: number;
    filters?: Filters;
    excludeIds?: string[];
  }): Promise<Candidate[]>;
  stats(): VectorStats;
}

/** Normalises an array-valued property for `contains`/`in` checks. */
function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value == null) return [];
  return [value];
}

/**
 * Filter evaluation (spec §6).
 *
 * Applied in the store BEFORE vector search, which is what makes it cheap: a
 * metadata filter that runs after nearest-neighbour has already paid for the
 * full ANN scan. Kept here rather than inside a provider so every store
 * applies identical semantics and a query cannot mean two things.
 */
export function matchesFilters(
  properties: MusicProperties,
  filters: Filters | undefined,
): boolean {
  if (!filters) return true;

  if (filters.ownerId !== undefined) {
    // Tenant isolation is checked first and is not optional (spec §18).
    if (properties.ownerId !== filters.ownerId) return false;
  }

  for (const condition of filters.conditions ?? []) {
    if (!matchesCondition(properties, condition)) return false;
  }

  const range = (
    value: unknown,
    min: number | undefined,
    max: number | undefined,
  ): boolean => {
    if (min === undefined && max === undefined) return true;
    if (typeof value !== "number") return false;
    if (min !== undefined && value < min) return false;
    if (max !== undefined && value > max) return false;
    return true;
  };

  if (
    !range(
      properties.releaseYear,
      filters.releaseYearMin,
      filters.releaseYearMax,
    )
  )
    return false;
  if (!range(properties.bpm, filters.bpmMin, filters.bpmMax)) return false;
  if (!range(properties.duration, filters.durationMin, filters.durationMax))
    return false;
  if (!range(properties.energy, filters.energyMin, filters.energyMax))
    return false;
  if (
    !range(
      properties.danceability,
      filters.danceabilityMin,
      filters.danceabilityMax,
    )
  )
    return false;
  if (
    typeof filters.popularityMin === "number" &&
    (typeof properties.popularity !== "number" ||
      properties.popularity < filters.popularityMin)
  )
    return false;

  return true;
}

function matchesCondition(
  properties: MusicProperties,
  condition: Filters["conditions"][number],
): boolean {
  const actual = properties[condition.field];
  const { op, value } = condition;

  switch (op) {
    case "eq":
      if (Array.isArray(actual)) return actual.some((v) => v === value);
      return actual === value;
    case "ne":
      if (Array.isArray(actual)) return !actual.some((v) => v === value);
      return actual !== value;
    case "in":
      if (!Array.isArray(value)) return false;
      return value.some((v) => asArray(actual).includes(v));
    case "nin":
      if (!Array.isArray(value)) return true;
      return !value.some((v) => asArray(actual).includes(v));
    case "contains": {
      const values = asArray(actual);
      return values.some((v) =>
        String(v).toLowerCase().includes(String(value).toLowerCase()),
      );
    }
    case "gt":
      return typeof actual === "number" && actual > Number(value);
    case "gte":
      return typeof actual === "number" && actual >= Number(value);
    case "lt":
      return typeof actual === "number" && actual < Number(value);
    case "lte":
      return typeof actual === "number" && actual <= Number(value);
    default:
      return false;
  }
}

/** Text a record exposes to keyword search.
 *
 *  Language and region are included because "Bengali songs" is a keyword
 *  query — the word appears on the track's `language` field and nowhere else,
 *  so leaving it out made that search return only songs whose LYRICS happened
 *  to contain the word, which is not the same thing at all. */
function searchableText(properties: MusicProperties): string {
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
    ...(properties.subgenres ?? []),
    ...(properties.vocalCharacteristics ?? []),
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * In-memory reference store.
 *
 * Exhaustive nearest-neighbour under the hood, with the HNSW parameters
 * recorded and honoured for reporting. This is the honest position: it is
 * exact, which makes it the correct baseline to measure a real ANN engine
 * against, and it is the adapter the tests run on so the engine is proven
 * before it meets a network.
 */
export class MemoryVectorStore implements VectorStore {
  readonly name = "memory";
  readonly index: IndexConfig;
  private readonly records = new Map<string, VectorRecord>();
  private searchCount = 0;
  private lastSearchLatencyMs = 0;
  private duplicateCandidates = 0;

  constructor(index: Partial<IndexConfig> = {}) {
    this.index = { ...DEFAULT_INDEX_CONFIG, ...index };
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    for (const record of records) {
      const existing = this.records.get(record.id);
      this.records.set(record.id, {
        ...record,
        createdAt: existing?.createdAt ?? record.createdAt,
        updatedAt: record.updatedAt,
      });
    }
  }

  async delete(ids: string[]): Promise<void> {
    for (const id of ids) this.records.delete(id);
  }

  async get(id: string): Promise<VectorRecord | null> {
    return this.records.get(id) ?? null;
  }

  async list(
    options: { limit?: number; offset?: number } = {},
  ): Promise<VectorRecord[]> {
    const all = [...this.records.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    const offset = options.offset ?? 0;
    const limit = options.limit ?? all.length;
    return all.slice(offset, offset + limit);
  }

  async searchByVector(args: {
    vector: number[];
    type: VectorType;
    limit: number;
    filters?: Filters;
    metric?: DistanceMetric;
    excludeIds?: string[];
  }): Promise<Candidate[]> {
    const started = now();
    const exclude = new Set(args.excludeIds ?? []);
    const metric = args.metric ?? this.index.metric;
    const scored: Candidate[] = [];

    for (const record of this.records.values()) {
      if (exclude.has(record.id)) continue;
      if (!matchesFilters(record.properties, args.filters)) continue;
      const score = similarity(args.vector, record.vectors[args.type], metric);
      scored.push({ id: record.id, score, rank: 0 });
    }

    const out = rank(scored, args.limit);
    this.recordSearch(started);
    return out;
  }

  async searchByKeyword(args: {
    terms: string[];
    limit: number;
    filters?: Filters;
    excludeIds?: string[];
  }): Promise<Candidate[]> {
    const started = now();
    const exclude = new Set(args.excludeIds ?? []);
    const terms = args.terms.map((t) => t.toLowerCase()).filter(Boolean);
    if (terms.length === 0) {
      this.recordSearch(started);
      return [];
    }

    const scored: Candidate[] = [];
    for (const record of this.records.values()) {
      if (exclude.has(record.id)) continue;
      if (!matchesFilters(record.properties, args.filters)) continue;
      const text = searchableText(record.properties).toLowerCase();
      if (!text) continue;
      let score = 0;
      for (const term of terms) {
        // Sub-linear term frequency: the tenth "love" is not ten times the
        // first, and an exact field match is worth more than a substring.
        const count = countOccurrences(text, term);
        if (count > 0) {
          score += 1 + Math.log(count);
          if (propertiesFieldMatches(record.properties, term)) score += 0.5;
        }
      }
      if (score > 0) scored.push({ id: record.id, score, rank: 0 });
    }

    const out = rank(scored, args.limit);
    this.recordSearch(started);
    return out;
  }

  /** Duplicate review-queue depth, set by the duplicate detector (spec §14). */
  setDuplicateCandidates(count: number): void {
    this.duplicateCandidates = count;
  }

  stats(): VectorStats {
    const byVectorType: Record<string, number> = {};
    const byModel: Record<string, number> = {};
    const dimensions: Record<string, number> = {};

    let totalVectors = 0;
    for (const record of this.records.values()) {
      for (const [type, version] of Object.entries(record.versions)) {
        if (!version) continue;
        totalVectors += 1;
        byVectorType[type] = (byVectorType[type] ?? 0) + 1;
        byModel[version.model] = (byModel[version.model] ?? 0) + 1;
        dimensions[type] = version.dimension;
      }
    }

    return {
      totalRecords: this.records.size,
      totalVectors,
      byVectorType,
      byModel,
      dimensions,
      index: this.index,
      lastSearchLatencyMs: this.lastSearchLatencyMs,
      searchCount: this.searchCount,
      failedJobs: 0,
      duplicateCandidates: this.duplicateCandidates,
    };
  }

  private recordSearch(started: number): void {
    this.searchCount += 1;
    this.lastSearchLatencyMs = Math.round((now() - started) * 1000) / 1000;
  }
}

function propertiesFieldMatches(p: MusicProperties, term: string): boolean {
  const fields = [
    p.title,
    p.artist,
    p.album,
    p.language,
    ...(p.genres ?? []),
  ].filter(Boolean) as string[];
  return fields.some((f) => f.toLowerCase().includes(term));
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function rank(scored: Candidate[], limit: number): Candidate[] {
  return scored
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((c, i) => ({ ...c, rank: i + 1 }));
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
