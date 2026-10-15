import { useMemo, useState } from "react";
import {
  Activity,
  BarChart3,
  Download,
  Globe,
  MousePointerClick,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { downloadCsv, toCsv } from "@/lib/csvExport";
import type { VisitSummary } from "@/lib/visitAnalytics";

/**
 * The admin Visits tab.
 *
 * Takes the summary as a PROP rather than fetching it itself, for the same
 * reason every other panel in this app is split out: the shaping logic in
 * `summariseVisits` is then testable without Convex, and this file stays a
 * pure function of its input. It also means the panel can be mounted in a test
 * with a hand-written summary and no deployment at all.
 *
 * Styling deliberately copies the language already in the admin area
 * (rounded-2xl, white/[0.07] borders, the `--tint` accent) so the new tab does
 * not read as a different product dropped into the same page.
 */
export function VisitAnalytics({
  summary,
  loading = false,
  days = 14,
  onDaysChange,
}: {
  summary?: VisitSummary;
  loading?: boolean;
  /** Which window the data was actually fetched for. */
  days?: number;
  /** Omit to hide the range switcher — e.g. in a test with fixed input. */
  onDaysChange?: (days: 7 | 14 | 30) => void;
}) {
  // The displayed range is the FETCHED range, not local state. An earlier
  // version kept its own `range` state and only relabelled the cards, so
  // clicking 30d showed 14 days of numbers under a "30 days" heading. The
  // parent owns the window and refetches; this component only asks for a
  // change. The local fallback exists solely so the buttons still work when
  // mounted standalone.
  const [localRange, setLocalRange] = useState(days);
  const range = onDaysChange ? days : localRange;
  const setRange = (next: 7 | 14 | 30) => {
    setLocalRange(next);
    onDaysChange?.(next);
  };

  if (loading || summary === undefined) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-[122px] animate-pulse rounded-2xl bg-white/[0.05]"
            />
          ))}
        </div>
        <div className="h-56 animate-pulse rounded-2xl bg-white/[0.05]" />
      </div>
    );
  }

  const { totals, series, topPages } = summary;
  const max = Math.max(1, ...series.map((s) => s.views));
  const busiest = topPages[0];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-xs text-muted-foreground">
          First-party page views, stored on this deployment. No IP addresses, no
          user agents, no fingerprints — a visitor is a random per-browser id
          used only to count.
        </p>
        <div className="flex items-center gap-1 rounded-full border border-white/[0.07] bg-white/[0.03] p-1">
          {onDaysChange
            ? ([7, 14, 30] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setRange(d)}
                  aria-pressed={range === d}
                  className={
                    range === d
                      ? "rounded-full bg-[rgb(var(--tint))] px-3 py-1 text-xs font-semibold text-black"
                      : "rounded-full px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                  }
                >
                  {d}d
                </button>
              ))
            : null}
          <DownloadCsv summary={summary} />
        </div>
      </div>

      {summary.sparse ? (
        <p className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-4 py-2.5 text-xs text-muted-foreground">
          Traffic is still light, so the averages below are based on very few
          visits. They will settle as the app is used.
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          icon={MousePointerClick}
          label={`Page views · ${range} days`}
          value={totals.views}
        />
        <Stat
          icon={Users}
          label={`Unique visitors · ${range} days`}
          value={totals.visitors}
        />
        <Stat
          icon={Activity}
          label="Views per visitor"
          value={totals.viewsPerVisitor.toFixed(1)}
        />
        <Stat
          icon={Globe}
          label="Busiest page"
          value={busiest ? busiest.path : "—"}
          small
        />
      </div>

      <section className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-5">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm font-semibold">Page views per day</p>
          <p className="text-xs text-muted-foreground tabular-nums">
            {totals.dailyAverage.toFixed(1)} avg/day
          </p>
        </div>

        {totals.views === 0 ? (
          <EmptyState
            title="No visits recorded yet"
            body="The moment anyone opens a page, the trend starts here. Raw page views are kept for 30 days and the daily rollup for 400."
          />
        ) : (
          <div className="mt-4 flex h-40 items-end gap-1.5">
            {series.map((point) => (
              <div
                key={point.day}
                className="group relative z-10 flex h-full min-w-0 flex-1 flex-col items-center gap-1 hover:z-20"
              >
                <div
                  className="relative w-full rounded-t bg-[rgb(var(--tint)_/_0.55)] transition-colors group-hover:bg-[rgb(var(--tint))]"
                  style={{
                    height: `${Math.max(3, (point.views / max) * 100)}%`,
                  }}
                  aria-label={`${point.day}: ${point.views} views, ${point.visitors} visitors`}
                >
                  <span className="pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 z-20 hidden w-max -translate-x-1/2 rounded-lg border border-white/10 bg-[#12151d]/95 px-2.5 py-1.5 text-left text-[10px] text-foreground shadow-xl backdrop-blur-xl group-hover:block">
                    <span className="block font-semibold">{point.day}</span>
                    <span className="block text-muted-foreground">
                      {point.views} {point.views === 1 ? "view" : "views"}
                    </span>
                    <span className="block text-muted-foreground">
                      {point.visitors} unique
                    </span>
                  </span>
                </div>
                <span className="w-full truncate text-center text-[9px] text-muted-foreground">
                  {point.day.slice(8)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-white/[0.07] bg-white/[0.03]">
        <div className="flex items-center justify-between gap-3 p-5 pb-3">
          <p className="text-sm font-semibold">Most visited pages</p>
          <p className="text-xs text-muted-foreground">
            routes, not URLs — one row per page, not per artist
          </p>
        </div>

        {topPages.length === 0 ? (
          <div className="px-5 pb-5">
            <EmptyState
              title="Nothing to rank yet"
              body="Page views are grouped by route, so every artist and playlist collapses into a single row instead of thousands of one-hit pages."
            />
          </div>
        ) : (
          <ul className="flex flex-col">
            {topPages.map((page, i) => (
              <li
                key={page.path}
                className="flex items-center gap-4 border-t border-white/[0.05] px-5 py-3"
              >
                <span className="w-5 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {page.path}
                </span>
                <span
                  className="hidden h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-white/[0.06] sm:block"
                  aria-hidden="true"
                >
                  <span
                    className="block h-full rounded-full bg-[rgb(var(--tint)_/_0.7)]"
                    style={{ width: `${Math.max(2, page.share * 100)}%` }}
                  />
                </span>
                <span className="w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                  {page.visitors} unique
                </span>
                <span className="w-14 shrink-0 text-right text-sm font-semibold tabular-nums">
                  {page.views}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-[11px] text-muted-foreground/70">
        Signed-in accounts seen in this window: {totals.members}. Visitors on
        the most recent day: {summary.liveVisitors}.
      </p>
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  small = false,
}: {
  icon: LucideIcon;
  label: string;
  value: number | string;
  small?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-5">
      <span className="flex size-9 items-center justify-center rounded-xl bg-[rgb(var(--tint)_/_0.14)] text-[rgb(var(--tint))]">
        <Icon className="size-[18px]" />
      </span>
      <p
        className={
          small
            ? "mt-3 truncate font-display text-xl font-bold tracking-tight"
            : "mt-3 font-display text-3xl font-bold tracking-tight tabular-nums"
        }
        title={small && typeof value === "string" ? value : undefined}
      >
        {value}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="mt-2 flex flex-col items-center justify-center rounded-xl border border-dashed border-white/[0.08] bg-black/10 px-4 py-8 text-center">
      <BarChart3 className="size-6 text-muted-foreground/45" />
      <p className="mt-2 text-sm font-semibold">{title}</p>
      <p className="mt-1 max-w-sm text-xs text-muted-foreground">{body}</p>
    </div>
  );
}

/**
 * CSV export, built in the browser via the project's shared `@/lib/csvExport`.
 *
 * Reusing that helper rather than hand-rolling a Blob matters: it neutralises
 * a leading `=`, `+`, `-` or `@`, so a route name can never be executed as a
 * formula when an admin opens the file, and it adds the UTF-8 BOM Excel needs.
 * Deliberately no server round trip — the numbers are already on the client.
 */
function DownloadCsv({ summary }: { summary: VisitSummary }) {
  const csv = useMemo(() => {
    const daily = toCsv(summary.series, [
      { header: "day", value: (r) => r.day },
      { header: "views", value: (r) => r.views },
      { header: "unique_visitors", value: (r) => r.visitors },
    ]);
    const pages = toCsv(summary.topPages, [
      { header: "path", value: (r) => r.path },
      { header: "views", value: (r) => r.views },
      { header: "unique_visitors", value: (r) => r.visitors },
      { header: "share", value: (r) => r.share.toFixed(4) },
    ]);
    return `${daily}\r\n${pages}`;
  }, [summary]);

  const lastDay = summary.days[summary.days.length - 1] ?? "export";
  return (
    <button
      type="button"
      onClick={() => {
        try {
          downloadCsv(`synq-visits-${lastDay}.csv`, csv);
        } catch {
          // A blocked download is not worth an error toast in an admin view.
        }
      }}
      className="ml-1 flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
    >
      <Download className="size-3.5" />
      CSV
    </button>
  );
}
