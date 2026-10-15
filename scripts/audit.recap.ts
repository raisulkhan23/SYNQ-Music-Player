/**
 * Audit harness for SYNQ's Recap shaping and Web/PWA notification decision.
 * Both modules are pure (notifications only touches the DOM in the guarded
 * `notifyTrackChange`, which this suite does not call), so they run under bun.
 *
 *   bun scripts/audit.recap.ts
 */

import {
  buildRecap,
  formatHour,
  formatListeningTime,
  previousRecapPeriodBounds,
  recapPeriodBounds,
  timeOfDayName,
  type RecapInput,
} from "../src/lib/recap";
import {
  notificationCopy,
  shouldNotify,
  notificationsSupported,
  notificationPermission,
  readNotificationsEnabled,
} from "../src/lib/notifications";

let pass = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = "") {
  if (cond) pass++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function eq<T>(name: string, actual: T, expected: T) {
  check(name, Object.is(actual, expected), `got ${String(actual)}, want ${String(expected)}`);
}

// ------------------------------------------------------------- period bounds
{
  const now = Date.UTC(2026, 8, 15, 12); // 2026-09-15
  const month = recapPeriodBounds("month", now);
  eq("month starts on the 1st", new Date(month.start).getUTCMonth(), 8);
  eq("month label includes the month", month.label.includes("September"), true);
  check("month starts before now", month.start < now);

  const year = recapPeriodBounds("year", now);
  eq("year starts in January", new Date(year.start).getUTCMonth(), 0);
  eq("year label is the year", year.label, "2026");

  const all = recapPeriodBounds("all", now);
  eq("all time starts at 0", all.start, 0);
  eq("all time ends now", all.end, now);

  const prevMonth = previousRecapPeriodBounds("month", now);
  check("month has a predecessor", prevMonth !== null);
  eq("predecessor ends where the month begins", prevMonth!.end, month.start);
  eq("predecessor label is August", prevMonth!.label.includes("August"), true);

  const prevYear = previousRecapPeriodBounds("year", now);
  eq("previous year label", prevYear!.label, "2025");
  eq("all time has no predecessor", previousRecapPeriodBounds("all", now), null);
}

// ------------------------------------------------------------- formatting
{
  eq("under an hour is minutes", formatListeningTime(48 * 60), "48m");
  eq("whole hours drop minutes", formatListeningTime(3 * 3600), "3h");
  eq("partial hours keep minutes", formatListeningTime(3 * 3600 + 12 * 60), "3h 12m");
  eq("zero is 0m", formatListeningTime(0), "0m");
  eq("negative is 0m", formatListeningTime(-5), "0m");
  eq("hour 0 is 12am", formatHour(0), "12am");
  eq("hour 12 is 12pm", formatHour(12), "12pm");
  eq("hour 9 is 9am", formatHour(9), "9am");
  eq("hour 21 is 9pm", formatHour(21), "9pm");
  eq("hour 23 is late night", timeOfDayName(23), "late night");
  eq("hour 8 is morning", timeOfDayName(8), "the morning");
  eq("hour 14 is afternoon", timeOfDayName(14), "the afternoon");
  eq("hour 19 is evening", timeOfDayName(19), "the evening");
}

function input(overrides: Partial<RecapInput> = {}): RecapInput {
  return {
    period: "month",
    label: "September 2026",
    totalPlays: 0,
    totalSeconds: 0,
    uniqueSongs: 0,
    uniqueArtists: 0,
    topTracks: [],
    topArtists: [],
    activeHours: new Array(24).fill(0) as number[],
    busiestDay: null,
    streak: 0,
    newArtists: 0,
    previous: null,
    ...overrides,
  };
}

// ------------------------------------------------------------- empty recap
{
  const recap = buildRecap(input());
  check("empty recap is flagged empty", recap.isEmpty);
  check("empty headline says so", recap.headline.toLowerCase().includes("no listening"));
  eq("empty recap has no highlights", recap.highlights.length, 0);
  eq("empty recap has no peak hour", recap.peakHour, null);
  eq("empty recap has no comparison", recap.comparison, null);
  eq("always 24 hour buckets", recap.hours.length, 24);
}

// ------------------------------------------------------------- populated recap
{
  const hours = new Array(24).fill(0) as number[];
  hours[22] = 30; // 10pm peak
  hours[9] = 12;
  const recap = buildRecap(
    input({
      totalPlays: 210,
      totalSeconds: 3 * 3600 + 20 * 60,
      uniqueSongs: 88,
      uniqueArtists: 40,
      streak: 5,
      newArtists: 7,
      activeHours: hours,
      busiestDay: { label: "Sep 4", plays: 34 },
      topTracks: [{ trackId: "x", title: "X", artistName: "A", coverUrl: "", plays: 30 }],
      topArtists: [{ artistName: "A", plays: 40, trackCount: 5, coverUrl: "" }],
      previous: { totalPlays: 180, totalSeconds: 3 * 3600, uniqueArtists: 33 },
    }),
  );
  check("populated recap is not empty", !recap.isEmpty);
  eq("peak hour is 10pm", recap.peakHour!.hour, 22);
  eq("minutes computed", recap.minutes, 200);
  check("headline names the top artist", recap.headline.includes("A"));
  check("headline names the time of day", recap.headline.includes("late night"));
  check("contains a minutes highlight", recap.highlights.some((h) => h.id === "minutes"));
  check("contains a new-artists highlight", recap.highlights.some((h) => h.id === "new_artists"));
  check("contains a busiest-day highlight", recap.highlights.some((h) => h.id === "busiest_day"));
  check("comparison exists", recap.comparison !== null);
  eq("comparison is up (210 > 180)", recap.comparison!.direction, "up");
  eq("plays delta percent", recap.comparison!.playsDeltaPercent, 17);
  // No highlight is ever emitted for a zero value.
  check("no zero-value highlight leaks", recap.highlights.every((h) => h.value !== "0"));
}

// ------------------------------------------------------------- comparison edge
{
  const down = buildRecap(
    input({ totalPlays: 50, previous: { totalPlays: 100, totalSeconds: 0, uniqueArtists: 0 } }),
  );
  eq("down direction", down.comparison!.direction, "down");
  eq("down percent", down.comparison!.playsDeltaPercent, -50);

  const flat = buildRecap(
    input({ totalPlays: 100, previous: { totalPlays: 100, totalSeconds: 0, uniqueArtists: 0 } }),
  );
  eq("flat direction", flat.comparison!.direction, "flat");

  const noPrev = buildRecap(input({ totalPlays: 100 }));
  eq("no previous means no comparison", noPrev.comparison, null);
}

// ------------------------------------------------------------- notifications
{
  const track = { id: "v1", title: "Song", artistName: "Artist" };
  const base = { enabled: true, permission: "granted" as NotificationPermission, hidden: true, lastNotifiedId: null };

  check("notify when visible & different & hidden & granted", shouldNotify(track, base));
  check("never when disabled", !shouldNotify(track, { ...base, enabled: false }));
  check("never without permission", !shouldNotify(track, { ...base, permission: "default" }));
  check("never when the tab is visible", !shouldNotify(track, { ...base, hidden: false }));
  check("never for the same track twice", !shouldNotify(track, { ...base, lastNotifiedId: "v1" }));
  check("never for a null track", !shouldNotify(null, base));
  check("never for a track without a title", !shouldNotify({ id: "v1", title: "", artistName: "x" }, base));

  const copy = notificationCopy(track);
  eq("title is the track title", copy.title, "Song");
  check("body names the artist", copy.body.includes("Artist"));
  eq("tag is stable", copy.tag, notificationCopy({ id: "v2", title: "Other", artistName: "B" }).tag);

  const withAlbum = notificationCopy({ id: "v3", title: "T", artistName: "A", albumName: "Album" });
  check("album is included when present", withAlbum.body.includes("Album"));

  // In a plain bun runtime there is no window/Notification: the module must
  // report unsupported rather than throw, and storage reads must fall back.
  if (!notificationsSupported()) {
    eq("permission is unsupported without the API", notificationPermission(), "unsupported");
  }
  eq("enabled defaults to false with no storage", readNotificationsEnabled(), false);
}

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} check(s) failed:\n`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error(`\n${pass} passed, ${failures.length} failed\n`);
  process.exit(1);
} else {
  console.log(`✓ recap + notifications: ${pass}/${pass} checks passed`);
}
