import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

/**
 * Cross-account playlist sharing.
 *
 * Model: one row per grant in the `playlistShares` table (see schema.ts).
 * Sharing is VIEW-ONLY by design: the owner keeps every edit right, and each
 * existing playlist mutation already re-checks ownership against
 * `playlist.userId` — a recipient's grant never extends to editing, so view
 * is the only permission this module has to reason about.
 *
 * Two separate recipient-side concepts, deliberately kept apart:
 *  - ACCESS: the grant row itself. Lets the recipient open the playlist.
 *  - LIBRARY REFERENCE: the row's `saved` flag. Controls whether the
 *    playlist is listed in the recipient's library. Removing the reference
 *    (saved=false) must not revoke access, and revoking the grant (row
 *    deleted) removes both at once.
 *
 * Security: every function here authenticates first and authorizes against
 * the row's owner/recipient — never against client-supplied ids alone, and
 * never via the frontend. Recipient display names come from the users table
 * but explicitly exclude email addresses. Anonymous sessions are ephemeral
 * guests, so they are rejected as recipients.
 */

/** How many user rows one recipient search reads. Bounded like social.ts. */
const USER_SCAN_LIMIT = 200;
/** Upper bound on matches shown for one search. */
const USER_MATCH_LIMIT = 8;

async function requireUser(ctx: MutationCtx): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new ConvexError("Sign in to share playlists");
  }
  return userId;
}

/**
 * Share one of YOUR playlists with one registered user.
 *
 * Creates the grant if none exists, or returns the existing one — sharing the
 * same playlist with the same person twice is a no-op, not a duplicate.
 * Editing an existing grant is impossible through this function; the owner
 * has to revoke first. Anonymous sessions cannot be recipients because they
 * are ephemeral guests, not accounts.
 */
export const sharePlaylist = mutation({
  args: {
    playlistId: v.id("playlists"),
    recipientId: v.id("users"),
  },
  handler: async (ctx, { playlistId, recipientId }) => {
    const ownerId = await requireUser(ctx);

    // The playlist must belong to the caller. Non-owners share nothing.
    const playlist = await ctx.db.get(playlistId);
    if (playlist === null || playlist.userId !== ownerId) {
      throw new ConvexError("You can only share your own playlist");
    }

    // The recipient must be a real, non-anonymous account. An anonymous
    // session evaporates with its browser tab and cannot be trusted as a
    // durable recipient; sharing with yourself is a meaningless grant.
    if (recipientId === ownerId) {
      throw new ConvexError("That is already yours");
    }
    const recipient = await ctx.db.get(recipientId);
    if (recipient === null || recipient.isAnonymous === true) {
      throw new ConvexError("That person doesn't have a SYNQ account");
    }

    // Duplicate invitations collapse into the existing row.
    const existing = await ctx.db
      .query("playlistShares")
      .withIndex("by_grant", (q) =>
        q.eq("playlistId", playlistId).eq("recipientId", recipientId),
      )
      .collect();
    if (existing[0]) return existing[0]._id;

    return await ctx.db.insert("playlistShares", {
      playlistId,
      ownerId,
      recipientId,
      saved: false,
      createdAt: Date.now(),
    });
  },
});

/**
 * Revoke a share. The OWNER decides; a recipient is never able to revoke
 * somebody else's access to their own playlist.
 */
export const revokeShare = mutation({
  args: {
    playlistId: v.id("playlists"),
    recipientId: v.id("users"),
  },
  handler: async (ctx, { playlistId, recipientId }) => {
    const ownerId = await requireUser(ctx);
    const playlist = await ctx.db.get(playlistId);
    if (playlist === null || playlist.userId !== ownerId) {
      throw new ConvexError("You can only manage your own playlist");
    }
    const grants = await ctx.db
      .query("playlistShares")
      .withIndex("by_grant", (q) =>
        q.eq("playlistId", playlistId).eq("recipientId", recipientId),
      )
      .collect();
    for (const grant of grants) {
      await ctx.db.delete(grant._id);
    }
    return grants.length;
  },
});

/**
 * Who has access to one of MY playlists. Owner-only; recipients get a
 * display name and avatar and nothing else — no emails, no raw account
 * metadata beyond what the share row already implies.
 */
export const accessList = query({
  args: { playlistId: v.id("playlists") },
  handler: async (ctx, { playlistId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const playlist = await ctx.db.get(playlistId);
    if (playlist === null || playlist.userId !== userId) return [];
    const grants = await ctx.db
      .query("playlistShares")
      .withIndex("by_playlist", (q) => q.eq("playlistId", playlistId))
      .order("desc")
      .take(200);
    return await Promise.all(
      grants.map(async (grant) => {
        const recipient = await ctx.db.get(grant.recipientId);
        return {
          recipientId: grant.recipientId,
          name: recipient?.name ?? "SYNQ listener",
          image: recipient?.image,
          saved: grant.saved,
          sharedAt: grant.createdAt,
        };
      }),
    );
  },
});

/**
 * The signed-in recipient's view: every playlist shared with me, with my
 * library-reference state. Unsaved grants ARE included — that is how a
 * recipient discovers a playlist they were sent but never added; the library
 * page renders only the `saved` ones.
 */
export const sharedWithMe = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const grants = await ctx.db
      .query("playlistShares")
      .withIndex("by_recipient", (q) => q.eq("recipientId", userId))
      .order("desc")
      .take(200);
    const out: Array<{
      playlistId: Id<"playlists">;
      name: string;
      description?: string;
      trackIds: string[];
      trackSnapshots?: Array<{
        id: string;
        title: string;
        artist: string;
        album?: string;
        coverUrl: string;
        duration: number;
        youtubeId?: string;
      }>;
      ownerId: Id<"users">;
      ownerName: string;
      saved: boolean;
      sharedAt: number;
    }> = [];
    for (const grant of grants) {
      const playlist = await ctx.db.get(grant.playlistId);
      // A deleted playlist leaves an orphan grant; it is skipped. The owner's
      // next share/revoke on that playlist, or a cleanup pass, reaps the row.
      if (playlist === null) continue;
      const owner = await ctx.db.get(grant.ownerId);
      out.push({
        playlistId: grant.playlistId,
        name: playlist.name,
        description: playlist.description,
        trackIds: playlist.trackIds,
        trackSnapshots: playlist.trackSnapshots,
        ownerId: grant.ownerId,
        ownerName: owner?.name ?? "SYNQ listener",
        saved: grant.saved,
        sharedAt: grant.createdAt,
      });
    }
    return out;
  },
});

/** Toggle whether one playlist shared with ME is listed in my library. */
export const setSavedInLibrary = mutation({
  args: {
    playlistId: v.id("playlists"),
    saved: v.boolean(),
  },
  handler: async (ctx, { playlistId, saved }) => {
    const userId = await requireUser(ctx);
    const grants = await ctx.db
      .query("playlistShares")
      .withIndex("by_grant", (q) =>
        q.eq("playlistId", playlistId).eq("recipientId", userId),
      )
      .collect();
    const grant = grants[0];
    // Only the recipient of an existing grant flips this flag. A non-existent
    // grant means no access, which a forged id cannot bypass.
    if (grant === undefined) {
      throw new ConvexError("This playlist isn't shared with you");
    }
    await ctx.db.patch(grant._id, { saved });
    return grant._id;
  },
});

/**
 * Find registered users to share with, by display name.
 *
 * Bounded scan of the users table (names change, so no index on purpose), so
 * the match window is capped. Anonymous guests are invisible, every viewer is
 * excluded from their own results, and NOTHING beyond name and avatar is
 * returned: emails and account metadata never leave the backend.
 */
export const searchShareableUsers = query({
  args: { query: v.string() },
  handler: async (ctx, { query: needle }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const trimmed = needle.trim().toLowerCase();
    if (trimmed.length < 2) return [];
    const users = await ctx.db.query("users").take(USER_SCAN_LIMIT);
    const matches: Array<{ userId: Id<"users">; name: string; image?: string }> = [];
    for (const user of users) {
      if (matches.length >= USER_MATCH_LIMIT) break;
      // Never offer the viewer themselves: sharing with your own account is
      // rejected downstream, so showing it is a dead end in the UI.
      if (user._id === userId) continue;
      if (user.isAnonymous === true) continue;
      const name = (user.name ?? "").trim();
      if (!name) continue;
      if (name.toLowerCase().includes(trimmed)) {
        matches.push({ userId: user._id, name, image: user.image });
      }
    }
    return matches;
  },
});
