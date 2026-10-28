import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";

/**
 * Toggle the liked state of a track for the signed-in user. Catalog tracks
 * are stored by id only; remote tracks (YouTube/Spotify chart items) also
 * store a snapshot so they can be rendered and replayed from Liked Songs.
 * Returns the new liked state (true = now liked).
 */
export const toggleLike = mutation({
  args: {
    trackId: v.string(),
    remote: v.optional(
      v.object({
        title: v.string(),
        artistName: v.string(),
        coverUrl: v.string(),
        duration: v.number(),
        youtubeId: v.optional(v.string()),
        source: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { trackId, remote }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new ConvexError("Sign in to like songs");
    }

    const existing = await ctx.db
      .query("likedSongs")
      .withIndex("by_user_track", (q) =>
        q.eq("userId", userId).eq("trackId", trackId),
      )
      .first();

    if (existing !== null) {
      await ctx.db.delete(existing._id);
      // Clean up any remote snapshot for this id as well.
      const remoteRow = await ctx.db
        .query("likedRemote")
        .withIndex("by_user_track", (q) =>
          q.eq("userId", userId).eq("trackId", trackId),
        )
        .first();
      if (remoteRow !== null) await ctx.db.delete(remoteRow._id);
      return false;
    }

    await ctx.db.insert("likedSongs", {
      userId,
      trackId,
      createdAt: Date.now(),
    });

    if (remote) {
      // Upsert the snapshot so re-liking refreshes metadata.
      const prev = await ctx.db
        .query("likedRemote")
        .withIndex("by_user_track", (q) =>
          q.eq("userId", userId).eq("trackId", trackId),
        )
        .first();
      const doc = {
        userId,
        trackId,
        title: remote.title,
        artistName: remote.artistName,
        coverUrl: remote.coverUrl,
        duration: remote.duration,
        youtubeId: remote.youtubeId,
        source: remote.source ?? "youtube",
        createdAt: Date.now(),
      };
      if (prev !== null) await ctx.db.replace(prev._id, doc);
      else await ctx.db.insert("likedRemote", doc);
    }

    return true;
  },
});

/**
 * All liked track ids for the signed-in user, most recently liked first.
 */
export const myLikedTrackIds = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return [];
    }

    const likes = await ctx.db
      .query("likedSongs")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();

    return likes.map((like) => ({
      trackId: like.trackId,
      createdAt: like.createdAt,
    }));
  },
});

/** Shape of a stored remote like, as returned to the client. */
export interface RemoteLike {
  trackId: string;
  title: string;
  artistName: string;
  coverUrl: string;
  duration: number;
  youtubeId?: string;
  source: string;
}

/**
 * Snapshots for liked remote (non-catalog) tracks, most recently liked first.
 */
export const myLikedRemote = query({
  args: {},
  handler: async (ctx): Promise<RemoteLike[]> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];

    const rows = await ctx.db
      .query("likedRemote")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();

    return rows.map((r) => ({
      trackId: r.trackId,
      title: r.title,
      artistName: r.artistName,
      coverUrl: r.coverUrl,
      duration: r.duration,
      youtubeId: r.youtubeId,
      source: r.source,
    }));
  },
});
