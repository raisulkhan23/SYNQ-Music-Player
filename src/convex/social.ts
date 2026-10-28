import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";

/**
 * Social backend: listening rooms (shared queues). Room membership is live —
 * everyone who joined sees the host's now-playing.
 */

/**
 * A room is only deleted when its last member explicitly leaves, and closing
 * a tab is not leaving. A room whose `updatedAt` has not moved for this long
 * has nobody actually in it — the host's player refreshes `updatedAt` on
 * every now-playing change, so a live room ticks continuously.
 */
export const ROOM_STALE_MS = 2 * 60 * 60 * 1000;

/** How many rooms the directory renders. */
export const ROOM_LIST_LIMIT = 50;

/**
 * How many fresh rows the directory is willing to read before giving up.
 * The `by_updatedAt` index is ascending and this Convex version's
 * `withIndex` takes no direction, so the newest rooms cannot be taken
 * directly; a bounded read plus an in-memory sort does the same job. The
 * bound matters: collecting the whole table (what this used to do) scanned
 * every dead room ever created, and dead rooms accumulated without limit.
 */
export const ROOM_SCAN_LIMIT = 200;

/** Refuse new rooms past this many live ones, so the table cannot run away. */
export const ROOM_HARD_LIMIT = 200;

/**
 * Rooms list for the Listening Rooms tab (live membership counts).
 *
 * The stale cutoff is applied INSIDE the index range, so abandoned rooms are
 * never read at all rather than being read and then discarded. A room with no
 * members is filtered afterwards — a closed tab cannot empty itself, so this
 * catches the tail the index range cannot.
 */
export const listRooms = query({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - ROOM_STALE_MS;
    const rooms = await ctx.db
      .query("listeningRooms")
      .withIndex("by_updatedAt", (q) => q.gte("updatedAt", cutoff))
      .take(ROOM_SCAN_LIMIT);
    return (
      rooms
        .filter((r) => (r.members ?? []).length > 0)
        .map((r) => ({
          _id: r._id,
          name: r.name,
          hostName: r.hostName ?? null,
          members: r.members ?? [],
          listenerCount: (r.members ?? []).length,
          nowPlaying: r.nowPlaying ?? null,
          updatedAt: r.updatedAt,
        }))
        // Newest first, then busiest — a room nobody has touched in an hour is
        // not what someone opening the directory is looking for.
        .sort(
          (a, b) =>
            b.updatedAt - a.updatedAt || b.listenerCount - a.listenerCount,
        )
        .slice(0, ROOM_LIST_LIMIT)
        .map((r) => ({
          _id: r._id,
          name: r.name,
          hostName: r.hostName,
          members: r.members,
          listenerCount: r.listenerCount,
          nowPlaying: r.nowPlaying,
        }))
    );
  },
});

export const createRoom = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new ConvexError("Sign in first");
    const me = await ctx.db.get(userId);
    const trimmed = name.trim().slice(0, 60);
    if (trimmed.length === 0) throw new ConvexError("Room name can't be empty");

    // Reclaim rooms abandoned by closed tabs before adding another. Nothing
    // else ever deletes them, so without this sweep the table only ever grew
    // and the directory query had to scan all of it.
    const cutoff = Date.now() - ROOM_STALE_MS;
    const live = await ctx.db
      .query("listeningRooms")
      .withIndex("by_updatedAt", (q) => q.gte("updatedAt", cutoff))
      .take(ROOM_SCAN_LIMIT);
    for (const room of live) {
      if ((room.members ?? []).length === 0) await ctx.db.delete(room._id);
    }
    if (live.length >= ROOM_HARD_LIMIT) {
      throw new ConvexError("The rooms list is full — try again in a bit");
    }

    await ctx.db.insert("listeningRooms", {
      name: trimmed,
      hostId: userId,
      hostName: me?.name ?? undefined,
      members: [{ userId, name: me?.name ?? undefined, joinedAt: Date.now() }],
      updatedAt: Date.now(),
    });
  },
});

export const joinRoom = mutation({
  args: { roomId: v.id("listeningRooms") },
  handler: async (ctx, { roomId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new ConvexError("Sign in first");
    const me = await ctx.db.get(userId);
    const room = await ctx.db.get(roomId);
    if (room === null) throw new ConvexError("Room not found");

    const members = (room.members ?? []).filter((m) => m.userId !== userId);
    members.push({ userId, name: me?.name ?? undefined, joinedAt: Date.now() });
    await ctx.db.patch(roomId, { members, updatedAt: Date.now() });
  },
});

export const leaveRoom = mutation({
  args: { roomId: v.id("listeningRooms") },
  handler: async (ctx, { roomId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new ConvexError("Sign in first");
    const room = await ctx.db.get(roomId);
    if (room === null) return;

    // Last member leaves → the room closes itself.
    const members = (room.members ?? []).filter((m) => m.userId !== userId);
    if (members.length === 0) {
      await ctx.db.delete(roomId);
      return;
    }
    await ctx.db.patch(roomId, { members, updatedAt: Date.now() });
  },
});

/** Update what a room's host is playing (called by the host's player). */
export const setRoomNowPlaying = mutation({
  args: {
    roomId: v.id("listeningRooms"),
    title: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { roomId, title }) => {
    const userId = await getAuthUserId(ctx);
    const room = await ctx.db.get(roomId);
    if (room === null || room.hostId !== userId) return;
    await ctx.db.patch(roomId, {
      nowPlaying: title ?? undefined,
      updatedAt: Date.now(),
    });
  },
});
