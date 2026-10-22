import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import {
  action,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
} from "./_generated/server";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  mergeRepairs,
  pickRepair,
  repairQuery,
  REPAIR_BATCH_SIZE,
  REPAIR_SEARCH_ATTEMPTS,
  REPAIR_SEARCH_GAP_MS,
  type RepairCandidate,
} from "../lib/importRepair";

/** A cancellable pause between two upstream searches. */
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const trackSnapshotValidator = v.object({
  id: v.string(),
  title: v.string(),
  artist: v.string(),
  album: v.optional(v.string()),
  // Accepted as optional so a partially-resolved remote track can still be
  // added; the handler normalizes it to the stored (non-optional) shape.
  coverUrl: v.optional(v.string()),
  duration: v.optional(v.number()),
  youtubeId: v.optional(v.string()),
});

type TrackSnapshot = {
  id: string;
  title: string;
  artist: string;
  album?: string;
  coverUrl: string;
  duration: number;
  youtubeId?: string;
};

/** Coerce a client-supplied snapshot into the exact shape stored on a doc. */
function normalizeSnapshot(track: TrackSnapshot): TrackSnapshot {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    ...(track.album ? { album: track.album } : {}),
    coverUrl: typeof track.coverUrl === "string" ? track.coverUrl : "",
    duration:
      typeof track.duration === "number" && Number.isFinite(track.duration)
        ? track.duration
        : 0,
    ...(typeof track.youtubeId === "string" && track.youtubeId
      ? { youtubeId: track.youtubeId }
      : {}),
  };
}

const requireUser = async (ctx: MutationCtx) => {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new ConvexError("Sign in to manage playlists");
  }
  return userId;
};

async function logEvent(
  ctx: MutationCtx,
  userId: Id<"users">,
  playlistId: Id<"playlists">,
  playlistName: string,
  kind: string,
  detail?: string,
) {
  await ctx.db.insert("playlistEvents", {
    userId,
    playlistId,
    playlistName,
    kind,
    detail,
    at: Date.now(),
  });
}

/**
 * Create a playlist for the signed-in user. Returns the new playlist id.
 */
export const create = mutation({
  args: {
    name: v.string(),
    description: v.optional(v.string()),
    tracks: v.optional(v.array(trackSnapshotValidator)),
  },
  handler: async (ctx, { name, description, tracks }) => {
    const userId = await requireUser(ctx);
    const now = Date.now();
    const playlistName = name.trim() || "New playlist";
    const snapshots = (tracks ?? []).filter((track) => track.id.trim());
    const uniqueSnapshots = [
      ...new Map(
        snapshots.map(
          (track) =>
            [track.id, normalizeSnapshot(track as TrackSnapshot)] as const,
        ),
      ).values(),
    ];
    const uniqueIds = uniqueSnapshots.map((track) => track.id);
    const id = await ctx.db.insert("playlists", {
      userId,
      name: playlistName,
      description,
      trackIds: uniqueIds,
      ...(uniqueSnapshots.length > 0
        ? { trackSnapshots: uniqueSnapshots }
        : {}),
      createdAt: now,
      updatedAt: now,
    });
    await logEvent(ctx, userId, id, playlistName, "created");
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
    const name = playlist.name;
    await ctx.db.delete(playlistId);
    await logEvent(ctx, userId, playlistId, name, "deleted");
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
    await logEvent(
      ctx,
      userId,
      playlistId,
      name.trim() || playlist.name,
      "renamed",
      playlist.name,
    );
  },
});

/**
 * Add a catalog track to a playlist (no duplicates).
 */
export const addTrack = mutation({
  args: {
    playlistId: v.id("playlists"),
    trackId: v.string(),
    detail: v.optional(v.string()),
    track: v.optional(trackSnapshotValidator),
  },
  handler: async (ctx, { playlistId, trackId, detail, track }) => {
    const userId = await requireUser(ctx);
    const playlist = await ctx.db.get(playlistId);
    if (playlist === null || playlist.userId !== userId) {
      throw new ConvexError("Playlist not found");
    }
    if (!playlist.trackIds.includes(trackId)) {
      const snapshots = playlist.trackSnapshots ?? [];
      const nextSnapshots = track
        ? [
            ...snapshots.filter((snapshot) => snapshot.id !== trackId),
            normalizeSnapshot(track as TrackSnapshot),
          ]
        : snapshots;
      await ctx.db.patch(playlistId, {
        trackIds: [...playlist.trackIds, trackId],
        ...(nextSnapshots.length > 0 ? { trackSnapshots: nextSnapshots } : {}),
        updatedAt: Date.now(),
      });
      await logEvent(ctx, userId, playlistId, playlist.name, "added", detail);
    }
  },
});

/**
 * Remove a catalog track from a playlist.
 */
export const removeTrack = mutation({
  args: {
    playlistId: v.id("playlists"),
    trackId: v.string(),
    detail: v.optional(v.string()),
  },
  handler: async (ctx, { playlistId, trackId, detail }) => {
    const userId = await requireUser(ctx);
    const playlist = await ctx.db.get(playlistId);
    if (playlist === null || playlist.userId !== userId) {
      throw new ConvexError("Playlist not found");
    }
    const removed = playlist.trackIds.includes(trackId);
    const snapshots = playlist.trackSnapshots?.filter(
      (track) => track.id !== trackId,
    );
    await ctx.db.patch(playlistId, {
      trackIds: playlist.trackIds.filter((id) => id !== trackId),
      ...(playlist.trackSnapshots !== undefined
        ? { trackSnapshots: snapshots ?? [] }
        : {}),
      updatedAt: Date.now(),
    });
    if (removed)
      await logEvent(ctx, userId, playlistId, playlist.name, "removed", detail);
  },
});

/** Change history for one playlist (newest first, capped). */
export const changeHistory = query({
  args: { playlistId: v.id("playlists") },
  handler: async (ctx, { playlistId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const events = await ctx.db
      .query("playlistEvents")
      .withIndex("by_playlist", (q) => q.eq("playlistId", playlistId))
      .order("desc")
      .take(30);
    return events.filter((e) => e.userId === userId);
  },
});

/**
 * A stable id for a track that came in through an import.
 *
 * An imported track has no provider id — a CSV row is a title and an artist —
 * so one is derived. It MUST be namespaced: a bare YouTube video id would
 * collide with a real track, and two different imported songs with the same
 * title and artist would collapse into one.
 *
 * Deterministic on purpose. Re-importing the same file produces the same ids,
 * so the playlist's own de-duplication does the sensible thing instead of
 * stacking up five copies of the same song.
 */
function importedTrackId(
  origin: string,
  title: string,
  artist: string,
): string {
  const key = `${origin}|${title}|${artist}`
    .toLowerCase()
    .replace(/[^a-z0-9|]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return `import:${key}`;
}

/**
 * Save a playlist imported from another music service (CSV/text export).
 * Tracks are snapshots — resolved to playable streams at play time.
 *
 * It writes to BOTH tables, and that is the fix rather than a flourish.
 *
 * `importedPlaylists` is the import system's own record and is what the admin
 * Imports tab reads, so it stays. But it was the ONLY table written, and the
 * one thing a listener actually looks at — "Your library" — reads `playlists`.
 * So an import reported success, showed a green toast, and then appeared
 * nowhere at all. `myImportedPlaylists` existed the whole time and nothing
 * called it.
 *
 * Writing a real `playlists` row as well is what makes the import land: it
 * shows up in the library immediately and is playable, editable, renameable
 * and deletable through the UI that is already there, rather than needing a
 * second screen built to display a table nobody renders.
 */
export const saveImported = mutation({
  args: {
    name: v.string(),
    origin: v.string(),
    tracks: v.array(
      v.object({
        title: v.string(),
        artist: v.string(),
        // Both were normalised by the importer and then discarded on the way
        // here, so every imported row rendered as an empty black box.
        album: v.optional(v.string()),
        artwork: v.optional(v.string()),
        duration: v.optional(v.number()),
      }),
    ),
  },
  handler: async (
    ctx,
    { name, origin, tracks },
  ): Promise<SaveImportedResult> => {
    const userId = await requireUser(ctx);
    if (tracks.length === 0) {
      throw new ConvexError("No tracks found in the import");
    }
    const playlistName = name.trim() || "Imported playlist";

    // The same tracks as real playlist snapshots, so the import is a first
    // class library entry rather than a record only the admin can see.
    // De-duplicated by id for the same reason `create` does it: a 200-row
    // export that repeats a track should not show it twice. Built BEFORE
    // either insert below, because the duplicate check against the library
    // needs the ids.
    const snapshots: TrackSnapshot[] = [];
    const seen = new Set<string>();
    for (const track of tracks) {
      const title = track.title.trim();
      if (!title) continue;
      const snapshot: TrackSnapshot = {
        id: importedTrackId(origin, title, track.artist),
        title,
        artist: track.artist.trim(),
        ...(track.album ? { album: track.album } : {}),
        // The provider's own artwork when it gave us one, and an honest empty
        // string when it did not. A missing cover is recoverable; a fabricated
        // one is not.
        coverUrl: typeof track.artwork === "string" ? track.artwork : "",
        duration:
          typeof track.duration === "number" && Number.isFinite(track.duration)
            ? track.duration
            : 0,
      };
      if (seen.has(snapshot.id)) continue;
      seen.add(snapshot.id);
      snapshots.push(snapshot);
    }

    if (snapshots.length > 0) {
      const duplicate = await findDuplicateImport(
        ctx,
        userId,
        playlistName,
        origin,
        snapshots,
      );
      if (duplicate) return duplicate;
    }

    const id = await ctx.db.insert("importedPlaylists", {
      userId,
      name: playlistName,
      origin,
      tracks,
      createdAt: Date.now(),
    });

    if (snapshots.length > 0) {
      const now = Date.now();
      await ctx.db.insert("playlists", {
        userId,
        name: playlistName,
        // No invented album: the import did not supply one, and fabricating
        // "Imported" as an album name would show up in the detail view as
        // though the data existed.
        description: `Imported from ${origin}`,
        trackIds: snapshots.map((snapshot) => snapshot.id),
        trackSnapshots: snapshots,
        createdAt: now,
        updatedAt: now,
      });
    }

    return { importedPlaylistId: id };
  },
});

/** Shape returned for both a fresh save and an idempotent skip. */
export type SaveImportedResult =
  | {
      importedPlaylistId: Id<"importedPlaylists">;
      playlistId?: undefined;
      duplicate?: false;
    }
  | {
      importedPlaylistId?: undefined;
      playlistId: Id<"playlists">;
      duplicate: true;
    };

/**
 * Re-importing the same source must not create a second playlist.
 *
 * An import id is deterministic — `import:origin|artist|title` — so the same
 * playlist imported twice produces the same ids. If a playlist from the same
 * origin with the same name already holds EXACTLY this id set, the import is
 * a repeat, not a refresh: returning the existing playlist is the honest
 * result, and a second library row a confusing one.
 *
 * Two deliberate refusals to "sync":
 *
 *  - A playlist whose content DIFFERS could be a changed source… or one the
 *    listener has since edited (they can remove and add tracks on imported
 *    playlists like any other). Reimporting over it would silently discard
 *    those edits, so a changed import creates a new playlist instead. The
 *    listener's library is never overwritten behind their back.
 *  - The search is bounded: one index read over the user's own playlists,
 *    capped, then in-memory matching. The `by_user` index keeps it O(own
 *    rows), never a table scan.
 */
async function findDuplicateImport(
  ctx: MutationCtx,
  userId: Id<"users">,
  name: string,
  origin: string,
  snapshots: TrackSnapshot[],
): Promise<{ playlistId: Id<"playlists">; duplicate: true } | null> {
  const expected = snapshots.map((s) => s.id).sort().join("\n");
  const candidates = await ctx.db
    .query("playlists")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .order("desc")
    .take(200);
  for (const row of candidates) {
    if (
      row.name !== name ||
      row.description !== `Imported from ${origin}`
    ) {
      continue;
    }
    if (row.trackIds.length !== snapshots.length) continue;
    if ([...row.trackIds].sort().join("\n") !== expected) continue;
    return { playlistId: row._id, duplicate: true };
  }
  return null;
}

/**
 * Replace all tracks of an imported playlist (used to cache resolved plays).
 */
export const removeImported = mutation({
  args: { playlistId: v.id("importedPlaylists") },
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
 * The signed-in user's imported playlists, newest first.
 */
export const myImportedPlaylists = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    return await ctx.db
      .query("importedPlaylists")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .collect();
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
/**
 * A single playlist the signed-in user may open: their own, or one shared
 * with them.
 *
 * The widening is READ-ONLY by construction. Every mutation above still
 * checks `playlist.userId === caller` on its own, so a share grant cannot
 * leak edit or delete rights through this query — it only enables opening
 * and viewing. An invalid or forged id that is neither owned nor granted
 * keeps returning null exactly as before.
 */
export const get = query({
  args: { playlistId: v.id("playlists") },
  handler: async (ctx, { playlistId }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      return null;
    }
    const playlist = await ctx.db.get(playlistId);
    if (playlist === null) {
      return null;
    }
    if (playlist.userId !== userId) {
      // view-only sharing: an existing grant row is the whole permission.
      const grant = await ctx.db
        .query("playlistShares")
        .withIndex("by_grant", (q) =>
          q.eq("playlistId", playlistId).eq("recipientId", userId),
        )
        .collect();
      if (grant.length === 0) return null;
    }
    return playlist;
  },
});

/**
 * Look up a batch of imported tracks on YouTube and return what is genuinely
 * the same song.
 *
 * This is the repair pass for playlists that were imported before cover art
 * was persisted. Those rows carry a title and an artist and nothing else, so
 * the library had no way to show artwork, show a length, or play them without
 * a search per click. The song itself is the only honest source for all
 * three, so SYNQ looks it up once and writes the result back.
 *
 * Three deliberate properties:
 *
 *  - It searches through the EXISTING `youtube.searchYoutube` action rather
 *    than re-implementing InnerTube parsing, so a repair can never disagree
 *    with what a search on the same query would have returned.
 *  - It returns only confident matches. A row it cannot place is simply
 *    absent from the response and keeps its honest unknown state; the UI
 *    renders a placeholder rather than a wrong cover.
 *  - It is capped per call AND runs its searches one at a time. One request
 *    fanning out into hundreds of YouTube searches gets killed by the
 *    caller's timeout, and concurrent searches get throttled to empty
 *    responses. The client walks the playlist in batches instead, and every
 *    batch that lands is persisted immediately.
 */
export const resolveImportedTracks = action({
  args: {
    tracks: v.array(
      v.object({
        id: v.string(),
        title: v.string(),
        artist: v.string(),
      }),
    ),
  },
  handler: async (
    ctx: ActionCtx,
    { tracks },
  ): Promise<{
    resolved: Array<{
      id: string;
      youtubeId: string;
      duration: number;
      thumbnail: string;
    }>;
    /**
     * Rows whose search came back with results, whether or not one of them
     * matched confidently.
     *
     * These are DONE: a result set that had no match is a real answer, and
     * asking again gets the same answer. Rows missing from this list had a
     * search that returned NOTHING, which from this deployment's IP means
     * throttled rather than absent — so the caller must leave those
     * retryable. Conflating the two is how a playlist ends up permanently
     * marked finished with nothing to show for it.
     */
    answered: string[];
    /** How many searches came back empty. Drives the caller's backoff. */
    empty: number;
  }> => {
    const bounded = tracks
      .filter((track) => track.title.trim())
      .slice(0, REPAIR_BATCH_SIZE);
    const resolved: Array<{
      id: string;
      youtubeId: string;
      duration: number;
      thumbnail: string;
    }> = [];
    const answered: string[] = [];
    let empty = 0;

    // SEQUENTIALLY, spaced out, with a single retry — all measured against the
    // live deployment, not chosen for style.
    //
    // Fanning these out with Promise.allSettled looked like the obvious way
    // to make a 107-track playlist finish quickly. Live, two concurrent
    // InnerTube searches return `{"items": []}` while the identical two
    // queries run one after the other return full results. YouTube throttles
    // the burst and answers with silence rather than with an error, so a
    // parallel batch resolves nothing and is indistinguishable from "these
    // songs don't exist".
    //
    // Even paced, roughly half of all searches from this IP come back empty,
    // so one retry after a pause recovers most of them. Anything still empty
    // is reported through `empty` and the caller backs off.
    for (const [index, track] of bounded.entries()) {
      let items: RepairCandidate[] = [];
      for (let attempt = 0; attempt < REPAIR_SEARCH_ATTEMPTS; attempt++) {
        if (index > 0 || attempt > 0) await delay(REPAIR_SEARCH_GAP_MS);
        try {
          const result = await ctx.runAction(api.youtube.searchYoutube, {
            query: repairQuery(track),
          });
          items = (result?.items ?? []) as RepairCandidate[];
        } catch {
          // A thrown upstream failure is not evidence about this song.
          continue;
        }
        if (items.length > 0) break;
      }
      if (items.length === 0) {
        empty++;
        continue;
      }
      answered.push(track.id);
      const best = pickRepair(track, items);
      if (!best) continue;
      resolved.push({
        id: track.id,
        youtubeId: best.id,
        duration: best.duration,
        thumbnail: best.thumbnail,
      });
    }
    return { resolved, answered, empty };
  },
});

/**
 * Write repair results back onto a playlist's snapshots.
 *
 * Additive only — see `mergeRepairs`. A repair never overwrites a field that
 * already holds a real value, so this is safe to call repeatedly and with
 * overlapping batches, which is exactly what the client does.
 */
export const applyImportedRepairs = mutation({
  args: {
    playlistId: v.id("playlists"),
    repairs: v.array(
      v.object({
        id: v.string(),
        youtubeId: v.string(),
        duration: v.number(),
        thumbnail: v.string(),
      }),
    ),
  },
  handler: async (ctx, { playlistId, repairs }) => {
    const userId = await requireUser(ctx);
    const playlist = await ctx.db.get(playlistId);
    if (playlist === null || playlist.userId !== userId) {
      throw new ConvexError("Playlist not found");
    }
    const snapshots = playlist.trackSnapshots ?? [];
    if (snapshots.length === 0 || repairs.length === 0) return 0;
    const merged = mergeRepairs(snapshots, repairs);
    if (merged === snapshots) return 0;
    await ctx.db.patch(playlistId, {
      trackSnapshots: merged,
      updatedAt: Date.now(),
    });
    return repairs.length;
  },
});
