/**
 * Personalised recommendations, diversity and duplicate detection
 * (spec §7, §8, §14).
 *
 * A user vector is built from listening EVENTS, not from a stored profile, so
 * it changes as the listener does. The events are weighted by how deliberate
 * they were — a full play of a saved track says far more than a track that was
 * skipped in four seconds — because a recommender that treats every play
 * equally ends up recommending whatever happened to be on repeat.
 *
 * Nothing in this file can reach another listener's data: every function takes
 * the tracks a user is allowed to see, and a user vector is only ever
 * compared against public music vectors (spec §18).
 */

import { l2Normalize, similarity, type MusicEmbedder } from "./embedder";
import { matchesFilters } from "./store";
import {
  DEFAULT_DIVERSITY,
  type DiversityConfig,
  type Filters,
  type ListeningEvent,
  type MatchReason,
  type MusicProperties,
  type VectorRecord,
} from "./types";

/** Why a user vector looks the way it does. Kept so "For You" is auditable. */
export type UserVectorProfile = {
  userId: string;
  vector: number[];
  /** Per-artist and per-genre affinity, normalised. */
  artistAffinity: Record<string, number>;
  genreAffinity: Record<string, number>;
  /** Languages actually listened to, for diversity quotas. */
  languages: string[];
  eventCount: number;
  topArtists: string[];
  topGenres: string[];
  /** Ids from the profile's own recent plays. Excluded from recommendations by
   *  default — handing someone the track they are currently listening to is
   *  the single most obvious way a recommender looks broken. */
  recentTrackIds: string[];
};

export type UserVectorOptions = {
  /** Events older than this are dropped: taste moves, and a two-year-old
   *  profile should not dominate today's recommendations. */
  maxAgeMs?: number;
  /** Recency half-life. Recent plays count for exponentially more. */
  halfLifeMs?: number;
  now?: number;
};

/**
 * Builds (or refreshes) the listener's vector from their events (spec §7).
 *
 * Recency is exponential rather than a hard cutoff alone, because "recently
 * played" in the spec is a soft signal — a track played twice a year ago is
 * weaker evidence than one played this morning, not worth throwing away.
 */
export async function buildUserVector(
  embedder: MusicEmbedder,
  userId: string,
  events: ListeningEvent[],
  trackIndex: Map<string, VectorRecord>,
  options: UserVectorOptions = {},
): Promise<UserVectorProfile> {
  const now = options.now ?? Date.now();
  const halfLife = options.halfLifeMs ?? 1000 * 60 * 60 * 24 * 30;
  const maxAge = options.maxAgeMs ?? 1000 * 60 * 60 * 24 * 365;

  const weighted = new Map<string, number>();
  const artistAffinity = new Map<string, number>();
  const genreAffinity = new Map<string, number>();
  const languageCounts = new Map<string, number>();
  const dimension = embedder.dimension;
  const vector = new Array<number>(dimension).fill(0);
  const recent: string[] = [];
  let used = 0;

  for (const event of events) {
    const age = now - event.at;
    if (age > maxAge || age < 0) continue;
    const track = trackIndex.get(event.trackId);
    if (!track) continue;

    const recency = Math.pow(0.5, age / halfLife);
    const weight = eventWeight(event, recency);
    used += 1;
    recent.push(event.trackId);

    const base = track.vectors.multimodal ?? track.vectors.audio;
    if (base && base.length === dimension) {
      for (let i = 0; i < dimension; i++) vector[i] += base[i] * weight;
    }

    if (track.properties.artist) {
      artistAffinity.set(
        track.properties.artist,
        (artistAffinity.get(track.properties.artist) ?? 0) + weight,
      );
    }
    for (const genre of track.properties.genres ?? []) {
      genreAffinity.set(genre, (genreAffinity.get(genre) ?? 0) + weight);
    }
    if (track.properties.language) {
      languageCounts.set(
        track.properties.language,
        (languageCounts.get(track.properties.language) ?? 0) + weight,
      );
    }
  }

  weighted.set("events", used);
  // Only genuinely recent plays are suppressed from recommendations; the whole
  // listening history is not a blacklist.
  const recentWindow = halfLife * 2;
  const recentTrackIds = events
    .filter((e) => {
      const age = now - e.at;
      return age >= 0 && age <= recentWindow && !e.skipped;
    })
    .sort((a, b) => b.at - a.at)
    .map((e) => e.trackId);

  const topArtists = topN(artistAffinity, 5);
  const topGenres = topN(genreAffinity, 5);

  return {
    userId,
    vector: l2Normalize(vector),
    artistAffinity: normaliseMap(artistAffinity),
    genreAffinity: normaliseMap(genreAffinity),
    languages: [...languageCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([code]) => code),
    eventCount: used,
    topArtists: topArtists.map(([name]) => name),
    topGenres: topGenres.map(([name]) => name),
    recentTrackIds: [...new Set(recentTrackIds)],
  };
}

/** How deliberate an event was.
 *
 *  Skips are NEGATIVE. Leaving that out is why "not interested" becomes "play
 *  me that again": the alternative is a listener who actively rejects a track
 *  and is served it harder for their trouble. */
function eventWeight(event: ListeningEvent, recency: number): number {
  let base = 1;
  const completion = event.completion ?? 1;
  base *= Math.min(1, Math.max(0.05, completion));
  if (event.liked) base *= 2.5;
  if (event.saved) base *= 2;
  if (event.skipped) base *= -1.5;
  if (event.source === "search") base *= 0.9;
  if (event.source === "recommendation") base *= 0.8;
  return base * recency;
}

export type RecommendArgs = {
  /** The listener to recommend for. The id lives on the profile, so it is not
   *  repeated here and the two can never disagree. */
  profile: UserVectorProfile;
  limit?: number;
  diversity?: Partial<DiversityConfig>;
  filters?: Filters;
  /** Never recommend these — typically what the listener just finished. */
  excludeIds?: string[];
};

export type Recommendation = {
  record: VectorRecord;
  score: number;
  matchReasons: MatchReason[];
  /** True when the item was pulled in by the exploration quota rather than
   *  pure similarity, so an admin can tell "relevant" from "diverse". */
  exploration: boolean;
};

/**
 * "For You" / "You May Like" / "Discover Weekly" (spec §7, §8).
 *
 * Two stages on purpose. First take the best candidates by user similarity,
 * then re-select under diversity quotas. Applying quotas DURING selection
 * pushes genuinely good matches out of the list entirely; applying them
 * afterwards keeps a strong item and only demotes a repeat of one already
 * chosen — which is what "not twenty of the same song" actually means.
 */
export async function recommend(
  profile: UserVectorProfile,
  candidates: VectorRecord[],
  args: RecommendArgs,
): Promise<Recommendation[]> {
  const limit = args.limit ?? 20;
  const diversity = { ...DEFAULT_DIVERSITY, ...args.diversity };
  const exclude = new Set([
    ...profile.recentTrackIds,
    ...(args.excludeIds ?? []),
  ]);

  const scored = candidates
    .filter((record) => !exclude.has(record.id))
    .filter((record) => matchesFilters(record.properties, args.filters))
    .map((record) => ({
      record,
      similarity: similarity(
        profile.vector,
        record.vectors.multimodal,
        "cosine",
      ),
      artistAffinity:
        profile.artistAffinity[record.properties.artist ?? ""] ?? 0,
      genreAffinity: topGenreAffinity(profile, record.properties),
    }))
    .filter((c) => c.similarity > 0)
    .sort(
      (a, b) =>
        b.similarity - a.similarity || a.record.id.localeCompare(b.record.id),
    );

  // Generous over-fetch so the quota pass has something to choose from.
  const pool = scored.slice(0, Math.max(limit * 4, 80));

  const chosen: Recommendation[] = [];
  const artistCount = new Map<string, number>();
  const genreCount = new Map<string, number>();
  const eraCount = new Map<string, number>();
  const languageCount = new Map<string, number>();
  const deferred: typeof pool = [];

  for (const candidate of pool) {
    if (chosen.length >= limit) break;
    const { record } = candidate;
    const artist = record.properties.artist ?? "";
    const genre = record.properties.genres?.[0] ?? "";
    const eraKey = era(record.properties.releaseYear);
    const language = record.properties.language ?? "";

    if (
      (artist && (artistCount.get(artist) ?? 0) >= diversity.maxPerArtist) ||
      (genre && (genreCount.get(genre) ?? 0) >= diversity.maxPerGenre) ||
      (eraKey && (eraCount.get(eraKey) ?? 0) >= diversity.maxPerEra) ||
      (language &&
        (languageCount.get(language) ?? 0) >= diversity.maxPerLanguage)
    ) {
      deferred.push(candidate);
      continue;
    }

    chosen.push(toRecommendation(candidate, false));
    if (artist) artistCount.set(artist, (artistCount.get(artist) ?? 0) + 1);
    if (genre) genreCount.set(genre, (genreCount.get(genre) ?? 0) + 1);
    if (eraKey) eraCount.set(eraKey, (eraCount.get(eraKey) ?? 0) + 1);
    if (language)
      languageCount.set(language, (languageCount.get(language) ?? 0) + 1);
  }

  // Exploration pass: fill any remaining slots from the deferred list, ordered
  // by score but explicitly labelled so it is visible that they came from the
  // diversity pass rather than the similarity pass.
  const explorationSlots = Math.floor(limit * diversity.exploration);
  let explorationUsed = 0;
  for (const candidate of deferred) {
    if (chosen.length >= limit || explorationUsed >= explorationSlots) break;
    chosen.push(toRecommendation(candidate, true));
    explorationUsed += 1;
  }

  // If exploration was too small to fill the list, top up with the best of
  // what is left rather than returning a short page.
  if (chosen.length < limit) {
    const takenIds = new Set(chosen.map((c) => c.record.id));
    for (const candidate of pool) {
      if (chosen.length >= limit) break;
      if (takenIds.has(candidate.record.id)) continue;
      chosen.push(toRecommendation(candidate, true));
    }
  }

  return chosen;
}

/** Builds the explanation from the listener's ACTUAL profile (spec §19).
 *  "Recommended because you frequently listen to…" is only honest if the
 *  affinity numbers it cites are the ones that produced the score. */
function toRecommendation(
  candidate: {
    record: VectorRecord;
    similarity: number;
    artistAffinity: number;
    genreAffinity: number;
  },
  exploration: boolean,
): Recommendation {
  const reasons: MatchReason[] = [];
  const { record } = candidate;

  if (candidate.artistAffinity > 0.1) {
    reasons.push({
      signal: "artist",
      detail: `you listen to ${record.properties.artist} a lot`,
      contribution: candidate.artistAffinity * 0.5,
    });
  }
  if (candidate.genreAffinity > 0.1) {
    reasons.push({
      signal: "genre",
      detail: `close to ${candidate.genreAffinity.toFixed(2)} affinity for ${record.properties.genres?.join(", ")}`,
      contribution: candidate.genreAffinity * 0.3,
    });
  }
  reasons.push({
    signal: "sound",
    detail: `${(candidate.similarity * 100).toFixed(0)}% similar to your listening profile`,
    contribution: candidate.similarity,
  });
  if (exploration) {
    reasons.push({
      signal: "diversity",
      detail: "added to keep the mix varied",
      contribution: 0,
    });
  }

  return {
    record,
    score: candidate.similarity,
    matchReasons: reasons.sort((a, b) => b.contribution - a.contribution),
    exploration,
  };
}

function topGenreAffinity(
  profile: UserVectorProfile,
  properties: MusicProperties,
): number {
  let best = 0;
  for (const genre of properties.genres ?? []) {
    best = Math.max(best, profile.genreAffinity[genre] ?? 0);
  }
  return best;
}

function era(year: number | undefined): string {
  if (typeof year !== "number" || year < 1900) return "";
  return `${Math.floor(year / 10) * 10}s`;
}

function topN(map: Map<string, number>, n: number): [string, number][] {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function normaliseMap(map: Map<string, number>): Record<string, number> {
  const max = Math.max(0.0001, ...map.values());
  const out: Record<string, number> = {};
  for (const [key, value] of map) out[key] = value / max;
  return out;
}

/**
 * Near-duplicate detection (spec §14).
 *
 * Finds alternate uploads, remasters and the same recording uploaded twice.
 * It deliberately does NOT delete anything: remaster detection has a real
 * false-positive rate, and auto-deleting on a 0.92 threshold would silently
 * destroy catalogue entries. Everything goes to a review queue where a human
 * decides (spec §14).
 */
export type DuplicateCandidate = {
  id: string;
  duplicateId: string;
  title: string;
  artist: string;
  score: number;
  reasons: string[];
};

export async function findDuplicates(
  records: VectorRecord[],
  args: { threshold?: number; limit?: number } = {},
): Promise<DuplicateCandidate[]> {
  const threshold = args.threshold ?? 0.92;
  const found: DuplicateCandidate[] = [];

  for (const record of records) {
    const candidates = await Promise.all(
      records
        .filter((other) => other.id !== record.id)
        .map(async (other) => {
          const score = similarity(
            record.vectors.multimodal,
            other.vectors.multimodal,
            "cosine",
          );
          return { other, score };
        }),
    );

    for (const { other, score } of candidates) {
      if (score < threshold) continue;
      const reasons: string[] = [];
      const sameTitle =
        normaliseTitle(record.properties.title) ===
        normaliseTitle(other.properties.title);
      const sameArtist =
        (record.properties.artist ?? "").toLowerCase() ===
        (other.properties.artist ?? "").toLowerCase();
      const lengthDelta =
        typeof record.properties.duration === "number" &&
        typeof other.properties.duration === "number"
          ? Math.abs(record.properties.duration - other.properties.duration)
          : null;

      if (sameTitle) reasons.push("same title");
      if (sameArtist) reasons.push("same artist");
      if (lengthDelta !== null && lengthDelta <= 3)
        reasons.push("duration within 3s");
      // A same-title, same-artist pair that is NOT acoustically similar is
      // almost certainly two different songs (or a badly tagged one), which is
      // exactly what the vector check is for.
      if (score >= 0.97) reasons.push("near-identical audio");
      if (reasons.length === 0) continue;

      found.push({
        id: record.id,
        duplicateId: other.id,
        title: record.properties.title,
        artist: record.properties.artist ?? "",
        score: Math.round(score * 1000) / 1000,
        reasons,
      });
    }
  }

  found.sort((a, b) => b.score - a.score);
  return found.slice(0, args.limit ?? 100);
}

function normaliseTitle(title: string | undefined): string {
  return (title ?? "")
    .toLowerCase()
    .replace(/\b(remaster|remastered|explicit|version|edit|mix)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}
