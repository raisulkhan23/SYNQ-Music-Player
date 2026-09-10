import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";

/**
 * Toggle the liked state of a catalog track for the signed-in user.
 * Returns the new liked state (true = now liked).
 */
export const toggleLike = mutation({
  args: { trackId: v.string() },
  handler: async (ctx, { trackId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new ConvexError("Sign in to like songs");
    }

    const existing = await ctx.db
      .query("likedSongs")
      .withIndex("by_user_track", (q) => q.eq("userId", userId).eq("trackId", trackId))
      .first();

    if (existing !== null) {
      await ctx.db.delete(existing._id);
      return false;
    }

    await ctx.db.insert("likedSongs", {
      userId,
      trackId,
      createdAt: Date.now(),
    });
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

    return likes.map((like) => ({ trackId: like.trackId, createdAt: like.createdAt }));
  },
});