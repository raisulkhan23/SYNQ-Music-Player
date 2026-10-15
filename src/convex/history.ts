import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import {
  previousRecapPeriodBounds,
  recapPeriodBounds,
  type RecapInput,
  type RecapPeriod,
} from "../lib/recap";

const playSnapshot = {
  source: v.optional(v.string()),
  title: v.optional(v.string()),
  artistName: v.optional(v.string()),
  coverUrl: v.optional(v.string()),
  duration: v.optional(v.number()),
  albumName: v.optional(v.string()),
  /** user | autoplay | recommendation | radio */
  origin: v.optional(v.string()),
};

/**
 * Maintain the derived per-track engagement summary the recommendation engine
 * reads (skip counts, completion ratio, last-played time).
 *
 * recordPlay counts a play optimistically with no completion, because a play
 * is only *started* at that point. recordEngagement then corrects it once the
 * track ends or is skipped. The pair is 1:1 — recordPlay returns the exact
 * `playedAt` it wrote and the client passes it back — so the correction always
 * lands on the row it belongs to, and a duplicate engagement call is a no-op.
 */
async function bumpTrackSignals(
  ctx: MutationCtx,
  userId: Id<"users">,
  entry: {
    trackId: string;
    at: number;
    title?: string | undefined;
    artistName?: string | undefined;
    albumName?: string | undefined;
    /** +1 play (unknown completion yet). */
    playDelta?: number;
    /** Adds a real completion ratio to completionSum. */
    completionDelta?: number;
    /** Marks the open play as having reached a measured outcome. */
    settledDelta?: number;
    /** Turns the optimistic play into a skip. */
    skipDelta?: number;
  },
) {
  const existing = await ctx.db
    .query("trackSignals")
    .withIndex("by_user_track", (q) =>
      q.eq("userId", userId).eq("trackId", entry.trackId),
    )
    .first();

  const plays = Math.max(0, (existing?.plays ?? 0) + (entry.playDelta ?? 0));
  const skips = Math.max(0, (existing?.skips ?? 0) + (entry.skipDelta ?? 0));
  const settledPlays = Math.max(
    0,
    (existing?.settledPlays ?? 0) + (entry.settledDelta ?? 0),
  );
  const completionSum = Math.max(
    0,
    (existing?.completionSum ?? 0) + (entry.completionDelta ?? 0),
  );

  const patch = {
    plays,
    skips,
    settledPlays,
    completionSum,
    lastPlayedAt: Math.max(existing?.lastPlayedAt ?? 0, entry.at),
    ...(entry.title !== undefined ? { title: entry.title } : {}),
    ...(entry.artistName !== undefined ? { artistName: entry.artistName } : {}),
    ...(entry.albumName !== undefined ? { albumName: entry.albumName } : {}),
  };

  if (existing) {
    await ctx.db.patch(existing._id, patch);
    return;
  }
  await ctx.db.insert("trackSignals", {
    userId,
    trackId: entry.trackId,
    title: entry.title,
    artistName: entry.artistName,
    albumName: entry.albumName,
    plays,
    skips,
    settledPlays,
    completionSum,
    firstPlayedAt: entry.at,
    lastPlayedAt: entry.at,
  });
}

/**
 * Record a play of ANY track (catalog-era ids, YouTube video ids, etc.):
 * upserts the user's playHistory row (bumping playCount + playedAt).
 * Remote plays include a title/artist/cover snapshot so stats and history
 * can render them without resolving anything.
 */
export const recordPlay = mutation({
  args: { trackId: v.string(), ...playSnapshot },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new ConvexError("Sign in to track listening history");
    }

    const { trackId, source, title, artistName, coverUrl, duration } = args;
    const now = Date.now();
    const existing = await ctx.db
      .query("playHistory")
      .withIndex("by_user_track", (q) =>
        q.eq("userId", userId).eq("trackId", trackId),
      )
      .first();

    // Count the play in the derived engagement summary. No completion yet —
    // recordEngagement supplies it when the track ends or is skipped.
    await bumpTrackSignals(ctx, userId, {
      trackId,
      at: now,
      title,
      artistName,
      albumName: args.albumName,
      playDelta: 1,
    });

    if (existing !== null) {
      await ctx.db.patch(existing._id, {
        playedAt: now,
        playCount: existing.playCount + 1,
        ...(source !== undefined ? { source } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(artistName !== undefined ? { artistName } : {}),
        ...(coverUrl !== undefined ? { coverUrl } : {}),
        ...(duration !== undefined ? { duration } : {}),
      });

      // Log the replay in the per-play analytics table (see insert branch).
      await ctx.db.insert("playEvents", {
        userId,
        trackId,
        playedAt: now,
        ...(source !== undefined ? { source } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(artistName !== undefined ? { artistName } : {}),
        ...(args.albumName !== undefined ? { albumName: args.albumName } : {}),
        ...(args.origin !== undefined ? { origin: args.origin } : {}),
      });

      return { playCount: existing.playCount + 1, startedAt: now };
    }

    await ctx.db.insert("playHistory", {
      userId,
      trackId,
      playedAt: now,
      playCount: 1,
      source,
      title,
      artistName,
      coverUrl,
      duration,
    });

    // Append-only per-play log — analytics (plays per day, peak hour) read
    // from this instead of playHistory, which is an upsert per track and
    // collapses every replay into one timestamp.
    await ctx.db.insert("playEvents", {
      userId,
      trackId,
      playedAt: now,
      ...(source !== undefined ? { source } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(artistName !== undefined ? { artistName } : {}),
      ...(args.albumName !== undefined ? { albumName: args.albumName } : {}),
      ...(args.origin !== undefined ? { origin: args.origin } : {}),
    });

    return { playCount: 1, startedAt: now };
  },
});

/**
 * Record what actually happened to a play once it ends or is skipped.
 *
 * This is the ONLY way SYNQ learns that a track was skipped, how much of it
 * was heard, or that it was played to the end — the player fires it when the
 * track ends or when the listener moves on. `startedAt` is the `startedAt`
 * recordPlay returned for that exact play, which is what makes the update
 * idempotent and stops a skipped track from being counted twice.
 *
 * Skips are graded, never absolute: one early skip is a small negative, a
 * repeat pattern is a strong one, and a long listen that was still skipped is
 * barely penalised at all.
 */
export const recordEngagement = mutation({
  args: {
    trackId: v.string(),
    startedAt: v.number(),
    /** 0..1 — how much of the track was actually heard. */
    completion: v.number(),
    listenedSeconds: v.optional(v.number()),
    skipped: v.optional(v.boolean()),
    duration: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;

    const completion = Math.min(1, Math.max(0, args.completion));
    const isSkip = args.skipped === true && completion < 0.7;

    // Claim the exact play event. `settled` guards against a duplicate call
    // (retry, double-fired ended+skip) applying the same correction twice.
    const row = await findPlayEvent(ctx, userId, args.trackId, args.startedAt);
    if (!row || row.engagedAt !== undefined) return null;
    await ctx.db.patch(row._id, {
      completion,
      skipped: isSkip,
      listenedSeconds: args.listenedSeconds,
      engagedAt: Date.now(),
    });

    await bumpTrackSignals(ctx, userId, {
      trackId: args.trackId,
      at: args.startedAt,
      // A skip is not a play: the optimistic entry recordPlay added is
      // converted, never doubled.
      playDelta: isSkip ? -1 : 0,
      skipDelta: isSkip ? 1 : 0,
      settledDelta: isSkip ? 0 : 1,
      completionDelta: isSkip ? 0 : completion,
    });

    return { completion, skipped: isSkip };
  },
});

/** The playEvent for one user+track at (approximately) one instant. */
async function findPlayEvent(
  ctx: MutationCtx,
  userId: Id<"users">,
  trackId: string,
  startedAt: number,
): Promise<Doc<"playEvents"> | null> {
  // No composite index exists for (user, track, time), so walk the user's
  // events newest-first and stop at the first match. Bounded on purpose.
  const rows = await ctx.db
    .query("playEvents")
    .withIndex("by_user_playedAt", (q) => q.eq("userId", userId))
    .order("desc")
    .take(50);
  let best: Doc<"playEvents"> | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    if (row.trackId !== trackId) continue;
    if (row.engagedAt !== undefined) continue;
    // The client echoes back the exact `startedAt` recordPlay returned, so the
    // correct row is normally an exact timestamp match. Falling back to the
    // closest unsettled row keeps a play recorded when the clock or the
    // client drifts, instead of silently dropping the outcome.
    const delta = Math.abs(row.playedAt - startedAt);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = row;
    }
  }
  return best;
}

/**
 * The user's most recently played tracks (unique, newest first) across all
 * sources. Self-contained rows: title/artist/cover snapshot included.
 */
export const recentlyPlayed = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];

    const rows = await ctx.db
      .query("playHistory")
      .withIndex("by_user_playedAt", (q) => q.eq("userId", userId))
      .order("desc")
      .take(limit ?? 12);

    return rows.map((r) => ({
      trackId: r.trackId,
      playedAt: r.playedAt,
      playCount: r.playCount,
      title: r.title,
      artistName: r.artistName,
      coverUrl: r.coverUrl,
      duration: r.duration,
    }));
  },
});

/**
 * The user's most played tracks by total play count, across all sources.
 */
export const mostPlayed = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];

    const rows = await ctx.db
      .query("playHistory")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    rows.sort((a, b) => b.playCount - a.playCount);
    return rows.slice(0, limit ?? 8).map((r) => ({
      trackId: r.trackId,
      playedAt: r.playedAt,
      playCount: r.playCount,
      title: r.title,
      artistName: r.artistName,
      coverUrl: r.coverUrl,
      duration: r.duration,
    }));
  },
});

/**
 * The track the user listened to last (for "Continue listening").
 */
export const continueListening = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;

    const last = await ctx.db
      .query("playHistory")
      .withIndex("by_user_playedAt", (q) => q.eq("userId", userId))
      .order("desc")
      .first();

    if (!last) return null;
    return {
      trackId: last.trackId,
      playedAt: last.playedAt,
      title: last.title,
      artistName: last.artistName,
      coverUrl: last.coverUrl,
    };
  },
});

/**
 * Full listening-statistics dashboard data for the signed-in user —
 * counted across ALL sources (every play of every song, catalog or not):
 * totals, most played, daily activity for the last 30 days, monthly
 * history, listening streaks and most-active hours.
 */
export const listeningStats = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;

    const rows = await ctx.db
      .query("playHistory")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    // playHistory is an upsert-per-track summary. It cannot represent the
    // activity chart correctly because a replay moves that track's single
    // playedAt timestamp to the newest play. Use the append-only event log
    // for every time-based statistic, with a legacy fallback for old data.
    const events = await ctx.db
      .query("playEvents")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const eventCounts = new Map<string, number>();
    for (const event of events) {
      eventCounts.set(event.trackId, (eventCounts.get(event.trackId) ?? 0) + 1);
    }
    // Include any legacy summary plays that predate the append-only event log.
    // Without this bridge, the first event after deployment would make all
    // older plays disappear from totals and charts.
    const legacyPlayedAt = rows.flatMap((row) => {
      const legacyCount = Math.max(
        0,
        row.playCount - (eventCounts.get(row.trackId) ?? 0),
      );
      return Array.from({ length: legacyCount }, () => row.playedAt);
    });
    const playedAt = [
      ...events.map((event) => event.playedAt),
      ...legacyPlayedAt,
    ];

    if (rows.length === 0) {
      return {
        totalPlays: 0,
        uniqueSongs: 0,
        totalSeconds: 0,
        topTracks: [],
        uniqueArtists: 0,
        dailyActivity: [],
        monthlyActivity: [],
        streak: 0,
        activeHours: [] as number[],
      };
    }

    const totalPlays = playedAt.length;
    const totalSeconds = rows.reduce(
      (sum, r) => sum + (r.duration ?? 0) * r.playCount,
      0,
    );

    // Top tracks by play count, with self-contained display info.
    const uniqueArtists = new Set(
      rows
        .map(
          (row) =>
            row.artistName?.trim() || row.title?.trim() || "Unknown artist",
        )
        .filter(Boolean),
    ).size;

    const topTracks = [...rows]
      .sort((a, b) => b.playCount - a.playCount)
      .slice(0, 10)
      .map((r) => ({
        trackId: r.trackId,
        playCount: r.playCount,
        playedAt: r.playedAt,
        title: r.title ?? "Unknown song",
        artistName: r.artistName ?? "Unknown artist",
        coverUrl: r.coverUrl ?? "",
        duration: r.duration,
      }));

    // Daily activity for the last 30 days (weight by playCount).
    const dayMs = 24 * 60 * 60 * 1000;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const daily: { day: string; label: string; plays: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const dayStart = today.getTime() - i * dayMs;
      const next = dayStart + dayMs;
      const plays = playedAt.filter((at) => at >= dayStart && at < next).length;
      const d = new Date(dayStart);
      daily.push({
        day: d.toISOString().slice(0, 10),
        label: d.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        }),
        plays,
      });
    }

    // Monthly activity for the last 12 months.
    const monthly: { month: string; plays: number }[] = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const start = d.getTime();
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
      const plays = playedAt.filter((at) => at >= start && at < end).length;
      monthly.push({
        month: d.toLocaleDateString(undefined, {
          month: "short",
          year: "2-digit",
        }),
        plays,
      });
    }

    // Listening streak — consecutive days (ending today or yesterday) with plays.
    const playedDaySet = new Set(
      playedAt.map((at) => new Date(at).setHours(0, 0, 0, 0)),
    );
    let streak = 0;
    const todayStart = today.getTime();
    const startOffset = playedDaySet.has(todayStart) ? 0 : 1;
    for (let i = startOffset; ; i++) {
      if (playedDaySet.has(todayStart - i * dayMs)) streak++;
      else break;
    }

    // Most active listening hours (0-23 buckets).
    const hourBuckets = new Array(24).fill(0) as number[];
    for (const at of playedAt) {
      hourBuckets[new Date(at).getHours()] += 1;
    }

    return {
      totalPlays,
      uniqueSongs: rows.length,
      totalSeconds,
      topTracks,
      uniqueArtists,
      dailyActivity: daily,
      monthlyActivity: monthly,
      streak,
      activeHours: hourBuckets,
    };
  },
});

/**
 * Aggregated listening facts for one Recap period (month / year / all time).
 *
 * Returns the ALREADY-AGGREGATED facts, not playEvents — the client shapes them
 * into the recap cards with the shared pure `buildRecap`. The window is derived
 * from the same `recapPeriodBounds` the UI labels the recap with, so the period
 * a listener sees is exactly the period that was counted.
 *
 * Uses the append-only event log with the same legacy bridge as
 * `listeningStats`: plays recorded before the log existed are counted from the
 * summary row so they do not silently vanish from an older account's recap.
 */
export const recap = query({
  args: { period: v.optional(v.string()) },
  handler: async (ctx, { period }): Promise<RecapInput | null> => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const p: RecapPeriod =
      period === "year" || period === "all" ? period : "month";
    const now = Date.now();
    const bounds = recapPeriodBounds(p, now);
    const prevBounds = previousRecapPeriodBounds(p, now);

    const rows = await ctx.db
      .query("playHistory")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const events = await ctx.db
      .query("playEvents")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();

    const meta = new Map<
      string,
      { title: string; artistName: string; coverUrl: string; duration: number }
    >();
    for (const row of rows) {
      meta.set(row.trackId, {
        title: row.title ?? "Unknown song",
        artistName: row.artistName ?? "",
        coverUrl: row.coverUrl ?? "",
        duration: row.duration ?? 0,
      });
    }

    const eventCounts = new Map<string, number>();
    for (const event of events) {
      eventCounts.set(event.trackId, (eventCounts.get(event.trackId) ?? 0) + 1);
    }

    const plays: Array<{ trackId: string; at: number }> = events.map((e) => ({
      trackId: e.trackId,
      at: e.playedAt,
    }));
    for (const row of rows) {
      const legacy = Math.max(0, row.playCount - (eventCounts.get(row.trackId) ?? 0));
      for (let i = 0; i < legacy; i++) {
        plays.push({ trackId: row.trackId, at: row.playedAt });
      }
    }

    const artistOf = (trackId: string): string =>
      meta.get(trackId)?.artistName?.trim() ?? "";

    const inRange = (at: number, b: { start: number; end: number }) =>
      at >= b.start && at < b.end;
    const periodPlays = plays.filter((play) => inRange(play.at, bounds));

    const totalPlays = periodPlays.length;
    const uniqueSongs = new Set(periodPlays.map((pl) => pl.trackId)).size;
    const uniqueArtists = new Set(
      periodPlays.map((pl) => artistOf(pl.trackId)).filter(Boolean),
    ).size;

    const durationOf = (trackId: string) => meta.get(trackId)?.duration ?? 0;
    let totalSeconds = 0;
    const playCountByTrack = new Map<string, number>();
    const hourBuckets = new Array(24).fill(0) as number[];
    const dayBuckets = new Map<string, { label: string; plays: number }>();
    for (const play of periodPlays) {
      totalSeconds += Math.max(0, durationOf(play.trackId));
      playCountByTrack.set(play.trackId, (playCountByTrack.get(play.trackId) ?? 0) + 1);
      hourBuckets[new Date(play.at).getHours()] += 1;
      const d = new Date(play.at);
      const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const bucket = dayBuckets.get(key);
      if (bucket) bucket.plays += 1;
      else
        dayBuckets.set(key, {
          label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
          plays: 1,
        });
    }

    let busiestDay: { label: string; plays: number } | null = null;
    for (const bucket of dayBuckets.values()) {
      if (bucket.plays > 0 && (busiestDay === null || bucket.plays > busiestDay.plays)) {
        busiestDay = bucket;
      }
    }

    // Streak is a property of the listener right now, not of the period.
    const dayMs = 24 * 60 * 60 * 1000;
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const todayStart = today.getTime();
    const playedDays = new Set(plays.map((pl) => new Date(pl.at).setHours(0, 0, 0, 0)));
    let streak = 0;
    const startOffset = playedDays.has(todayStart) ? 0 : 1;
    for (let i = startOffset; ; i++) {
      if (playedDays.has(todayStart - i * dayMs)) streak += 1;
      else break;
    }

    // New artists: those whose FIRST recorded play falls inside this period.
    const firstPlayByArtist = new Map<string, number>();
    for (const play of plays) {
      const artist = artistOf(play.trackId);
      if (!artist) continue;
      const first = firstPlayByArtist.get(artist);
      if (first === undefined || play.at < first) firstPlayByArtist.set(artist, play.at);
    }
    // "New artists" only means something for a bounded period. For all-time the
    // window starts at 0, so every artist's first play technically falls inside
    // it and the count would just equal the total artist count — technically
    // true and completely useless. Report 0 for all-time so the recap omits
    // the card rather than showing a meaningless number.
    let newArtists = 0;
    if (p !== "all") {
      for (const first of firstPlayByArtist.values()) {
        if (inRange(first, bounds)) newArtists += 1;
      }
    }

    const topTracks = [...playCountByTrack.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([trackId, playsCount]) => {
        const m = meta.get(trackId);
        return {
          trackId,
          title: m?.title ?? "Unknown song",
          artistName: m?.artistName ?? "Unknown artist",
          coverUrl: m?.coverUrl ?? "",
          plays: playsCount,
        };
      });

    const artistAgg = new Map<
      string,
      { plays: number; tracks: Set<string>; coverUrl: string }
    >();
    for (const play of periodPlays) {
      const artist = artistOf(play.trackId);
      if (!artist) continue;
      const entry = artistAgg.get(artist);
      const coverUrl = meta.get(play.trackId)?.coverUrl ?? "";
      if (entry) {
        entry.plays += 1;
        entry.tracks.add(play.trackId);
        if (!entry.coverUrl && coverUrl) entry.coverUrl = coverUrl;
      } else {
        artistAgg.set(artist, {
          plays: 1,
          tracks: new Set([play.trackId]),
          coverUrl,
        });
      }
    }
    const topArtists = [...artistAgg.entries()]
      .sort((a, b) => b[1].plays - a[1].plays)
      .slice(0, 8)
      .map(([artistName, entry]) => ({
        artistName,
        plays: entry.plays,
        trackCount: entry.tracks.size,
        coverUrl: entry.coverUrl,
      }));

    let previous: RecapInput["previous"] = null;
    if (prevBounds) {
      const prevPlays = plays.filter((play) => inRange(play.at, prevBounds));
      let prevSeconds = 0;
      for (const play of prevPlays) prevSeconds += Math.max(0, durationOf(play.trackId));
      previous = {
        totalPlays: prevPlays.length,
        totalSeconds: prevSeconds,
        uniqueArtists: new Set(
          prevPlays.map((pl) => artistOf(pl.trackId)).filter(Boolean),
        ).size,
      };
    }

    return {
      period: p,
      label: bounds.label,
      totalPlays,
      totalSeconds,
      uniqueSongs,
      uniqueArtists,
      topTracks,
      topArtists,
      activeHours: hourBuckets,
      busiestDay,
      streak,
      newArtists,
      previous,
    };
  },
});

/**
 * Clear all listening history for the signed-in user.
 */
export const clearHistory = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) {
      throw new ConvexError("Sign in first");
    }
    const rows = await ctx.db
      .query("playHistory")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const events = await ctx.db
      .query("playEvents")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    // The derived engagement summary and the recommendation feedback log are
    // derived FROM this history. Leaving them behind after a "clear history"
    // would keep personalising from behaviour the user just deleted, so they
    // are cleared with their source.
    const signals = await ctx.db
      .query("trackSignals")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const feedback = await ctx.db
      .query("recommendationEvents")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const cache = await ctx.db
      .query("recommendationCache")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const all = [...rows, ...events, ...signals, ...feedback, ...cache];
    for (const row of all) {
      await ctx.db.delete(row._id);
    }
    return rows.length;
  },
});
