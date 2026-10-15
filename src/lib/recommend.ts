/**
 * SYNQ recommendation engine — pure logic, no imports, no I/O.
 *
 * Everything here is deliberately side-effect free and synchronous so the whole
 * pipeline (signals → candidates → score → filter → dedupe → diversify) can be
 * tested without a network, a database or a clock. The Convex layer supplies
 * the real data; this file decides what to do with it.
 *
 * ── What this engine can and cannot use ────────────────────────────────────
 *
 * SYNQ has NO genre or mood metadata anywhere — neither YouTube InnerTube nor
 * the Spotify chart payload carries a genre/mood field the app can read. Album
 * IS available (parsed out of the InnerTube subtitle column), so album-level
 * diversity is real. The scoring leans on the artist string, which is the one
 * similarity axis that is always populated.
 * Genre/mood features are deliberately absent rather than guessed at: a
 * fabricated genre match is worse than no genre match, because it looks
 * explainable while being fiction.
 *
 * Everything the app *can* observe is used: likes, play counts, recency,
 * completion ratio, skip counts, playlist membership, the current track and
 * the live queue.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The minimum a candidate needs to be scored. Mirrors `YtItem` + album. */
export interface RecoCandidate {
  id: string;
  title: string;
  artist: string;
  duration: number;
  thumbnail: string;
  /** Real album name when the source supplied one; never invented. */
  album?: string;
  /**
   * Why the engine picked this track. Set on the candidates the Home rows are
   * built from so the UI can show a "why" line without a second lookup. Absent
   * on a bare candidate (e.g. a raw search hit) — never fabricated to fill a
   * card.
   */
  reason?: RecoReason;
}

/** One observed listening event, already normalised. */
export interface PlaySignal {
  trackId: string;
  artistName?: string;
  albumName?: string;
  /** Epoch ms. */
  at: number;
  /** 0..1 — how much of the track was actually heard. */
  completion?: number;
  /** True when the user pressed next / changed track before the end. */
  skipped?: boolean;
  /** Seconds heard before the track was left. */
  listenedSeconds?: number;
  /** Where the play came from, used for the feedback loop. */
  origin?: "user" | "autoplay" | "recommendation" | "radio";
}

export interface LikeSignal {
  trackId: string;
  artistName?: string;
  albumName?: string;
  at: number;
}

export interface PlaylistSignal {
  name: string;
  tracks: Array<{ trackId: string; artistName?: string; albumName?: string }>;
  updatedAt: number;
}

/** Everything the engine knows about one listener. */
export interface UserSignals {
  userId: string | null;
  plays: PlaySignal[];
  likes: LikeSignal[];
  playlists: PlaylistSignal[];
  /** Populated when the listener is signed in; empty for anonymous. */
}

/**
 * Human copy for a recommendation reason — the "why this song?" line.
 *
 * Every label describes a signal the engine actually used; none of them claims
 * a genre or a mood, because SYNQ has no such metadata. `discovery` and
 * `global_fallback` are deliberately worded as non-personal so a cold-start row
 * never reads as if it knew the listener.
 */
export function explainReason(
  reason: RecoReason | null | undefined,
): string | null {
  switch (reason) {
    case "based_on_likes":
      return "From songs you liked";
    case "because_you_listened":
      return "Based on your listening";
    case "favorite_artist":
      return "An artist you keep playing";
    case "similar_song":
      return "Sounds like your music";
    case "playlist_related":
      return "From your playlists";
    case "discovery":
      return "Something new";
    case "new_release":
      return "A fresh release";
    case "continuing_mix":
      return "Keeps the vibe going";
    case "global_fallback":
      return "Popular right now";
    default:
      return null;
  }
}

/** Why a candidate was picked. Never emitted without a supporting signal. */
export type RecoReason =
  | "based_on_likes"
  | "because_you_listened"
  | "favorite_artist"
  | "similar_song"
  | "playlist_related"
  | "discovery"
  | "new_release"
  | "continuing_mix"
  | "global_fallback";

/** Where a candidate came from, before scoring. */
export type CandidateSource =
  | "likes"
  | "history"
  | "artists"
  | "playlist"
  | "related_to_current"
  | "discovery"
  | "global"
  /**
   * From the music vector index rather than a text search: the candidate was
   * found by sounding like something the listener played, not by matching an
   * artist or title string. This is the only source that can surface music the
   * listener has never searched for by name.
   */
  | "vector_sound_alike"
  /**
   * Found through the Jamendo catalogue and then resolved to a YouTube upload.
   *
   * The song came from an independent, Creative Commons index; the audio that
   * plays is YouTube's. Kept distinct from `discovery` because it is sourced
   * from a different catalogue with a different licensing story, and the UI
   * credits the independent release.
   */
  | "jamendo_discovery";

/** The full explainable breakdown. Every field is a real computed number. */
export interface ScoreBreakdown {
  artistAffinity: number;
  likeScore: number;
  historyScore: number;
  recencyScore: number;
  completionScore: number;
  playlistScore: number;
  discoveryScore: number;
  /**
   * The shift the listener's exploration preference applied to artist
   * affinity: negative when they asked to explore, positive when they asked to
   * stay close. Kept separate from `artistAffinity` so the raw affinity stays
   * visible and the slider's effect is auditable on its own.
   */
  familiarityAdjustment: number;
  skipPenalty: number;
  recentPlayPenalty: number;
  duplicatePenalty: number;
  diversityAdjustment: number;
  finalScore: number;
}

export interface ScoredCandidate {
  track: RecoCandidate;
  source: CandidateSource;
  score: ScoreBreakdown;
  reason: RecoReason;
  /** Human-readable seed, for the debug view. Never shown to users. */
  seed: string | null;
}

export interface RankOptions {
  /** How many to return. */
  limit?: number;
  /** Currently playing; always filtered out. */
  currentTrackId?: string | null;
  /** Every id already in the queue or history. */
  excludeIds?: Iterable<string>;
  /** Ids played in the last `recentWindowMs`. */
  recentPlays?: Array<{ trackId: string; at: number }>;
  /** The track the recommendations should flow from, if any. */
  currentTrack?: RecoCandidate | null;
  /** Epoch ms. Injected so the decay is deterministic under test. */
  now: number;
  /** Max candidates from any single artist. */
  maxPerArtist?: number;
  /** Max candidates from any single album. */
  maxPerAlbum?: number;
  /** Drop a candidate whose artist is already this many times in the list. */
  artistRepeatLimit?: number;
  /** Cap on how many candidates the pipeline will consider. */
  candidateCap?: number;
  /** Exploration preference. Omit for the balanced default. */
  tuning?: Tuning;
  /**
   * Seed that actually produced each candidate, when the caller already knows
   * (the Convex action fetched "<artist> songs" and can therefore say exactly
   * which seed a returned track came from). Without it, attribution falls back
   * to matching the candidate's artist against the seed query, which is only
   * reliable for the plain "<artist> songs" form.
   */
  seedByTrackId?: Map<string, CandidateSeed>;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

export const WEIGHTS = {
  artistAffinity: 0.42,
  likeScore: 0.15,
  historyScore: 0.18,
  recencyScore: 0.12,
  completionScore: 0.1,
  playlistScore: 0.08,
  discoveryScore: 0.12,
  skipPenalty: -0.55,
  recentPlayPenalty: -0.1,
  duplicatePenalty: -1.0,
  diversityPerRepeat: -0.16,
} as const;

/** Half-life for the recency term. Older plays still count, just less. */
export const RECENCY_HALF_LIFE_DAYS = 14;
/** A play inside this window is "too recent" and takes the penalty. */
export const RECENT_PLAY_WINDOW_MS = 6 * 60 * 60 * 1000;
/** A skip shorter than this is treated as a strong rejection, not a skip. */
export const EARLY_SKIP_SECONDS = 12;
/** Fraction of the track that counts as "finished". */
export const COMPLETION_COMPLETE = 0.7;
/** Below this a track is unheard, above it is a full listen. */
export const DISCOVERY_FLOOR = 0.02;

// ---------------------------------------------------------------------------
// Exploration tuning
// ---------------------------------------------------------------------------

/**
 * How adventurous the listener wants their recommendations to be.
 *
 * 0 = stay inside what they already play; 100 = push unfamiliar music at them
 * as hard as the rest of their taste allows. The midpoint is the un-tuned
 * default, and the whole default profile below is expressed as a function of
 * it — so "no preference expressed" and "balanced" are the same code path, not
 * two behaviours that can drift apart.
 */
export const DEFAULT_EXPLORATION = 50;

/** What the engine does differently at each end of the slider. */
export interface Tuning {
  /** The listener's stated setting, 0..100. */
  exploration: number;
  /** 0..1 multiplier for a candidate from an artist they already know. */
  familiarityBonus: number;
  /** 0..1 multiplier for a candidate from an artist they have never played. */
  discoveryBonus: number;
  /** How many of the candidate seeds are spent on discovery. */
  discoverySeeds: number;
  /** Penalty per repeat of the same artist; higher when exploring. */
  diversityPerRepeat: number;
}

/**
 * Derive the tuning profile from a 0..100 setting.
 *
 * Bounds matter here: the discovery bonus is only worth anything while there
 * is still taste to be near, and the familiarity bonus has to keep a floor so
 * that turning the slider all the way up cannot reduce the app to pure noise.
 * A listener who asks for discovery still gets music related to them, and one
 * who asks for comfort still gets some.
 */
export function buildTuning(exploration: number | undefined | null): Tuning {
  const value = clampExploration(exploration);
  // 0 at pure familiarity, 1 at pure discovery.
  const lean = value / 100;
  return {
    exploration: value,
    // Neither end is ever fully switched off: a listener asking for
    // discovery still wants it to be reachable FROM their taste, and one
    // asking for comfort should still be offered something occasionally new.
    familiarityBonus: 1 - 0.65 * lean,
    discoveryBonus: 0.55 + 1.55 * lean,
    discoverySeeds: Math.round(1 + 2 * lean),
    diversityPerRepeat: -0.1 - 0.12 * lean,
  };
}

/** The tuning used when a caller expresses no preference. */
export const DEFAULT_TUNING: Tuning = buildTuning(DEFAULT_EXPLORATION);

// ---------------------------------------------------------------------------
// Adaptive discovery/familiarity balance
// ---------------------------------------------------------------------------
//
// The exploration slider is a LISTENER'S INTENT, not the whole story. A person
// can ask for discovery and then skip every unfamiliar track the engine offers;
// continuing to serve them surprises they reject is not "following their
// setting", it is ignoring them. These pure functions read how the listener
// actually responds to what the engine recommended and nudge the dial toward
// what is working — bounded, and reversible as behaviour changes.
//
// Only RECOMMENDED plays count. What a listener does with music they chose
// themselves says nothing about whether the RECOMMENDER is landing, and mixing
// the two would let a heavy self-directed listener look tolerant of
// recommendations they never saw.

/** How the listener responds to recommended/autoplay/radio plays. */
export interface FeedbackTolerance {
  /** Plays that came from the engine (recommendation, autoplay or radio). */
  recommended: number;
  /** Of those, how many the listener skipped. */
  skipped: number;
}

/**
 * Below this many recommended plays, adaptivity keeps its hands off the dial.
 * With one or two skips a listener has no pattern yet, and moving their setting
 * would be reading noise as signal.
 */
export const ADAPT_MIN_SAMPLES = 6;

/**
 * The most adaptivity may ever shift the discovery dial, in points (0..100).
 *
 * Capped on purpose: adaptivity is a NUDGE that corrects a small mismatch
 * between what the listener asked for and what they enjoy, not a replacement
 * for their preference. A run of skips must never be able to switch discovery
 * off entirely, and the shift simply falls away once the listening changes.
 */
export const ADAPT_MAX_SHIFT = 18;

/** Fold the raw plays into the two numbers adaptivity cares about. */
export function measureFeedbackTolerance(
  plays: PlaySignal[],
): FeedbackTolerance {
  let recommended = 0;
  let skipped = 0;
  for (const play of plays) {
    if (
      play.origin !== "recommendation" &&
      play.origin !== "autoplay" &&
      play.origin !== "radio"
    ) {
      continue;
    }
    recommended += 1;
    if (play.skipped) skipped += 1;
  }
  return { recommended, skipped };
}

/**
 * Shift the exploration preference toward what the listener actually accepts.
 *
 * A 50% skip rate is neutral — the mix lands about as often as it misses, which
 * is an ordinary hit rate for discovery. Liking more than half of it earns more
 * discovery; skipping more than half of it earns more of the familiar. The
 * shift is proportional to how far from neutral the rate is, capped by
 * {@link ADAPT_MAX_SHIFT}, and returns the base value untouched until there is
 * enough evidence to justify moving it.
 */
export function adaptExploration(
  base: number | undefined | null,
  tolerance: FeedbackTolerance,
): number {
  const value = clampExploration(base);
  if (tolerance.recommended < ADAPT_MIN_SAMPLES) return value;
  const skipRatio = Math.min(
    1,
    Math.max(0, tolerance.skipped / tolerance.recommended),
  );
  // Confidence ramps in over the first forty rated plays so the correction is
  // gentle while the picture is still forming and firm once it is clear.
  const confidence = Math.min(1, tolerance.recommended / 40);
  const shift = (0.5 - skipRatio) * 2 * ADAPT_MAX_SHIFT * confidence;
  return clampExploration(value + shift);
}

/**
 * The tuning the engine should actually use, given real behaviour.
 *
 * This is the ONE entry point callers should reach for: it folds the listener's
 * stated preference together with how they respond to recommendations and
 * returns a tuning, never a bare number, so "what plays next", the Home
 * shelves and the score inspector all adapt identically.
 */
export function adaptiveTuning(
  base: number | undefined | null,
  plays: PlaySignal[],
): Tuning {
  return buildTuning(adaptExploration(base, measureFeedbackTolerance(plays)));
}

/** Coerce anything into a sane 0..100 exploration value. */
export function clampExploration(value: unknown): number {
  // `null` means NO PREFERENCE, not "zero". `Number(null)` is 0, so the
  // generic numeric path read a missing preference as the strongest possible
  // familiarity lean — the exact opposite of the middle it is supposed to
  // mean, and silent because 0 is a legal value. Checked before the coercion.
  if (value === null || value === undefined) return DEFAULT_EXPLORATION;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_EXPLORATION;
  return Math.min(100, Math.max(0, n));
}

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

const PLACEHOLDER_ARTIST = /^(unknown artist|artist|various artists?)$/i;

/**
 * Fold an artist string to a comparable key.
 *
 * This is the single most load-bearing normalisation in the engine: the same
 * artist appears as "Rick Astley", "Rick Astley - Topic" and
 * "Rick Astley (feat. …)". Without folding, affinity silently splits across
 * variants and every artist looks unheard.
 */
export function artistKey(raw: string | null | undefined): string {
  if (!raw) return "";
  const base = raw.split(/ - Topic$/i)[0] ?? raw;
  const cleaned = base
    .toLowerCase()
    // "VEVO" is glued to the name in real channel titles ("RickAstleyVEVO"),
    // so a word boundary here would never match it.
    .replace(/\bofficial\b|\bmusic\b|vevo/g, " ")
    // A featured credit is not part of the artist's identity.
    .replace(/\s*[([]?(feat|ft|featuring|with)\.?\s.*$/i, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || PLACEHOLDER_ARTIST.test(cleaned)) return "";
  return cleaned;
}

/** Fold a title for duplicate detection, ignoring parenthetical noise. */
export function titleKey(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/\b(official|music video|audio|lyrics?|hd|hq|4k)\b/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function trackKey(track: {
  title?: string | null;
  artist?: string | null;
}): string {
  const t = titleKey(track.title);
  const a = artistKey(track.artist);
  if (!t && !a) return "";
  return `${a}|${t}`;
}

// ---------------------------------------------------------------------------
// Signal aggregation
// ---------------------------------------------------------------------------

export interface AffinityEntry {
  /** 0..1, recency-weighted, so a like from last week outweighs one from last month. */
  weight: number;
  plays: number;
  likes: number;
  skips: number;
  lastAt: number;
  /** Weighted share of listened-through time. */
  completion: number;
}

export interface ArtistProfile {
  key: string;
  display: string;
  plays: number;
  likes: number;
  skips: number;
  /** 0..1. */
  affinity: number;
  lastAt: number;
  /** Recency-weighted mean completion ratio over non-skipped plays. */
  completion: number;
}

export interface Signals {
  artists: Map<string, ArtistProfile>;
  trackPlayCount: Map<string, number>;
  trackLiked: Set<string>;
  trackSkips: Map<string, number>;
  /** Ids with any real positive signal — the "you know this" set. */
  knownTracks: Set<string>;
  /** Recency-weighted total, used to normalise the like term. */
  likeMass: number;
  /** Recency-weighted total, used to normalise the history term. */
  historyMass: number;
  /** True when there is enough signal for personalised ranking. */
  personalised: boolean;
  /** Number of distinct artists heard — a cold-start proxy. */
  artistCount: number;
}

function decayFor(at: number, now: number): number {
  const age = Math.max(0, now - at);
  return Math.pow(0.5, age / (RECENCY_HALF_LIFE_DAYS * DAY_MS));
}

function clampRatio(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

/** Classify a play as a completion, a partial listen or a skip. */
export function classifyPlay(
  play: PlaySignal,
  durationHint?: number,
): "complete" | "partial" | "skip" {
  if (play.skipped) {
    // A long listen that was still skipped is weaker evidence of dislike than
    // a thumb on the track after four seconds.
    const heard = play.listenedSeconds ?? 0;
    return heard >= (durationHint ?? 0) * 0.5 && heard >= EARLY_SKIP_SECONDS * 2
      ? "partial"
      : "skip";
  }
  if (typeof play.completion === "number") {
    if (play.completion >= COMPLETION_COMPLETE) return "complete";
    if (play.completion <= DISCOVERY_FLOOR) return "skip";
    return "partial";
  }
  return "partial";
}

/**
 * Fold the raw signals into per-artist affinity.
 *
 * Positive and negative evidence are kept separate and then subtracted, so a
 * listener who skipped an artist twice and played them five times lands at a
 * small positive affinity rather than a wash.
 */
export function buildSignals(signals: UserSignals, now: number): Signals {
  const artists = new Map<string, ArtistProfile>();
  const trackPlayCount = new Map<string, number>();
  const trackLiked = new Set<string>();
  const trackSkips = new Map<string, number>();
  const knownTracks = new Set<string>();
  let likeMass = 0;
  let historyMass = 0;
  const bump = (
    rawArtist: string | undefined,
    at: number,
    delta: {
      plays?: number;
      likes?: number;
      skips?: number;
      /** 0..1, only meaningful alongside a play. */
      completion?: number;
    },
  ) => {
    const key = artistKey(rawArtist);
    if (!key) return;
    const decay = decayFor(at, now);
    const existing = artists.get(key) ?? {
      key,
      display: rawArtist ?? key,
      plays: 0,
      likes: 0,
      skips: 0,
      affinity: 0,
      lastAt: 0,
      completion: 0,
    };
    const addedPlays = delta.plays ?? 0;
    existing.plays += addedPlays;
    existing.likes += delta.likes ?? 0;
    existing.skips += delta.skips ?? 0;
    existing.lastAt = Math.max(existing.lastAt, at);
    // A like is worth more than a play, and a skip subtracts less than a play
    // adds — that asymmetry is what stops a single skip from killing a song.
    existing.affinity +=
      decay *
      ((delta.likes ?? 0) * 1.6 + addedPlays - (delta.skips ?? 0) * 0.5);
    if (addedPlays > 0 && typeof delta.completion === "number") {
      // Running mean, decayed: a listener who used to skip this artist and now
      // finishes their tracks should see their completion score recover.
      const prior = existing.completion * (existing.plays - addedPlays);
      const weight = Math.max(1, existing.plays);
      existing.completion = (prior + decay * delta.completion) / weight;
    }
    artists.set(key, existing);
  };

  for (const play of signals.plays) {
    const kind = classifyPlay(play);
    if (kind === "skip") {
      trackSkips.set(play.trackId, (trackSkips.get(play.trackId) ?? 0) + 1);
      bump(play.artistName, play.at, { skips: 1 });
      continue;
    }
    trackPlayCount.set(
      play.trackId,
      (trackPlayCount.get(play.trackId) ?? 0) + 1,
    );
    knownTracks.add(play.trackId);
    historyMass += decayFor(play.at, now);
    // Plays recorded before skip tracking existed carry no position, so
    // `clampRatio` defaults them to a half-listen. Assuming 1.0 there would
    // let ancient history claim full completion and inflate the term.
    bump(play.artistName, play.at, {
      plays: 1,
      completion: kind === "complete" ? 1 : clampRatio(play.completion),
    });
  }

  for (const like of signals.likes) {
    trackLiked.add(like.trackId);
    knownTracks.add(like.trackId);
    likeMass += decayFor(like.at, now) * 1.6;
    bump(like.artistName, like.at, { likes: 1 });
  }

  for (const playlist of signals.playlists) {
    for (const track of playlist.tracks) {
      const decay = decayFor(playlist.updatedAt, now);
      bump(track.artistName, playlist.updatedAt, { plays: decay * 0.25 });
    }
  }

  // Normalise each artist's affinity against the strongest artist, so the term
  // lands in 0..1 and the weights mean what they say. A cold listener gets a
  // flat 0 rather than a division by zero.
  let peak = 0;
  for (const profile of artists.values()) {
    peak = Math.max(peak, profile.affinity);
  }
  if (peak > 0) {
    for (const profile of artists.values()) {
      profile.affinity = Math.max(0, profile.affinity) / peak;
    }
  }

  return {
    artists,
    trackPlayCount,
    trackLiked,
    trackSkips,
    knownTracks,
    likeMass,
    historyMass,
    personalised: artists.size > 0,
    artistCount: artists.size,
  };
}

// ---------------------------------------------------------------------------
// Candidate generation
// ---------------------------------------------------------------------------

export interface CandidateSeed {
  /** The artist string to search with. */
  query: string;
  source: CandidateSource;
  /** 0..1 — how strongly this seed reflects the listener's taste. */
  weight: number;
  seed: string | null;
  reason: RecoReason;
}

/**
 * Build the list of search queries to resolve candidates from.
 *
 * This produces *seeds*, not tracks. The actual fetching is network work and
 * belongs in a Convex action; this function only decides what to ask for, in
 * priority order, and caps the fan-out so a heavy listener cannot turn one
 * recommendation request into fifty upstream searches.
 */
export function buildSeeds(
  signals: Signals,
  userSignals: UserSignals,
  options: {
    maxSeeds?: number;
    currentTrack?: RecoCandidate | null;
    /** Exploration preference. Omit for the balanced default. */
    tuning?: Tuning;
  } = {},
): CandidateSeed[] {
  const maxSeeds = options.maxSeeds ?? 6;
  const tuning = options.tuning ?? DEFAULT_TUNING;
  const seeds: CandidateSeed[] = [];

  // How many slots discovery is entitled to, decided up front.
  //
  // These used to be appended after every other seed with a
  // `seeds.length >= maxSeeds` guard, which meant that whenever the earlier
  // loops filled the budget — i.e. any listener with more than a handful of
  // artists — the discovery seed was NEVER reached. The engine advertised a
  // discovery source that could not fire.
  const wanted = Math.max(1, Math.min(tuning.discoverySeeds, maxSeeds));
  // Seeds available for everything else, so discovery always has room.
  const familiarBudget = Math.max(1, maxSeeds - wanted);

  if (!signals.personalised) {
    // Cold start: there is nothing to personalise from, so ask for broadly
    // popular music rather than inventing a taste.
    return [
      {
        query: "popular songs",
        source: "global",
        weight: 1,
        seed: null,
        reason: "global_fallback",
      },
    ];
  }

  // Top artists by affinity, recency already folded in.
  const ranked = [...signals.artists.values()].sort(
    (a, b) => b.affinity - a.affinity || b.lastAt - a.lastAt,
  );

  // Liked artists lead: a like is the most deliberate signal available.
  for (const profile of ranked) {
    if (seeds.length >= familiarBudget) break;
    if (profile.likes > 0) {
      seeds.push({
        query: `${profile.display} songs`,
        source: "likes",
        weight: 1,
        seed: `liked:${profile.key}`,
        reason: "based_on_likes",
      });
    }
  }

  // The track playing right now is the strongest context signal we have.
  if (options.currentTrack) {
    const artist = artistKey(options.currentTrack.artist);
    seeds.push({
      query: `artists similar to ${options.currentTrack.artist}`,
      source: "related_to_current",
      weight: 1,
      seed: `current:${options.currentTrack.id}`,
      reason: "similar_song",
    });
    if (artist) {
      seeds.push({
        query: `${options.currentTrack.artist} songs`,
        source: "artists",
        weight: 0.9,
        seed: `current-artist:${artist}`,
        reason: "favorite_artist",
      });
    }
  }

  // Frequently played artists.
  for (const profile of ranked) {
    if (seeds.length >= familiarBudget) break;
    if (profile.plays > 0) {
      seeds.push({
        query: `${profile.display} songs`,
        source: "artists",
        weight: 0.85,
        seed: `artist:${profile.key}`,
        reason: "because_you_listened",
      });
    }
  }

  // Playlist-derived artists, which carry a different kind of intent.
  for (const playlist of userSignals.playlists) {
    if (seeds.length >= familiarBudget) break;
    const artist = playlist.tracks[0]?.artistName;
    if (artist) {
      seeds.push({
        query: `${artist} songs`,
        source: "playlist",
        weight: 0.7,
        seed: `playlist:${playlist.name}`,
        reason: "playlist_related",
      });
    }
  }

  // Always keep discovery in the mix, so the listener keeps meeting new music
  // instead of collapsing into an ever-narrower loop. How MANY discovery seeds
  // get spent is the listener's stated preference — but never zero, because a
  // pure-familiarity setting that never proposes anything new is exactly the
  // feedback loop this engine exists to avoid.
  let discoveryAdded = 0;
  for (const profile of ranked) {
    if (seeds.length >= maxSeeds) break;
    if (discoveryAdded >= wanted) break;
    seeds.push({
      query: `new songs like ${profile.display}`,
      source: "discovery",
      weight: 0.5,
      seed: `discovery:${profile.key}`,
      reason: "discovery",
    });
    discoveryAdded += 1;
  }

  return seeds;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Score one candidate. Pure, and the only place weights are applied.
 *
 * Every returned field is derived from a real signal; when a signal is absent
 * its term is 0 rather than a guess, and `reason` is resolved from whichever
 * term actually contributed most.
 */
export function scoreCandidate(
  candidate: RecoCandidate,
  signals: Signals,
  source: CandidateSeed,
  context: {
    now: number;
    recentPlays: Map<string, number>;
    duplicate: boolean;
    currentTrackId?: string | null;
    /** Exploration preference. Omit for the balanced default. */
    tuning?: Tuning;
  },
): ScoredCandidate {
  const tuning = context.tuning ?? DEFAULT_TUNING;
  const key = artistKey(candidate.artist);
  const profile = key ? signals.artists.get(key) : undefined;

  const artistAffinity = clamp01(profile?.affinity ?? 0);

  // Like term: how strongly this artist is liked relative to total like mass,
  // so it does not grow without bound for a heavy listener.
  const likeScore =
    signals.likeMass > 0 && profile
      ? clamp01(
          ((profile.likes * 1.6) / signals.likeMass) *
            Math.min(1, profile.affinity * 2),
        )
      : 0;

  const plays = profile?.plays ?? 0;
  const historyScore =
    signals.historyMass > 0
      ? clamp01((plays / Math.max(1, signals.historyMass)) * Math.min(1, plays))
      : 0;

  // Recency is about the *listener's* momentum with this artist, not the
  // track's own age.
  const ageDays = profile
    ? Math.max(0, context.now - profile.lastAt) / DAY_MS
    : Infinity;
  const recencyScore = Number.isFinite(ageDays)
    ? clamp01(Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS))
    : 0;

  // Completion: only counted over plays that were not skips, so a skipped
  // track can never earn completion credit.
  const completionScore =
    profile && profile.plays > 0
      ? clamp01((profile.completion ?? 0) * Math.min(1, profile.plays / 3))
      : 0;

  // Playlist term: the artist appears in one of the listener's own playlists.
  const playlistScore = source.source === "playlist" ? 0.8 : 0;

  // Discovery: unknown artists get a bonus so the list is not entirely made of
  // things already in the listener's history. Its size is the listener's stated
  // exploration preference, scaled by the tuning profile.
  const isKnown = signals.knownTracks.has(candidate.id) || Boolean(profile);
  const discoveryScore = isKnown ? 0 : 0.6 * tuning.discoveryBonus;

  // Familiarity: a listener who asked to stay close to their taste gets a
  // nudge toward artists they already play. This is a MULTIPLIER on the real
  // affinity signal above, never a substitute for it — an unknown artist earns
  // nothing here, so the slider cannot invent a connection that does not exist.
  const familiarityAdjustment = artistAffinity * (tuning.familiarityBonus - 1);

  // Skip penalty scales with how many times this exact track was skipped and
  // with artist-level skips, so one skip is small and a pattern is not.
  const trackSkips = signals.trackSkips.get(candidate.id) ?? 0;
  const artistSkips = profile?.skips ?? 0;
  const skipPenalty =
    clamp01(trackSkips / 3) * 0.8 + clamp01(artistSkips / 6) * 0.2;

  const lastPlayedAt = context.recentPlays.get(candidate.id);
  const recentPlayPenalty =
    lastPlayedAt !== undefined &&
    context.now - lastPlayedAt < RECENT_PLAY_WINDOW_MS
      ? 0.8
      : 0;

  const duplicatePenalty = context.duplicate ? 1 : 0;

  const finalScore =
    artistAffinity * WEIGHTS.artistAffinity +
    familiarityAdjustment * WEIGHTS.artistAffinity +
    likeScore * WEIGHTS.likeScore +
    historyScore * WEIGHTS.historyScore +
    recencyScore * WEIGHTS.recencyScore +
    completionScore * WEIGHTS.completionScore +
    playlistScore * WEIGHTS.playlistScore +
    discoveryScore * WEIGHTS.discoveryScore +
    skipPenalty * WEIGHTS.skipPenalty +
    recentPlayPenalty * WEIGHTS.recentPlayPenalty +
    duplicatePenalty * WEIGHTS.duplicatePenalty;

  const breakdown: ScoreBreakdown = {
    artistAffinity,
    likeScore,
    historyScore,
    recencyScore,
    completionScore,
    playlistScore,
    discoveryScore,
    familiarityAdjustment,
    skipPenalty,
    recentPlayPenalty,
    duplicatePenalty,
    diversityAdjustment: 0,
    finalScore,
  };

  return {
    track: candidate,
    source: source.source,
    seed: source.seed,
    // Resolved here, not left to the caller: the seed's reason only says where
    // the candidate came FROM, whereas this is why it actually scored where it
    // did. Deriving it in one place keeps a directly-scored candidate and a
    // ranked one from disagreeing about their own explanation.
    reason: reasonFor({
      track: candidate,
      source: source.source,
      seed: source.seed,
      reason: source.reason,
      score: breakdown,
    }),
    score: breakdown,
  };
}

/** Pick the reason that matches whichever term actually contributed most. */
export function reasonFor(scored: ScoredCandidate): RecoReason {
  const s = scored.score;
  const terms: Array<[number, RecoReason]> = [
    [
      s.artistAffinity,
      scored.source === "likes" ? "based_on_likes" : "favorite_artist",
    ],
    [s.likeScore, "based_on_likes"],
    [s.historyScore, "because_you_listened"],
    [s.recencyScore, "because_you_listened"],
    [s.playlistScore, "playlist_related"],
  ];
  let best: [number, RecoReason] = [0, scored.reason];
  for (const term of terms) {
    if (term[0] > best[0]) best = term;
  }
  // Nothing personal scored at all — the listener has no history with this
  // artist, so the honest reason is discovery, not a fabricated connection.
  if (best[0] <= 0) return "discovery";
  return best[1];
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export interface FilterContext {
  currentTrackId?: string | null;
  excludeIds: Set<string>;
  recentPlays: Map<string, number>;
  now: number;
  /** Track ids already accepted, for intra-pass dedupe. */
  seenTrackKeys: Set<string>;
}

/** True when a candidate must not be shown at all. */
export function shouldFilter(
  candidate: RecoCandidate,
  context: FilterContext,
): { filtered: boolean; reason: string | null } {
  if (!candidate || typeof candidate.id !== "string" || !candidate.id) {
    return { filtered: true, reason: "invalid_id" };
  }
  if (typeof candidate.title !== "string" || !candidate.title.trim()) {
    return { filtered: true, reason: "missing_title" };
  }
  if (
    typeof candidate.duration !== "number" ||
    !Number.isFinite(candidate.duration) ||
    candidate.duration <= 0
  ) {
    return { filtered: true, reason: "unavailable" };
  }
  if (candidate.duration > 60 * 60) {
    return { filtered: true, reason: "unavailable" };
  }
  if (context.currentTrackId && candidate.id === context.currentTrackId) {
    return { filtered: true, reason: "currently_playing" };
  }
  if (context.excludeIds.has(candidate.id)) {
    return { filtered: true, reason: "already_queued" };
  }
  const key = trackKey(candidate);
  if (key && context.seenTrackKeys.has(key)) {
    return { filtered: true, reason: "duplicate" };
  }
  return { filtered: false, reason: null };
}

/**
 * Is this track a repeat of something heard very recently?
 *
 * Deliberately a soft signal, not a hard block: a listener who has a track on
 * repeat should still see it available, so this only feeds the penalty term.
 */
export function wasPlayedRecently(
  trackId: string,
  recentPlays: Map<string, number>,
  now: number,
): boolean {
  const at = recentPlays.get(trackId);
  return at !== undefined && now - at < RECENT_PLAY_WINDOW_MS;
}

// ---------------------------------------------------------------------------
// Diversity
// ---------------------------------------------------------------------------

/**
 * Re-rank with a repeating-artist penalty applied greedily.
 *
 * A sort-then-trim would drop a genuinely strong second pick from the same
 * artist; instead the penalty grows as an artist reappears, so a good track
 * still beats a weak one but five of the same artist cannot fill a row.
 */
export function applyDiversity(
  scored: ScoredCandidate[],
  options: {
    maxPerArtist?: number;
    maxPerAlbum?: number;
    /** Exploration preference; a higher value pushes harder against repeats. */
    tuning?: Tuning;
  } = {},
): ScoredCandidate[] {
  const maxPerArtist = options.maxPerArtist ?? 2;
  const maxPerAlbum = options.maxPerAlbum ?? 3;
  const tuning = options.tuning ?? DEFAULT_TUNING;

  const remaining = [...scored];
  const accepted: ScoredCandidate[] = [];
  const artistCount = new Map<string, number>();
  const albumCount = new Map<string, number>();

  while (remaining.length > 0 && accepted.length < scored.length) {
    let bestIndex = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i += 1) {
      const candidate = remaining[i];
      if (!candidate) continue;
      const artist = artistKey(candidate.track.artist);
      const seen = artist ? (artistCount.get(artist) ?? 0) : 0;
      const album = candidate.track.album
        ? (albumCount.get(candidate.track.album.toLowerCase()) ?? 0)
        : 0;

      // Hard cap: an artist that has had its fill cannot take another slot.
      if (artist && seen >= maxPerArtist) continue;
      if (album >= maxPerAlbum) continue;

      const penalty = seen * tuning.diversityPerRepeat + album * 0.04;
      const adjusted = candidate.score.finalScore + penalty;
      if (adjusted > bestScore) {
        bestScore = adjusted;
        bestIndex = i;
      }
    }
    // Nothing left that clears the caps — stop rather than spin.
    if (bestIndex < 0) break;

    const [picked] = remaining.splice(bestIndex, 1);
    if (!picked) break;
    const artist = artistKey(picked.track.artist);
    if (artist) artistCount.set(artist, (artistCount.get(artist) ?? 0) + 1);
    if (picked.track.album) {
      const album = picked.track.album.toLowerCase();
      albumCount.set(album, (albumCount.get(album) ?? 0) + 1);
    }
    // The diversity term is recorded in the breakdown so the debug view shows
    // what the pipeline actually did to this track's score.
    accepted.push({
      ...picked,
      reason: reasonFor(picked),
      score: {
        ...picked.score,
        diversityAdjustment: bestScore - picked.score.finalScore,
        finalScore: bestScore,
      },
    });
  }

  return accepted;
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/**
 * Full pipeline: score → filter → dedupe → diversify → rank.
 *
 * `candidates` must already be resolved to real playable tracks (the network
 * step lives in the Convex action). Everything from here down is pure.
 */
export function rankCandidates(
  candidates: RecoCandidate[],
  signals: Signals,
  seeds: CandidateSeed[],
  options: RankOptions,
): ScoredCandidate[] {
  const now = options.now;
  const limit = options.limit ?? 12;
  const excludeIds = new Set(options.excludeIds ?? []);
  const recentPlays = new Map(
    (options.recentPlays ?? []).map((entry) => [entry.trackId, entry.at]),
  );
  if (options.currentTrackId) excludeIds.add(options.currentTrackId);

  const filterContext: FilterContext = {
    currentTrackId: options.currentTrackId,
    excludeIds,
    recentPlays,
    now,
    seenTrackKeys: new Set(),
  };

  // Attribute each candidate to the seed whose artist it matches, so the
  // reason is derived from the seed that actually produced it.
  const seedByArtist = new Map<string, CandidateSeed>();
  for (const seed of seeds) {
    const key = artistKey(seed.query.replace(/\s+songs$/i, ""));
    if (key && !seedByArtist.has(key)) seedByArtist.set(key, seed);
  }

  const scored: ScoredCandidate[] = [];
  const cap = options.candidateCap ?? 200;
  for (const candidate of candidates) {
    if (scored.length >= cap) break;
    const verdict = shouldFilter(candidate, filterContext);
    if (verdict.filtered) continue;

    const key = artistKey(candidate.artist);
    const seed = options.seedByTrackId?.get(candidate.id) ??
      (key ? seedByArtist.get(key) : undefined) ??
      seeds[0] ?? {
        query: "",
        source: "discovery" as CandidateSource,
        weight: 0,
        seed: null,
        reason: "discovery" as RecoReason,
      };

    const result = scoreCandidate(candidate, signals, seed, {
      now,
      recentPlays,
      duplicate: false,
      currentTrackId: options.currentTrackId,
      tuning: options.tuning,
    });
    result.reason = reasonFor(result);
    scored.push(result);
    const trackIdentity = trackKey(candidate);
    if (trackIdentity) filterContext.seenTrackKeys.add(trackIdentity);
  }

  scored.sort((a, b) => b.score.finalScore - a.score.finalScore);
  return applyDiversity(scored, {
    maxPerArtist: options.maxPerArtist ?? 2,
    maxPerAlbum: options.maxPerAlbum ?? 3,
    tuning: options.tuning,
  }).slice(0, limit);
}

/**
 * Pick the single best track. Used by autoplay and "what plays next".
 *
 * Falls back to the original candidate list when strict filtering leaves
 * nothing: stopping the music is far worse than offering a track that is only
 * a mild repeat.
 */
export function pickNextTrack(
  candidates: RecoCandidate[],
  signals: Signals,
  seeds: CandidateSeed[],
  options: RankOptions,
): ScoredCandidate | null {
  const ranked = rankCandidates(candidates, signals, seeds, {
    ...options,
    limit: 1,
  });
  if (ranked[0]) return ranked[0];

  if (candidates.length === 0) return null;

  // Fallback pass: keep only the hard validity checks, drop the recency and
  // queue rules, so playback continues from whatever is actually playable.
  const relaxed: FilterContext = {
    currentTrackId: options.currentTrackId ?? null,
    excludeIds: new Set(),
    recentPlays: new Map(),
    now: options.now,
    seenTrackKeys: new Set(),
  };
  const seed = seeds[0] ?? {
    query: "",
    source: "discovery" as CandidateSource,
    weight: 0,
    seed: null,
    reason: "discovery" as RecoReason,
  };
  for (const candidate of candidates) {
    const verdict = shouldFilter(candidate, relaxed);
    if (verdict.filtered) continue;
    return scoreCandidate(candidate, signals, seed, {
      now: options.now,
      recentPlays: new Map(),
      duplicate: false,
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// Debug
// ---------------------------------------------------------------------------

/** Human-readable score breakdown for the developer debug view. */
export function explainCandidate(scored: ScoredCandidate): string {
  const s = scored.score;
  const lines: string[] = [];
  const add = (label: string, value: number) => {
    if (Math.abs(value) < 0.001) return;
    lines.push(`${value >= 0 ? "+" : ""}${value.toFixed(2)} ${label}`);
  };
  lines.push(`Candidate: ${scored.track.title} — ${scored.track.artist}`);
  lines.push(
    `Source: ${scored.source}${scored.seed ? ` (${scored.seed})` : ""}`,
  );
  lines.push("");
  add("Artist affinity", s.artistAffinity * WEIGHTS.artistAffinity);
  add("Like affinity", s.likeScore * WEIGHTS.likeScore);
  add("Listening history", s.historyScore * WEIGHTS.historyScore);
  add("Recent listening", s.recencyScore * WEIGHTS.recencyScore);
  add("Completion", s.completionScore * WEIGHTS.completionScore);
  add("Playlist", s.playlistScore * WEIGHTS.playlistScore);
  add("Discovery", s.discoveryScore * WEIGHTS.discoveryScore);
  if (s.familiarityAdjustment)
    add(
      s.familiarityAdjustment >= 0 ? "Familiarity" : "Exploration",
      s.familiarityAdjustment * WEIGHTS.artistAffinity,
    );
  if (s.skipPenalty) add("Skip penalty", s.skipPenalty * WEIGHTS.skipPenalty);
  if (s.recentPlayPenalty)
    add("Recently played", s.recentPlayPenalty * WEIGHTS.recentPlayPenalty);
  if (s.diversityAdjustment) add("Diversity adjustment", s.diversityAdjustment);
  lines.push("");
  lines.push(`Final score: ${s.finalScore.toFixed(3)}`);
  lines.push(`Reason: ${scored.reason}`);
  return lines.join("\n");
}
