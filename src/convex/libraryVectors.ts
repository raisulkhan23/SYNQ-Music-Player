/**
 * Listener library vectors — ingestion and discovery (spec §12, §15, §18).
 *
 * This is the part that makes the vector database earn its place in SYNQ. A
 * catalogue-wide store is inert on its own; what a listener can actually USE
 * is searching the music they already has, in their own words.
 *
 * Shape follows Convex's split, and each piece is where it belongs:
 *
 *   queries    — read the library and the stored vectors
 *   mutations  — write vectors (short, indexed, single-writer)
 *   action     — the expensive part: embedding, which never blocks a query
 *
 * Decisions worth stating, because each protects something real:
 *
 * - The index is built ONLY from data the listener already has: liked tracks,
 *   play history and playlist contents. Nothing is invented and no external
 *   service is required, so it works the moment a listener has history.
 * - Owner identity is taken from the session, never from a request argument,
 *   and every query re-checks it. There is no parameter a caller could change
 *   to read somebody else's listening history.
 * - Sync is incremental. Each record carries a signature of the metadata that
 *   produced its vectors; unchanged tracks are skipped, so re-syncing a large
 *   library does not re-embed it.
 */
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import {
  action,
  mutation,
  query,
  type ActionCtx,
  type QueryCtx,
} from "./_generated/server";
import { api } from "./_generated/api";
import { ConvexVectorStore } from "./convexVectorStore";
import {
  HashingEmbedder,
  MusicVectorDB,
  metadataSignature,
  type Filters,
  type ListeningEvent,
  type MusicProperties,
} from "../lib/musicdb";

/** Ceiling per sync, not a target.
 *
 *  Beyond this the embedding pass would exceed a single action's time budget.
 *  A listener with a very large library gets a partial index plus an honest
 *  "more to go" cursor rather than a request that fails outright. */
const MAX_PER_SYNC = 200;

const embedder = new HashingEmbedder();

/* ── Reads ─────────────────────────────────────────────────────────────── */

/** Every source the listener's library actually lives in, merged by track id.
 *
 *  Merging rather than choosing one source is what lets a track liked months
 *  ago and played yesterday come back as a single, complete record: liked rows
 *  carry the best metadata, history carries the plays, playlists carry album
 *  and cover detail for tracks that were only ever saved. */
export const libraryItems = query({
  args: {},
  handler: async (ctx) => {
    const { userId } = await requireUserDoc(ctx);
    return await collectLibraryItems(ctx, userId);
  },
});

/** Recent plays, for the listener's own vector profile. */
export const recentPlays = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const { userId } = await requireUserDoc(ctx);
    const rows = await ctx.db
      .query("playEvents")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(args.limit ?? 300);
    return rows.map(
      (row: {
        trackId: string;
        playedAt: number;
        completion?: number;
        skipped?: boolean;
      }) => ({
        trackId: row.trackId,
        playedAt: row.playedAt,
        completion: row.completion,
        skipped: row.skipped,
      }),
    );
  },
});

export const listRecords = query({
  args: {
    ownerId: v.string(),
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const caller = await requireOwner(ctx);
    // Defence in depth: the caller may only ever read their own records.
    assertOwner(caller, args.ownerId);

    const result = await ctx.db
      .query("vectorRecords")
      .withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId))
      .paginate({
        numItems: args.numItems ?? 128,
        cursor: args.cursor ?? null,
      });

    return {
      rows: result.page.map((row) => ({
        trackId: row.trackId,
        properties: row.properties,
        vectors: row.vectors,
        versions: row.versions,
        signature: row.signature,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

export const recordByTrack = query({
  args: { ownerId: v.string(), trackId: v.string() },
  handler: async (ctx, args) => {
    const caller = await requireOwner(ctx);
    assertOwner(caller, args.ownerId);
    const row = await ctx.db
      .query("vectorRecords")
      .withIndex("by_owner_track", (q) =>
        q.eq("ownerId", args.ownerId).eq("trackId", args.trackId),
      )
      .unique();
    if (!row) return null;
    return {
      trackId: row.trackId,
      properties: row.properties,
      vectors: row.vectors,
      versions: row.versions,
      signature: row.signature,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  },
});

export const indexStatus = query({
  args: {},
  handler: async (ctx) => {
    const userId = await requireOwner(ctx);
    const rows = await ctx.db
      .query("vectorRecords")
      .withIndex("by_owner", (q) => q.eq("ownerId", userId))
      .collect();
    return { indexed: rows.length };
  },
});

/* ── Writes ────────────────────────────────────────────────────────────── */

export const saveRecords = mutation({
  args: {
    ownerId: v.string(),
    records: v.array(
      v.object({
        trackId: v.string(),
        properties: v.any(),
        vectors: v.any(),
        versions: v.any(),
        signature: v.string(),
        createdAt: v.number(),
        updatedAt: v.number(),
      }),
    ),
  },
  handler: async (ctx, args) => {
    const caller = await requireOwner(ctx);
    assertOwner(caller, args.ownerId);

    for (const record of args.records) {
      const existing = await ctx.db
        .query("vectorRecords")
        .withIndex("by_owner_track", (q) =>
          q.eq("ownerId", args.ownerId).eq("trackId", record.trackId),
        )
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, {
          properties: record.properties,
          vectors: record.vectors,
          versions: record.versions,
          signature: record.signature,
          updatedAt: record.updatedAt,
        });
      } else {
        await ctx.db.insert("vectorRecords", {
          ownerId: args.ownerId,
          trackId: record.trackId,
          properties: record.properties,
          vectors: record.vectors,
          versions: record.versions,
          signature: record.signature,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        });
      }
    }
    return { saved: args.records.length };
  },
});

export const removeRecords = mutation({
  args: { ownerId: v.string(), trackIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const caller = await requireOwner(ctx);
    assertOwner(caller, args.ownerId);

    for (const trackId of args.trackIds) {
      const row = await ctx.db
        .query("vectorRecords")
        .withIndex("by_owner_track", (q) =>
          q.eq("ownerId", args.ownerId).eq("trackId", trackId),
        )
        .unique();
      if (row) await ctx.db.delete(row._id);
    }
    return { removed: args.trackIds.length };
  },
});

/* ── Actions ───────────────────────────────────────────────────────────── */

function makeDb(ctx: ActionCtx, ownerId: string): MusicVectorDB {
  return new MusicVectorDB({
    store: new ConvexVectorStore(
      {
        listRecords: (args) =>
          ctx.runQuery(api.libraryVectors.listRecords, args),
        recordByTrack: (args) =>
          ctx.runQuery(api.libraryVectors.recordByTrack, args),
        saveRecords: (args) =>
          ctx.runMutation(api.libraryVectors.saveRecords, args),
        removeRecords: (args) =>
          ctx.runMutation(api.libraryVectors.removeRecords, args),
      },
      ownerId,
    ),
    embedder,
  });
}

export const syncLibrary = action({
  args: { cursor: v.optional(v.number()) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    considered: number;
    indexed: number;
    skipped: number;
    has_more: boolean;
    cursor: number | null;
  }> => {
    const ownerId = await requireOwner(ctx);
    const db = makeDb(ctx, ownerId);

    const candidates: MusicProperties[] = await ctx.runQuery(
      api.libraryVectors.libraryItems,
      {},
    );
    const start = args.cursor ?? 0;
    const slice = candidates.slice(start, start + MAX_PER_SYNC);

    // Skip anything whose metadata has not changed since the last sync.
    const changed: MusicProperties[] = [];
    let skipped = 0;
    for (const item of slice) {
      const signature = metadataSignature(item);
      const existing = await db.get(item.trackId);
      const stored = existing
        ? ((existing.properties as Record<string, unknown>)["signature"] ?? "")
        : "";
      if (stored === signature) {
        skipped += 1;
        continue;
      }
      // The signature rides along on the metadata, because that is what
      // ingestion hashed — one source of truth rather than two.
      changed.push({ ...item, signature } as MusicProperties);
    }

    const report = await db.ingest(
      changed.map((properties) => ({ properties })),
      { batchSize: 50 },
    );

    const next = start + MAX_PER_SYNC;
    return {
      considered: candidates.length,
      indexed: report.accepted,
      skipped,
      has_more: next < candidates.length,
      cursor: next < candidates.length ? next : null,
    };
  },
});

export const discover = action({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
    filters: v.optional(v.any()),
    strategy: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const ownerId = await requireOwner(ctx);
    const db = makeDb(ctx, ownerId);
    const limit = Math.max(1, Math.min(args.limit ?? 20, 50));

    const existing = await db.store.list({ limit: 1 });
    if (existing.length === 0) {
      return {
        results: [],
        indexed: 0,
        needs_sync: true,
        reason: "library_not_indexed",
      };
    }

    const filters = normaliseFilters(args.filters);
    const strategy = args.strategy;
    const results =
      strategy === "hybrid" || strategy === "reciprocal_rank_fusion"
        ? await db.hybrid({
            query: args.query,
            limit,
            filters,
            strategy:
              strategy === "reciprocal_rank_fusion"
                ? "reciprocal_rank_fusion"
                : "weighted",
          })
        : await db.search({ query: args.query, limit, filters });

    return {
      results: results.map((r) => ({
        track_id: r.record.id,
        title: r.record.properties.title,
        artist: r.record.properties.artist ?? "",
        album: r.record.properties.album ?? "",
        cover_url:
          typeof r.record.properties["coverUrl"] === "string"
            ? (r.record.properties["coverUrl"] as string)
            : "",
        duration:
          typeof r.record.properties.duration === "number"
            ? r.record.properties.duration
            : 0,
        youtube_id:
          typeof r.record.properties["youtubeId"] === "string"
            ? (r.record.properties["youtubeId"] as string)
            : undefined,
        score: Math.round(r.score * 1000) / 1000,
        match_reasons: r.matchReasons.map((reason) => reason.detail),
      })),
      indexed: (await db.store.list({ limit: 5000 })).length,
      needs_sync: false,
    };
  },
});

/** "More like this", over the listener's own library only. */
export const similarInLibrary = action({
  args: {
    track_id: v.string(),
    limit: v.optional(v.number()),
    weights: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const ownerId = await requireOwner(ctx);
    const db = makeDb(ctx, ownerId);
    const results = await db.similar({
      trackId: args.track_id,
      limit: Math.max(1, Math.min(args.limit ?? 10, 30)),
      weights: args.weights,
    });
    return {
      results: results.map((r) => ({
        track_id: r.record.id,
        title: r.record.properties.title,
        artist: r.record.properties.artist ?? "",
        score: Math.round(r.score * 1000) / 1000,
        match_reasons: r.matchReasons.map((reason) => reason.detail),
      })),
    };
  },
});

/** The listener's vector profile, built from the real play log. */
export const myListeningProfile = action({
  args: {},
  handler: async (ctx) => {
    const ownerId = await requireOwner(ctx);
    const db = makeDb(ctx, ownerId);

    const rows: {
      trackId: string;
      playedAt: number;
      completion?: number;
      skipped?: boolean;
    }[] = await ctx.runQuery(api.libraryVectors.recentPlays, { limit: 300 });
    if (!rows || rows.length === 0) {
      return { indexed: 0, top_artists: [], top_genres: [], event_count: 0 };
    }

    const events: ListeningEvent[] = rows.map((row) => ({
      trackId: row.trackId,
      at: row.playedAt,
      completion: row.completion,
      skipped: row.skipped,
      source: "play" as const,
    }));

    const profile = await db.userVectorFromRecords(ownerId, events);
    return {
      indexed: (await db.store.list({ limit: 5000 })).length,
      top_artists: profile.topArtists,
      top_genres: profile.topGenres,
      event_count: profile.eventCount,
    };
  },
});

/* ── Shared helpers ────────────────────────────────────────────────────── */

async function requireOwner(ctx: {
  auth: { getUserIdentity(): Promise<unknown> };
}): Promise<string> {
  const identity = (await ctx.auth.getUserIdentity()) as {
    subject?: string;
  } | null;
  if (!identity?.subject) throw new Error("Not authenticated");
  return identity.subject;
}

/**
 * The library tables key on the `users` document id, while the session carries
 * an auth SUBJECT. They are usually the same string, but assuming that is
 * exactly the kind of assumption that quietly returns an empty library for
 * accounts created before a schema change, so it is verified against the
 * `users` table and falls back to a clear error rather than to zero results.
 */
async function requireUserDoc(ctx: QueryCtx): Promise<{
  subject: string;
  userId: Id<"users">;
}> {
  const subject = await requireOwner(ctx);
  const user = await ctx.db
    .query("users")
    .withIndex("email", (q) => q.eq("email", subject))
    .unique();
  if (user) return { subject, userId: user._id };
  const byId = await ctx.db.get(subject as Id<"users">);
  if (byId) return { subject, userId: byId._id };
  throw new Error("No user record for this session");
}

function assertOwner(caller: string, requested: string): void {
  if (caller !== requested) {
    // The owner comes from the session, never from the request body. This
    // throws rather than returning an empty set, so a bug here is loud.
    throw new Error("Not authorised");
  }
}

/** Only known operators survive; anything else is dropped rather than passed
 *  through to the engine. */
function normaliseFilters(raw: unknown): Filters {
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
  const source = (raw ?? {}) as Record<string, unknown>;
  const conditions = Array.isArray(source.conditions)
    ? source.conditions.filter((c): c is Filters["conditions"][number] => {
        const condition = c as Filters["conditions"][number];
        return (
          Boolean(condition) &&
          typeof condition.field === "string" &&
          allowedOps.has(condition.op)
        );
      })
    : [];
  return { ...(source as Filters), conditions };
}

async function collectLibraryItems(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<MusicProperties[]> {
  const merged = new Map<string, MusicProperties & { _plays: number }>();

  const add = (id: string, patch: Partial<MusicProperties>, plays = 0) => {
    if (!id) return;
    const existing = merged.get(id);
    const next: MusicProperties & { _plays: number } = {
      ...(existing ?? { trackId: id, kind: "track" as const, title: id }),
      ...patch,
      _plays: (existing?._plays ?? 0) + plays,
    };
    // A later, thinner source must never blank out a title we already have.
    if (existing?.title && !patch.title) next.title = existing.title;
    if (existing?.artist && !patch.artist) next.artist = existing.artist;
    merged.set(id, next);
  };

  const liked = await ctx.db
    .query("likedRemote")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const row of liked) {
    add(row.trackId, {
      title: row.title,
      artist: row.artistName,
      duration: row.duration,
      coverUrl: row.coverUrl,
      youtubeId: row.youtubeId,
      kind: "track",
    });
  }

  const history = await ctx.db
    .query("playHistory")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const row of history) {
    add(
      row.trackId,
      {
        title: row.title ?? row.trackId,
        artist: row.artistName,
        duration: row.duration,
        coverUrl: row.coverUrl,
        kind: "track",
      },
      row.playCount ?? 1,
    );
  }

  const playlists = await ctx.db
    .query("playlists")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .collect();
  for (const row of playlists) {
    if (row.trackSnapshots) {
      for (const track of row.trackSnapshots) {
        add(track.id, {
          title: track.title,
          artist: track.artist,
          album: track.album,
          duration: track.duration,
          coverUrl: track.coverUrl,
          youtubeId: track.youtubeId,
          kind: "track",
        });
      }
    } else {
      for (const id of row.trackIds ?? [])
        add(id, { title: id, kind: "track" });
    }
  }

  return [...merged.values()].map(({ _plays, ...properties }) => ({
    ...properties,
    // Play count is metadata that explains a ranking, not a statement of taste.
    popularity: _plays > 1 ? Math.min(1, _plays / 50) : undefined,
  }));
}
