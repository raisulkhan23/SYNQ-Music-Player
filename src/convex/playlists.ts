import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { mutation, query, MutationCtx } from "./_generated/server";

const requireUser = async (ctx: MutationCtx) => {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new ConvexError("Sign in to manage playlists");
  }
  return userId;
};

/**
 * Create a playlist for the signed-in user. Returns the new playlist id.
 */
export const create = mutation({
  args: { name: v.string(), description: v.optional(v.string()) },
  handler: async (ctx, { name, description }) => {
    const userId = await requireUser(ctx);
    const now = Date.now();
    const id = await ctx.db.insert("playlists", {
      userId,
      name: name.trim() || "New playlist",
      description,
      trackIds: [],
      createdAt: now,
      updatedAt: now,
    });
    return id;
  },
});

/**
 * Delete one of the signed-in user's playlists.
 */
export const remove = mutation({
  args: { playlistId: v.id("playlists") },
  handler: async (ctx, { playlistId }) => {
    const userId = await requireUser(ctx);
    const playlist = await ctx.db.get(playlistId);
    if (playlist === null || playlist.userId !== userId) {
      throw new ConvexError("Playlist not found");
    }
    await ctx.db.delete(playlistId);
  },
});

/**
 * Rename one of the signed-in user's playlists.
 */
export const rename = mutation({
  args: { playlistId: v.id("playlists"), name: v.string() },
  handler: async (ctx, { playlistId, name }) => {
    const userId = await requireUser(ctx);
    const playlist = await ctx.db.get(playlistId);
    if (playlist === null || playlist.userId !== userId) {
      throw new ConvexError("Playlist not found");
    }
    await ctx.db.patch(playlistId, {
      name: name.trim() || playlist.name,
      updatedAt: Date.now(),
    });
  },
});

/**
 * Add a catalog track to a playlist (no duplicates).
 */
export const addTrack = mutation({
  args: { playlistId: v.id("playlists"), trackId: v.string() },
  handler: async (ctx, { playlistId, trackId }) => {
    const userId = await requireUser(ctx);
    const playlist = await ctx.db.get(playlistId);
    if (playlist === null || playlist.userId !== userId) {
      throw new ConvexError("Playlist not found");
    }
    if (!playlist.trackIds.includes(trackId)) {
      await ctx.db.patch(playlistId, {
        trackIds: [...playlist.trackIds, trackId],
        updatedAt: Date.now(),
      });
    }
  },
});

/**
 * Remove a catalog track from a playlist.
 */
export const removeTrack = mutation({
  args: { playlistId: v.id("playlists"), trackId: v.string() },
  handler: async (ctx, { playlistId, trackId }) => {
    const userId = await requireUser(ctx);
    const playlist = await ctx.db.get(playlistId);
    if (playlist === null || playlist.userId !== userId) {
      throw new ConvexError("Playlist not found");
    }
    await ctx.db.patch(playlistId, {
      trackIds: playlist.trackIds.filter((id) => id !== trackId),
      updatedAt: Date.now(),
    });
  },
});

/**
 * The signed-in user's playlists, most recently updated first.
 */
export const myPlaylists = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return [];
    }
    return await ctx.db
      .query("playlists")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();
  },
});

/**
 * A single playlist owned by the signed-in user.
 */
export const get = query({
  args: { playlistId: v.id("playlists") },
  handler: async (ctx, { playlistId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return null;
    }
    const playlist = await ctx.db.get(playlistId);
    if (playlist === null || playlist.userId !== userId) {
      return null;
    }
    return playlist;
  },
});