import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  defaultSmartName,
  describeSmartRules,
  evaluateSmartRules,
  normalizeSmartRules,
  type SmartRules,
  type SmartTrack,
} from "../lib/smartPlaylists";

/** The validator widens literals to `string`; the engine narrows them back. */
const asRules = (rules: Record<string, unknown>): Partial<SmartRules> =>
  rules as unknown as Partial<SmartRules>;

/**
 * Smart playlists: a saved RULE SET, recomputed every time it is opened.
 *
 * The library a rule runs against is assembled from data SYNQ already stores —
 * `playHistory` (plays, last-played, play counts) and the two likes tables
 * (`likedSongs` ids + `likedRemote` snapshots). Nothing here resolves a stream
 * or performs an upstream lookup; a smart playlist is a VIEW of the listener's
 * own library, which is why opening one is instant and free of network work.
 *
 * The rule engine itself lives in `lib/smartPlaylists.ts` and is imported, not
 * re-implemented, so the UI's preview of "what this rule matches" and the
 * server's actual result can never disagree.
 */

const rulesValidator = v.object({
  source: v.string(),
  minPlays: v.number(),
  maxPlays: v.number(),
  withinDays: v.number(),
  notWithinDays: v.number(),
  artist: v.string(),
  title: v.string(),
  limit: v.number(),
  sort: v.string(),
});

const requireUser = async (ctx: MutationCtx): Promise<Id<"users">> => {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new ConvexError("Sign in to manage smart playlists");
  return userId;
};

/**
 * The listener's whole library, one row per track, with the play and like
 * signals the rules read.
 *
 * Merged from three tables keyed by the shared trackId: a play contributes its
 * count and last-played time, a like contributes its liked-at time, and either
 * one may contribute the display metadata. A liked track with no play and no
 * remote snapshot has no metadata to render, so it is skipped rather than shown
 * as a nameless row.
 */
export async function buildSmartLibrary(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<SmartTrack[]> {
  const [history, likes, likedRemote] = await Promise.all([
    ctx.db
      .query("playHistory")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect(),
    ctx.db
      .query("likedSongs")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect(),
    ctx.db
      .query("likedRemote")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect(),
  ]);

  const byId = new Map<string, SmartTrack>();

  for (const row of history) {
    byId.set(row.trackId, {
      trackId: row.trackId,
      title: row.title ?? "Unknown song",
      artistName: row.artistName ?? "",
      coverUrl: row.coverUrl ?? "",
      duration: row.duration ?? 0,
      playCount: row.playCount,
      lastPlayedAt: row.playedAt,
      likedAt: 0,
      source: row.source,
    });
  }

  for (const like of likes) {
    const existing = byId.get(like.trackId);
    if (existing) {
      existing.likedAt = like.createdAt;
    }
    // A local like with no playHistory row has no title/artist to display and
    // is skipped — a nameless playlist row is worse than an absent one.
  }

  for (const remote of likedRemote) {
    const existing = byId.get(remote.trackId);
    if (existing) {
      existing.likedAt = Math.max(existing.likedAt, remote.createdAt);
      if (!existing.title || existing.title === "Unknown song") existing.title = remote.title;
      if (!existing.artistName) existing.artistName = remote.artistName;
      if (!existing.coverUrl) existing.coverUrl = remote.coverUrl;
      if (!existing.duration) existing.duration = remote.duration;
      continue;
    }
    byId.set(remote.trackId, {
      trackId: remote.trackId,
      title: remote.title,
      artistName: remote.artistName,
      coverUrl: remote.coverUrl,
      duration: remote.duration,
      playCount: 0,
      lastPlayedAt: 0,
      likedAt: remote.createdAt,
      source: remote.source,
    });
  }

  return [...byId.values()];
}

/** The signed-in user's saved smart playlists, newest first. */
export const mySmartPlaylists = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    return await ctx.db
      .query("smartPlaylists")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();
  },
});

/**
 * Every smart playlist with its CURRENTLY matched tracks.
 *
 * Read as one query so the library is assembled once and shared across every
 * rule, rather than once per playlist. Each playlist carries a `description`
 * derived from its rules, so the UI never has to re-derive copy.
 */
export const mySmartPlaylistsResolved = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const rows = await ctx.db
      .query("smartPlaylists")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();
    if (rows.length === 0) return [];
    const library = await buildSmartLibrary(ctx, userId);
    const now = Date.now();
    return rows.map((row) => {
      const rules = normalizeSmartRules(asRules(row.rules));
      const tracks = evaluateSmartRules(library, rules, now);
      return {
        _id: row._id,
        name: row.name,
        rules,
        description: describeSmartRules(rules),
        trackCount: tracks.length,
        tracks,
      };
    });
  },
});

/** Create a smart playlist. Returns the new id. */
export const create = mutation({
  args: { name: v.optional(v.string()), rules: rulesValidator },
  handler: async (ctx, { name, rules }) => {
    const userId = await requireUser(ctx);
    const normalized = normalizeSmartRules(asRules(rules));
    const now = Date.now();
    return await ctx.db.insert("smartPlaylists", {
      userId,
      name: (name?.trim() || defaultSmartName(normalized)).slice(0, 60),
      rules: normalized,
      createdAt: now,
      updatedAt: now,
    });
  },
});

/** Update a smart playlist's name and/or rules. */
export const update = mutation({
  args: {
    playlistId: v.id("smartPlaylists"),
    name: v.optional(v.string()),
    rules: v.optional(rulesValidator),
  },
  handler: async (ctx, { playlistId, name, rules }) => {
    const userId = await requireUser(ctx);
    const row = await ctx.db.get(playlistId);
    if (row === null || row.userId !== userId) {
      throw new ConvexError("Smart playlist not found");
    }
    const patch: {
      updatedAt: number;
      name?: string;
      rules?: ReturnType<typeof normalizeSmartRules>;
    } = { updatedAt: Date.now() };
    if (name !== undefined) {
      const trimmed = name.trim().slice(0, 60);
      if (trimmed) patch.name = trimmed;
    }
    if (rules !== undefined) {
      const normalized = normalizeSmartRules(asRules(rules));
      patch.rules = normalized;
      // Keep the default name in sync when the listener never chose one.
      if (
        name === undefined &&
        row.name === defaultSmartName(normalizeSmartRules(asRules(row.rules)))
      ) {
        patch.name = defaultSmartName(normalized);
      }
    }
    await ctx.db.patch(playlistId, patch);
    return playlistId;
  },
});

/** Delete a smart playlist. */
export const remove = mutation({
  args: { playlistId: v.id("smartPlaylists") },
  handler: async (ctx, { playlistId }) => {
    const userId = await requireUser(ctx);
    const row = await ctx.db.get(playlistId);
    if (row === null || row.userId !== userId) {
      throw new ConvexError("Smart playlist not found");
    }
    await ctx.db.delete(playlistId);
  },
});
