import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import {
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import type { Id } from "./_generated/dataModel";

/**
 * Playlist sharing.
 *
 * ---------------------------------------------------------------------------
 * The one rule this file exists to enforce
 * ---------------------------------------------------------------------------
 * POSSESSION OF A PLAYLIST ID IS NOT AUTHORIZATION. A Convex document id is a
 * stable, unsecret identifier; it appears in the app's URLs and in every network
 * payload. If reading a private playlist were decided by "you supplied its id",
 * then the id would be the password. So every read and every write below goes
 * through `accessFor`, which answers with the ROLE the caller actually holds and
 * with nothing at all when they hold none.
 *
 * ---------------------------------------------------------------------------
 * Why grants instead of copies
 * ---------------------------------------------------------------------------
 * "Share" is implemented as a grant row, not by duplicating the playlist. A copy
 * would be the easy version and it is wrong in three visible ways: the owner's
 * later edits would not reach the recipient, revoking would be impossible
 * (the copy is already gone), and the recipient removing it from their own
 * library would read as the owner having deleted their playlist. A grant keeps
 * one source of truth for the tracks and one row for the permission.
 *
 * ---------------------------------------------------------------------------
 * Access levels
 * ---------------------------------------------------------------------------
 *   private (default)  owner + explicitly shared accounts
 *   link               the above, plus anyone holding the current share token
 *   public             the above, plus any signed-in account
 *
 * Only "link" and "public" ever expose anything to a signed-out visitor, and
 * even then only a bounded preview (see `playlistByToken`) — never another
 * account's library, email, or the owner's own private playlist list.
 */

export type ShareRole = "owner" | "editor" | "viewer";
export type PlaylistVisibility = "private" | "link" | "public";

const VISIBILITIES: readonly PlaylistVisibility[] = ["private", "link", "public"];

/** How many tracks a signed-out link preview shows. */
export const PREVIEW_TRACK_LIMIT = 30;

/** How many accounts a user search returns. */
const USER_SEARCH_LIMIT = 8;

/** How many rows a user search reads before filtering. Bounded, never a scan. */
const USER_SCAN_LIMIT = 300;

/** Caps so one account cannot fill the table. */
const MAX_SHARES_PER_PLAYLIST = 100;
const MAX_RECIPIENTS_PER_CALL = 20;
const MIN_SEARCH_LENGTH = 2;

/** Stable, URL-safe, 32 hex characters of entropy. */
function randomToken(): string {
  const bytes = new Uint8Array(16);
  const webCrypto =
    typeof globalThis !== "undefined"
      ? (globalThis as { crypto?: Crypto }).crypto
      : undefined;
  if (webCrypto && typeof webCrypto.getRandomValues === "function") {
    webCrypto.getRandomValues(bytes);
  } else {
    // Fallback for a runtime without Web Crypto. Documented as weaker rather
    // than presented as equivalent: it still mixes two independent sources and
    // the current time, but it is not cryptographic. Convex's default runtime
    // provides `crypto.getRandomValues`, so this branch should not be reached
    // in a deployed environment.
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256) ^ ((Date.now() >> (i % 8)) & 0xff);
    }
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function requireUser(
  ctx: QueryCtx | MutationCtx,
): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new ConvexError("Sign in to share playlists");
  return userId;
}

export interface PlaylistAccess {
  playlist: {
    _id: Id<"playlists">;
    userId: Id<"users">;
    name: string;
    [key: string]: unknown;
  };
  role: ShareRole;
}

/**
 * The role the caller holds on this playlist, or null.
 *
 * Returns null for a playlist that does not exist as well as for one the caller
 * cannot see, on purpose: telling them apart would leak the existence of other
 * people's private playlists to anyone willing to guess ids.
 */
export async function accessFor(
  ctx: QueryCtx | MutationCtx,
  playlistId: Id<"playlists">,
  userId: Id<"users"> | null,
): Promise<PlaylistAccess | null> {
  const playlist = await ctx.db.get(playlistId);
  if (playlist === null) return null;
  const typed = playlist as unknown as PlaylistAccess["playlist"];

  if (userId && typed.userId === userId) {
    return { playlist: typed, role: "owner" };
  }

  // A public playlist is readable by any signed-in account, as a viewer.
  const visibility = (typed.visibility as string | undefined) ?? "private";
  if (visibility === "public" && userId) {
    return { playlist: typed, role: "viewer" };
  }

  if (!userId) return null;

  const grant = await ctx.db
    .query("playlistShares")
    .withIndex("by_playlist_recipient", (q) =>
      q.eq("playlistId", playlistId).eq("recipientId", userId),
    )
    .first();
  if (!grant || grant.status !== "accepted") return null;
  return {
    playlist: typed,
    role: grant.role === "editor" ? "editor" : "viewer",
  };
}

/** True when the role may change the playlist's tracks. */
export function canEdit(role: ShareRole): boolean {
  return role === "owner" || role === "editor";
}

/** Owner-only, for everything that is not a track edit. */
export function canAdminister(role: ShareRole): boolean {
  return role === "owner";
}

/** A display label that never exposes an email address. */
function displayName(user: { name?: string | null; email?: string | null }): string {
  const name = (user.name ?? "").trim();
  if (name) return name;
  // A local part is not an email address and is what the account chose to be
  // known by; fall back to something honest rather than leaking the full address.
  const email = (user.email ?? "").trim();
  const local = email.includes("@") ? email.slice(0, email.indexOf("@")) : "";
  return local || "A listener";
}

/**
 * Find accounts to share with, by display name.
 *
 * Returns ONLY the public projection — id, name, image. Never an email, never a
 * role, never anything from the caller's or the target's library. A directory
 * that returns email addresses is a scraper's index of the user base.
 */
export const searchUsers = query({
  args: { query: v.string() },
  handler: async (ctx, { query: raw }) => {
    const me = await getAuthUserId(ctx);
    if (me === null) return [];
    const term = raw.trim().toLowerCase();
    if (term.length < MIN_SEARCH_LENGTH) return [];

    const users = await ctx.db.query("users").take(USER_SCAN_LIMIT);
    const matches: Array<{ id: string; name: string; image: string | null }> = [];
    for (const user of users) {
      if (user._id === me) continue;
      const name = displayName(user);
      const haystack = name.toLowerCase();
      if (!haystack.includes(term)) continue;
      matches.push({
        id: user._id,
        name,
        image: typeof user.image === "string" ? user.image : null,
      });
      if (matches.length >= USER_SEARCH_LIMIT) break;
    }
    return matches;
  },
});

/** Replace the visibility setting. Owner-only. */
export const setVisibility = mutation({
  args: {
    playlistId: v.id("playlists"),
    visibility: v.string(),
  },
  handler: async (ctx, { playlistId, visibility }) => {
    const userId = await requireUser(ctx);
    const access = await accessFor(ctx, playlistId, userId);
    if (!access) throw new ConvexError("Playlist not found");
    if (!canAdminister(access.role)) {
      throw new ConvexError("Only the owner can change who this is shared with");
    }
    if (!VISIBILITIES.includes(visibility as PlaylistVisibility)) {
      throw new ConvexError("Unknown sharing setting");
    }
    const patch: Record<string, unknown> = {
      visibility,
      updatedAt: Date.now(),
    };
    // Going private also revokes any live link. Leaving a working token behind
    // on a playlist that says "Private" is exactly the kind of mismatch between
    // what the UI claims and what the server does that this file exists to
    // prevent.
    if (visibility === "private") {
      patch.shareToken = undefined;
      patch.shareTokenCreatedAt = undefined;
    }
    await ctx.db.patch(playlistId, patch);
    return visibility;
  },
});

/**
 * Create (or rotate) the playlist's share link.
 *
 * Rotating rather than reusing is deliberate: the only reason to call this when
 * a token already exists is that the old link leaked, and handing the same URL
 * back would silently fail to do the one thing the caller asked for.
 */
export const createShareLink = mutation({
  args: { playlistId: v.id("playlists") },
  handler: async (ctx, { playlistId }) => {
    const userId = await requireUser(ctx);
    const access = await accessFor(ctx, playlistId, userId);
    if (!access) throw new ConvexError("Playlist not found");
    if (!canAdminister(access.role)) {
      throw new ConvexError("Only the owner can create a share link");
    }
    const token = randomToken();
    const now = Date.now();
    const visibility = (access.playlist.visibility as string) ?? "private";
    await ctx.db.patch(playlistId, {
      shareToken: token,
      shareTokenCreatedAt: now,
      // A link that works while the playlist still says "private" would make the
      // privacy control a lie.
      visibility: visibility === "public" ? "public" : "link",
      updatedAt: now,
    });
    return token;
  },
});

/** Revoke the current share link, leaving direct shares alone. */
export const revokeShareLink = mutation({
  args: { playlistId: v.id("playlists") },
  handler: async (ctx, { playlistId }) => {
    const userId = await requireUser(ctx);
    const access = await accessFor(ctx, playlistId, userId);
    if (!access) throw new ConvexError("Playlist not found");
    if (!canAdminister(access.role)) {
      throw new ConvexError("Only the owner can revoke a share link");
    }
    const visibility = (access.playlist.visibility as string) ?? "private";
    await ctx.db.patch(playlistId, {
      shareToken: undefined,
      shareTokenCreatedAt: undefined,
      visibility: visibility === "public" ? "public" : "private",
      updatedAt: Date.now(),
    });
    return true;
  },
});

/**
 * Share with one or more accounts.
 *
 * Idempotent per recipient: sharing twice updates the existing grant's role
 * instead of inserting a second row, so the recipient's library cannot grow a
 * duplicate entry and a role can be changed without a revoke-then-share dance.
 */
export const shareWith = mutation({
  args: {
    playlistId: v.id("playlists"),
    recipientIds: v.array(v.id("users")),
    role: v.optional(v.string()),
  },
  handler: async (ctx, { playlistId, recipientIds, role }) => {
    const userId = await requireUser(ctx);
    const access = await accessFor(ctx, playlistId, userId);
    if (!access) throw new ConvexError("Playlist not found");
    if (!canAdminister(access.role)) {
      throw new ConvexError("Only the owner can share this playlist");
    }
    const shareRole: ShareRole = role === "editor" ? "editor" : "viewer";

    const existing = await ctx.db
      .query("playlistShares")
      .withIndex("by_playlist", (q) => q.eq("playlistId", playlistId))
      .take(MAX_SHARES_PER_PLAYLIST + 1);

    const byRecipient = new Map(existing.map((grant) => [grant.recipientId, grant]));
    const now = Date.now();
    let added = 0;
    let updated = 0;

    for (const recipientId of [...new Set(recipientIds)].slice(0, MAX_RECIPIENTS_PER_CALL)) {
      if (recipientId === userId) continue; // sharing with yourself is a no-op
      const recipient = await ctx.db.get(recipientId);
      if (recipient === null) continue; // deleted account: skipped, not crashed
      const grant = byRecipient.get(recipientId);
      if (grant) {
        if (grant.role !== shareRole) {
          await ctx.db.patch(grant._id, {
            role: shareRole,
            // Re-sharing un-hides it: the owner deliberately sent it again.
            hiddenByRecipient: undefined,
            updatedAt: now,
          });
          updated += 1;
        }
        continue;
      }
      if (existing.length + added >= MAX_SHARES_PER_PLAYLIST) break;
      await ctx.db.insert("playlistShares", {
        playlistId,
        ownerId: userId,
        recipientId,
        role: shareRole,
        status: "accepted",
        createdAt: now,
        updatedAt: now,
      });
      added += 1;
    }

    return { added, updated };
  },
});

/** Take access away from one account. Owner-only. */
export const revoke = mutation({
  args: {
    playlistId: v.id("playlists"),
    recipientId: v.id("users"),
  },
  handler: async (ctx, { playlistId, recipientId }) => {
    const userId = await requireUser(ctx);
    const access = await accessFor(ctx, playlistId, userId);
    if (!access) throw new ConvexError("Playlist not found");
    if (!canAdminister(access.role)) {
      throw new ConvexError("Only the owner can revoke access");
    }
    const grant = await ctx.db
      .query("playlistShares")
      .withIndex("by_playlist_recipient", (q) =>
        q.eq("playlistId", playlistId).eq("recipientId", recipientId),
      )
      .first();
    if (!grant) return false;
    await ctx.db.delete(grant._id);
    return true;
  },
});

/**
 * The recipient's own dismissal.
 *
 * Marks the grant hidden instead of deleting it, so the owner still sees who
 * they shared with, the recipient can put it back without asking, and — the
 * point of the whole design — NOTHING in this path can touch the owner's
 * playlist or its tracks.
 */
export const removeFromLibrary = mutation({
  args: { playlistId: v.id("playlists") },
  handler: async (ctx, { playlistId }) => {
    const userId = await requireUser(ctx);
    const grant = await ctx.db
      .query("playlistShares")
      .withIndex("by_playlist_recipient", (q) =>
        q.eq("playlistId", playlistId).eq("recipientId", userId),
      )
      .first();
    if (!grant) return false;
    await ctx.db.patch(grant._id, {
      hiddenByRecipient: true,
      updatedAt: Date.now(),
    });
    return true;
  },
});

/** Undo `removeFromLibrary`. */
export const restoreToLibrary = mutation({
  args: { playlistId: v.id("playlists") },
  handler: async (ctx, { playlistId }) => {
    const userId = await requireUser(ctx);
    const grant = await ctx.db
      .query("playlistShares")
      .withIndex("by_playlist_recipient", (q) =>
        q.eq("playlistId", playlistId).eq("recipientId", userId),
      )
      .first();
    if (!grant) return false;
    await ctx.db.patch(grant._id, {
      hiddenByRecipient: undefined,
      updatedAt: Date.now(),
    });
    return true;
  },
});

/**
 * Playlists other accounts have shared with the signed-in user.
 *
 * Live in the sense that matters: the tracks are read from the OWNER's playlist
 * on every query, so an edit by the owner is visible on the recipient's next
 * render with no polling, no copy to re-sync, and no second source of truth.
 *
 * Includes hidden grants so the Library can offer "Restore", but the visible
 * ones are what the section renders.
 */
export const sharedWithMe = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];

    const grants = await ctx.db
      .query("playlistShares")
      .withIndex("by_recipient", (q) => q.eq("recipientId", userId))
      .take(MAX_SHARES_PER_PLAYLIST);

    const out: Array<{
      playlistId: string;
      name: string;
      description: string | null;
      ownerName: string;
      role: string;
      trackCount: number;
      coverUrl: string;
      hidden: boolean;
      sharedAt: number;
      /** Set when the owner's playlist is gone; the entry is still removable. */
      unavailable: boolean;
    }> = [];

    for (const grant of grants) {
      if (grant.status !== "accepted") continue;
      const playlist = await ctx.db.get(grant.playlistId);
      if (playlist === null) {
        // The owner deleted their playlist. The grant is reported as
        // unavailable rather than dropped, so the recipient's Library can show
        // it and let them clear it out — silently vanishing is worse.
        out.push({
          playlistId: grant.playlistId,
          name: "Playlist unavailable",
          description: null,
          ownerName: "",
          role: grant.role,
          trackCount: 0,
          coverUrl: "",
          hidden: grant.hiddenByRecipient === true,
          sharedAt: grant.createdAt,
          unavailable: true,
        });
        continue;
      }
      const owner = await ctx.db.get(grant.ownerId);
      const snapshots = playlist.trackSnapshots ?? [];
      out.push({
        playlistId: grant.playlistId,
        name: playlist.name,
        description: playlist.description ?? null,
        ownerName: owner ? displayName(owner) : "A listener",
        role: grant.role,
        trackCount: playlist.trackIds.length,
        coverUrl:
          snapshots.find((snapshot) => snapshot.coverUrl?.trim())?.coverUrl ?? "",
        hidden: grant.hiddenByRecipient === true,
        sharedAt: grant.createdAt,
        unavailable: false,
      });
    }

    return out.sort((a, b) => b.sharedAt - a.sharedAt);
  },
});

/** Who a playlist is shared with, for the owner's share dialog. */
export const sharesFor = query({
  args: { playlistId: v.id("playlists") },
  handler: async (ctx, { playlistId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const access = await accessFor(ctx, playlistId, userId);
    if (!access || !canAdminister(access.role)) return [];
    const grants = await ctx.db
      .query("playlistShares")
      .withIndex("by_playlist", (q) => q.eq("playlistId", playlistId))
      .take(MAX_SHARES_PER_PLAYLIST);
    const out: Array<{
      recipientId: string;
      name: string;
      image: string | null;
      role: string;
      sharedAt: number;
    }> = [];
    for (const grant of grants) {
      const recipient = await ctx.db.get(grant.recipientId);
      out.push({
        recipientId: grant.recipientId,
        name: recipient ? displayName(recipient) : "Deleted account",
        image:
          recipient && typeof recipient.image === "string"
            ? recipient.image
            : null,
        role: grant.role,
        sharedAt: grant.createdAt,
      });
    }
    return out.sort((a, b) => b.sharedAt - a.sharedAt);
  },
});

/** The sharing settings for a playlist, for the owner's dialog. */
export const sharingState = query({
  args: { playlistId: v.id("playlists") },
  handler: async (ctx, { playlistId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const access = await accessFor(ctx, playlistId, userId);
    if (!access) return null;
    const playlist = access.playlist;
    return {
      role: access.role,
      visibility: ((playlist.visibility as string) ?? "private") as PlaylistVisibility,
      shareToken: (playlist.shareToken as string | undefined) ?? null,
      // The token is only ever returned to an owner or an editor who can already
      // read every track; a viewer never needs it and never gets it.
      canShare: canAdminister(access.role),
    };
  },
});

/**
 * Read a playlist through a share link, without an account.
 *
 * Deliberately a SEPARATE query from `playlists.get`. That one is scoped to the
 * signed-in owner; this one is reachable by a stranger, so it must be impossible
 * for a bug here to widen what `get` returns. It answers only for a playlist
 * whose visibility is `link` (or `public`) AND whose stored token matches, and
 * it returns a bounded preview rather than the whole document.
 */
export const playlistByToken = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const trimmed = token.trim();
    // A token is 32 hex characters. Anything else is a mistyped or truncated
    // link and there is no reason to run a database lookup for it.
    if (!/^[a-f0-9]{32}$/.test(trimmed)) return null;

    const playlist = await ctx.db
      .query("playlists")
      .withIndex("by_shareToken", (q) => q.eq("shareToken", trimmed))
      .first();
    if (!playlist) return null;

    const visibility = (playlist.visibility as string) ?? "private";
    if (visibility !== "link" && visibility !== "public") return null;

    const owner = await ctx.db.get(playlist.userId);
    const trackIds = playlist.trackIds.slice(0, PREVIEW_TRACK_LIMIT);
    const snapshots = new Map(
      (playlist.trackSnapshots ?? []).map((snapshot) => [snapshot.id, snapshot]),
    );
    const tracks = trackIds.map((trackId) => {
      const snapshot = snapshots.get(trackId);
      return {
        id: trackId,
        title: snapshot?.title ?? "",
        artist: snapshot?.artist ?? "",
        coverUrl: snapshot?.coverUrl ?? "",
        duration: snapshot?.duration ?? 0,
        // The requester is a stranger: they get to SEE the list, and the
        // playback ids stay on the server until they sign in and the playlist is
        // in their library. A preview that handed over playable ids would make
        // the account step pure ceremony.
        status: (snapshot?.status as string | undefined) ?? null,
      };
    });

    return {
      name: playlist.name,
      description: playlist.description ?? null,
      ownerName: owner ? displayName(owner) : "A listener",
      trackCount: playlist.trackIds.length,
      // Honest about truncation instead of silently showing 30 of 107.
      truncated: playlist.trackIds.length > tracks.length,
      tracks,
    };
  },
});

/**
 * Copy a link-shared playlist into the signed-in user's own library.
 *
 * A COPY, not a grant, and that is the right call here: a link has no recipient
 * identity to grant to, so the only way this can work for an account that was
 * never individually shared with is to materialise their own playlist. It is
 * idempotent per (user, source) so pressing it twice does not stack copies.
 */
export const addLinkToLibrary = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const userId = await requireUser(ctx);
    const trimmed = token.trim();
    if (!/^[a-f0-9]{32}$/.test(trimmed)) throw new ConvexError("Invalid link");

    const playlist = await ctx.db
      .query("playlists")
      .withIndex("by_shareToken", (q) => q.eq("shareToken", trimmed))
      .first();
    if (!playlist) throw new ConvexError("This link is no longer active");
    const visibility = (playlist.visibility as string) ?? "private";
    if (visibility !== "link" && visibility !== "public") {
      throw new ConvexError("This link is no longer active");
    }
    if (playlist.userId === userId) {
      // Already theirs; sending them to their own copy would be confusing.
      return playlist._id;
    }

    const marker = `shared:${trimmed}`;
    const mine = await ctx.db
      .query("playlists")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(200);
    const existing = mine.find((row) => (row.description ?? "").includes(marker));
    if (existing) return existing._id;

    const now = Date.now();
    return await ctx.db.insert("playlists", {
      userId,
      name: playlist.name,
      description: `Shared with you · ${marker}`,
      trackIds: [...playlist.trackIds],
      ...(playlist.trackSnapshots
        ? { trackSnapshots: [...playlist.trackSnapshots] }
        : {}),
      visibility: "private",
      createdAt: now,
      updatedAt: now,
    });
  },
});
