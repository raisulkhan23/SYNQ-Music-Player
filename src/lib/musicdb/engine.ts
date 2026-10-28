/**
 * The search and similarity engine (spec §3, §4, §5, §19).
 *
 * Two rules shape everything here:
 *
 * 1. Retrieval is the store's job, RANKING is this file's job. The store
 *    returns candidates per sub-search; fusion, weighting and explanation
 *    happen once, in one place, so a score can always be traced back to the
 *    signals that produced it.
 *
 * 2. An explanation is DERIVED from the same numbers as the score, never
 *    written separately. A recommendation that cannot explain itself is a
 *    recommendation nobody can debug, and this is the layer that has to be
 *    debuggable when a user's "For You" looks wrong.
 */

import { similarity, type MusicEmbedder } from "./embedder";
import { matchesFilters, type Candidate, type VectorStore } from "./store";
import {
  DEFAULT_RANKING,
  DEFAULT_SIMILARITY_WEIGHTS,
  type Filters,
  type MatchReason,
  type RankingStrategy,
  type SearchResult,
  type SimilarityWeights,
  type VectorRecord,
  type VectorType,
} from "./types";

export type EngineContext = {
  store: VectorStore;
  embedder: MusicEmbedder;
};

export type SemanticSearchArgs = {
  query: string;
  limit?: number;
  filters?: Filters;
  /** Which vector the query is compared against. `multimodal` is the default
   *  because it is the only one that answers a whole-sentence question. */
  vectorType?: VectorType;
};

export type HybridSearchArgs = SemanticSearchArgs & {
  strategy?: RankingStrategy;
  /** Candidates pulled from each sub-search before fusion. Larger than `limit`
   *  on purpose: fusing two short lists loses items that only one side liked. */
  candidateDepth?: number;
  vectorWeight?: number;
  keywordWeight?: number;
};

/** Natural-language search (spec §3). */
export async function semanticSearch(
  ctx: EngineContext,
  args: SemanticSearchArgs,
): Promise<SearchResult[]> {
  const limit = args.limit ?? 20;
  const vectorType = args.vectorType ?? "multimodal";

  // The query is encoded through the SAME embedder and the same field mapping
  // as the catalogue. Encoding it differently is why "sad songs for a rainy
  // night" returns confident nonsense.
  const embedded = await ctx.embedder.embed(
    { trackId: "__query__", kind: "track", title: args.query },
    { text: args.query, purpose: "query" },
  );
  const queryVector = embedded.find((v) => v.type === vectorType)?.vector;
  if (!queryVector || queryVector.every((n) => n === 0)) return [];

  const candidates = await ctx.store.searchByVector({
    vector: queryVector,
    type: vectorType,
    limit,
    filters: args.filters,
  });

  return hydrate(ctx, candidates, (record, score) => [
    reasonFor(vectorType, score, `closest on the ${vectorType} vector`),
  ]);
}

/**
 * Hybrid search (spec §5): vector meaning + keyword + metadata filters.
 *
 * Filters are passed to BOTH passes so "Chill Bengali songs from the 2010s"
 * is constrained before either side runs, rather than being applied to a fused
 * list that already contains out-of-range results.
 */
export async function hybridSearch(
  ctx: EngineContext,
  args: HybridSearchArgs,
): Promise<SearchResult[]> {
  const limit = args.limit ?? 20;
  const strategy = args.strategy ?? DEFAULT_RANKING;
  const depth = args.candidateDepth ?? Math.max(limit * 3, 60);
  const vectorWeight = args.vectorWeight ?? 0.6;
  const keywordWeight = args.keywordWeight ?? 0.4;

  if (strategy === "keyword_only") {
    return keywordOnly(ctx, args, limit);
  }

  const vectorResults =
    strategy === "vector_only"
      ? await semanticSearch(ctx, { ...args, limit: depth })
      : null;

  let vectorCandidates: Candidate[] = [];
  const embedded = await ctx.embedder.embed(
    { trackId: "__query__", kind: "track", title: args.query },
    { text: args.query, purpose: "query" },
  );
  const queryVector = embedded.find((v) => v.type === "multimodal")?.vector;
  if (queryVector && !queryVector.every((n) => n === 0)) {
    vectorCandidates = await ctx.store.searchByVector({
      vector: queryVector,
      type: "multimodal",
      limit: depth,
      filters: args.filters,
    });
  }

  const keywordCandidates = await ctx.store.searchByKeyword({
    terms: tokenizeQuery(args.query),
    limit: depth,
    filters: args.filters,
  });

  if (vectorResults && !keywordCandidates.length)
    return vectorResults.slice(0, limit);

  const fused = fuse(vectorCandidates, keywordCandidates, {
    strategy,
    vectorWeight,
    keywordWeight,
    limit,
  });

  return hydrate(ctx, fused, (record, score, signals) => {
    const reasons: MatchReason[] = [];
    if (signals.vectorRank) {
      reasons.push(
        reasonFor(
          "multimodal",
          score,
          `semantic match, ranked #${signals.vectorRank} by meaning`,
        ),
      );
    }
    if (signals.keywordRank) {
      reasons.push(
        reasonFor(
          "keyword",
          score,
          `matched "${record.properties.title}" text, ranked #${signals.keywordRank}`,
        ),
      );
    }
    return reasons;
  });
}

async function keywordOnly(
  ctx: EngineContext,
  args: HybridSearchArgs,
  limit: number,
): Promise<SearchResult[]> {
  const candidates = await ctx.store.searchByKeyword({
    terms: tokenizeQuery(args.query),
    limit,
    filters: args.filters,
  });
  return hydrate(ctx, candidates, (record, score) => [
    reasonFor(
      "keyword",
      score,
      `matched the words in "${record.properties.title}"`,
    ),
  ]);
}

/**
 * "More Like This" (spec §4).
 *
 * The score is the configured weighted sum, and each component's CONTRIBUTION
 * to that sum is kept, which is what makes both the ranking and the
 * explanation explainable. Weights are per-call so the admin panel can move
 * them without a deploy.
 */
export async function similarTracks(
  ctx: EngineContext,
  args: {
    trackId: string;
    limit?: number;
    weights?: Partial<SimilarityWeights>;
    filters?: Filters;
    excludeIds?: string[];
  },
): Promise<SearchResult[]> {
  const limit = args.limit ?? 20;
  const weights = { ...DEFAULT_SIMILARITY_WEIGHTS, ...args.weights };
  const seed = await ctx.store.get(args.trackId);
  if (!seed) return [];

  const exclude = new Set([args.trackId, ...(args.excludeIds ?? [])]);

  const all = await ctx.store.list();
  const metric = ctx.store.index.metric;

  // Normalised so scores stay comparable across requests even when the admin
  // panel saves weights that do not sum to 1. Without this, raising one weight
  // silently rescales every score in the system and two requests stop being
  // comparable — which is exactly what configurable weights are for.
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0) || 1;

  const scored = all
    .filter((record) => !exclude.has(record.id))
    .filter((record) => matchesFilters(record.properties, args.filters))
    .map((record) => {
      const components = {
        audio: similarity(seed.vectors.audio, record.vectors.audio, metric),
        lyrics: similarity(seed.vectors.lyrics, record.vectors.lyrics, metric),
        genre: similarity(seed.vectors.genre, record.vectors.genre, metric),
        mood: similarity(seed.vectors.mood, record.vectors.mood, metric),
        artist: similarity(seed.vectors.artist, record.vectors.artist, metric),
        metadata: metadataSimilarity(seed.properties, record.properties),
      };
      let score = 0;
      for (const [key, weight] of Object.entries(weights) as [
        keyof SimilarityWeights,
        number,
      ][]) {
        score += (weight / totalWeight) * components[key];
      }
      return { record, components, score };
    })
    .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
    .slice(0, limit);

  return scored.map(({ record, components, score }) => ({
    record,
    score,
    signals: {},
    matchReasons: buildReasons(record, components, weights, score),
  }));
}

/** Numeric closeness across the bounded audio features plus tempo and era.
 *  Complements the vectors rather than duplicating them. */
export function metadataSimilarity(
  a: VectorRecord["properties"],
  b: VectorRecord["properties"],
): number {
  const pairs: [number | undefined, number | undefined, number][] = [
    [a.energy, b.energy, 1],
    [a.danceability, b.danceability, 1],
    [a.valence, b.valence, 1],
    [a.instrumentalness, b.instrumentalness, 1],
    [a.bpm, b.bpm, 0.4],
    [a.releaseYear, b.releaseYear, 0.2],
  ];
  let total = 0;
  let weight = 0;
  for (const [x, y, w] of pairs) {
    if (typeof x !== "number" || typeof y !== "number") continue;
    const diff = Math.abs(x - y) / Math.max(1, Math.abs(x));
    total += w * Math.max(0, 1 - diff);
    weight += w;
  }
  return weight === 0 ? 0 : total / weight;
}

function buildReasons(
  record: VectorRecord,
  components: Record<string, number>,
  weights: SimilarityWeights,
  score: number,
): MatchReason[] {
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0) || 1;

  const labels: Record<keyof SimilarityWeights, string> = {
    audio: "similar sound",
    lyrics: "similar lyrical theme",
    genre: "similar genre",
    mood: "similar mood",
    artist: "similar artist style",
    metadata: "similar tempo and era",
  };

  const reasons = (Object.keys(components) as (keyof SimilarityWeights)[])
    .map((key) => ({
      signal: key,
      detail:
        components[key] <= 0
          ? `no ${labels[key]}`
          : `${labels[key]} to ${record.properties.title}`,
      contribution: (weights[key] / totalWeight) * components[key],
    }))
    // Only the signals that actually moved the score, strongest first. Ten
    // reasons where two would do is the same clutter problem as the UI.
    .filter((r) => r.contribution > 0.02)
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 3);

  if (reasons.length === 0) {
    return [
      { signal: "weak", detail: "weak overall match", contribution: score },
    ];
  }
  return reasons;
}

function reasonFor(signal: string, score: number, detail: string): MatchReason {
  return { signal, detail, contribution: score };
}

/** Fuses the two candidate lists (spec §5).
 *
 *  Weighted fusion and RRF solve different problems. Weighted fusion can rank
 *  a strong keyword hit above a slightly stronger semantic one, which is
 *  usually right. RRF ignores raw scores entirely and uses only position, so
 *  it is robust when the two score scales are not comparable — which is the
 *  default here, because a BM25 score and a cosine score are different
 *  currencies. Both are offered; neither is assumed correct. */
function fuse(
  vector: Candidate[],
  keyword: Candidate[],
  options: {
    strategy: RankingStrategy;
    vectorWeight: number;
    keywordWeight: number;
    limit: number;
  },
): Candidate[] {
  const { strategy, vectorWeight, keywordWeight, limit } = options;
  const byId = new Map<string, Candidate>();

  for (const c of vector)
    byId.set(c.id, { ...c, score: c.score * vectorWeight });
  for (const c of keyword) {
    const existing = byId.get(c.id);
    const contribution =
      strategy === "reciprocal_rank_fusion"
        ? keywordWeight / (60 + c.rank)
        : c.score * keywordWeight;
    if (existing) existing.score += contribution;
    else byId.set(c.id, { ...c, score: contribution });
  }

  return [...byId.values()]
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((c, i) => ({ ...c, rank: i + 1 }));
}

/** Turns candidates into full results with their sub-search positions intact,
 *  which is what lets an admin see WHY a hybrid result landed where it did. */
async function hydrate(
  ctx: EngineContext,
  candidates: Candidate[],
  reasons: (
    record: VectorRecord,
    score: number,
    signals: { vectorRank?: number; keywordRank?: number },
  ) => MatchReason[],
): Promise<SearchResult[]> {
  const out: SearchResult[] = [];
  for (const candidate of candidates) {
    const record = await ctx.store.get(candidate.id);
    if (!record) continue;
    out.push({
      record,
      score: candidate.score,
      signals: { vectorRank: candidate.rank },
      matchReasons: reasons(record, candidate.score, {
        vectorRank: candidate.rank,
      }),
    });
  }
  return out;
}

function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}
