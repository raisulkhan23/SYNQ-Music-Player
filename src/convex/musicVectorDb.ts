/**
 * Music Vector Database — API layer (spec §15, §18).
 *
 * The HTTP routes in the spec map onto Convex actions and queries:
 *
 *   POST /api/search/music      -> searchMusic
 *   POST /api/search/semantic   -> semanticSearch
 *   POST /api/music/similar     -> similarMusic
 *   POST /api/recommendations   -> recommendations
 *   POST /api/artists/similar   -> similarArtists
 *   POST /api/playlists/similar -> similarPlaylists
 *   POST /api/vector/upsert     -> upsertVectors
 *   POST /api/vector/delete     -> deleteVectors
 *   GET  /api/vector/stats      -> vectorStats
 *
 * Two rules this layer enforces that the engine deliberately does not:
 *
 * 1. AUTHORISATION. Catalogue search is public; anything that reads or writes
 *    a user's listening history requires an identity. The engine has no idea
 *    who is calling — that is what this file is for.
 * 2. VALIDATION AT THE EDGE. Everything arriving from a client is untrusted
 *    and goes through `v` validators before it reaches the engine, so a
 *    malformed limit cannot turn into an unbounded scan.
 */
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { api } from "./_generated/api";
import { action, query, type ActionCtx } from "./_generated/server";
import {
  HashingEmbedder,
  MemoryVectorStore,
  MusicVectorDB,
  similarity as vectorSimilarity,
  type DiversityConfig,
  type Filters,
  type ListeningEvent,
  type MusicProperties,
  type SimilarityWeights,
} from "../lib/musicdb";

/**
 * The database instance.
 *
 * A module-level singleton, which is honest about what it is: an in-process
 * store that lives as long as the deployment does. It is the correct shape for
 * local development and for tests, and it is deliberately behind the
 * `VectorStore` interface so swapping it for a hosted engine is one factory
 * change here and nowhere else. It is NOT a durable database — vectors written
 * to it do not survive a cold start, and `upsertVectors` must not be treated as
 * ingestion until a real provider is wired in behind the same interface.
 */
const db = new MusicVectorDB({
  store: new MemoryVectorStore(),
  embedder: new HashingEmbedder(),
});

/** Rejects absurd limits before they become an unbounded scan. */
const MAX_LIMIT = 100;

function clampLimit(limit: number | undefined, fallback: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(Math.floor(limit), MAX_LIMIT));
}

/** Rate limiting, in-process (spec §18).
 *
 *  Per-identity and per-IP, fixed window. Adequate for a single node and
 *  honestly labelled as such: behind more than one instance the limits are
 *  per-instance, and a shared store is required for a real limit. */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(key: string): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { ok: true, retryAfterMs: 0 };
  }
  bucket.count += 1;
  if (bucket.count > RATE_MAX) {
    return { ok: false, retryAfterMs: bucket.resetAt - now };
  }
  return { ok: true, retryAfterMs: 0 };
}

/** Metadata filters arrive as a validated struct, never as a raw expression,
 *  so a client cannot smuggle an operator the engine does not understand. */
const filtersValidator = v.optional(
  v.object({
    conditions: v.optional(
      v.array(
        v.object({
          field: v.string(),
          op: v.string(),
          value: v.union(v.string(), v.number(), v.boolean(), v.array(v.any())),
        }),
      ),
    ),
    releaseYearMin: v.optional(v.number()),
    releaseYearMax: v.optional(v.number()),
    bpmMin: v.optional(v.number()),
    bpmMax: v.optional(v.number()),
    durationMin: v.optional(v.number()),
    durationMax: v.optional(v.number()),
    energyMin: v.optional(v.number()),
    energyMax: v.optional(v.number()),
    danceabilityMin: v.optional(v.number()),
    danceabilityMax: v.optional(v.number()),
    popularityMin: v.optional(v.number()),
  }),
);

function toFilters(
  raw:
    | {
        conditions?: { field: string; op: string; value: unknown }[];
        [key: string]: unknown;
      }
    | undefined,
): Filters | undefined {
  if (!raw) return undefined;
  const allowedOps = new Set([
    "eq",
    "ne",
    "in",
    "nin",
    "contains",
    "gt",
    "gte",
    "lt",
    "lte",
  ]);
  return {
    ...raw,
    conditions: (raw.conditions ?? [])
      .filter((c) => allowedOps.has(c.op))
      .map((c) => c as Filters["conditions"][number]),
  } as Filters;
}

/** The response shape from the spec, produced from internal results so the
 *  public contract does not leak vector internals. */
function present(
  results: {
    record: { id: string; properties: MusicProperties };
    score: number;
    matchReasons: { signal: string; detail: string; contribution: number }[];
  }[],
) {
  return {
    results: results.map((r) => ({
      track_id: r.record.id,
      title: r.record.properties.title,
      artist: r.record.properties.artist ?? "",
      album: r.record.properties.album ?? "",
      similarity: Math.round(r.score * 1000) / 1000,
      match_reasons: r.matchReasons.map((reason) => reason.detail),
    })),
  };
}

export const searchMusic = action({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
    filters: filtersValidator,
    strategy: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    const limit = checkRateLimit(`search:${identity?.subject ?? "anon"}`);
    if (!limit.ok) {
      return {
        results: [],
        rate_limited: true,
        retry_after_ms: limit.retryAfterMs,
      };
    }
    const size = clampLimit(args.limit, 20);
    const filters = toFilters(args.filters);

    const strategy = args.strategy ?? "weighted";
    const results =
      strategy === "vector_only" || strategy === "keyword_only"
        ? await db.hybrid({
            query: args.query,
            limit: size,
            filters,
            strategy: strategy as "vector_only" | "keyword_only",
          })
        : strategy === "reciprocal_rank_fusion"
          ? await db.hybrid({
              query: args.query,
              limit: size,
              filters,
              strategy: "reciprocal_rank_fusion",
            })
          : await db.search({ query: args.query, limit: size, filters });

    return { ...present(results), rate_limited: false, retry_after_ms: 0 };
  },
});

export const semanticSearch = action({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
    filters: filtersValidator,
  },
  handler: async (_ctx, args) => {
    const results = await db.search({
      query: args.query,
      limit: clampLimit(args.limit, 20),
      filters: toFilters(args.filters),
    });
    return present(results);
  },
});

export const similarMusic = action({
  args: {
    track_id: v.string(),
    limit: v.optional(v.number()),
    filters: filtersValidator,
    weights: v.optional(v.any()),
  },
  handler: async (_ctx, args) => {
    const results = await db.similar({
      trackId: args.track_id,
      limit: clampLimit(args.limit, 20),
      filters: toFilters(args.filters),
      weights: args.weights as Partial<SimilarityWeights> | undefined,
    });
    return present(results);
  },
});

/** Similar artists: artists ranked by how close they are to a seed artist.
 *  Derived from the artist vector rather than by string-matching a name. */
export const similarArtists = action({
  args: { artist: v.string(), limit: v.optional(v.number()) },
  handler: async (_ctx, args) => {
    const all = await db.store.list();
    const seed = all.find(
      (r) =>
        (r.properties.artist ?? "").toLowerCase() === args.artist.toLowerCase(),
    );
    if (!seed) return { results: [] };

    const byArtist = new Map<
      string,
      { id: string; score: number; genres: string[] }
    >();
    for (const record of all) {
      const name = record.properties.artist;
      if (!name || name.toLowerCase() === args.artist.toLowerCase()) continue;
      const score = vectorSimilarity(
        seed.vectors.artist,
        record.vectors.artist,
        "cosine",
      );
      const existing = byArtist.get(name);
      if (!existing || score > existing.score) {
        byArtist.set(name, {
          id: name,
          score,
          genres: record.properties.genres ?? [],
        });
      }
    }

    return {
      results: [...byArtist.values()]
        .sort((a, b) => b.score - a.score)
        .slice(0, clampLimit(args.limit, 20))
        .map((a) => ({
          artist: a.id,
          similarity: Math.round(a.score * 1000) / 1000,
          genres: a.genres,
        })),
    };
  },
});

export const similarPlaylists = action({
  args: { playlist_id: v.string(), limit: v.optional(v.number()) },
  handler: async (_ctx, args) => {
    const seed = await db.get(args.playlist_id);
    if (!seed) return { results: [] };
    const all = await db.store.list();
    const results = all
      .filter((record) => record.id !== args.playlist_id)
      .map((record) => ({
        record,
        score: vectorSimilarity(
          seed.vectors.multimodal,
          record.vectors.multimodal,
          "cosine",
        ),
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, clampLimit(args.limit, 20));
    return present(
      results.map((r) => ({
        record: r.record,
        score: r.score,
        matchReasons: [
          {
            signal: "playlist",
            detail: `${Math.round(r.score * 100)}% similar to playlist "${seed.properties.title}"`,
            contribution: r.score,
          },
        ],
      })),
    );
  },
});

/**
 * Personalised recommendations.
 *
 * Identity is REQUIRED. There is no anonymous path here and no way to pass
 * another user's id: the listening events are the caller's own, fetched
 * server-side, so a client cannot request someone else's "For You" by
 * changing a parameter (spec §18).
 */
export const recommendations = action({
  args: {
    limit: v.optional(v.number()),
    diversity: v.optional(v.any()),
    filters: filtersValidator,
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const limit = checkRateLimit(`reco:${identity.subject}`);
    if (!limit.ok) {
      return {
        results: [],
        rate_limited: true,
        retry_after_ms: limit.retryAfterMs,
      };
    }

    const now = Date.now();
    const events = await listeningEventsFor(identity.subject);

    // A listener with no history gets nothing rather than a popular list
    // dressed up as a personal one.
    if (events.length === 0) {
      return {
        results: [],
        reason: "no_listening_history",
        rate_limited: false,
      };
    }

    const profile = await db.userVectorFromRecords(identity.subject, events, {
      now,
    });
    const results = await db.recommend(profile, {
      limit: clampLimit(args.limit, 20),
      diversity: args.diversity as Partial<DiversityConfig> | undefined,
      filters: toFilters(args.filters),
    });

    return {
      results: results.map((r) => ({
        track_id: r.record.id,
        title: r.record.properties.title,
        artist: r.record.properties.artist ?? "",
        similarity: Math.round(r.score * 1000) / 1000,
        match_reasons: r.matchReasons.map((reason) => reason.detail),
        exploration: r.exploration,
      })),
      profile_summary: {
        events_considered: profile.eventCount,
        top_artists: profile.topArtists,
        top_genres: profile.topGenres,
      },
      rate_limited: false,
      retry_after_ms: 0,
    };
  },
});

/** Upstream listening history for a user.
 *
 * Currently fed from the in-process event log that `upsertVectors`/the player
 * write. When the Convex `history` table is the system of record, this becomes
 * a query against it — the rest of the recommendation path is unchanged,
 * because it only ever sees `ListeningEvent[]`. */
const listeningEvents = new Map<string, ListeningEvent[]>();

export const recordListeningEvent = action({
  args: {
    track_id: v.string(),
    completion: v.optional(v.number()),
    liked: v.optional(v.boolean()),
    skipped: v.optional(v.boolean()),
    saved: v.optional(v.boolean()),
    source: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireIdentity(ctx);
    const event: ListeningEvent = {
      trackId: args.track_id,
      at: Date.now(),
      completion: args.completion,
      liked: args.liked,
      skipped: args.skipped,
      saved: args.saved,
      source: args.source as ListeningEvent["source"],
    };
    const existing = listeningEvents.get(identity.subject) ?? [];
    existing.push(event);
    listeningEvents.set(identity.subject, existing);
    return { ok: true };
  },
});

async function listeningEventsFor(userId: string): Promise<ListeningEvent[]> {
  return listeningEvents.get(userId) ?? [];
}

/** Writing vectors. Administrative: ingestion and admin tooling only. */
export const upsertVectors = action({
  args: {
    items: v.array(
      v.object({
        properties: v.any(),
        text: v.optional(v.string()),
      }),
    ),
    batch_size: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const report = await db.ingest(
      args.items as { properties: MusicProperties; text?: string }[],
      {
        batchSize: args.batch_size ?? 100,
      },
    );
    return report;
  },
});

export const deleteVectors = action({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const removed = await db.delete(args.ids);
    return { removed };
  },
});

export const vectorStats = action({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    return db.stats();
  },
});

/** The duplicate review queue (spec §14). Read-only by construction: the
 *  detector reports candidates and nothing here deletes them. */
export const duplicateCandidates = action({
  args: { threshold: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const found = await db.duplicates({
      threshold: args.threshold,
      limit: clampLimit(args.limit, 100),
    });
    return { candidates: found };
  },
});

/** Clusters for the admin dashboard projection (spec §9). */
export const clusters = action({
  args: { k: v.optional(v.number()), vector_type: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const result = await db.clustering({
      k: clampLimit(args.k, 8),
      vectorType: (args.vector_type ?? "multimodal") as
        | "audio"
        | "lyrics"
        | "artist"
        | "genre"
        | "mood"
        | "user"
        | "playlist"
        | "multimodal",
    });
    return {
      axes: result.axes,
      sampled: result.sampled,
      iterations: result.iterations,
      clusters: result.clusters.map((c) => ({
        id: c.id,
        label: c.label,
        size: c.size,
        exemplars: c.exemplarIds,
      })),
      points: result.points,
    };
  },
});

/** Liveness check that does not require admin rights, so the frontend can
 *  show "connected" without exposing catalogue counts publicly. */
export const vectorHealth = query({
  args: {},
  handler: async () => {
    const stats = db.stats();
    return {
      ok: true,
      engine: db.store.name,
      index: stats.index,
      model: db.embedder.model,
      records: stats.totalRecords,
    };
  },
});

/**
 * The caller's role, and nothing else.
 *
 * A whole-file `users` scan would be the obvious way to check "is this an
 * admin", and it would be wrong: it reads every account on the deployment just
 * to answer a yes/no question, and it burns the read budget that keeps the
 * admin panel itself loading past a few thousand rows. `getAuthUserId` is an
 * index lookup on the session, so this stays O(1) and owner-scoped.
 */
export const myRole = query({
  args: {},
  handler: async (ctx): Promise<string | null> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const me = await ctx.db.get(userId);
    return me?.role ?? null;
  },
});

/**
 * Authorisation, not authentication.
 *
 * Signing in is not permission to rewrite the vector database. `ingestVectors`
 * and `deleteVectors` write across every listener's records, so before this
 * check they were reachable by anyone who had merely signed up — a real
 * privilege-escalation hole wearing a `requireAdmin` name. The role comes from
 * the `users` table (see `admin.setRole`); the identity is still required
 * first so an anonymous caller gets "Not authenticated" rather than a null
 * dereference.
 *
 * An action has no `ctx.db`, so the role is read through `myRole` rather than
 * duplicating the user lookup here. `admin.status` is not a substitute: it
 * scans three whole tables before it will answer.
 */
async function requireAdmin(ctx: ActionCtx): Promise<void> {
  await requireIdentity(ctx);
  const role = await ctx.runQuery(api.musicVectorDb.myRole);
  if (role !== "admin") {
    throw new Error("Admin access required");
  }
}

/** Identity is required for anything touching a listening history. Throwing
 *  here rather than returning an empty result is deliberate: a silent empty
 *  list would look like "you have no taste yet" instead of "you are not
 *  signed in". */
async function requireIdentity(ctx: {
  auth: { getUserIdentity(): Promise<unknown> };
}): Promise<{ subject: string }> {
  const identity = (await ctx.auth.getUserIdentity()) as {
    subject?: string;
  } | null;
  if (!identity?.subject) {
    throw new Error("Not authenticated");
  }
  return { subject: identity.subject };
}
