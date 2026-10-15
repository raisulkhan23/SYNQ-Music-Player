/**
 * Visit analytics — the PURE half.
 *
 * No fetch, no Convex, no React. Everything the admin dashboard shows and
 * everything the server stores is decided here, so the interesting parts
 * (what counts as one page, what counts as a unique visitor, how a trend is
 * shaped) are unit-testable without a database or a DOM.
 *
 * This module is imported by BOTH the browser and the Convex action beside it,
 * so it must not import the `@/` alias (the Convex bundler does not resolve
 * path aliases) and must not import anything Convex-only.
 *
 * PRIVACY IS THE DESIGN, NOT A FILTER. No IP address, no user agent, no
 * fingerprint, no third-party id. A "visitor" is a random string the browser
 * invents, and the only thing derived from it is a count. Anything that would
 * let two different people be told apart — or one person followed across
 * devices — is absent on purpose, which is what /privacy actually promises.
 */

/** Route patterns, matched longest-first. Mirrors the router in `main.tsx`. */
const KNOWN_ROUTES: readonly string[] = [
  "/album/:artist/:album",
  "/artist/:artist",
  "/playlist/:id",
  "/t/:trackId",
  "/dashboard",
  "/discover",
  "/support",
  "/privacy",
  "/terms",
  "/profile",
  "/playlists",
  "/settings",
  "/social",
  "/recent",
  "/search",
  "/stats",
  "/admin",
  "/liked",
  "/home",
  "/auth",
  "/",
];

/** Anything longer is a runaway query string, not a route. */
const MAX_PATH_LENGTH = 120;
/** Deeper than this and it is not a route in this app; bucket it. */
const MAX_SEGMENTS = 4;

/**
 * Collapse a real URL into a route PATTERN.
 *
 * This is the single most important function in the file. Without it,
 * `/artist/Bjork` and `/artist/Taylor Swift` are two different "pages" and the
 * admin dashboard reports 400 one-hit pages instead of one page with 400
 * visits — technically true and completely useless.
 *
 * Segments in the value position are replaced with the parameter name, so
 * cardinality stays bounded no matter how many artists exist.
 */
export function normaliseVisitPath(raw: string): string {
  // Drop the query string and hash: "?q=love" is a search, not a page, and
  // storing it would make an unbounded number of "pages" out of one screen.
  let path = String(raw ?? "")
    .split("?")[0]
    .split("#")[0];
  if (path.length > MAX_PATH_LENGTH) path = path.slice(0, MAX_PATH_LENGTH);
  if (!path.startsWith("/")) path = `/${path}`;
  // Collapse duplicate slashes, then drop the trailing one — but never turn
  // the root into an empty string.
  path = path.replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  if (path === "") path = "/";

  // Exact known route (covers the root and every static page).
  if (KNOWN_ROUTES.includes(path)) return path;

  // Parameterised route: compare segment counts so "/artist/x" cannot match
  // "/artist", and match a literal only against a literal.
  const segments = path.split("/").filter(Boolean);
  if (segments.length > MAX_SEGMENTS) return "/:other";
  for (const pattern of KNOWN_ROUTES) {
    const patternSegments = pattern.split("/").filter(Boolean);
    if (patternSegments.length !== segments.length) continue;
    const matches = patternSegments.every(
      (p, i) => p.startsWith(":") || p === segments[i],
    );
    if (matches) return pattern;
  }

  // An unknown route that looks like it carries an id is almost always a real
  // page we have not listed yet; bucket it as a generic detail page so the row
  // is still recognisable.
  const last = segments[segments.length - 1] ?? "";
  const looksLikeId = /^\d+$/.test(last) || last.length > 24;
  if (looksLikeId) return `/:other`;
  return path;
}

/** UTC day key, "YYYY-MM-DD". UTC so a day does not change shape at midnight
 *  for a user, and so server and client agree without a timezone argument. */
export function dayKeyOf(at: number): string {
  const d = new Date(at);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Shift a day key by whole days. Returns a valid key for negative `delta`. */
export function addDays(dayKey: string, delta: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  const base = Date.UTC(y, (m ?? 1) - 1, d ?? 1);
  return dayKeyOf(base + delta * 86_400_000);
}

/**
 * The last `days` day keys ending at `nowMs`, OLDEST FIRST.
 *
 * Gaps are filled in rather than skipped, so a day with no traffic is a zero
 * in the chart instead of a missing bar. A chart that silently closes the gap
 * is a chart that lies about uptime.
 */
export function lastNDays(days: number, nowMs: number): string[] {
  const n = Math.max(1, Math.min(365, Math.floor(days) || 1));
  const end = dayKeyOf(nowMs);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i -= 1) out.push(addDays(end, -i));
  return out;
}

/** Coarse device bucket. Deliberately not a UA string. */
export function deviceBucketOf(
  ua: string | undefined,
  width: number | undefined,
): "mobile" | "tablet" | "desktop" {
  const s = (ua ?? "").toLowerCase();
  if (/ipad|tablet|playbook|silk/.test(s)) return "tablet";
  if (/mobi|iphone|android|phone/.test(s)) return "mobile";
  if (typeof width === "number" && width > 0) {
    if (width < 640) return "mobile";
    if (width < 1024) return "tablet";
  }
  return "desktop";
}

/** A rollup row, as stored. */
export interface VisitDailyRow {
  day: string;
  path: string;
  views: number;
  visitors: string[];
  members: string[];
}

/** One bar in the trend chart. */
export interface VisitDayPoint {
  day: string;
  views: number;
  visitors: number;
}

/** One row in the top-pages table. */
export interface VisitTopPage {
  path: string;
  views: number;
  visitors: number;
  /** 0..1 against the busiest page, for the share bar. */
  share: number;
}

export interface VisitSummary {
  days: string[];
  totals: {
    views: number;
    visitors: number;
    members: number;
    /** Distinct visitors per view — how many pages one person saw. */
    viewsPerVisitor: number;
    dailyAverage: number;
  };
  series: VisitDayPoint[];
  topPages: VisitTopPage[];
  /** Distinct visitors seen in the last 24h of the window. */
  liveVisitors: number;
  /** True when there is not enough data for the averages to mean anything. */
  sparse: boolean;
}

const EMPTY_SUMMARY_DAYS = 14;

/**
 * Turn rollup rows into exactly what the dashboard renders.
 *
 * Pure and total: any input (including none) produces a well-formed summary,
 * so the admin tab can render unconditionally instead of guarding every field.
 * Gaps in the day range are filled with zeros for the reason given on
 * `lastNDays`.
 */
export function summariseVisits(
  rows: VisitDailyRow[],
  days: number = EMPTY_SUMMARY_DAYS,
  nowMs: number = Date.now(),
): VisitSummary {
  const dayList = lastNDays(days, nowMs);
  const daySet = new Set(dayList);
  const inWindow = rows.filter((r) => daySet.has(r.day));

  const perDay = new Map<string, { views: number; visitors: Set<string> }>();
  for (const day of dayList) perDay.set(day, { views: 0, visitors: new Set() });

  const perPath = new Map<string, { views: number; visitors: Set<string> }>();
  const allVisitors = new Set<string>();
  const allMembers = new Set<string>();
  let views = 0;

  for (const row of inWindow) {
    const rowViews = Number.isFinite(row.views) ? Math.max(0, row.views) : 0;
    views += rowViews;

    const dayBucket = perDay.get(row.day);
    if (dayBucket) dayBucket.views += rowViews;

    const pathBucket = perPath.get(row.path) ?? {
      views: 0,
      visitors: new Set(),
    };
    pathBucket.views += rowViews;
    perPath.set(row.path, pathBucket);

    for (const v of row.visitors ?? []) {
      allVisitors.add(v);
      dayBucket?.visitors.add(v);
      pathBucket.visitors.add(v);
    }
    for (const m of row.members ?? []) allMembers.add(m);
  }

  const series: VisitDayPoint[] = dayList.map((day) => {
    const b = perDay.get(day);
    return { day, views: b?.views ?? 0, visitors: b?.visitors.size ?? 0 };
  });

  const topPages: VisitTopPage[] = [...perPath.entries()]
    .map(([path, b]) => ({
      path,
      views: b.views,
      visitors: b.visitors.size,
      share: 0,
    }))
    .sort((a, b) => b.views - a.views || a.path.localeCompare(b.path))
    .slice(0, 12);
  const busiest = topPages[0]?.views ?? 0;
  for (const p of topPages) p.share = busiest > 0 ? p.views / busiest : 0;

  const visitorCount = allVisitors.size;
  const spanDays = dayList.length;

  return {
    days: dayList,
    totals: {
      views,
      visitors: visitorCount,
      members: allMembers.size,
      viewsPerVisitor: visitorCount > 0 ? views / visitorCount : 0,
      dailyAverage: views / spanDays,
    },
    series,
    topPages,
    // "Live" here means seen within the final day of the window, which is the
    // most this rollup can honestly claim without a realtime store.
    liveVisitors: series[series.length - 1]?.visitors ?? 0,
    sparse: views < spanDays,
  };
}

/**
 * CSV of the summary is intentionally NOT built here.
 *
 * The project already has `@/lib/csvExport`, which does this properly —
 * including neutralising a leading `=`, `+`, `-` or `@` so a spreadsheet
 * cannot execute a route name as a formula. That module imports through the
 * `@/` alias, which the Convex bundler cannot resolve, and this file IS
 * imported by the Convex action. So the CSV is assembled in the React panel,
 * next to the button that downloads it, using the shared helper.
 */
