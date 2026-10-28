// ---------------------------------------------------------------------------
// "Not interested" — the listener's explicit negative signal.
//
// This is NOT the same as a skip. A skip is a reflex on whatever happened to be
// playing; this is a deliberate act on a song the listener looked at and chose
// to reject. Treating them the same is why "skip" buttons in music apps tend
// to feel broken: the thing you skipped by accident keeps coming back.
//
// Two scopes, because the two requests are genuinely different:
//   - "track"  — do not show me this song again.
//   - "artist" — do not show me this artist again.
//
// Both are applied as HARD EXCLUSIONS by the recommender. Down-weighting a
// rejected artist instead would keep putting them in front of the listener at
// a lower rank, which is not what "I'm not interested" means.
// ---------------------------------------------------------------------------

import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
// Relative, not the `@/` alias: the Convex bundler does not resolve it. The
// matching rule itself lives in the pure module so the server and the scorer
// cannot drift apart — two implementations of "is this the same artist" is
// exactly how exclusions quietly stop applying.
import { artistKey as normaliseArtist } from "../lib/notInterested";

export type NotInterestedScope = "track" | "artist";

/** Hard cap, so a listener cannot grow an unbounded exclusion set by accident. */
const MAX_ENTRIES = 500;

/**
 * The exclusion set, in the flat form an action can filter a candidate pool
 * with.
 *
 * Arrays rather than Sets because this crosses a Convex function boundary, and
 * because the filtering itself lives in the pure scorer — which is what makes
 * the exclusion behaviour testable without a database.
 */
export const exclusions = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ trackIds: string[]; artistKeys: string[] }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { trackIds: [], artistKeys: [] };

    const rows = await ctx.db
      .query("notInterested")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    const trackIds: string[] = [];
    const artistKeys: string[] = [];
    for (const row of rows) {
      if (row.scope === "track" && row.trackId) trackIds.push(row.trackId);
      // An artist exclusion also covers the specific song that was on screen
      // when the listener tapped it, so one tap is enough to make both go away.
      else if (row.scope === "artist") {
        const key = normaliseArtist(row.artistName);
        if (key) artistKeys.push(key);
        if (row.trackId) trackIds.push(row.trackId);
      }
    }
    return { trackIds, artistKeys };
  },
});

export const markNotInterested = mutation({
  args: {
    scope: v.union(v.literal("track"), v.literal("artist")),
    trackId: v.optional(v.string()),
    artistName: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: boolean; alreadyExcluded: boolean; total: number }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { ok: false, alreadyExcluded: false, total: 0 };

    const trackId = args.trackId?.trim() ?? "";
    const artistKey = normaliseArtist(args.artistName);

    // A row that identifies nothing is not an exclusion, it is a bug that
    // would otherwise come back as a permanent, unexplainable "why isn't this
    // artist showing up".
    if (args.scope === "track" && !trackId) {
      return { ok: false, alreadyExcluded: false, total: 0 };
    }
    if (args.scope === "artist" && !artistKey) {
      return { ok: false, alreadyExcluded: false, total: 0 };
    }

    const existing = await ctx.db
      .query("notInterested")
      .withIndex("by_user_scope", (q) =>
        q.eq("userId", userId).eq("scope", args.scope),
      )
      .collect();

    const already =
      args.scope === "track"
        ? existing.some((row) => row.trackId === trackId)
        : existing.some((row) => normaliseArtist(row.artistName) === artistKey);
    if (already) {
      return {
        ok: true,
        alreadyExcluded: true,
        total: existing.length,
      };
    }

    if (existing.length >= MAX_ENTRIES) {
      // Drop the OLDEST entry to make room rather than refusing the new one.
      // Refusing would mean the newest thing the listener just said no to is
      // the one thing still shown to them.
      const oldest = [...existing].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) await ctx.db.delete(oldest._id);
    }

    await ctx.db.insert("notInterested", {
      userId,
      scope: args.scope,
      // Stored for BOTH scopes. On an artist exclusion it is the song that was
      // on screen, so one tap removes the specific track immediately rather
      // than only taking effect on the next recommendation run.
      trackId: trackId || undefined,
      artistName: artistNameForStorage(args.artistName),
      createdAt: Date.now(),
    });

    return { ok: true, alreadyExcluded: false, total: existing.length + 1 };
  },
});

/** Keep the original spelling for display; the key is derived on read. */
function artistNameForStorage(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed.slice(0, 120) : undefined;
}

export const unmarkNotInterested = mutation({
  args: {
    scope: v.union(v.literal("track"), v.literal("artist")),
    trackId: v.optional(v.string()),
    artistName: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ ok: boolean }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { ok: false };

    const trackId = args.trackId?.trim() ?? "";
    const artistKey = normaliseArtist(args.artistName);

    const existing = await ctx.db
      .query("notInterested")
      .withIndex("by_user_scope", (q) =>
        q.eq("userId", userId).eq("scope", args.scope),
      )
      .collect();

    const row =
      args.scope === "track"
        ? existing.find((r) => r.trackId === trackId)
        : existing.find(
            (r) => normaliseArtist(r.artistName) === artistKey && artistKey,
          );
    if (row) await ctx.db.delete(row._id);
    return { ok: true };
  },
});

/** Everything the UI needs to render the current state of the toggle. */
export const listNotInterested = query({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    tracks: string[];
    artists: { name: string; key: string }[];
  }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { tracks: [], artists: [] };

    const rows = await ctx.db
      .query("notInterested")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    return {
      tracks: rows
        .filter((r) => r.scope === "track" && r.trackId)
        .map((r) => r.trackId as string),
      artists: rows
        .filter((r) => r.scope === "artist")
        .map((r) => ({
          name: r.artistName ?? "",
          key: normaliseArtist(r.artistName),
        }))
        .filter((a) => a.key),
    };
  },
});

/** Undo for the "no, put it back" case, and the escape hatch in Settings. */
export const clearNotInterested = mutation({
  args: {},
  handler: async (ctx): Promise<{ removed: number }> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return { removed: 0 };
    const rows = await ctx.db
      .query("notInterested")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
    return { removed: rows.length };
  },
});
