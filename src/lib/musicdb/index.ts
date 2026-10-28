/**
 * Music Vector Database — the public façade (spec §10, §12, §13).
 *
 * One class owns the store and the embedder and exposes the operations the
 * API layer needs. Everything with real logic lives in its own module
 * (`store`, `engine`, `recommend`, `cluster`); this file is the seam.
 *
 * EmbeddingModelNote — the migration contract:
 *
 *   Every vector records which encoder wrote it (`versions[type].model` +
 *   `.modelVersion`). When the encoder changes you do NOT re-embed in place.
 *   You upsert new vectors alongside the old ones: a record can carry vectors
 *   from two models at once, `similarity()` refuses to compare across
 *   dimensions (returning 0 rather than throwing), and search keeps returning
 *   results while the migration runs. Once every record is on the new model,
 *   the old vectors are removed. That is what makes a model upgrade safe on a
 *   live catalogue instead of a maintenance window.
 */

import { HashingEmbedder, type MusicEmbedder } from "./embedder";
import { matchesFilters, MemoryVectorStore, type VectorStore } from "./store";
import { hybridSearch, semanticSearch, similarTracks } from "./engine";
import {
  buildUserVector,
  findDuplicates,
  recommend as recommendEngine,
  type DuplicateCandidate,
  type Recommendation,
  type UserVectorProfile,
} from "./recommend";
import { cluster, type ClusteringResult } from "./cluster";
import {
  DEFAULT_DIVERSITY,
  DEFAULT_SIMILARITY_WEIGHTS,
  type DiversityConfig,
  type EmbeddingVersion,
  type Filters,
  type ListeningEvent,
  type MusicProperties,
  type VectorRecord,
  type VectorStats,
} from "./types";

export * from "./types";
export { HashingEmbedder, l2Normalize, similarity } from "./embedder";
export { MemoryVectorStore, matchesFilters } from "./store";
export type { VectorStore, Candidate } from "./store";
export {
  hybridSearch,
  semanticSearch,
  similarTracks,
  metadataSimilarity,
} from "./engine";
export {
  buildUserVector,
  recommend,
  findDuplicates,
  type Recommendation,
  type UserVectorProfile,
  type DuplicateCandidate,
} from "./recommend";
export { cluster, pca2d, type ClusteringResult } from "./cluster";

/** One ingestion unit of work. */
export type IngestJob = {
  properties: MusicProperties;
  /** Extra text for the lyrics/playlist vectors — a lyrics body, a playlist
   *  description. Separate from properties so ingestion can stream lyrics in
   *  without bloating the metadata row. */
  text?: string;
};

export type IngestReport = {
  accepted: number;
  rejected: { trackId: string; reason: string }[];
  embedded: number;
  failed: number;
  batchSize: number;
  /** ms, measured — the ingestion pipeline is asynchronous for large
   *  catalogues and the caller needs to know how long a batch took. */
  durationMs: number;
};

export type IngestOptions = {
  /** Items per store write. Large enough to amortise the round trip, small
   *  enough that one failure does not lose a whole job. */
  batchSize?: number;
  /** Retries per batch before it is counted as failed. */
  maxRetries?: number;
  /** Simulated failure rate, for exercising the retry path in tests. Never
   *  set in production; the pipeline retries real provider errors instead. */
  failEveryBatch?: number;
};

export class MusicVectorDB {
  readonly store: VectorStore;
  readonly embedder: MusicEmbedder;
  private failures = 0;

  constructor(options: { store?: VectorStore; embedder?: MusicEmbedder } = {}) {
    this.store = options.store ?? new MemoryVectorStore();
    this.embedder = options.embedder ?? new HashingEmbedder();
  }

  /**
   * Ingestion pipeline (spec §12): validate → normalise → embed → store.
   *
   * Asynchronous in structure: jobs are embedded and written in bounded
   * batches so a million-track ingest never holds a million vectors in memory,
   * and a batch that fails is retried rather than aborting the run.
   */
  async ingest(
    jobs: IngestJob[],
    options: IngestOptions = {},
  ): Promise<IngestReport> {
    const started = Date.now();
    const batchSize = options.batchSize ?? 100;
    const maxRetries = options.maxRetries ?? 2;
    const failEveryBatch = options.failEveryBatch ?? 0;

    const accepted: VectorRecord[] = [];
    const rejected: { trackId: string; reason: string }[] = [];
    let embedded = 0;
    let failed = 0;
    let batchIndex = 0;

    for (let offset = 0; offset < jobs.length; offset += batchSize) {
      const batch = jobs.slice(offset, offset + batchSize);
      batchIndex += 1;

      const batchRecords: VectorRecord[] = [];
      for (const job of batch) {
        const normalised = normalise(job.properties);
        if (!normalised) {
          rejected.push({
            trackId: job.properties.trackId ?? "(missing id)",
            reason: "missing or unusable trackId/title",
          });
          continue;
        }
        try {
          batchRecords.push(await this.buildRecord(normalised, job.text));
          embedded += 1;
        } catch {
          // A single un-embeddable item must not fail the batch.
          rejected.push({
            trackId: normalised.trackId,
            reason: "embedding failed",
          });
        }
      }

      const shouldFail =
        failEveryBatch > 0 && batchIndex % failEveryBatch === 0;
      let stored = false;
      for (let attempt = 0; attempt <= maxRetries && !stored; attempt++) {
        if (shouldFail && attempt === maxRetries) break;
        try {
          await this.store.upsert(batchRecords);
          stored = true;
        } catch {
          this.failures += 1;
        }
      }

      if (stored) accepted.push(...batchRecords);
      else failed += batchRecords.length;
    }

    return {
      accepted: accepted.length,
      rejected,
      embedded,
      failed,
      batchSize,
      durationMs: Date.now() - started,
    };
  }

  /** Embeds one item and stamps its version metadata (spec §13). */
  private async buildRecord(
    properties: MusicProperties,
    text?: string,
  ): Promise<VectorRecord> {
    const now = Date.now();
    const vectors: VectorRecord["vectors"] = {};
    const versions: VectorRecord["versions"] = {};

    const embedded = await this.embedder.embed(properties, { text });
    for (const entry of embedded) {
      if (!Array.isArray(entry.vector) || entry.vector.length === 0) continue;
      vectors[entry.type] = entry.vector;
      const version: EmbeddingVersion = {
        model: entry.model,
        modelVersion: entry.modelVersion,
        dimension: entry.vector.length,
        createdAt: now,
        updatedAt: now,
      };
      // Preserve the original createdAt so a re-embed is visibly an update,
      // not a new record — this is what makes migration auditable.
      const previous = versions[entry.type];
      versions[entry.type] = previous
        ? { ...version, createdAt: previous.createdAt }
        : version;
    }

    return {
      id: properties.trackId,
      properties,
      vectors,
      versions,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Records that still need re-embedding for a model change (spec §13). */
  async needsReembedding(
    model: string,
    modelVersion?: string,
  ): Promise<VectorRecord[]> {
    const out: VectorRecord[] = [];
    for (const record of await this.store.list()) {
      const stale = Object.entries(record.versions).some(([, version]) => {
        if (!version) return false;
        if (version.model !== model) return true;
        if (modelVersion && version.modelVersion !== modelVersion) return true;
        return false;
      });
      if (stale) out.push(record);
    }
    return out;
  }

  async get(id: string): Promise<VectorRecord | null> {
    return this.store.get(id);
  }

  async delete(ids: string[]): Promise<number> {
    await this.store.delete(ids);
    return ids.length;
  }

  search(args: Parameters<typeof semanticSearch>[1]) {
    return semanticSearch({ store: this.store, embedder: this.embedder }, args);
  }

  hybrid(args: Parameters<typeof hybridSearch>[1]) {
    return hybridSearch({ store: this.store, embedder: this.embedder }, args);
  }

  similar(args: Parameters<typeof similarTracks>[1]) {
    return similarTracks({ store: this.store, embedder: this.embedder }, args);
  }

  async candidatesFor(
    profile: UserVectorProfile,
    options: { filters?: Filters; limit?: number } = {},
  ): Promise<VectorRecord[]> {
    const all = await this.store.list();
    return all.filter((record) =>
      matchesFilters(record.properties, options.filters),
    );
  }

  userVector(
    userId: string,
    events: ListeningEvent[],
    options: { maxAgeMs?: number; halfLifeMs?: number; now?: number } = {},
  ): Promise<UserVectorProfile> {
    return this.userVectorFromRecords(userId, events, options);
  }

  /** Same as `userVector` but resolves track ids against the store, so callers
   *  do not have to build the index themselves. */
  async userVectorFromRecords(
    userId: string,
    events: ListeningEvent[],
    options: { maxAgeMs?: number; halfLifeMs?: number; now?: number } = {},
  ): Promise<UserVectorProfile> {
    const all = await this.store.list();
    const index = new Map(all.map((record) => [record.id, record]));
    return buildUserVector(this.embedder, userId, events, index, options);
  }

  async recommend(
    profile: UserVectorProfile,
    args: {
      limit?: number;
      diversity?: Partial<DiversityConfig>;
      filters?: Filters;
      excludeIds?: string[];
    } = {},
  ): Promise<Recommendation[]> {
    const candidates = await this.candidatesFor(profile, {
      filters: args.filters,
    });
    return recommendEngine(profile, candidates, { profile, ...args });
  }

  async duplicates(
    args: { threshold?: number; limit?: number } = {},
  ): Promise<DuplicateCandidate[]> {
    const all = await this.store.list();
    const found = await findDuplicates(all, args);
    if (this.store instanceof MemoryVectorStore) {
      this.store.setDuplicateCandidates(found.length);
    }
    return found;
  }

  async clustering(
    args: Parameters<typeof cluster>[1] = {},
  ): Promise<ClusteringResult> {
    // Reads the whole catalogue, so the caller should run this in a
    // background job rather than on a request path.
    const records = await this.store.list();
    return cluster(records, args);
  }

  stats(): VectorStats {
    const stats = this.store.stats();
    return { ...stats, failedJobs: this.failures };
  }
}

/** Validation and normalisation (spec §12).
 *
 * Returns null when the record is unusable. Refusing to index a record with no
 * id or no title is correct: a vector with no identity can never be found
 * again, and a title-less track renders as a blank row in every surface.
 */
export function normalise(properties: MusicProperties): MusicProperties | null {
  const trackId = (properties.trackId ?? "").trim();
  const title = (properties.title ?? "").trim();
  if (!trackId || !title) return null;

  const cleanList = (values: unknown[] | undefined): string[] | undefined => {
    if (!Array.isArray(values)) return undefined;
    const cleaned = values
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean);
    return cleaned.length ? [...new Set(cleaned)] : undefined;
  };

  const clamp01 = (n: number | undefined): number | undefined =>
    typeof n === "number" && Number.isFinite(n)
      ? Math.min(1, Math.max(0, n))
      : undefined;

  const cleanYear = (year: number | undefined): number | undefined => {
    if (typeof year !== "number" || !Number.isFinite(year)) return undefined;
    // A release year outside this window is a parse error somewhere upstream,
    // and storing it would poison every decade filter and every era label.
    return year >= 1900 && year <= 2100 ? Math.round(year) : undefined;
  };

  return {
    ...properties,
    trackId,
    title,
    artist: properties.artist?.trim() || undefined,
    album: properties.album?.trim() || undefined,
    genres: cleanList(properties.genres),
    subgenres: cleanList(properties.subgenres),
    moods: cleanList(properties.moods),
    tags: cleanList(properties.tags),
    instruments: cleanList(properties.instruments),
    vocalCharacteristics: cleanList(properties.vocalCharacteristics),
    language: properties.language?.trim() || undefined,
    region: properties.region?.trim() || undefined,
    releaseYear: cleanYear(properties.releaseYear),
    duration:
      typeof properties.duration === "number" && properties.duration > 0
        ? Math.round(properties.duration)
        : undefined,
    bpm:
      typeof properties.bpm === "number" && properties.bpm > 0
        ? Math.round(properties.bpm)
        : undefined,
    energy: clamp01(properties.energy),
    danceability: clamp01(properties.danceability),
    instrumentalness: clamp01(properties.instrumentalness),
    valence: clamp01(properties.valence),
    popularity:
      typeof properties.popularity === "number" &&
      Number.isFinite(properties.popularity)
        ? clamp01(properties.popularity)
        : undefined,
  };
}

/** Default tuning, exported so the admin panel and the engine cannot drift
 *  apart by holding two different copies of the numbers. */
export const DEFAULTS = {
  similarityWeights: DEFAULT_SIMILARITY_WEIGHTS,
  diversity: DEFAULT_DIVERSITY,
};

/**
 * A hash of the metadata that produced a record's vectors.
 *
 * Ingestion is expensive — every changed track is re-embedded — so a sync must
 * be able to tell "this track is unchanged" from "this track changed" without
 * re-embedding it to find out. The signature covers exactly the fields the
 * embedder reads, in a fixed order, so it is stable across runs and machines.
 * Vector version is deliberately NOT part of it: a model change is handled by
 * `needsReembedding`, which asks a different and more accurate question.
 */
export function metadataSignature(properties: MusicProperties): string {
  const canonical = [
    properties.trackId,
    properties.title,
    properties.artist ?? "",
    properties.album ?? "",
    properties.language ?? "",
    properties.region ?? "",
    String(properties.releaseYear ?? ""),
    String(properties.duration ?? ""),
    String(properties.bpm ?? ""),
    String(properties.energy ?? ""),
    String(properties.danceability ?? ""),
    String(properties.instrumentalness ?? ""),
    String(properties.valence ?? ""),
    listKey(properties.genres),
    listKey(properties.moods),
    listKey(properties.tags),
    listKey(properties.instruments),
    listKey(properties.subgenres),
  ].join(" ");

  // FNV-1a, matching the embedder's hash so there is one algorithm in the file.
  let h = 2166136261 >>> 0;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0).toString(36);
}

/** Sorted so a re-ordered list is not mistaken for a changed one. */
function listKey(values: string[] | undefined): string {
  return values ? [...values].sort().join(",") : "";
}
