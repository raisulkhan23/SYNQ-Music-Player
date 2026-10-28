import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./_generated/server";

/**
 * Single-profile preferences sync.
 *
 * SYNQ has one profile per account, so "sync settings across devices" is a
 * single JSON blob per user, last write wins. The blob holds UI preferences
 * only (volume, theme, wallpaper key, playback prefs); the ALLOWED_KEYS
 * whitelist on the client decides what goes in, and this module enforces the
 * size cap server-side so a runaway client cannot park megabytes in the
 * database. It never stores auth material — those live in Convex Auth's own
 * tables and never leave them.
 */

/** A 32 KiB blob is far more than any real preference set needs. */
const MAX_PREFS_BYTES = 32 * 1024;

/** The signed-in caller's stored preferences, or null when none yet. */
export const get = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const row = await ctx.db
      .query("userPreferences")
      .withIndex("byUser", (q) => q.eq("userId", userId))
      .unique();
    return row ? { prefs: row.prefs, updatedAt: row.updatedAt } : null;
  },
});

/**
 * Replace the caller's preferences wholesale.
 *
 * Whole-blob rather than per-field: the client owns the merge (it hydrates
 * local defaults first, layers the server blob on top, and pushes the merged
 * result on change), so the server does not need to know any key names —
 * only that the payload is small, opaque and belongs to the caller.
 */
export const put = mutation({
  args: { prefs: v.any() },
  handler: async (ctx, { prefs }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not signed in");

    const serialized = JSON.stringify(prefs);
    if (serialized.length > MAX_PREFS_BYTES) {
      throw new Error("Preferences payload too large");
    }

    const existing = await ctx.db
      .query("userPreferences")
      .withIndex("byUser", (q) => q.eq("userId", userId))
      .unique();

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { prefs, updatedAt: now });
    } else {
      await ctx.db.insert("userPreferences", { userId, prefs, updatedAt: now });
    }
    return { updatedAt: now };
  },
});
