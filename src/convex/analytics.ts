// ---------------------------------------------------------------------------
// Visit analytics — recording.
//
// First-party page-view capture for the admin dashboard. This is deliberately
// SEPARATE from convex/amplitude.ts: Amplitude is an outbound integration that
// needs a key the workspace may not have, and an admin page that depends on a
// third-party account is an admin page that shows nothing on a fresh deploy.
//
// Privacy: no IP, no user agent, no fingerprint. See src/lib/visitAnalytics.ts.
// ---------------------------------------------------------------------------

import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mutation, internalMutation } from "./_generated/server";
// Relative, not the `@/` alias: the Convex bundler does not resolve it.
import {
  dayKeyOf,
  deviceBucketOf,
  normaliseVisitPath,
} from "../lib/visitAnalytics";

/** Raw rows are pruned after this long; the rollup is what carries the trend. */
const RAW_RETENTION_DAYS = 30;
/** Rollup rows live longer, so year-over-year stays possible. */
const ROLLUP_RETENTION_DAYS = 400;

/**
 * Minimum gap between two recorded visits from the same visitor.
 *
 * Not a rate limit to stop abuse — a listener clicking through the app in two
 * seconds is a normal person, and dropping their navigation would understate
 * the very number this exists to measure. It exists to swallow the double-fires
 * a client produces (React 18 StrictMode double-effects, a route change that
 * re-renders the tracker, a back/forward that reports twice).
 */
const MIN_VISIT_GAP_MS = 1_200;

/**
 * Cap on the distinct-visitor list kept per (day, path).
 *
 * A popularity spike must not turn into an unbounded document. Past the cap we
 * stop ADDING ids and keep counting views, which means the unique-visitor
 * number is a floor rather than a ceiling — the honest direction to be wrong
 * in, and the cap is surfaced to the admin rather than hidden.
 */
const MAX_VISITORS_PER_ROW = 5_000;

const deviceValidator = v.union(
  v.literal("mobile"),
  v.literal("tablet"),
  v.literal("desktop"),
);

/**
 * Record one page view.
 *
 * PUBLIC on purpose: a signed-out visitor on the landing page is still a
 * visit, and gating this on auth would silently drop every anonymous
 * pageview — the majority of them on a music app. It is a fire-and-forget
 * write that stores no personal data, so there is nothing here to leak.
 */
export const recordVisit = mutation({
  args: {
    path: v.string(),
    /** Random per-browser id minted by the client. Never a fingerprint. */
    visitorId: v.string(),
    /**
     * A referrer PATH, already restricted to the app's own origin by the
     * client. The browser is the only place that knows the origin — there is
     * no `location` in the Convex runtime (verified, not assumed) — so the
     * same-origin decision is made there and this value is simply normalised
     * and length-capped here.
     */
    referrerPath: v.optional(v.string()),
    device: v.optional(deviceValidator),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ recorded: boolean; capped?: boolean }> => {
    const now = Date.now();
    const visitorId = args.visitorId.trim();
    if (!visitorId || visitorId.length > 100) return { recorded: false };

    const path = normaliseVisitPath(args.path);
    if (!path || path.length > 120) return { recorded: false };

    // Swallow a double-fire rather than counting the same view twice.
    const last = await ctx.db
      .query("visitEvents")
      .withIndex("by_visitor_at", (q) => q.eq("visitorId", visitorId))
      .order("desc")
      .take(1);
    const lastAt = last[0]?.at ?? 0;
    if (now - lastAt < MIN_VISIT_GAP_MS) return { recorded: false };

    // Signed-in status is a bonus dimension, not a requirement.
    const userId = (await getAuthUserId(ctx)) ?? undefined;

    const day = dayKeyOf(now);
    await ctx.db.insert("visitEvents", {
      day,
      path,
      at: now,
      visitorId,
      userId,
      // A referrer can carry a query string full of campaign junk, and the
      // client has already dropped anything not same-origin. Normalising it
      // here keeps it a route pattern, so a referrer cannot become a new page.
      referrer: safeReferrerPath(args.referrerPath),
      device: args.device ?? deviceBucketOf(undefined, undefined),
    });

    // Roll the day+path counters up in the same transaction, so the dashboard
    // can never read a view that has no rollup or a rollup with no view.
    const existing = await ctx.db
      .query("visitDaily")
      .withIndex("by_day_path", (q) => q.eq("day", day).eq("path", path))
      .take(1);
    const row = existing[0];
    const capped = (row?.visitors.length ?? 0) >= MAX_VISITORS_PER_ROW;
    const seenBefore = row?.visitors.includes(visitorId) ?? false;

    await ctx.db.patch(
      row?._id ??
        (await ctx.db.insert("visitDaily", {
          day,
          path,
          views: 0,
          visitors: [],
          members: [],
          updatedAt: now,
        })),
      {
        views: (row?.views ?? 0) + 1,
        // `capped` deliberately still counts the VIEW; only the distinct list
        // stops growing, so a spike cannot inflate reads.
        visitors:
          seenBefore || capped
            ? (row?.visitors ?? [])
            : [...(row?.visitors ?? []), visitorId],
        members:
          userId && capped
            ? (row?.members ?? [])
            : userId && !(row?.members ?? []).includes(userId)
              ? [...(row?.members ?? []), userId]
              : (row?.members ?? []),
        updatedAt: now,
      },
    );

    return { recorded: true, capped };
  },
});

/**
 * Normalise a client-supplied referrer path, or drop it.
 *
 * Anything that does not look like a plain path is discarded rather than
 * repaired, so a hostile value cannot smuggle a URL or a huge string into the
 * table. The origin was already checked in the browser.
 */
function safeReferrerPath(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  if (raw.length > 200 || !raw.startsWith("/")) return undefined;
  return normaliseVisitPath(raw);
}

/**
 * Trim the raw log and the rollup.
 *
 * Without this `visitEvents` is the only unbounded table in the schema and a
 * busy app would eventually make every admin query expensive. Runs daily; the
 * dashboard degrades to "fewer days of raw data" rather than to "broken".
 */
export const pruneVisits = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ events: number; rollups: number }> => {
    const now = Date.now();
    const rawCutoff = now - RAW_RETENTION_DAYS * 86_400_000;
    const rollupCutoff = dayKeyOf(now - ROLLUP_RETENTION_DAYS * 86_400_000);

    const staleEvents = await ctx.db
      .query("visitEvents")
      .withIndex("by_at", (q) => q.lt("at", rawCutoff))
      .take(5000);
    for (const row of staleEvents) await ctx.db.delete(row._id);

    const staleRollups = await ctx.db
      .query("visitDaily")
      .withIndex("by_day", (q) => q.lt("day", rollupCutoff))
      .take(2000);
    for (const row of staleRollups) await ctx.db.delete(row._id);

    return { events: staleEvents.length, rollups: staleRollups.length };
  },
});
