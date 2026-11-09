/**
 * Recommendation server layer.
 *
 * Responsibilities, and deliberately nothing else:
 *   - `signals` : a cheap reactive QUERY returning the listener's raw
 *                 signals. Convex queries cannot make network calls and have
 *                 a read budget, so this does bounded reads and no I/O.
 *   - `forYou` / `nextTrack` : ACTIONS that do the network work (upstream
 *                 searches) and then hand everything to the pure pipeline in
 *                 `src/lib/recommend.ts`. Home and autoplay both call in here,
 *                 so there is exactly ONE scoring implementation in the app.
 *   - feedback + debug.
 *
 * It deliberately does NOT own listening history: plays, likes, playlists and
 * engagement all live in the existing `history` / `likes` / `playlists` tables.
 * This file only reads them.
 */

import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { action, mutation, query, type ActionCtx } from "./_generated/server";
import { api } from "./_generated/api";
import {
  adaptiveTuning,
  buildSeeds,
  buildSignals,
  explainCandidate,
  pickNextTrack,
  rankCandidates,
  scoreCandidate,
  type CandidateSeed,
  type PlaySignal,
  type PlaylistSignal,
  type RecoCandidate,
  type RecoReason,
  type Signals,
  type Tuning,
  DEFAULT_EXPLORATION,
  type UserSignals,
} from "../lib/recommend";
import type { YtItem } from "./youtube";
// Relative, not the `@/` alias: the Convex bundler does not resolve it.
import { applyExclusions, mergeExtra, poolIds } from "../lib/recoMerge";
import {
  allocateWithBudget,
  blendDiscovery,
  discoveryAnchors,
  excludeAnchors,
  DISCOVERY_ARTIST_CAP,
  DISCOVERY_LIMIT,
} from "../lib/recoBalance";
import { NO_EXCLUSIONS, type Exclusions } from "../lib/notInterested";
import {
  jamendoDiscoveryQueries,
  isResolvableDiscovery,
  resolveDiscoveries,
  type DiscoveryCandidate,
  type DiscoveryTrack,
} from "../lib/jamendoDiscovery";
import { VECTOR_SEED } from "./recommendVectors";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** How long a Home payload may be reused before it is recomputed. */
const CACHE_TTL_MS = 10 * 60 * 1000;
/**
 * Cache identity for a Home payload.
 *
 * The discovery-vs-familiarity preference is PART of the key, bucketed rather
 * than exact. Without this, moving the slider would keep serving the payload
 * that was cached for the old setting — the control would look broken for ten
 * minutes. Bucketing to 20 keeps the cache small (six entries at most) while
 * still feeling immediate.
 */
function cacheKeyFor(exploration: number | undefined): string {
  const value =
    typeof exploration === "number" && Number.isFinite(exploration)
      ? Math.min(100, Math.max(0, exploration))
      : DEFAULT_EXPLORATION;
  return `home:v1:${Math.round(value / 20)}`;
}
/** Hard ceilings on read volume, so a heavy listener cannot blow the budget. */
const MAX_SIGNAL_ROWS = 200;
const MAX_LIKES = 100;
const MAX_PLAYLISTS = 25;
const MAX_FEEDBACK_ROWS = 100;
/**
 * Upstream searches per recommendation request.
 *
 * Six, raised from four. With four seeds and a discovery reservation, a
 * listener whose profile held three artists could only ever see two of them
 * on the whole page — the funnel was narrower than the taste it described.
 */
const MAX_SEEDS = 6;

/**
 * How many cards one shelf may show, and how many candidates it is ranked
 * from. The pool is deliberately larger than the shelf: the Home coordinator
 * spends from these pools and needs alternates when an artist is already at
 * its page-wide budget.
 */
const PER_SECTION = 14;
const PER_SECTION_POOL = 26;

/** Below this a shelf is dropped instead of rendered as a stub. */
const MIN_PER_SECTION = 4;

/**
 * Evidence before Home may call a row personalised.
 *
 * Eight-ish interactions. Below it the cards still render, but the row is
 * labelled as popular picks rather than claiming a taste the data cannot show.
 */
const PERSONALISED_CONFIDENCE = 0.35;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const candidateValidator = v.object({
  id: v.string(),
  title: v.string(),
  artist: v.string(),
  duration: v.number(),
  thumbnail: v.string(),
  album: v.optional(v.string()),
});

/** The section ids the Home page renders, in display order. */
const SECTION_IDS = [
  "for_you",
  "because_you_listened",
  "based_on_likes",
  "from_artists",
  "discover",
  "sound_alike",
] as const;

type SectionId = (typeof SECTION_IDS)[number];

interface SectionPayload {
  id: SectionId;
  title: string;
  subtitle: string;
  items: RecoCandidate[];
  /** False when the row is filled from global discovery (cold listener). */
  personalised: boolean;
}

interface ForYouPayload {
  sections: SectionPayload[];
}

interface NextTrackPayload {
  track: RecoCandidate | null;
  reason: RecoReason | null;
  explanation: string | null;
}

interface ResolvedPool {
  items: RecoCandidate[];
  seedByTrackId: Map<string, CandidateSeed>;
  seeds: CandidateSeed[];
}

const EMPTY_SIGNALS: UserSignals = {
  userId: null,
  plays: [],
  likes: [],
  playlists: [],
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function toCandidate(item: YtItem): RecoCandidate {
  return {
    id: item.id,
    title: item.title,
    artist: item.artist,
    duration: item.duration,
    thumbnail: item.thumbnail,
    // Left undefined when the source had no album. Never defaulted to a
    // placeholder: "unknown album" and "album named Single" must not look
    // the same to the diversity pass.
    ...(item.album ? { album: item.album } : {}),
  };
}

/**
 * How much of a track the listener actually heard, as an engine play.
 *
 * `skipped`/`removed` are real rejections; anything else is a positive signal
 * scaled by how completely the track was played.
 */
function feedbackToPlay(row: {
  trackId: string;
  artistName?: string;
  origin?: string;
  settledAt: number;
  outcome: string;
}): PlaySignal {
  const origin: PlaySignal["origin"] =
    row.origin === "autoplay"
      ? "autoplay"
      : row.origin === "radio"
        ? "radio"
        : "recommendation";
  const base = {
    trackId: row.trackId,
    artistName: row.artistName,
    at: row.settledAt,
    origin,
  };
  if (row.outcome === "removed" || row.outcome === "skipped") {
    return { ...base, skipped: true, listenedSeconds: 4 };
  }
  const completion =
    row.outcome === "completed" ? 1 : row.outcome === "played" ? 0.5 : 0.4;
  return { ...base, completion };
}

/**
 * Which candidate sources may legitimately feed each section.
 *
 * This is what stops a card from claiming a reason it cannot support: a track
 * discovered by a "new songs like X" search is never rendered in a row that
 * says "Based on your likes".
 */
function seedsForSection(section: SectionId, seeds: CandidateSeed[]) {
  switch (section) {
    case "for_you": {
      // Exploration is not taste evidence. The broad seed asks the provider
      // for a genre it has never seen a single play from, so ranking it into
      // "Recommended for you" both mislabels it and — because this row is
      // served first — spends the material Discover needs, which is how the
      // page ended up with one row full of generic songs and no discovery row
      // at all. Cold start is the exception: there "popular songs" is the
      // only seed there is, and an honest generic row beats a blank page.
      const familiar = seeds.filter((s) => s.source !== "broad_discovery");
      return familiar.length > 0 ? familiar : seeds;
    }
    case "because_you_listened":
      return seeds.filter(
        (s) => s.source === "history" || s.source === "artists",
      );
    case "based_on_likes":
      return seeds.filter((s) => s.source === "likes");
    case "from_artists":
      return seeds.filter((s) => s.source === "artists");
    case "discover":
      // The broad seed belongs here too: it is a discovery source, not a
      // fallback, and the row blends it with the related results rather than
      // showing it in place of them.
      return seeds.filter(
        (s) =>
          s.source === "discovery" ||
          s.source === "jamendo_discovery" ||
          s.source === "broad_discovery",
      );
    case "sound_alike":
      // Only the vector seed. Without this the row would be populated by the
      // same text-search candidates as every other row, and the title would be
      // claiming a sound-alike search that never happened.
      return seeds.filter((s) => s.source === "vector_sound_alike");
    default:
      return [];
  }
}

/**
 * How much real data each row needs before it is shown.
 *
 * A "Based on Your Likes" row for a listener with two likes is not
 * personalisation, it is noise — and it is dishonest, because the reasons on
 * those cards would be claiming a connection the data does not support.
 */
const MIN_LIKES = 3;
const MIN_PLAYS = 3;
const MIN_ARTISTS = 2;

function sectionEligibility(
  built: Signals,
  userSignals: UserSignals,
): Record<SectionId, boolean> {
  const realPlays = userSignals.plays.filter((p) => !p.skipped).length;
  const artistsWithPlays = [...built.artists.values()].filter(
    (p) => p.plays > 0,
  ).length;
  return {
    // "Recommended for You" always renders: for a cold listener it is filled
    // from global discovery, which is a real answer rather than a blank row.
    for_you: true,
    because_you_listened: realPlays >= MIN_PLAYS,
    based_on_likes: userSignals.likes.length >= MIN_LIKES,
    from_artists: artistsWithPlays >= MIN_ARTISTS,
    // Discovery stays visible as soon as there is any profile at all — but
    // what FILLS it is now protected: the anchors are excluded, one artist
    // may hold one card, and the row is blended with broad exploration. The
    // row is not hidden from a thin-evidence listener; it stops pretending to
    // know them (see the `personalised` flag below).
    discover: built.personalised,
    // The sound-alike row needs RECENT PLAYS, not plays in general: it is
    // built by asking the vector index "what is near what I just played", so
    // with no recent plays there is nothing to be near. Gating on a total
    // count instead would show the row to a listener whose last play was
    // months ago, populated by similarity to a stale session.
    sound_alike: realPlays >= MIN_PLAYS,
  };
}

const SECTION_META: Record<SectionId, { title: string; subtitle: string }> = {
  for_you: {
    title: "Recommended for you",
    subtitle: "Picked from what you actually play, like and skip.",
  },
  because_you_listened: {
    title: "Because you listened to",
    subtitle: "Drawn from the artists you keep coming back to.",
  },
  based_on_likes: {
    title: "Based on your likes",
    subtitle: "More from the artists you saved.",
  },
  from_artists: {
    title: "From artists you listen to",
    subtitle: "Straight from your most-played artists.",
  },
  discover: {
    title: "Discover something new",
    subtitle: "Near your taste, but not in your history yet.",
  },
  sound_alike: {
    title: "Sounds like what you play",
    subtitle: "Matched by sound, from your own library.",
  },
};

// ---------------------------------------------------------------------------
// signals — cheap reactive query
// ---------------------------------------------------------------------------

/**
 * The listener's raw signals, as the engine's `UserSignals`.
 *
 * Bounded on every axis. The derived `trackSignals` rows make this cheap: the
 * engine needs per-track skip counts and completion ratios, and recomputing
 * those by scanning the append-only `playEvents` log would mean reading a
 * heavy listener's entire history on every Home render.
 *
 * Returns null for signed-out visitors rather than throwing — Home then
 * renders its public/discovery layout instead of an error.
 */
export const signals = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;

    const signalRows = await ctx.db
      .query("trackSignals")
      .withIndex("by_user_lastPlayedAt", (q) => q.eq("userId", userId))
      .order("desc")
      .take(MAX_SIGNAL_ROWS);

    const plays: PlaySignal[] = [];
    for (const row of signalRows) {
      // A track with N plays contributes at most 3 play entries: enough to
      // represent a pattern without letting one repeat-heavy track dominate
      // the whole profile. The completion ratio is measured only over plays
      // that actually reached an outcome, so a session that ended mid-song
      // cannot drag the average down.
      const ratio =
        row.settledPlays > 0 ? row.completionSum / row.settledPlays : undefined;
      const playCount = Math.min(row.plays, 3);
      for (let i = 0; i < playCount; i += 1) {
        plays.push({
          trackId: row.trackId,
          artistName: row.artistName,
          albumName: row.albumName,
          at: row.lastPlayedAt,
          completion: ratio,
        });
      }
      const skipCount = Math.min(row.skips, 3);
      for (let i = 0; i < skipCount; i += 1) {
        plays.push({
          trackId: row.trackId,
          artistName: row.artistName,
          at: row.lastPlayedAt,
          skipped: true,
          listenedSeconds: 3,
        });
      }
    }

    // Catalog likes and remote likes are separate tables upstream; both are
    // real likes, so both are read. `likedSongs` carries no metadata of its own.
    const remoteLikes = await ctx.db
      .query("likedRemote")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(MAX_LIKES);
    const catalogLikes = await ctx.db
      .query("likedSongs")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(MAX_LIKES);

    const likes = [
      ...remoteLikes.map((row) => ({
        trackId: row.trackId,
        artistName: row.artistName,
        at: row.createdAt,
      })),
      ...catalogLikes.map((row) => ({
        trackId: row.trackId,
        at: row.createdAt,
      })),
    ];

    const playlistRows = await ctx.db
      .query("playlists")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(MAX_PLAYLISTS);
    const playlists: PlaylistSignal[] = playlistRows.map((row) => ({
      name: row.name,
      updatedAt: row.updatedAt,
      tracks: (row.trackSnapshots ?? []).map((snap) => ({
        trackId: snap.id,
        artistName: snap.artist,
        albumName: snap.album,
      })),
    }));

    // Feedback loop (phase 14): settled recommendation outcomes are real
    // listening behaviour and must feed the next ranking. Unsettled rows are
    // ignored — an unplayed recommendation is not evidence of anything.
    const feedbackRows = await ctx.db
      .query("recommendationEvents")
      .withIndex("by_user_createdAt", (q) => q.eq("userId", userId))
      .order("desc")
      .take(MAX_FEEDBACK_ROWS);
    for (const row of feedbackRows) {
      if (!row.outcome || !row.settledAt) continue;
      plays.push(
        feedbackToPlay({
          trackId: row.trackId,
          artistName: row.artistName,
          origin: row.origin,
          settledAt: row.settledAt,
          outcome: row.outcome,
        }),
      );
    }

    plays.sort((a, b) => b.at - a.at);
    return {
      userId,
      plays: plays.slice(0, 600),
      likes,
      playlists,
    };
  },
});

/**
 * Recent-play timestamps for the "played too recently" penalty.
 * Split out because `signals` already returns the rows; this only exposes the
 * small projection so callers do not have to re-derive it.
 */
export const recentPlayTimes = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const rows = await ctx.db
      .query("trackSignals")
      .withIndex("by_user_lastPlayedAt", (q) => q.eq("userId", userId))
      .order("desc")
      .take(MAX_SIGNAL_ROWS);
    return rows.map((row) => ({ trackId: row.trackId, at: row.lastPlayedAt }));
  },
});

// ---------------------------------------------------------------------------
// Candidate resolution
// ---------------------------------------------------------------------------

async function searchOnce(ctx: ActionCtx, seed: CandidateSeed) {
  try {
    const res = await ctx.runAction(api.youtube.searchYoutube, {
      query: seed.query,
    });
    return (res?.items ?? []) as YtItem[];
  } catch {
    // One failed upstream search must not take down the whole request.
    return [] as YtItem[];
  }
}

/**
 * Resolve candidate tracks for a set of seeds, reusing the EXISTING search
 * action rather than reimplementing InnerTube parsing.
 */
async function resolvePool(
  ctx: ActionCtx,
  seeds: CandidateSeed[],
  excludeIds: Set<string>,
): Promise<ResolvedPool> {
  const batches = await Promise.all(
    seeds.map(async (seed) => ({ seed, items: await searchOnce(ctx, seed) })),
  );

  const items: RecoCandidate[] = [];
  const seedByTrackId = new Map<string, CandidateSeed>();
  for (const batch of batches) {
    for (const item of batch.items) {
      if (!item || !item.id) continue;
      if (excludeIds.has(item.id)) continue;
      if (seedByTrackId.has(item.id)) continue;
      const candidate = toCandidate(item);
      // Drop anything unplayable before it reaches scoring, so "unavailable"
      // never has to be second-guessed downstream.
      if (!candidate.title.trim() || candidate.duration <= 0) continue;
      items.push(candidate);
      seedByTrackId.set(candidate.id, batch.seed);
    }
  }
  return { items, seedByTrackId, seeds };
}

/**
 * The listener's "not interested" set, or an empty one.
 *
 * Never throws: an exclusion set that fails to load must not take the
 * recommendations down with it, and NO_EXCLUSIONS degrades to exactly the
 * behaviour the app had before the feature existed.
 */
async function loadExclusions(ctx: ActionCtx): Promise<Exclusions> {
  try {
    const row = await ctx.runQuery(api.notInterested.exclusions, {});
    return row ?? NO_EXCLUSIONS;
  } catch {
    return NO_EXCLUSIONS;
  }
}

/**
 * Vector-derived candidates, fetched but NOT yet merged.
 *
 * Returns an empty array rather than throwing in every failure case, because
 * the recommender must be exactly as good as it was before the vector database
 * existed. Two are worth naming: a library that was never indexed (the normal
 * state for a new account) and a failure inside the vector store. In both
 * cases `mergeExtra` declines to add anything and the pool is left alone.
 */
async function fetchVectorCandidates(
  ctx: ActionCtx,
  args: {
    recentPlays: Array<{ trackId: string; at: number }>;
    excludeIds: Set<string>;
  },
): Promise<RecoCandidate[]> {
  // Seed from the most RECENT plays rather than the most liked: "what does
  // this sound like" is a question about now, and a listener whose taste moved
  // on six months ago should not keep getting their old self back.
  const seedTrackIds = args.recentPlays
    .slice()
    .sort((a, b) => b.at - a.at)
    .map((entry) => entry.trackId);
  if (seedTrackIds.length === 0) return [];

  try {
    const result = await ctx.runAction(api.recommendVectors.vectorCandidates, {
      seedTrackIds,
      excludeIds: [...args.excludeIds],
      limit: 24,
    });
    return result?.candidates ?? [];
  } catch {
    // The vector index is an enhancement, never a dependency.
    return [];
  }
}

/**
 * The candidate seed for one Jamendo discovery query.
 *
 * A seed, not a track — Jamendo tells us WHAT to listen to, YouTube resolves
 * WHERE it plays. The `discovery` section is the only one allowed to render
 * these, so the card's wording ("Discover something new") stays true.
 */
function jamendoDiscoverySeed(query: string): CandidateSeed {
  return {
    query,
    source: "jamendo_discovery",
    weight: 0.5,
    seed: query,
    reason: "discovery",
  };
}

/**
 * How many Jamendo hits are carried through to a YouTube lookup.
 *
 * Every hit costs an extra upstream search, so this is deliberately small.
 * Jamendo is an enhancement to the "Discover" row, never a dependency: if any
 * of this fails, the row is simply the row it always was.
 *
 * The number is 4 rather than 2 because roughly HALF of Jamendo hits do not
 * resolve — measured live against the deployment, 2 of 4 independent releases
 * had no genuine YouTube upload and were correctly dropped rather than
 * substituted. Two attempts therefore usually yielded nothing at all.
 */
const MAX_JAMENDO_HITS = 4;

/**
 * Jamendo discovery, resolved into playable YouTube candidates.
 *
 * Fetches Jamendo for the listener's strongest artists, takes the top few
 * independent releases, looks each one up on YouTube and returns only the
 * ones that genuinely resolved. Returns [] in every failure case — an
 * unconfigured key, a rate limit, an upstream outage — because a Home page
 * that renders nothing because a bonus source was unreachable is a far worse
 * outcome than a Home page without the bonus row.
 */
async function fetchJamendoDiscovery(
  ctx: ActionCtx,
  args: { artistNames: string[]; excludeIds: Set<string> },
): Promise<Array<{ item: RecoCandidate; seed: CandidateSeed }>> {
  const queries = jamendoDiscoveryQueries(args.artistNames);
  if (queries.length === 0) return [];

  const discovered: DiscoveryTrack[] = [];
  const seedsByJamendoId = new Map<string, CandidateSeed>();
  try {
    const results = await Promise.all(
      queries.map(async (query) => ({
        query,
        result: await ctx.runAction(api.jamendo.searchJamendo, {
          query,
          limit: MAX_JAMENDO_HITS,
        }),
      })),
    );
    for (const { query, result } of results) {
      if (!result?.ok) continue;
      const seed = jamendoDiscoverySeed(query);
      for (const track of result.tracks) {
        if (discovered.length >= MAX_JAMENDO_HITS) break;
        if (!isResolvableDiscovery(track)) continue;
        discovered.push(track);
        seedsByJamendoId.set(track.jamendoId, seed);
      }
    }
  } catch {
    return [];
  }
  if (discovered.length === 0) return [];

  // Resolve each hit to a real YouTube upload. A hit that does not resolve
  // is dropped here rather than surfaced: it can never play.
  let resolved: Array<{
    jamendoId: string;
    ytId: string;
    title: string;
    artist: string;
    score: number;
  }>;
  // Every YouTube item seen across the lookups, so a resolved hit can be
  // rebuilt into a real candidate with its actual duration and artwork
  // instead of a stub.
  const allItems = new Map<string, YtItem>();
  try {
    const searches = await Promise.all(
      discovered.map(async (track) => ({
        track,
        items: await searchOnce(ctx, {
          query: `${track.title} ${track.artistName}`.trim(),
          source: "jamendo_discovery",
          weight: 0.5,
          seed: null,
          reason: "discovery",
        }),
      })),
    );
    for (const { items } of searches) {
      for (const raw of items) {
        if (raw?.id) allItems.set(raw.id, raw);
      }
    }
    resolved = resolveDiscoveries(
      discovered,
      new Map(
        searches.map(({ track, items }) => [
          track.jamendoId,
          items as DiscoveryCandidate[],
        ]),
      ),
    );
  } catch {
    return [];
  }

  const out: Array<{ item: RecoCandidate; seed: CandidateSeed }> = [];
  const seen = new Set<string>();
  for (const hit of resolved) {
    if (args.excludeIds.has(hit.ytId)) continue;
    if (seen.has(hit.ytId)) continue;
    seen.add(hit.ytId);
    const sourceItem = allItems.get(hit.ytId);
    if (!sourceItem) continue;
    const item = toCandidate(sourceItem);
    if (!item.title.trim() || item.duration <= 0) continue;
    out.push({
      item,
      seed:
        seedsByJamendoId.get(hit.jamendoId) ?? jamendoDiscoverySeed(hit.title),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Section assembly
// ---------------------------------------------------------------------------

function buildSections(
  pool: ResolvedPool,
  built: Signals,
  eligible: Record<SectionId, boolean>,
  now: number,
  recentPlays: Array<{ trackId: string; at: number }>,
  excludeIds: Set<string>,
  tuning: Tuning,
): SectionPayload[] {
  // ── 1. Rank each shelf's own pool ─────────────────────────────────────────
  // Per-shelf at this stage, because "the best track for this row" is a
  // different question from "the best tracks for the page". Each row is ranked
  // generously, and WITHOUT a per-artist cap: the coordinator below needs
  // alternates to spend when an artist has already used its page-wide budget,
  // and a cap applied twice would just hide them.
  const pools = new Map<SectionId, RecoCandidate[]>();
  for (const id of SECTION_IDS) {
    if (!eligible[id]) continue;

    const allowed = new Set(
      seedsForSection(id, pool.seeds).map((s) => s.seed ?? s.query),
    );
    const candidates = pool.items.filter((item) => {
      const seed = pool.seedByTrackId.get(item.id);
      if (!seed) return false;
      return allowed.has(seed.seed ?? seed.query);
    });
    if (candidates.length === 0) continue;

    const ranked = rankCandidates(candidates, built, pool.seeds, {
      now,
      limit: PER_SECTION_POOL,
      // Only the hard excludes here. Cross-shelf de-duplication belongs to the
      // coordinator, which is the only thing that can see every row at once.
      excludeIds,
      recentPlays,
      seedByTrackId: pool.seedByTrackId,
      maxPerArtist: PER_SECTION_POOL,
      maxPerAlbum: PER_SECTION_POOL,
      tuning,
    });
    if (ranked.length > 0) {
      pools.set(
        id,
        ranked.map((entry) => ({ ...entry.track, reason: entry.reason })),
      );
    }
  }

  // ── 2. Discovery is a blend, and never anchored on its own source ────────
  // The provider answers "new songs like <artist>" with that artist's own
  // catalogue often enough that filtering the SEED is not sufficient: the
  // anchor has to be filtered out of the RESULTS. Whatever survives is then
  // blended with sound-alike and broad candidates, so no single search can
  // define the row.
  const discoverPool = pools.get("discover") ?? [];
  const anchors = discoveryAnchors(built.artists.values(), 3);
  const related: RecoCandidate[] = [];
  const adjacent: RecoCandidate[] = [];
  const broad: RecoCandidate[] = [];
  for (const item of discoverPool) {
    const seed = pool.seedByTrackId.get(item.id);
    if (seed?.source === "vector_sound_alike") adjacent.push(item);
    else if (seed?.source === "broad_discovery") broad.push(item);
    else related.push(item);
  }
  const discovery = blendDiscovery(
    {
      related: excludeAnchors(related, anchors),
      adjacent: excludeAnchors(adjacent, anchors),
      broad,
    },
    {
      limit: DISCOVERY_LIMIT,
      maxPerArtist: DISCOVERY_ARTIST_CAP,
      reserved: excludeIds,
    },
  );

  // ── 3. One coordinator for the whole page ────────────────────────────────
  const ordered: Array<{ id: SectionId; pool: RecoCandidate[] }> = [];
  for (const id of SECTION_IDS) {
    if (id === "discover") {
      if (discovery.length > 0) ordered.push({ id, pool: discovery });
      continue;
    }
    const items = pools.get(id);
    if (items && items.length > 0) ordered.push({ id, pool: items });
  }

  const allocated = allocateWithBudget(ordered, {
    perSection: PER_SECTION,
    minPerSection: MIN_PER_SECTION,
    // Four tracks by one artist across the ENTIRE page. Enough for a genuine
    // favourite to show up more than once, never enough to own Home.
    maxPerArtistTotal: 4,
    sectionArtistCap: {
      for_you: 3,
      because_you_listened: 2,
      based_on_likes: 2,
      from_artists: 2,
      sound_alike: 2,
      discover: DISCOVERY_ARTIST_CAP,
    },
    // The headline row may honestly show three; a three-card discovery row
    // would just look broken.
    sectionMin: { for_you: 3 },
    reserved: excludeIds,
  });

  const sections: SectionPayload[] = [];
  for (const section of allocated) {
    if (section.items.length === 0) continue;
    const id = section.id as SectionId;
    const meta = SECTION_META[id];
    sections.push({
      id,
      title: meta.title,
      subtitle: meta.subtitle,
      // A row may only call itself personalised when the profile has the
      // evidence behind it. The cards still render either way; only the claim
      // is withheld, which is what the Home subtitle switches on.
      personalised:
        id === "for_you" || id === "discover"
          ? built.confidence >= PERSONALISED_CONFIDENCE
          : true,
      items: section.items,
    });
  }

  return sections;
}

// ---------------------------------------------------------------------------
// forYou — Home recommendation payload
// ---------------------------------------------------------------------------

/**
 * The Home page's personalised rows.
 *
 * Fallback order is explicit and total: PERSONALISED → RELATED → DISCOVERY →
 * GLOBAL. A failure at any level degrades the payload, it never throws — Home
 * must keep working when an upstream search or the cache is down.
 */
export const forYou = action({
  args: {
    force: v.optional(v.boolean()),
    /**
     * The listener's discovery-vs-familiarity preference, 0..100. It is a
     * device-local setting, so it travels with the request rather than living
     * in the database — nothing about a private preference is stored server
     * side.
     */
    exploration: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<ForYouPayload> => {
    const userId = await getAuthUserId(ctx);
    const now = Date.now();
    const cacheKey = cacheKeyFor(args.exploration);

    // ---- cache ------------------------------------------------------
    if (userId && !args.force) {
      try {
        const hit = await ctx.runQuery(api.recommend.cacheGet, {
          key: cacheKey,
        });
        if (hit) return hit as ForYouPayload;
      } catch {
        /* a cache miss must never be fatal */
      }
    }

    // ---- signals ----------------------------------------------------
    let userSignals = EMPTY_SIGNALS;
    try {
      userSignals =
        (await ctx.runQuery(api.recommend.signals, {})) ?? EMPTY_SIGNALS;
    } catch {
      userSignals = EMPTY_SIGNALS;
    }

    // Adaptive tuning: the stated preference, corrected by how the listener
    // actually responds to what the engine recommends (see `adaptiveTuning`).
    const tuning = adaptiveTuning(args.exploration, userSignals.plays);
    const built = buildSignals(userSignals, now);
    const eligible = sectionEligibility(built, userSignals);

    // ---- candidates -------------------------------------------------
    const seeds = buildSeeds(built, userSignals, {
      maxSeeds: MAX_SEEDS,
      tuning,
      // Rotates the broad exploration search once a day, so the floor of the
      // discovery row is not the same handful of songs on every visit.
      broadOffset: Math.floor(now / 86_400_000),
    });
    const recentPlays: Array<{ trackId: string; at: number }> = [];
    try {
      const times = await ctx.runQuery(api.recommend.recentPlayTimes, {});
      recentPlays.push(...((times ?? []) as typeof recentPlays));
    } catch {
      /* recency info is a bonus, not a requirement */
    }
    const excludeIds = new Set(recentPlays.map((entry) => entry.trackId));

    let pool = await resolvePool(ctx, seeds, excludeIds);

    // ---- "Not interested" -----------------------------------------
    // Applied to the resolved pool rather than baked into the seeds: a seed is
    // a search string and a rejection is about a specific track or artist, so
    // filtering after resolution is the only place both can be honoured.
    const exclusions = await loadExclusions(ctx);
    if (pool.items.length > 0) {
      pool = { ...pool, items: applyExclusions(pool.items, exclusions) };
    }

    // ---- vector candidates ----------------------------------------
    // Merged in AFTER the text-search pool so these are genuinely additional
    // candidates rather than a re-ranking of the same ones. The whole call is
    // best-effort: a cold or missing vector index returns nothing and the row
    // is simply absent, which is the correct behaviour for a feature that
    // depends on the listener having indexed a library.
    const vectorCandidates = await fetchVectorCandidates(ctx, {
      recentPlays,
      excludeIds,
    });
    const merged = mergeExtra(pool.items, vectorCandidates, exclusions);
    if (merged) {
      pool = {
        items: merged.pool,
        seedByTrackId: new Map([
          ...pool.seedByTrackId,
          ...merged.usable.map((c) => [c.id, VECTOR_SEED] as const),
        ]),
        seeds: [...pool.seeds, VECTOR_SEED],
      };
    }

    // ---- Jamendo discovery ----------------------------------------
    // Jamendo is a DISCOVERY index here, never a playback source: it names
    // independent Creative Commons releases, and each one is resolved to a
    // real YouTube upload before it can be offered. Anything that fails to
    // resolve is dropped inside the fetch, so this can never add a dead
    // track to a row.
    const artistNames = [...built.artists.values()]
      .sort((a, b) => b.affinity - a.affinity)
      .map((a) => a.display);
    const jamendoPicks = await fetchJamendoDiscovery(ctx, {
      artistNames,
      excludeIds,
    });
    if (jamendoPicks.length > 0) {
      const known = poolIds(pool.items);
      const fresh = jamendoPicks.filter((pick) => !known.has(pick.item.id));
      const merged = mergeExtra(
        pool.items,
        fresh.map((p) => p.item),
        exclusions,
      );
      if (merged) {
        const seedById = new Map(jamendoPicks.map((p) => [p.item.id, p.seed]));
        pool = {
          items: merged.pool,
          seedByTrackId: new Map([
            ...pool.seedByTrackId,
            ...[...seedById].filter(([id]) => !known.has(id)),
          ]),
          seeds: [
            ...pool.seeds,
            ...jamendoPicks
              .filter((p) => !known.has(p.item.id))
              .map((p) => p.seed),
          ],
        };
      }
    }

    // RELATED fallback: the personalised seeds came back empty. Ask for
    // something adjacent rather than dropping straight to global charts.
    if (pool.items.length === 0 && built.personalised) {
      const ranked = [...built.artists.values()].sort(
        (a, b) => b.affinity - a.affinity,
      );
      const top = ranked[0];
      const related: CandidateSeed[] = top
        ? [
            {
              query: `artists similar to ${top.display}`,
              source: "related_to_current",
              weight: 0.8,
              seed: `related:${top.key}`,
              reason: "similar_song",
            },
          ]
        : [];
      pool = await resolvePool(ctx, related, excludeIds);
    }

    // DISCOVERY / GLOBAL fallback: no taste at all yet, or every personalised
    // search failed. buildSeeds already emits this exact seed for cold
    // listeners; re-resolving here covers the "personalised but the network
    // failed" case.
    if (pool.items.length === 0) {
      const global: CandidateSeed[] = [
        {
          query: "popular songs",
          source: "global",
          weight: 1,
          seed: null,
          reason: "global_fallback",
        },
      ];
      pool = await resolvePool(ctx, global, excludeIds);
    }

    const payload: ForYouPayload = {
      sections: buildSections(
        pool,
        built,
        eligible,
        now,
        recentPlays,
        excludeIds,
        tuning,
      ),
    };

    if (userId) {
      try {
        await ctx.runMutation(api.recommend.cachePut, {
          key: cacheKey,
          payload,
        });
      } catch {
        /* caching is best-effort */
      }
    }
    return payload;
  },
});

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export const cacheGet = query({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    // The row is looked up by the CALLER's own id, so this can never leak
    // another listener's cached recommendations.
    const row = await ctx.db
      .query("recommendationCache")
      .withIndex("by_user_key", (q) =>
        q.eq("userId", userId).eq("key", args.key),
      )
      .first();
    if (!row) return null;
    if (row.expiresAt <= Date.now()) return null;
    return row.payload;
  },
});

export const cachePut = mutation({
  args: { key: v.string(), payload: v.any() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return;
    const existing = await ctx.db
      .query("recommendationCache")
      .withIndex("by_user_key", (q) =>
        q.eq("userId", userId).eq("key", args.key),
      )
      .first();
    const now = Date.now();
    const expiresAt = now + CACHE_TTL_MS;
    if (existing) {
      await ctx.db.patch(existing._id, {
        payload: args.payload,
        computedAt: now,
        expiresAt,
      });
      return;
    }
    await ctx.db.insert("recommendationCache", {
      userId,
      key: args.key,
      payload: args.payload,
      computedAt: now,
      expiresAt,
    });
  },
});

/** Drop the listener's cached Home payload so the next load recomputes. */
export const invalidateCache = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return;
    const rows = await ctx.db
      .query("recommendationCache")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
  },
});

// ---------------------------------------------------------------------------
// nextTrack — the SAME engine, for autoplay and "what plays next"
// ---------------------------------------------------------------------------

const NOTHING: NextTrackPayload = {
  track: null,
  reason: null,
  explanation: null,
};

/**
 * Pick the best next track.
 *
 * The caller passes the live queue so the engine can refuse anything already
 * scheduled, including Play Next items and manually added tracks. Returns null
 * rather than throwing when nothing can be found; the player then keeps its
 * existing related-mix path, so a recommendation failure can never stop audio.
 */
export const nextTrack = action({
  args: {
    /** Every id in the queue, including Play Next. */
    queueIds: v.array(v.string()),
    currentTrack: v.optional(candidateValidator),
    /** Set when the queue is empty and autoplay is driving. */
    autoplay: v.optional(v.boolean()),
    /** > 1 returns a ranked list for the smart future queue. */
    limit: v.optional(v.number()),
    /** The listener's discovery-vs-familiarity preference, 0..100. */
    exploration: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<NextTrackPayload> => {
    const now = Date.now();
    try {
      const excludeIds = new Set<string>(args.queueIds);
      const userSignals =
        (await ctx.runQuery(api.recommend.signals, {})) ?? EMPTY_SIGNALS;
      // The SAME tuning the Home shelves use: "what plays next" must not
      // quietly disagree with what the listener was just shown.
      // Adaptive tuning: the stated preference, corrected by how the listener
    // actually responds to what the engine recommends (see `adaptiveTuning`).
    const tuning = adaptiveTuning(args.exploration, userSignals.plays);
      const built = buildSignals(userSignals, now);
      const current = args.currentTrack ?? null;
      const seeds = buildSeeds(built, userSignals, {
        maxSeeds: MAX_SEEDS,
        currentTrack: current,
        tuning,
      });
      let pool = await resolvePool(ctx, seeds, excludeIds);

      let recentPlays: Array<{ trackId: string; at: number }> = [];
      try {
        const times = await ctx.runQuery(api.recommend.recentPlayTimes, {});
        recentPlays = (times ?? []) as typeof recentPlays;
      } catch {
        /* optional */
      }

      // The same two corrections Home gets, so "what plays next" cannot
      // contradict the shelves: a rejected track or artist stays out of
      // autoplay, and a sound-alike from the vector index is a legitimate
      // candidate here too.
      const exclusions = await loadExclusions(ctx);
      if (pool.items.length > 0) {
        pool = { ...pool, items: applyExclusions(pool.items, exclusions) };
      }
      const vectorCandidates = await fetchVectorCandidates(ctx, {
        recentPlays,
        excludeIds,
      });
      const merged = mergeExtra(pool.items, vectorCandidates, exclusions);
      if (merged) {
        pool = {
          items: merged.pool,
          seedByTrackId: new Map([
            ...pool.seedByTrackId,
            ...merged.usable.map((c) => [c.id, VECTOR_SEED] as const),
          ]),
          seeds: [...pool.seeds, VECTOR_SEED],
        };
      }
      if (pool.items.length === 0) return NOTHING;

      const limit = args.limit && args.limit > 1 ? args.limit : 1;
      const best =
        limit > 1
          ? (rankCandidates(pool.items, built, pool.seeds, {
              now,
              limit,
              excludeIds,
              currentTrackId: current ? current.id : null,
              currentTrack: current,
              recentPlays,
              seedByTrackId: pool.seedByTrackId,
              maxPerArtist: 2,
              maxPerAlbum: 3,
              tuning,
            })[0] ?? null)
          : pickNextTrack(pool.items, built, pool.seeds, {
              now,
              limit: 1,
              excludeIds,
              currentTrackId: current ? current.id : null,
              currentTrack: current,
              recentPlays,
              seedByTrackId: pool.seedByTrackId,
              maxPerArtist: 2,
              maxPerAlbum: 3,
              tuning,
            });

      if (!best) return NOTHING;
      return {
        track: best.track,
        reason: best.reason,
        explanation: explainCandidate(best),
      };
    } catch {
      // Never propagate: autoplay must not be able to break playback.
      return NOTHING;
    }
  },
});

// ---------------------------------------------------------------------------
// Feedback loop (phase 12 + 14)
// ---------------------------------------------------------------------------

/**
 * Outcomes that record only that something HAPPENED, not how it turned out.
 * They are stored unsettled so the `signals` query — which ignores unsettled
 * rows — does not count a recommendation twice: once when it started and once
 * when it finished. `settleOutcome` writes the real verdict later.
 */
const UNSETTLED_OUTCOMES = new Set(["shown", "played", "queued"]);

/**
 * Record what happened to a recommendation.
 *
 * Called by the client when a recommendation is shown, played or queued. The
 * row is what lets the next request learn from this one. Writes are scoped to
 * the caller's own id, so a client cannot attribute feedback to another user.
 */
export const recordFeedback = mutation({
  args: {
    trackId: v.string(),
    outcome: v.string(),
    section: v.optional(v.string()),
    reason: v.optional(v.string()),
    source: v.optional(v.string()),
    seed: v.optional(v.string()),
    score: v.optional(v.number()),
    breakdown: v.optional(v.any()),
    origin: v.optional(v.string()),
    title: v.optional(v.string()),
    artistName: v.optional(v.string()),
    albumName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const now = Date.now();
    // An impression or a start is deliberately NOT treated as a signal yet.
    const settled = !UNSETTLED_OUTCOMES.has(args.outcome);
    await ctx.db.insert("recommendationEvents", {
      userId,
      trackId: args.trackId,
      section: args.section ?? "unknown",
      reason: args.reason ?? "discovery",
      source: args.source,
      seed: args.seed,
      score: args.score,
      breakdown: args.breakdown,
      createdAt: now,
      outcome: args.outcome,
      settledAt: settled ? now : undefined,
      origin: args.origin,
      title: args.title,
      artistName: args.artistName,
      albumName: args.albumName,
    });
    return now;
  },
});

/**
 * Settle the newest undecided recommendation for a track with what actually
 * happened: completed or skipped. Paired 1:1 with the `recordFeedback` call
 * that opened the row, and idempotent — a replay or a retry finds nothing
 * unsettled and changes nothing.
 */
export const settleOutcome = mutation({
  args: { trackId: v.string(), outcome: v.string() },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const rows = await ctx.db
      .query("recommendationEvents")
      .withIndex("by_user_createdAt", (q) => q.eq("userId", userId))
      .order("desc")
      .take(MAX_FEEDBACK_ROWS);
    const row = rows.find((r) => r.trackId === args.trackId && !r.settledAt);
    if (!row) return null;
    await ctx.db.patch(row._id, {
      settledAt: Date.now(),
      outcome: args.outcome,
    });
    return Date.now();
  },
});

/**
 * Called when the user pulls an automatically generated track out of the
 * queue. That is a real rejection and it must reach the scoring model —
 * otherwise the engine keeps offering what the listener just deleted.
 */
export const recordRemoval = mutation({
  args: { trackId: v.string(), section: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const now = Date.now();
    await ctx.db.insert("recommendationEvents", {
      userId,
      trackId: args.trackId,
      section: args.section ?? "queue",
      reason: "discovery",
      createdAt: now,
      settledAt: now,
      outcome: "removed",
    });
    return now;
  },
});

// ---------------------------------------------------------------------------
// Debug (phase 17)
// ---------------------------------------------------------------------------

/**
 * Developer-facing score breakdown for a single track.
 *
 * Returns the same numbers the ranking used, including the exact contribution
 * of every weighted term, so a bad recommendation can be traced to the signal
 * that caused it. Not surfaced in the product UI.
 */
export const explain = action({
  args: {
    candidate: candidateValidator,
    exploration: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const userSignals =
      (await ctx.runQuery(api.recommend.signals, {})) ?? EMPTY_SIGNALS;
    // Adaptive tuning: the stated preference, corrected by how the listener
    // actually responds to what the engine recommends (see `adaptiveTuning`).
    const tuning = adaptiveTuning(args.exploration, userSignals.plays);
    const built = buildSignals(userSignals, now);
    const seeds = buildSeeds(built, userSignals, {
      maxSeeds: MAX_SEEDS,
      currentTrack: args.candidate,
      tuning,
    });

    let recentPlays: Array<{ trackId: string; at: number }> = [];
    try {
      const times = await ctx.runQuery(api.recommend.recentPlayTimes, {});
      recentPlays = (times ?? []) as typeof recentPlays;
    } catch {
      /* optional */
    }

    const fallbackSeed: CandidateSeed = {
      query: "",
      source: "discovery",
      weight: 0,
      seed: null,
      reason: "discovery",
    };
    const seed = seeds[0] ?? fallbackSeed;
    const scored = scoreCandidate(args.candidate, built, seed, {
      now,
      recentPlays: new Map(recentPlays.map((e) => [e.trackId, e.at])),
      duplicate: false,
      tuning,
    });

    return {
      candidate: args.candidate,
      breakdown: scored.score,
      reason: scored.reason,
      seed: seed.seed,
      explanation: explainCandidate(scored),
      personalised: built.personalised,
      artistCount: built.artistCount,
      tuning,
      seeds: seeds.map((s) => ({
        query: s.query,
        source: s.source,
        seed: s.seed,
      })),
    };
  },
});
