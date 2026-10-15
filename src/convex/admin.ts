import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import {
  action,
  mutation,
  query,
  MutationCtx,
  QueryCtx,
} from "./_generated/server";
// Relative, not the `@/` alias: the Convex bundler does not resolve it.
import { summariseVisits } from "../lib/visitAnalytics";

type Ctx = QueryCtx | MutationCtx;

const getAdminUser = async (ctx: Ctx) => {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new ConvexError("Sign in to access the admin area");
  }
  const user = await ctx.db.get(userId);
  if (user === null || user.role !== "admin") {
    throw new ConvexError("Admin access required");
  }
  return userId;
};

/**
 * Bootstrap: the very first account on the deployment becomes an admin so the
 * workspace can be managed from day one. No-op for everyone else.
 */
export const claimAdminIfEmpty = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return false;

    const me = await ctx.db.get(userId);
    if (me === null || me.role !== undefined) return false;

    const users = await scanAll(ctx.db.query("users"));
    const adminExists = users.some((u) => u.role === "admin");
    if (adminExists) return false;

    await ctx.db.patch(userId, { role: "admin" });
    return true;
  },
});

/**
 * Admin status + headline numbers. Returns null when the caller is not an
 * admin so the UI can render a clean "restricted" state.
 */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;

    const me = await ctx.db.get(userId);
    if (me === null || me.role !== "admin") return null;

    const [users, playlists, likes] = await Promise.all([
      scanAll(ctx.db.query("users")),
      scanAll(ctx.db.query("playlists")),
      scanAll(ctx.db.query("likedSongs")),
    ]);

    return {
      isAdmin: true,
      counts: {
        users: users.length,
        admins: users.filter((u) => u.role === "admin").length,
        playlists: playlists.length,
        likes: likes.length,
      },
    };
  },
});

/**
 * Normalize a Convex Auth provider id into the slug the admin UI filters on.
 *
 * The `authAccounts.provider` column stores whatever id the provider was
 * registered with ("github", "google", "email-otp", "anonymous", …), and the
 * built-in email provider is registered by the deployment as "email" or
 * "email-otp" depending on config. Anything we don't recognise is kept as-is
 * (lowercased) so it still shows up under the "Other" bucket instead of
 * silently disappearing from the accounts table.
 */
function normalizeAuthProvider(raw: string | undefined | null): string {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return "unknown";
  if (value.includes("github")) return "github";
  if (value.includes("google")) return "google";
  if (value.includes("anonymous") || value.includes("guest"))
    return "anonymous";
  if (value.includes("email") || value.includes("otp")) return "email-otp";
  if (value.includes("password")) return "password";
  if (value.includes("phone")) return "phone";
  return value;
}

/**
 * Ceiling on how many documents any one admin query will read.
 *
 * Every admin view was a bare `.collect()`. Convex enforces a per-query read
 * budget, so past a few thousand rows the whole admin panel — including the
 * accounts list behind the CSV export — stopped loading at all, and there was
 * no way to tell that apart from "the page is broken". Bounded reads turn a
 * hard failure into a page that renders the most recent slice.
 */
export const ADMIN_SCAN_LIMIT = 2000;

/** A bounded stand-in for `collect()`, for the admin views. */
function scanAll<T>(reader: {
  take: (n: number) => Promise<T[]>;
}): Promise<T[]> {
  return reader.take(ADMIN_SCAN_LIMIT);
}

/** Every account on the deployment (admin only). */
export const listUsers = query({
  args: {},
  handler: async (ctx) => {
    await getAdminUser(ctx);
    const users = await scanAll(ctx.db.query("users"));
    // Enrich with the auth provider(s) each account signed up with —
    // Convex Auth keeps one authAccounts row per linked credential
    // ("github", "google", "email-otp", "anonymous", …). Both fields live on
    // the row itself: `provider` is the registered provider id and
    // `providerAccountId` is the external id (e.g. the GitHub numeric id).
    const accounts = await scanAll(ctx.db.query("authAccounts"));
    const byUser = new Map<
      string,
      { provider: string; accountId: string | null }[]
    >();
    for (const acc of accounts) {
      const arr = byUser.get(acc.userId) ?? [];
      arr.push({
        provider: normalizeAuthProvider(acc.provider),
        accountId: acc.providerAccountId ?? null,
      });
      byUser.set(acc.userId, arr);
    }
    return users
      .map((u) => ({
        _id: u._id,
        _creationTime: u._creationTime,
        name: u.name ?? null,
        email: u.email ?? null,
        image: u.image ?? null,
        isAnonymous: u.isAnonymous ?? false,
        role: u.role ?? null,
        providers: (byUser.get(u._id) ?? []).map((a) => a.provider),
        githubId:
          (byUser.get(u._id) ?? []).find((a) => a.provider === "github")
            ?.accountId ?? null,
      }))
      .sort((a, b) => a._creationTime - b._creationTime);
  },
});

/**
 * Resolve GitHub account details for a user (admin only). Uses the public
 * GitHub API with the external account id stored by Convex Auth — no token
 * needed for public profile info.
 */
export const githubProfile = action({
  args: { githubId: v.string() },
  handler: async (_ctx, { githubId }) => {
    const numeric = githubId.replace(/[^0-9]/g, "");
    const res = await fetch(`https://api.github.com/user/${numeric}`, {
      headers: {
        "User-Agent": "soniq-admin",
        Accept: "application/vnd.github+json",
      },
    });
    if (!res.ok) return null;
    const j = (await res.json()) as Record<string, unknown>;
    return {
      login: (j.login as string) ?? null,
      name: (j.name as string) ?? null,
      avatarUrl: (j.avatar_url as string) ?? null,
      htmlUrl: (j.html_url as string) ?? null,
      publicRepos: (j.public_repos as number) ?? 0,
      createdAt: (j.created_at as string) ?? null,
    };
  },
});

/** Moderate: delete any playlist (admin only). */
export const moderateDeletePlaylist = mutation({
  args: { playlistId: v.id("playlists") },
  handler: async (ctx, { playlistId }) => {
    await getAdminUser(ctx);
    await ctx.db.delete(playlistId);
  },
});

/** Promote or demote a user (admin only; you cannot change your own role). */
export const setRole = mutation({
  args: {
    userId: v.id("users"),
    role: v.union(
      v.literal("admin"),
      v.literal("user"),
      v.literal("member"),
      v.null(),
    ),
  },
  handler: async (ctx, { userId, role }) => {
    const adminId = await getAdminUser(ctx);
    if (userId === adminId) {
      throw new ConvexError("You cannot change your own role");
    }
    const target = await ctx.db.get(userId);
    if (target === null) {
      throw new ConvexError("User not found");
    }
    await ctx.db.patch(userId, { role: role ?? undefined });
  },
});

/** Delete an account and everything they created (admin only). */
export const deleteUser = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const adminId = await getAdminUser(ctx);
    if (userId === adminId) {
      throw new ConvexError("You cannot delete your own account");
    }

    const likes = await ctx.db
      .query("likedSongs")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const like of likes) {
      await ctx.db.delete(like._id);
    }

    const playlists = await ctx.db
      .query("playlists")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const playlist of playlists) {
      await ctx.db.delete(playlist._id);
    }

    await ctx.db.delete(userId);
  },
});

/** Every playlist across the deployment, with its owner (admin only). */
export const listAllPlaylists = query({
  args: {},
  handler: async (ctx) => {
    await getAdminUser(ctx);
    const [playlists, users] = await Promise.all([
      scanAll(ctx.db.query("playlists")),
      scanAll(ctx.db.query("users")),
    ]);
    const owners = new Map(users.map((u) => [u._id, u]));
    return playlists
      .map((p) => {
        const owner = owners.get(p.userId);
        return {
          _id: p._id,
          _creationTime: p._creationTime,
          name: p.name,
          trackCount: p.trackIds.length,
          ownerName: owner?.name ?? null,
          ownerEmail: owner?.email ?? null,
        };
      })
      .sort((a, b) => b._creationTime - a._creationTime);
  },
});

/**
 * One playlist's full contents, with its owner (admin only).
 *
 * `listAllPlaylists` gives an admin a row per playlist — name, owner, track
 * COUNT — but there was no way to see WHAT is in one. An admin handling a
 * report or a copyright complaint needs the actual tracks; a track count alone
 * cannot answer that, and the admin had to ask the user to screenshot it.
 *
 * Track metadata comes from the playlist's own `trackSnapshots` when present.
 * That snapshot is optional and is missing on older playlists, and a playlist
 * can also contain ids added before snapshots existed, so each row is reported
 * honestly: `known: false` with a null title means "there is a track here and we
 * do not know what it is", which is itself the answer an admin needs. Nothing
 * is invented to fill the gap.
 */
export const playlistDetail = query({
  args: { playlistId: v.id("playlists") },
  handler: async (ctx, { playlistId }) => {
    await getAdminUser(ctx);
    const playlist = await ctx.db.get(playlistId);
    if (playlist === null) {
      throw new ConvexError("Playlist not found");
    }
    const owner = await ctx.db.get(playlist.userId);
    // Snapshots are positional against `trackIds` on well-formed playlists, but
    // a mismatch is possible (a playlist edited by an older client), so index
    // defensively rather than assuming the arrays line up.
    const snapshots = playlist.trackSnapshots ?? [];
    const tracks = playlist.trackIds.map((trackId, i) => {
      const snap = snapshots[i];
      return {
        trackId,
        title: snap?.title ?? null,
        artist: snap?.artist ?? null,
        album: snap?.album ?? null,
        coverUrl: snap?.coverUrl ?? null,
        duration: snap?.duration ?? null,
        youtubeId: snap?.youtubeId ?? null,
        known: snap !== undefined,
      };
    });
    return {
      _id: playlist._id,
      _creationTime: playlist._creationTime,
      name: playlist.name,
      description: playlist.description ?? null,
      ownerName: owner?.name ?? null,
      ownerEmail: owner?.email ?? null,
      tracks,
      knownTracks: tracks.filter((t) => t.known).length,
    };
  },
});
/** Delete any playlist on the deployment (admin only). */
export const deletePlaylist = mutation({
  args: { playlistId: v.id("playlists") },
  handler: async (ctx, { playlistId }) => {
    await getAdminUser(ctx);
    const playlist = await ctx.db.get(playlistId);
    if (playlist === null) {
      throw new ConvexError("Playlist not found");
    }
    await ctx.db.delete(playlistId);
  },
});

/**
 * Every user's liked songs — both catalog likes and remote (streamed) likes
 * with their metadata snapshots (admin only).
 */
export const listAllLikes = query({
  args: {},
  handler: async (ctx) => {
    await getAdminUser(ctx);
    const [likes, remotes, users] = await Promise.all([
      scanAll(ctx.db.query("likedSongs")),
      scanAll(ctx.db.query("likedRemote")),
      scanAll(ctx.db.query("users")),
    ]);
    const owners = new Map(users.map((u) => [u._id, u]));
    const remoteByUserTrack = new Map(
      remotes.map((r) => [`${r.userId}:${r.trackId}`, r]),
    );
    return likes
      .map((like) => {
        const owner = owners.get(like.userId);
        const remote = remoteByUserTrack.get(`${like.userId}:${like.trackId}`);
        return {
          _id: like._id,
          trackId: like.trackId,
          createdAt: like.createdAt,
          ownerName: owner?.name ?? null,
          ownerEmail: owner?.email ?? null,
          title: remote?.title ?? like.trackId,
          artistName: remote?.artistName ?? "SYNQ catalog",
          coverUrl: remote?.coverUrl ?? "",
          duration: remote?.duration ?? 0,
        };
      })
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 500);
  },
});

/**
 * Recent signups across the deployment (admin only).
 */
export const recentSignups = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    await getAdminUser(ctx);
    const users = await scanAll(ctx.db.query("users"));
    return users
      .sort((a, b) => b._creationTime - a._creationTime)
      .slice(0, limit ?? 10)
      .map((u) => ({
        _id: u._id,
        _creationTime: u._creationTime,
        name: u.name ?? null,
        email: u.email ?? null,
        isAnonymous: u.isAnonymous ?? false,
        role: u.role ?? null,
      }));
  },
});

/**
 * Platform-wide listening statistics for the last 14 days (admin only):
 * total plays, unique tracks, daily activity, and most active hour.
 */
export const platformListeningStats = query({
  args: {},
  handler: async (ctx) => {
    await getAdminUser(ctx);
    const dayMs = 24 * 60 * 60 * 1000;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const windowStart = today.getTime() - 13 * dayMs;
    // The dashboard is a 14-day view. Use the time index so this does not
    // scan the entire append-only event history on every admin refresh.
    const events = await ctx.db
      .query("playEvents")
      .withIndex("by_playedAt", (q) => q.gte("playedAt", windowStart))
      .collect();

    const totalPlays = events.length;

    // plays per day, last 14 days
    const daily: { day: string; label: string; plays: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const start = today.getTime() - i * dayMs;
      const next = start + dayMs;
      const plays = events.filter(
        (h) => h.playedAt >= start && h.playedAt < next,
      ).length;
      const d = new Date(start);
      daily.push({
        day: d.toISOString().slice(0, 10),
        label: d.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        }),
        plays,
      });
    }

    // most active hour of day (0-23)
    const hourBuckets = new Array(24).fill(0) as number[];
    for (const h of events) hourBuckets[new Date(h.playedAt).getHours()] += 1;
    const peakHour =
      totalPlays === 0 ? null : hourBuckets.indexOf(Math.max(...hourBuckets));

    // distinct tracks in the catalog history
    const uniqueTracks = new Set(events.map((h) => h.trackId)).size;

    return { totalPlays, uniqueTracks, daily, peakHour, hourBuckets };
  },
});

/**
 * Listening rooms overview for moderation (admin only).
 */
export const listRooms = query({
  args: {},
  handler: async (ctx) => {
    await getAdminUser(ctx);
    const rooms = await scanAll(ctx.db.query("listeningRooms"));
    const users = await scanAll(ctx.db.query("users"));
    const names = new Map(
      users.map((u) => [u._id, u.name ?? u.email ?? "Anonymous"]),
    );
    return rooms
      .map((r) => ({
        _id: r._id,
        name: r.name,
        hostName: r.hostName ?? names.get(r.hostId) ?? "Unknown",
        hostId: r.hostId,
        memberCount: r.members.length,
        nowPlaying: r.nowPlaying ?? null,
        updatedAt: r.updatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  },
});

/** Delete a listening room (admin only). */
export const deleteRoom = mutation({
  args: { roomId: v.id("listeningRooms") },
  handler: async (ctx, { roomId }) => {
    await getAdminUser(ctx);
    await ctx.db.delete(roomId);
  },
});

/**
 * Imported playlists audit (admin only) — shows what users brought in from
 * other platforms.
 */
export const listImports = query({
  args: {},
  handler: async (ctx) => {
    await getAdminUser(ctx);
    const [imports, users] = await Promise.all([
      scanAll(ctx.db.query("importedPlaylists")),
      scanAll(ctx.db.query("users")),
    ]);
    const names = new Map(
      users.map((u) => [u._id, u.name ?? u.email ?? "Anonymous"]),
    );
    return imports
      .map((i) => ({
        _id: i._id,
        name: i.name,
        origin: i.origin,
        trackCount: i.tracks.length,
        ownerName: names.get(i.userId) ?? "Unknown",
        createdAt: i.createdAt,
      }))
      .sort((a, b) => b.createdAt - a.createdAt);
  },
});

/** Delete an imported playlist (admin only). */
export const deleteImport = mutation({
  args: { importId: v.id("importedPlaylists") },
  handler: async (ctx, { importId }) => {
    await getAdminUser(ctx);
    await ctx.db.delete(importId);
  },
});

/** Rename any playlist (admin only). */
export const renamePlaylist = mutation({
  args: { playlistId: v.id("playlists"), name: v.string() },
  handler: async (ctx, { playlistId, name }) => {
    await getAdminUser(ctx);
    const trimmed = name.trim();
    if (!trimmed) throw new ConvexError("Name cannot be empty");
    const p = await ctx.db.get(playlistId);
    if (p === null) throw new ConvexError("Playlist not found");
    await ctx.db.patch(playlistId, { name: trimmed, updatedAt: Date.now() });
  },
});

/** Clear a user's entire listening history (admin only). */
export const clearUserHistory = mutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    await getAdminUser(ctx);
    const rows = await ctx.db
      .query("playHistory")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const events = await ctx.db
      .query("playEvents")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const row of [...rows, ...events]) await ctx.db.delete(row._id);
    return rows.length;
  },
});

/**
 * Global listening stats: most played tracks across the whole deployment
 * (admin only).
 *
 * Returns the song's TITLE, not its id. `playHistory` has carried optional
 * `title` / `artistName` / `coverUrl` snapshots since remote playback was
 * added, but this query only ever tallied `trackId` — so the deployment's
 * most-played chart was a wall of opaque ids like `wpKqN3Ny_P0`, which is
 * useless to an admin: it cannot be acted on, searched for, or recognised.
 *
 * The snapshot is taken from the most recent row that has one, so a track first
 * played before titles were recorded still resolves once anyone replays it.
 * `title` stays nullable: older rows genuinely have no title, and inventing
 * one would be worse than admitting the gap.
 */
export const globalTopTracks = query({
  args: {},
  handler: async (ctx) => {
    await getAdminUser(ctx);
    const history = await scanAll(ctx.db.query("playHistory"));
    const byTrack = new Map<
      string,
      {
        plays: number;
        listeners: Set<string>;
        title: string | null;
        artistName: string | null;
        coverUrl: string | null;
        lastPlayedAt: number;
      }
    >();
    for (const h of history) {
      const entry = byTrack.get(h.trackId) ?? {
        plays: 0,
        listeners: new Set<string>(),
        title: null,
        artistName: null,
        coverUrl: null,
        lastPlayedAt: 0,
      };
      entry.plays += h.playCount;
      entry.listeners.add(h.userId);
      // A later row carrying a snapshot always wins, so a track recorded
      // before titles existed fills in as soon as it is played again.
      if (h.title) {
        entry.title = h.title;
        entry.artistName = h.artistName ?? entry.artistName;
        entry.coverUrl = h.coverUrl ?? entry.coverUrl;
      }
      if (h.playedAt > entry.lastPlayedAt) entry.lastPlayedAt = h.playedAt;
      byTrack.set(h.trackId, entry);
    }
    return [...byTrack.entries()]
      .map(([trackId, v]) => ({
        trackId,
        title: v.title,
        artistName: v.artistName,
        coverUrl: v.coverUrl,
        plays: v.plays,
        listeners: v.listeners.size,
        lastPlayedAt: v.lastPlayedAt,
      }))
      .sort((a, b) => b.plays - a.plays)
      .slice(0, 25);
  },
});

/** Per-user activity rollup: likes, playlists, plays (admin only). */
export const userActivity = query({
  args: {},
  handler: async (ctx) => {
    await getAdminUser(ctx);
    const [users, likes, playlists, history] = await Promise.all([
      scanAll(ctx.db.query("users")),
      scanAll(ctx.db.query("likedSongs")),
      scanAll(ctx.db.query("playlists")),
      scanAll(ctx.db.query("playHistory")),
    ]);
    // Tally in a SINGLE pass. This used to re-scan the whole likes, playlists
    // and history tables once per user, so the query was O(users x rows): an
    // admin page that crawled to a halt as the deployment grew, and blew
    // through Convex's read budget long before the numbers were useful.
    const likeCount = new Map<string, number>();
    for (const l of likes) {
      likeCount.set(l.userId, (likeCount.get(l.userId) ?? 0) + 1);
    }
    const playlistCount = new Map<string, number>();
    for (const p of playlists) {
      playlistCount.set(p.userId, (playlistCount.get(p.userId) ?? 0) + 1);
    }
    const playCount = new Map<string, number>();
    const lastPlayedAt = new Map<string, number>();
    for (const h of history) {
      playCount.set(h.userId, (playCount.get(h.userId) ?? 0) + h.playCount);
      // Reduced in the same pass: this used to be a per-user
      // `history.filter(...).reduce(...)`, which put the query straight back
      // into O(users x rows) after the counters had just been fixed.
      lastPlayedAt.set(
        h.userId,
        Math.max(lastPlayedAt.get(h.userId) ?? 0, h.playedAt),
      );
    }

    return users
      .map((u) => ({
        _id: u._id,
        name: u.name ?? null,
        email: u.email ?? null,
        likes: likeCount.get(u._id) ?? 0,
        playlists: playlistCount.get(u._id) ?? 0,
        plays: playCount.get(u._id) ?? 0,
        lastPlayedAt: lastPlayedAt.get(u._id) ?? 0,
      }))
      .sort((a, b) => b.plays - a.plays);
  },
});

/**
 * Visit analytics for the admin Visits tab (admin only).
 *
 * Reads the `visitDaily` rollup rather than the raw log, so the cost is
 * bounded by days x distinct pages instead of by traffic. Authorisation goes
 * through the same `getAdminUser` gate as every other function in this file,
 * so there is exactly ONE place in the codebase that decides who is an admin —
 * a second check is a second thing to forget to update.
 */
export const visitAnalytics = query({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await getAdminUser(ctx);
    const days = Math.max(1, Math.min(90, Math.floor(args.days ?? 14)));

    // One indexed read per day in the window, rather than a full table scan.
    // The day list is built in JS so a day with no rows still appears, as a
    // zero, instead of silently vanishing from the chart.
    const rollup = [];
    for (const day of summariseVisits([], days).days) {
      rollup.push(
        ...(await ctx.db
          .query("visitDaily")
          .withIndex("by_day", (q) => q.eq("day", day))
          .collect()),
      );
    }

    return summariseVisits(
      rollup.map((r) => ({
        day: r.day,
        path: r.path,
        views: r.views,
        visitors: r.visitors,
        members: r.members,
      })),
      days,
    );
  },
});
