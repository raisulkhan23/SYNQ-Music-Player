/**
 * SYNQ Recap — pure shaping of listening history into a shareable summary.
 *
 * This is the yearly/monthly recap feature. It adds NO new data collection:
 * every number comes from `playEvents` / `playHistory`, which the app already
 * records. Convex owns the database and does the windowed aggregation, then
 * hands the aggregated facts here; this file turns those facts into ranked
 * highlights, a period comparison and a short narration.
 *
 * ── Why it is pure ─────────────────────────────────────────────────────────
 *
 * No I/O and no clock reads except an injected `now`. The period arithmetic
 * (`recapPeriodBounds`) is shared with the Convex query so the window the UI
 * describes is the exact window the query counted — a recap that says "2026"
 * while summing a different range is a bug this structure makes impossible.
 *
 * ── The honesty rule ───────────────────────────────────────────────────────
 *
 * A recap is only ever assembled from measured plays. When a listener has no
 * history for the period the recap is empty and says so, rather than inventing
 * a "top artist" from a single unrelated play or padding the highlight list.
 */

export type RecapPeriod = "month" | "year" | "all";

export const RECAP_PERIODS: Array<{ id: RecapPeriod; label: string }> = [
  { id: "month", label: "This month" },
  { id: "year", label: "This year" },
  { id: "all", label: "All time" },
];

export interface RecapBounds {
  /** Inclusive start, epoch ms. */
  start: number;
  /** Exclusive end, epoch ms. */
  end: number;
  label: string;
}

/**
 * The window a period covers, and the label to show for it.
 *
 * `all` is unbounded in the past: it starts at 0 and ends at `now`. `month` and
 * `year` are calendar-aligned, not rolling, because "September" means the
 * calendar month to a listener, not the last 30 days.
 */
export function recapPeriodBounds(
  period: RecapPeriod,
  now: number = Date.now(),
): RecapBounds {
  const date = new Date(now);
  if (period === "all") {
    return { start: 0, end: now, label: "All time" };
  }
  if (period === "year") {
    const start = new Date(date.getFullYear(), 0, 1).getTime();
    return { start, end: now, label: `${date.getFullYear()}` };
  }
  const start = new Date(date.getFullYear(), date.getMonth(), 1).getTime();
  return {
    start,
    end: now,
    label: date.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
  };
}

/**
 * The window of the period BEFORE `period` relative to `now`, or null when
 * there is no meaningful predecessor (`all`). Used for the "vs last month"
 * comparison so a recap can honestly say whether listening is up or down.
 */
export function previousRecapPeriodBounds(
  period: RecapPeriod,
  now: number = Date.now(),
): RecapBounds | null {
  if (period === "all") return null;
  const date = new Date(now);
  if (period === "year") {
    const year = date.getFullYear() - 1;
    return {
      start: new Date(year, 0, 1).getTime(),
      end: new Date(date.getFullYear(), 0, 1).getTime(),
      label: `${year}`,
    };
  }
  const prevMonthStart = new Date(date.getFullYear(), date.getMonth() - 1, 1);
  const thisMonthStart = new Date(date.getFullYear(), date.getMonth(), 1);
  return {
    start: prevMonthStart.getTime(),
    end: thisMonthStart.getTime(),
    label: prevMonthStart.toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    }),
  };
}

/** The raw, already-aggregated facts a Recap is built from. */
export interface RecapInput {
  period: RecapPeriod;
  label: string;
  totalPlays: number;
  totalSeconds: number;
  uniqueSongs: number;
  uniqueArtists: number;
  topTracks: Array<{
    trackId: string;
    title: string;
    artistName: string;
    coverUrl: string;
    plays: number;
  }>;
  topArtists: Array<{
    artistName: string;
    plays: number;
    trackCount: number;
    coverUrl: string;
  }>;
  /** 24 buckets, index = hour of day. */
  activeHours: number[];
  busiestDay: { label: string; plays: number } | null;
  streak: number;
  /** Artists whose first-ever play fell inside this period. */
  newArtists: number;
  /** Same-shape totals for the immediately preceding period, when available. */
  previous: {
    totalPlays: number;
    totalSeconds: number;
    uniqueArtists: number;
  } | null;
}

export interface RecapHighlight {
  id: string;
  label: string;
  value: string;
  detail?: string;
}

export interface RecapHour {
  hour: number;
  label: string;
  plays: number;
}

export interface RecapComparison {
  /** Percent change in plays vs the previous period, or null when incomparable. */
  playsDeltaPercent: number | null;
  minutesDeltaPercent: number | null;
  /** "up" | "down" | "flat" — for a directional arrow. */
  direction: "up" | "down" | "flat";
}

export interface Recap {
  period: RecapPeriod;
  label: string;
  isEmpty: boolean;
  /** Minutes listened, rounded. */
  minutes: number;
  headline: string;
  highlights: RecapHighlight[];
  topTracks: RecapInput["topTracks"];
  topArtists: RecapInput["topArtists"];
  hours: RecapHour[];
  /** The single busiest hour bucket, or null when there is no history. */
  peakHour: RecapHour | null;
  comparison: RecapComparison | null;
}

function isNum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** "3h 12m" / "48m" / "0m". */
export function formatListeningTime(seconds: number): string {
  const safe = isNum(seconds) && seconds > 0 ? seconds : 0;
  const totalMinutes = Math.round(safe / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** "1", "9am", "12pm", "11pm" for an hour bucket. */
export function formatHour(hour: number): string {
  const h = ((Math.round(hour) % 24) + 24) % 24;
  if (h === 0) return "12am";
  if (h === 12) return "12pm";
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

/** A named time-of-day band for the peak hour, e.g. "late night". */
export function timeOfDayName(hour: number): string {
  const h = ((Math.round(hour) % 24) + 24) % 24;
  if (h < 5) return "late night";
  if (h < 12) return "the morning";
  if (h < 17) return "the afternoon";
  if (h < 21) return "the evening";
  return "late night";
}

function percentChange(current: number, previous: number): number | null {
  if (!isNum(previous) || previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

function directionFrom(delta: number | null): "up" | "down" | "flat" {
  if (delta === null || delta === 0) return "flat";
  return delta > 0 ? "up" : "down";
}

/**
 * Build the ordered highlight cards for a recap.
 *
 * Only cards with a real value behind them are emitted, so a light month shows
 * three cards rather than eight with three of them reading "0".
 */
function buildHighlights(input: RecapInput, peakHour: RecapHour | null): RecapHighlight[] {
  const highlights: RecapHighlight[] = [];
  const minutes = Math.round(input.totalSeconds / 60);

  if (minutes > 0) {
    highlights.push({
      id: "minutes",
      label: "Minutes listened",
      value: formatListeningTime(input.totalSeconds),
    });
  }
  if (input.totalPlays > 0) {
    highlights.push({
      id: "plays",
      label: "Tracks played",
      value: input.totalPlays.toLocaleString(),
    });
  }
  if (input.uniqueSongs > 0) {
    highlights.push({
      id: "songs",
      label: "Different songs",
      value: input.uniqueSongs.toLocaleString(),
    });
  }
  if (input.uniqueArtists > 0) {
    highlights.push({
      id: "artists",
      label: "Different artists",
      value: input.uniqueArtists.toLocaleString(),
    });
  }
  if (input.streak > 1) {
    highlights.push({
      id: "streak",
      label: "Listening streak",
      value: `${input.streak} days`,
    });
  }
  if (input.newArtists > 0) {
    highlights.push({
      id: "new_artists",
      label: "New artists",
      value: `${input.newArtists}`,
      detail: "First time you played them",
    });
  }
  if (peakHour && peakHour.plays > 0) {
    highlights.push({
      id: "peak_hour",
      label: "Most active around",
      value: formatHour(peakHour.hour),
      detail: timeOfDayName(peakHour.hour),
    });
  }
  if (input.busiestDay && input.busiestDay.plays > 0) {
    highlights.push({
      id: "busiest_day",
      label: "Biggest day",
      value: input.busiestDay.label,
      detail: `${input.busiestDay.plays} plays`,
    });
  }
  return highlights;
}

function buildHeadline(input: RecapInput, peakHour: RecapHour | null): string {
  if (input.totalPlays === 0) {
    return `No listening recorded for ${input.label} yet.`;
  }
  const topArtist = input.topArtists[0]?.artistName;
  const timeOfDay = peakHour ? timeOfDayName(peakHour.hour) : null;
  const pieces: string[] = [];
  pieces.push(`${input.totalPlays.toLocaleString()} plays in ${input.label}`);
  if (topArtist) pieces.push(`${topArtist} was your top artist`);
  if (timeOfDay) pieces.push(`most of it in ${timeOfDay}`);
  return `${pieces.join(" · ")}.`;
}

/**
 * Turn aggregated facts into the finished recap. `now` is unused today but kept
 * in the signature so a future time-relative highlight (e.g. "as of today") has
 * a deterministic seam.
 */
export function buildRecap(input: RecapInput): Recap {
  const hours: RecapHour[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    label: formatHour(hour),
    plays: isNum(input.activeHours?.[hour]) ? input.activeHours[hour]! : 0,
  }));

  let peakHour: RecapHour | null = null;
  for (const bucket of hours) {
    if (bucket.plays > 0 && (peakHour === null || bucket.plays > peakHour.plays)) {
      peakHour = bucket;
    }
  }

  const isEmpty = input.totalPlays <= 0;
  const previous = input.previous ?? null;
  const comparison: RecapComparison | null =
    previous && previous.totalPlays > 0
      ? (() => {
          const playsDeltaPercent = percentChange(input.totalPlays, previous.totalPlays);
          const minutesDeltaPercent = percentChange(
            input.totalSeconds,
            previous.totalSeconds,
          );
          return {
            playsDeltaPercent,
            minutesDeltaPercent,
            direction: directionFrom(playsDeltaPercent),
          };
        })()
      : null;

  return {
    period: input.period,
    label: input.label,
    isEmpty,
    minutes: Math.round(input.totalSeconds / 60),
    headline: buildHeadline(input, peakHour),
    highlights: buildHighlights(input, peakHour),
    topTracks: input.topTracks ?? [],
    topArtists: input.topArtists ?? [],
    hours,
    peakHour,
    comparison,
  };
}
