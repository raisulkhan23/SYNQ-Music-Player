import { getAuthUserId } from "@convex-dev/auth/server";
import { query } from "./_generated/server";

/**
 * Everything the signed-in account has stored, in one payload.
 *
 * The "Your data" section could delete a user's history but not hand it to
 * them: if someone wanted their data out of SYNQ (or just wanted a backup
 * before clearing something), the only route was a support request. One query
 * instead of four so the export is a consistent snapshot of the account
 * rather than four reads that can disagree.
 *
 * Scoped to the caller's own id — this is a data export, not an admin tool,
 * and it must never be able to reach another account's rows.
 */
export const exportData = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const user = await ctx.db.get(userId);
    if (user === null) return null;

    const [likes, likedRemote, playlists, history] = await Promise.all([
      ctx.db
        .query("likedSongs")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect(),
      ctx.db
        .query("likedRemote")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect(),
      ctx.db
        .query("playlists")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect(),
      ctx.db
        .query("playHistory")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect(),
    ]);

    return {
      exportedAt: new Date().toISOString(),
      profile: {
        id: user._id,
        name: user.name ?? null,
        email: user.email ?? null,
        image: user.image ?? null,
        role: user.role ?? null,
        isAnonymous: user.isAnonymous ?? false,
        createdAt: new Date(user._creationTime).toISOString(),
      },
      // Local (catalog) likes.
      likes: likes.map((l) => ({
        trackId: l.trackId,
        likedAt: new Date(l.createdAt).toISOString(),
      })),
      // Remote (YouTube) likes keep their own metadata snapshot, otherwise an
      // export of a listener's library would be a list of bare video ids.
      likedRemote: likedRemote.map((l) => ({
        ...l,
        likedAt: new Date(l.createdAt).toISOString(),
      })),
      playlists: playlists.map((p) => ({
        id: p._id,
        name: p.name,
        description: p.description ?? null,
        tracks: p.trackSnapshots ?? p.trackIds,
        createdAt: new Date(p.createdAt).toISOString(),
        updatedAt: new Date(p.updatedAt).toISOString(),
      })),
      history: history
        .map((h) => ({
          trackId: h.trackId,
          title: h.title ?? null,
          artistName: h.artistName ?? null,
          source: h.source ?? null,
          playCount: h.playCount,
          lastPlayedAt: new Date(h.playedAt).toISOString(),
        }))
        .sort((a, b) => b.lastPlayedAt.localeCompare(a.lastPlayedAt)),
    };
  },
});
