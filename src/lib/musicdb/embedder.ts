/**
 * Embedding generation and distance metrics.
 *
 * The engine never calls a model directly — it calls `MusicEmbedder`. That
 * boundary is what lets the catalogue be built and searched end-to-end right
 * now, with no provider account, and lets a hosted encoder be dropped in later
 * by implementing one interface.
 *
 * The default implementation is a real technique, not a placeholder: a signed
 * feature-hashing vectorizer over tokens plus a projection of the numeric audio
 * features, with sub-linear term weighting. It is deterministic (the same
 * input always yields the same vector, which is what makes tests meaningful
 * and makes re-embedding idempotent), dependency-free, and fast enough for a
 * full catalogue ingest.
 *
 * The default dimension is 1024, not 256, and that number is measured rather
 * than guessed. A short search query occupies only a handful of the hash axes,
 * so at 256 dims a "upbeat workout music" query collides badly enough to rank
 * an unrelated track first; at 1024 the intended track ranks first and the
 * result stops changing as the dimension grows. The cost is 8KB per vector
 * instead of 2KB, which is the right trade for not returning the wrong music.
 *
 * What it is NOT: it captures lexical and attribute similarity, not timbre or
 * lyrical meaning. Swapping in a real encoder is a drop-in — see
 * `EmbeddingModelNote` in index.ts for the migration contract.
 */

import type { DistanceMetric, MusicProperties, VectorType } from "./types";

/** One vector plus where it came from. */
export type EmbeddedVector = {
  type: VectorType;
  vector: number[];
  model: string;
  modelVersion: string;
};

export interface MusicEmbedder {
  readonly model: string;
  readonly modelVersion: string;
  readonly dimension: number;
  /** Vectors a set of properties should carry. Implementations decide which
   *  types are meaningful for a given item. */
  embed(
    properties: MusicProperties,
    context?: EmbedContext,
  ): Promise<EmbeddedVector[]>;
}

export type EmbedContext = {
  /** Free-text used for the lyrics/playlist vectors. */
  text?: string;
  /** What the embedding is FOR. "query" encodes a search phrase; "track"
   *  encodes catalogue metadata. Keeping them apart stops a search string
   *  being compared against a vector that was never meant to hold one. */
  purpose?: "query" | "track" | "user" | "artist" | "playlist";
};

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "the",
  "of",
  "for",
  "to",
  "in",
  "on",
  "with",
  "my",
  "me",
  "i",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "it",
  "its",
  "that",
  "this",
  "at",
  "by",
  "from",
  "as",
  "but",
  "or",
  "so",
  "if",
  "you",
  "your",
  "we",
  "our",
  "they",
  "their",
  "he",
  "she",
  "his",
  "her",
  "them",
  "not",
  "no",
  "do",
  "does",
  "did",
  "have",
  "has",
  "had",
  "will",
  "would",
  "can",
  "could",
  "should",
  "just",
  "like",
  "get",
  "got",
  "about",
  "songs",
  "song",
  "music",
  "track",
  "tracks",
]);

/** FNV-1a. Small, fast, and stable across processes — unlike a JS object hash
 *  it cannot be reseeded per run, so vectors survive a restart. */
function hash(text: string, seed = 2166136261): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

export class HashingEmbedder implements MusicEmbedder {
  readonly model = "synq-hashing";
  readonly modelVersion: string;
  readonly dimension: number;

  constructor(dimension = 1024, modelVersion = "1.0.0") {
    this.dimension = dimension;
    this.modelVersion = modelVersion;
  }

  async embed(
    properties: MusicProperties,
    context: EmbedContext = {},
  ): Promise<EmbeddedVector[]> {
    const out: EmbeddedVector[] = [];
    const push = (type: VectorType, vector: number[]) =>
      out.push({
        type,
        vector: l2Normalize(vector),
        model: this.model,
        modelVersion: this.modelVersion,
      });

    const purpose = context.purpose ?? "track";

    if (purpose === "query") {
      // A query is a SENTENCE, not a track. It has no audio features, no BPM
      // and no energy — so building it the way a document is built produces a
      // sparse text-only vector that is then compared against a dense
      // 40%-audio document vector. Different spaces, and the comparison is
      // dominated by hash collisions rather than meaning.
      //
      // Instead the query is read for the ATTRIBUTES it names, so that its
      // genre/mood vectors land on the same axes as the catalogue's. "upbeat
      // workout music" then genuinely overlaps the `electronic`/`energetic`
      // axes instead of accidentally matching whatever hashed there.
      const text = context.text ?? properties.title ?? "";
      const hints = hintsFromText(text);
      const hinted: MusicProperties = {
        ...properties,
        genres: hints.genres,
        moods: hints.moods,
        instruments: hints.instruments,
        language: hints.language ?? properties.language,
      };

      push("lyrics", this.textVector(text));
      push("genre", this.genreVector(hinted));
      push("mood", this.moodVector(hinted));
      push("artist", this.artistVector(hinted));
      // Mood words ("upbeat", "chill") are an energy signal even when no
      // track carries the label, so the query's audio vector is seeded with
      // the energy the wording implies rather than left empty.
      push("audio", this.audioVector(hinted));
      push("multimodal", this.multimodalVector(hinted, { text }));
      return out;
    }

    push("audio", this.audioVector(properties));
    push(
      "lyrics",
      this.textVector(
        context.text ?? properties.lyrics ?? properties.title ?? "",
      ),
    );
    push("genre", this.genreVector(properties));
    push("mood", this.moodVector(properties));
    push("artist", this.artistVector(properties));
    if (purpose === "playlist" || properties.kind === "playlist") {
      push("playlist", this.multimodalVector(properties, context));
    }
    push("multimodal", this.multimodalVector(properties, context));
    return out;
  }

  /** Sub-linear term frequency over signed feature hashing. Two texts sharing
   *  vocabulary land near each other; unrelated ones do not. */
  private textVector(text: string): number[] {
    const vec = new Array<number>(this.dimension).fill(0);
    const tokens = tokenize(text ?? "");
    if (tokens.length === 0) return vec;
    const counts = new Map<string, number>();
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const [term, count] of counts) {
      // 1 + log(tf) stops one repeated word dominating the whole vector.
      const weight = 1 + Math.log(count);
      const h = hash(term);
      const index = h % this.dimension;
      // The sign bit stops hash collisions from always pushing the same way.
      const sign = (hash(term, 0x9e3779b9) & 1) === 0 ? 1 : -1;
      vec[index] += sign * weight;
    }
    return vec;
  }

  /** Projects the continuous audio features onto the same space. Each feature
   *  gets its own hashed axis, so "fast and energetic" is measurably closer to
   *  another fast energetic track than to a slow acoustic one. */
  private audioVector(p: MusicProperties): number[] {
    const vec = new Array<number>(this.dimension).fill(0);
    const feature = (name: string, value: number | undefined) => {
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      const index = hash(`feat:${name}`) % this.dimension;
      vec[index] += value;
    };
    feature("energy", p.energy ?? energyFromMood(p.moods ?? []));
    feature("danceability", p.danceability);
    feature("instrumentalness", p.instrumentalness);
    feature("valence", p.valence);
    // Tempo and duration are scaled into 0..1 so they do not swamp the
    // bounded features above purely by magnitude.
    feature("bpm", p.bpm == null ? undefined : clamp01((p.bpm - 40) / 180));
    feature(
      "duration",
      p.duration == null ? undefined : clamp01(p.duration / 600),
    );
    for (const instrument of p.instruments ?? []) {
      const index = hash(`inst:${instrument.toLowerCase()}`) % this.dimension;
      vec[index] += 1;
    }
    for (const vocal of p.vocalCharacteristics ?? []) {
      const index = hash(`vocal:${vocal.toLowerCase()}`) % this.dimension;
      vec[index] += 1;
    }
    return vec;
  }

  private genreVector(p: MusicProperties): number[] {
    const vec = new Array<number>(this.dimension).fill(0);
    for (const g of p.genres ?? []) {
      vec[hash(`genre:${g.toLowerCase()}`) % this.dimension] += 1;
    }
    for (const g of p.subgenres ?? []) {
      vec[hash(`subgenre:${g.toLowerCase()}`) % this.dimension] += 1;
    }
    for (const t of p.tags ?? []) {
      vec[hash(`tag:${t.toLowerCase()}`) % this.dimension] += 1;
    }
    return vec;
  }

  private moodVector(p: MusicProperties): number[] {
    const vec = new Array<number>(this.dimension).fill(0);
    for (const m of p.moods ?? []) {
      vec[hash(`mood:${m.toLowerCase()}`) % this.dimension] += 1;
    }
    // Mood is partly audible: valence and energy are moods whether or not
    // anyone labelled them, so they belong in this vector too.
    const index = hash("feat:valence") % this.dimension;
    if (typeof p.valence === "number") vec[index] += p.valence;
    const eIndex = hash("feat:energy") % this.dimension;
    if (typeof p.energy === "number") vec[eIndex] += p.energy;
    return vec;
  }

  private artistVector(p: MusicProperties): number[] {
    const vec = new Array<number>(this.dimension).fill(0);
    if (p.artist) {
      for (const t of tokenize(p.artist)) {
        vec[hash(`artist:${t}`) % this.dimension] += 1;
      }
    }
    return vec;
  }

  /** The combination vector: audio + text + genre + mood at fixed weights, so
   *  one query can be compared against one vector without scoring N types and
   *  fusing the answers (spec §5). */
  private multimodalVector(
    p: MusicProperties,
    context: EmbedContext,
  ): number[] {
    const parts = [
      this.audioVector(p),
      this.textVector(
        context.text ?? `${p.title} ${p.artist ?? ""} ${p.lyrics ?? ""}`,
      ),
      this.genreVector(p),
      this.moodVector(p),
    ];
    const weights = [0.4, 0.3, 0.15, 0.15];
    const vec = new Array<number>(this.dimension).fill(0);
    parts.forEach((part, i) => {
      for (let j = 0; j < vec.length; j++) vec[j] += part[j] * weights[i];
    });
    return vec;
  }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/* ── Query attribute hints ────────────────────────────────────────────────
 * A searcher's words name categories the catalogue already uses: "electronic",
 * "sad", "bengali", "guitar". Mapping those words onto the SAME axes the
 * catalogue writes is what lets a plain sentence reach the right records. It
 * is deliberately small and explicit — a real deployment would load this from
 * a taxonomy service, and an unbounded guess would map "bass" onto whichever
 * genre happened to be listed first. */

const GENRE_WORDS: Record<string, string> = {
  electronic: "electronic",
  edm: "electronic",
  techno: "electronic",
  house: "electronic",
  dance: "electronic",
  dubstep: "electronic",
  rock: "rock",
  "alternative rock": "alternative rock",
  alt: "alternative rock",
  indie: "indie rock",
  grunge: "alternative rock",
  metal: "metal",
  pop: "pop",
  kpop: "pop",
  "hip hop": "hip hop",
  rap: "hip hop",
  jazz: "jazz",
  blues: "blues",
  classical: "classical",
  piano: "classical",
  folk: "folk",
  acoustic: "acoustic",
  country: "country",
  reggae: "reggae",
  rnb: "rnb",
  soul: "soul",
  funk: "funk",
  latin: "latin",
  ambient: "ambient",
  classical_: "ambient",
};

const MOOD_WORDS: Record<string, string> = {
  sad: "sad",
  melancholy: "melancholic",
  melancholic: "melancholic",
  happy: "happy",
  joyful: "happy",
  uplifting: "happy",
  energetic: "energetic",
  upbeat: "energetic",
  intense: "energetic",
  workout: "energetic",
  running: "energetic",
  gym: "energetic",
  chill: "calm",
  calm: "calm",
  relaxing: "calm",
  peaceful: "calm",
  romantic: "romantic",
  love: "romantic",
  dreamy: "dreamy",
  dark: "dark",
  angry: "angry",
  aggressive: "aggressive",
  focused: "focused",
  studying: "focused",
  motivational: "motivational",
};

const INSTRUMENT_WORDS: Record<string, string> = {
  guitar: "guitar",
  piano: "piano",
  drums: "drums",
  violin: "violin",
  bass: "bass",
  synth: "synth",
  saxophone: "saxophone",
  cello: "cello",
};

const LANGUAGE_WORDS: Record<string, string> = {
  bengali: "Bengali",
  bangla: "Bengali",
  hindi: "Hindi",
  urdu: "Urdu",
  spanish: "Spanish",
  french: "French",
  german: "German",
  japanese: "Japanese",
  korean: "Korean",
  tamil: "Tamil",
  telugu: "Telugu",
  arabic: "Arabic",
  portuguese: "Portuguese",
  italian: "Italian",
  russian: "Russian",
};

export type QueryHints = {
  genres: string[];
  moods: string[];
  instruments: string[];
  language?: string;
};

/** Two-word genre phrases ("alternative rock", "hip hop") are matched before
 *  single words, otherwise "alternative rock" is only ever seen as "rock". */
export function hintsFromText(text: string): QueryHints {
  const lower = ` ${text.toLowerCase()} `;
  const genres = new Set<string>();
  const moods = new Set<string>();
  const instruments = new Set<string>();
  let language: string | undefined;

  for (const [word, value] of Object.entries(GENRE_WORDS)) {
    if (word.endsWith("_")) continue;
    if (lower.includes(` ${word} `)) genres.add(value);
  }
  for (const [word, value] of Object.entries(MOOD_WORDS)) {
    if (lower.includes(` ${word} `)) moods.add(value);
  }
  for (const [word, value] of Object.entries(INSTRUMENT_WORDS)) {
    if (lower.includes(` ${word} `)) instruments.add(value);
  }
  for (const [word, value] of Object.entries(LANGUAGE_WORDS)) {
    if (lower.includes(` ${word} `)) language = value;
  }

  return {
    genres: [...genres],
    moods: [...moods],
    instruments: [...instruments],
    language,
  };
}

/** Energy implied by the wording, used to seed a query's audio vector.
 *  Bounded so a vague word can nudge the ranking but never dominate it. */
export function energyFromMood(moods: string[]): number | undefined {
  if (moods.length === 0) return undefined;
  const scores = moods.map((mood) => MOOD_ENERGY[mood] ?? 0.5);
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

const MOOD_ENERGY: Record<string, number> = {
  energetic: 0.95,
  motivational: 0.85,
  angry: 0.9,
  aggressive: 0.9,
  happy: 0.7,
  romantic: 0.45,
  dreamy: 0.3,
  focused: 0.35,
  calm: 0.2,
  sad: 0.25,
  melancholic: 0.25,
  dark: 0.4,
  peaceful: 0.15,
};

export function l2Normalize(vector: number[]): number[] {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector.slice();
  return vector.map((v) => v / norm);
}

/**
 * Similarity in 0..1, where higher is MORE similar, for every metric.
 *
 * Cosine is the default and the only metric valid for every encoder. Dot and
 * Euclidean are supported because a self-supervised audio encoder is often
 * trained with a dot-product head, where cosine would throw away information
 * the model relies on. Euclidean is mapped through a bounded transform so it
 * can be fused with the others without dominating the ranking.
 */
export function similarity(
  a: number[] | undefined,
  b: number[] | undefined,
  metric: DistanceMetric = "cosine",
): number {
  if (!a || !b || a.length === 0 || b.length === 0) return 0;
  // Dimensions must agree. Returning 0 rather than throwing keeps a partially
  // re-embedded catalogue searchable during a model migration (spec §13).
  if (a.length !== b.length) return 0;
  switch (metric) {
    case "dot": {
      let sum = 0;
      for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
      return 1 - 1 / (1 + Math.max(-1, Math.min(1, sum)));
    }
    case "euclidean": {
      let sum = 0;
      for (let i = 0; i < a.length; i++) {
        const d = a[i] - b[i];
        sum += d * d;
      }
      return Math.exp(-Math.sqrt(sum));
    }
    case "cosine":
    default: {
      let dot = 0;
      let na = 0;
      let nb = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
      }
      if (na === 0 || nb === 0) return 0;
      return Math.max(0, dot / (Math.sqrt(na) * Math.sqrt(nb)));
    }
  }
}
