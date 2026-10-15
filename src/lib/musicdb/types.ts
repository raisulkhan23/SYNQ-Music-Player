/**
 * Music vector database — the data model.
 *
 * Everything downstream (ingestion, search, recommendations, the API) speaks
 * these types, and they are deliberately provider-free. A vector record here
 * is plain JSON; whether it ends up in Weaviate, Qdrant, pgvector or Milvus is
 * the store's problem, not the model's. That separation is what makes the
 * engine swappable without touching a line of search or ranking code.
 */

/** The kinds of thing a vector can describe (spec §2).
 *
 *  A track carries several of these at once — an audio vector for "sounds
 *  like", a lyrics vector for "says the same thing", an artist vector for
 *  "who sounds similar". Treating them as one vector is the single most
 *  common way a music recommender gets worse at both jobs at once. */
export type VectorType =
  | "audio"
  | "lyrics"
  | "artist"
  | "genre"
  | "mood"
  | "user"
  | "playlist"
  | "multimodal";

export const VECTOR_TYPES: readonly VectorType[] = [
  "audio",
  "lyrics",
  "artist",
  "genre",
  "mood",
  "user",
  "playlist",
  "multimodal",
];

/** Distance metrics (spec §11). Cosine is the default because embedding
 *  lengths are not comparable across models — a magnitude difference between
 *  two vectors is an artefact of the encoder, not of the music. */
export type DistanceMetric = "cosine" | "dot" | "euclidean";

/** Approximate-nearest-neighbour index configuration (spec §11).
 *
 *  `efConstruction` trades build time for recall and `m` for query speed;
 *  both are HNSW knobs. `ivfLists`/`nprobe` are the IVF equivalents and are
 *  ignored by an HNSW store. Keeping both on the record means a store can be
 *  swapped without the caller re-learning which fields matter. */
export type IndexConfig = {
  kind: "hnsw" | "ivfflat" | "exact";
  metric: DistanceMetric;
  m: number;
  efConstruction: number;
  efSearch: number;
  ivfLists: number;
  nprobe: number;
};

export const DEFAULT_INDEX_CONFIG: IndexConfig = {
  kind: "hnsw",
  metric: "cosine",
  m: 16,
  efConstruction: 128,
  efSearch: 96,
  ivfLists: 100,
  nprobe: 16,
};

/** Provenance of a stored vector (spec §13).
 *
 *  This is what makes a model change safe: every vector knows which encoder
 *  wrote it, so a migration can select exactly the records to re-embed
 *  instead of guessing, and a mixed-version catalogue is readable rather than
 *  quietly wrong. */
export type EmbeddingVersion = {
  model: string;
  modelVersion: string;
  dimension: number;
  createdAt: number;
  updatedAt: number;
};

/** Rich music metadata (spec §1). Every field is optional because a vector
 *  must stay useful when half of it is missing — an imported playlist has no
 *  BPM and no energy, and refusing to index it would be worse than indexing
 *  it honestly. */
export type MusicProperties = {
  trackId: string;
  kind: "track" | "artist" | "album" | "playlist" | "user";
  title: string;
  artist?: string;
  album?: string;
  genres?: string[];
  subgenres?: string[];
  moods?: string[];
  tags?: string[];
  instruments?: string[];
  vocalCharacteristics?: string[];
  language?: string;
  region?: string;
  releaseYear?: number;
  duration?: number;
  bpm?: number;
  energy?: number;
  danceability?: number;
  instrumentalness?: number;
  valence?: number;
  explicit?: boolean;
  instrumental?: boolean;
  popularity?: number;
  lyrics?: string;
  /** Owner of the record. Public music vectors have none; a user vector always
   *  does, and it is the field tenant isolation keys on (spec §18). */
  ownerId?: string;
  [key: string]: unknown;
};

/** One music item, carrying one or more typed vectors (spec §2). */
export type VectorRecord = {
  id: string;
  properties: MusicProperties;
  vectors: Partial<Record<VectorType, number[]>>;
  versions: Partial<Record<VectorType, EmbeddingVersion>>;
  createdAt: number;
  updatedAt: number;
};

/** Metadata filters applied before/during search (spec §6).
 *
 *  Every operator is spelled out rather than a raw query object so a provider
 *  cannot be handed an injectable expression, and so every store translates
 *  the same structure to its own native syntax. */
export type FilterField =
  | "genres"
  | "subgenres"
  | "moods"
  | "tags"
  | "instruments"
  | "language"
  | "region"
  | "artist"
  | "album"
  | "explicit"
  | "instrumental"
  | "kind";

export type FilterCondition = {
  field: FilterField;
  op: "eq" | "ne" | "in" | "nin" | "contains" | "gt" | "gte" | "lt" | "lte";
  value: string | number | boolean | Array<string | number | boolean>;
};

export type Filters = {
  conditions: FilterCondition[];
  /** Release-year range is first-class: "90s", "2010s" and "this decade" are
   *  the filters listeners actually reach for. */
  releaseYearMin?: number;
  releaseYearMax?: number;
  bpmMin?: number;
  bpmMax?: number;
  durationMin?: number;
  durationMax?: number;
  energyMin?: number;
  energyMax?: number;
  danceabilityMin?: number;
  danceabilityMax?: number;
  popularityMin?: number;
  ownerId?: string;
};

export const EMPTY_FILTERS: Filters = { conditions: [] };

/** Why a result matched (spec §19).
 *
 *  Explanations are derived from the SAME signals that produced the score, so
 *  they cannot drift from the ranking the way a separately-written blurb can. */
export type MatchReason = {
  signal: string;
  detail: string;
  contribution: number;
};

export type SearchResult = {
  record: VectorRecord;
  score: number;
  /** Populated for hybrid results: where in the list each sub-search placed
   *  the item, before fusion. Kept so ranking is debuggable. */
  signals: { vectorRank?: number; keywordRank?: number };
  matchReasons: MatchReason[];
};

export type RankingStrategy =
  | "weighted"
  | "reciprocal_rank_fusion"
  | "vector_only"
  | "keyword_only";

export const DEFAULT_RANKING: RankingStrategy = "weighted";

/** Weights for "More Like This" (spec §4). Configurable, and stored per call
 *  rather than hard-coded, so the admin panel can move them without a
 *  deploy. They must sum to ~1 to keep scores comparable across requests. */
export type SimilarityWeights = {
  audio: number;
  lyrics: number;
  genre: number;
  mood: number;
  artist: number;
  metadata: number;
};

export const DEFAULT_SIMILARITY_WEIGHTS: SimilarityWeights = {
  audio: 0.4,
  lyrics: 0.2,
  genre: 0.15,
  mood: 0.1,
  artist: 0.1,
  metadata: 0.05,
};

/** Diversity controls (spec §8). Twenty near-identical songs is a
 *  recommender that has stopped recommending anything. */
export type DiversityConfig = {
  maxPerArtist: number;
  maxPerGenre: number;
  maxPerEra: number;
  maxPerLanguage: number;
  /** 0 = pure exploitation (most similar first), 1 = maximum exploration. */
  exploration: number;
};

export const DEFAULT_DIVERSITY: DiversityConfig = {
  maxPerArtist: 2,
  maxPerGenre: 4,
  maxPerEra: 3,
  maxPerLanguage: 6,
  exploration: 0.15,
};

/** A listening event (spec §7). These are the raw material for a user vector;
 *  note they are the listener's own data and never leave the user boundary. */
export type ListeningEvent = {
  trackId: string;
  /** Epoch ms. */
  at: number;
  /** Fraction actually listened, 0..1. A skip and a full play of the same
   *  track must not be treated as the same signal. */
  completion?: number;
  liked?: boolean;
  saved?: boolean;
  skipped?: boolean;
  /** Where it came from, used to down-weight passive exposure. */
  source?: "play" | "search" | "playlist" | "radio" | "recommendation";
};

export type VectorStats = {
  totalRecords: number;
  totalVectors: number;
  byVectorType: Record<string, number>;
  byModel: Record<string, number>;
  dimensions: Record<string, number>;
  index: IndexConfig;
  /** ms, measured over recent searches rather than asserted. */
  lastSearchLatencyMs: number;
  searchCount: number;
  failedJobs: number;
  duplicateCandidates: number;
};
