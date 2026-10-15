import { describe, expect, test } from 'vitest';
import {
  addDays,
  dayKeyOf,
  deviceBucketOf,
  lastNDays,
  normaliseVisitPath,
  summariseVisits,
} from "../src/lib/visitAnalytics.ts";

/**
 * The pure half of visit analytics.
 *
 * The single most important behaviour here is `normaliseVisitPath`. If it
 * regresses, the admin dashboard does not error — it quietly starts reporting
 * one page per artist, which looks like plausible data and is worse than no
 * analytics at all. So it is tested hard.
 */
describe("page views are counted per page, not per URL", () => {
  test("two different artists collapse into one row", () => {
    expect(normaliseVisitPath("/artist/Bjork")).toBe("/artist/:artist");
    expect(normaliseVisitPath("/artist/Taylor Swift")).toBe("/artist/:artist");
    expect(normaliseVisitPath("/artist/Pj Harvey")).toBe("/artist/:artist");
  });

  test("an encoded segment is still just one page", () => {
    expect(normaliseVisitPath("/artist/Taylor%20Swift")).toBe(
      "/artist/:artist",
    );
  });

  test("an album keeps both of its parameters", () => {
    expect(normaliseVisitPath("/album/Bjork/Vespertine")).toBe(
      "/album/:artist/:album",
    );
  });

  test("every dynamic route in the app is recognised", () => {
    expect(normaliseVisitPath("/t/abc123")).toBe("/t/:trackId");
    expect(normaliseVisitPath("/playlist/k9x2")).toBe("/playlist/:id");
  });

  test("static routes are left alone", () => {
    for (const path of [
      "/",
      "/home",
      "/search",
      "/discover",
      "/liked",
      "/playlists",
      "/stats",
      "/recent",
      "/social",
      "/profile",
      "/settings",
      "/admin",
      "/auth",
      "/support",
      "/privacy",
      "/terms",
    ]) {
      expect(normaliseVisitPath(path)).toBe(path);
    }
  });

  test("home and the root stay separate, because they are separate pages", () => {
    expect(normaliseVisitPath("/")).toBe("/");
    expect(normaliseVisitPath("/home")).toBe("/home");
  });

  test("a query string is not a new page", () => {
    // Otherwise every search a listener types becomes its own row, and the
    // "most visited pages" table fills up with searches instead of pages.
    expect(normaliseVisitPath("/search?q=love")).toBe("/search");
    expect(normaliseVisitPath("/discover#results")).toBe("/discover");
  });

  test("trailing and duplicate slashes are one page", () => {
    expect(normaliseVisitPath("/search/")).toBe("/search");
    expect(normaliseVisitPath("//search//")).toBe("/search");
    expect(normaliseVisitPath("/")).toBe("/");
  });

  test("an unknown deep route is bucketed rather than exploded", () => {
    const first = normaliseVisitPath("/a/b/c/d/e/f");
    const second = normaliseVisitPath("/x/y/z/w/q/r");
    expect(first).toBe(second);
    expect(first).toBe("/:other");
  });

  test("an unknown short route is kept, so the admin can see it exists", () => {
    expect(normaliseVisitPath("/promo/spring")).toBe("/promo/spring");
  });

  test("a hostile or empty input cannot break normalisation", () => {
    expect(normaliseVisitPath("")).toBe("/");
    expect(normaliseVisitPath(undefined)).toBe("/");
    expect(normaliseVisitPath(null)).toBe("/");
    expect(normaliseVisitPath("not-a-path")).toBe("/not-a-path");
    expect(normaliseVisitPath("a".repeat(500)).length).toBeLessThanOrEqual(121);
  });
});

describe("days are counted in UTC so the chart cannot shift shape", () => {
  const at = Date.UTC(2026, 0, 15, 23, 30);

  test("a day key is YYYY-MM-DD", () => {
    expect(dayKeyOf(at)).toBe("2026-01-15");
  });

  test("a day key does not roll over at local midnight", () => {
    // 23:30 UTC is already the next day in Sydney and still the previous one
    // in Los Angeles. Using local time would make the same instant produce two
    // different days depending on who looked.
    expect(dayKeyOf(at)).toBe("2026-01-15");
  });

  test("adding days crosses months and years", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  test("the window is oldest-first and contiguous", () => {
    const days = lastNDays(3, Date.UTC(2026, 0, 15));
    expect(days).toEqual(["2026-01-13", "2026-01-14", "2026-01-15"]);
  });

  test("an absurd window is clamped instead of hanging", () => {
    expect(lastNDays(0, at)).toHaveLength(1);
    expect(lastNDays(-5, at)).toHaveLength(1);
    expect(lastNDays(99999, at)).toHaveLength(365);
  });
});

describe("the device is a bucket, never a fingerprint", () => {
  test("phones and tablets are told apart from desktops", () => {
    expect(
      deviceBucketOf("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)", 390),
    ).toBe("mobile");
    expect(deviceBucketOf("Mozilla/5.0 (iPad; CPU OS 17_0)", 820)).toBe(
      "tablet",
    );
    expect(
      deviceBucketOf("Mozilla/5.0 (Macintosh; Intel Mac OS X)", 1440),
    ).toBe("desktop");
  });

  test("width alone is enough when the user agent says nothing", () => {
    expect(deviceBucketOf(undefined, 375)).toBe("mobile");
    expect(deviceBucketOf(undefined, 800)).toBe("tablet");
    expect(deviceBucketOf(undefined, 1600)).toBe("desktop");
  });

  test("an unknown device is a desktop, not a crash", () => {
    expect(deviceBucketOf(undefined, undefined)).toBe("desktop");
  });
});

describe("the summary the admin actually sees", () => {
  const now = Date.UTC(2026, 0, 15, 12);
  const row = (day, path, views, visitors, members = []) => ({
    day,
    path,
    views,
    visitors,
    members,
  });

  test("totals add up and unique visitors are deduped across pages", () => {
    // The same person on two pages is ONE visitor and TWO views. Getting this
    // backwards is the classic mistake in visit analytics.
    const summary = summariseVisits(
      [
        row("2026-01-15", "/home", 3, ["v1", "v2"]),
        row("2026-01-15", "/search", 1, ["v1"]),
      ],
      14,
      now,
    );
    expect(summary.totals.views).toBe(4);
    expect(summary.totals.visitors).toBe(2);
    expect(summary.totals.viewsPerVisitor).toBe(2);
  });

  test("a day with no traffic is a zero bar, not a missing one", () => {
    const summary = summariseVisits(
      [row("2026-01-15", "/home", 5, ["v1"])],
      7,
      now,
    );
    expect(summary.series).toHaveLength(7);
    expect(summary.series.every((p) => p.views >= 0)).toBe(true);
    const today = summary.series[6];
    expect(today.views).toBe(5);
    // And the day before is present and zero, not absent.
    expect(summary.series[5].day).toBe("2026-01-14");
    expect(summary.series[5].views).toBe(0);
  });

  test("rows outside the window are ignored", () => {
    const summary = summariseVisits(
      [row("2020-01-01", "/ancient", 999, ["v0"])],
      14,
      now,
    );
    expect(summary.totals.views).toBe(0);
    expect(summary.topPages).toHaveLength(0);
  });

  test("top pages are ranked and their share is relative to the busiest", () => {
    const summary = summariseVisits(
      [
        row("2026-01-15", "/home", 10, ["v1"]),
        row("2026-01-15", "/search", 5, ["v1", "v2"]),
        row("2026-01-15", "/settings", 1, ["v3"]),
      ],
      14,
      now,
    );
    expect(summary.topPages.map((p) => p.path)).toEqual([
      "/home",
      "/search",
      "/settings",
    ]);
    expect(summary.topPages[0].share).toBe(1);
    expect(summary.topPages[1].share).toBe(0.5);
  });

  test("it admits when there is too little data to average", () => {
    expect(summariseVisits([], 14, now).sparse).toBe(true);
    const busy = summariseVisits(
      [row("2026-01-15", "/home", 40, ["v1", "v2"])],
      14,
      now,
    );
    expect(busy.sparse).toBe(false);
  });

  test("no data at all produces a well-formed, renderable summary", () => {
    const summary = summariseVisits([], 14, now);
    expect(summary.totals.views).toBe(0);
    expect(summary.totals.viewsPerVisitor).toBe(0);
    expect(summary.totals.dailyAverage).toBe(0);
    expect(summary.series).toHaveLength(14);
    expect(summary.topPages).toEqual([]);
    expect(summary.liveVisitors).toBe(0);
  });

  test("malformed rows cannot produce NaN on the dashboard", () => {
    const summary = summariseVisits(
      [
        { day: "2026-01-15", path: "/home", views: NaN, visitors: null },
        { day: "2026-01-15", path: "/search", views: -5, visitors: undefined },
      ],
      14,
      now,
    );
    expect(Number.isFinite(summary.totals.views)).toBe(true);
    expect(summary.totals.views).toBe(0);
    expect(summary.totals.visitors).toBe(0);
  });
});
