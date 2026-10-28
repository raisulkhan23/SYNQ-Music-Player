import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { motion } from "framer-motion";
import {
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Clock,
  Flame,
  Minus,
  Music2,
  Sparkles,
  Users,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import { buildRecap, RECAP_PERIODS, type RecapPeriod } from "@/lib/recap";
import { cn } from "@/lib/utils";

const HIGHLIGHT_ICONS: Record<string, typeof Clock> = {
  minutes: Clock,
  plays: Music2,
  songs: Music2,
  artists: Users,
  streak: Flame,
  new_artists: Sparkles,
  peak_hour: Clock,
  busiest_day: BarChart3,
};

function Cover({ src, alt, className }: { src?: string; alt: string; className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-xl bg-white/[0.06]", className)}>
      {src ? (
        <img src={src} alt={alt} loading="lazy" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <Music2 className="size-5 text-muted-foreground" />
        </div>
      )}
    </div>
  );
}

function ComparisonPill({
  comparison,
}: {
  comparison: NonNullable<ReturnType<typeof buildRecap>["comparison"]>;
}) {
  const delta = comparison.playsDeltaPercent;
  if (delta === null) return null;
  const Icon =
    comparison.direction === "up" ? ArrowUpRight : comparison.direction === "down" ? ArrowDownRight : Minus;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold",
        comparison.direction === "up" && "bg-emerald-500/15 text-emerald-300",
        comparison.direction === "down" && "bg-rose-500/15 text-rose-300",
        comparison.direction === "flat" && "bg-white/[0.07] text-muted-foreground",
      )}
    >
      <Icon className="size-3.5" />
      {delta > 0 ? "+" : ""}
      {delta}% vs last period
    </span>
  );
}

export default function Recap() {
  const [period, setPeriod] = useState<RecapPeriod>("month");
  const raw = useQuery(api.history.recap, { period });
  const recap = useMemo(() => (raw ? buildRecap(raw) : null), [raw]);

  const maxHour = recap ? Math.max(1, ...recap.hours.map((h) => h.plays)) : 1;

  return (
    <div className="flex flex-col gap-8 pb-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[rgb(var(--tint))]">
            Recap
          </p>
          <h1 className="mt-1 font-display text-3xl font-bold tracking-tight sm:text-4xl">
            Your listening, wrapped
          </h1>
          <p className="mt-1 max-w-lg text-sm text-muted-foreground">
            A summary of everything you actually pressed play on — no guessing, no
            invented taste.
          </p>
        </div>
        <div
          role="tablist"
          aria-label="Recap period"
          className="flex rounded-full border border-white/[0.08] bg-white/[0.03] p-1"
        >
          {RECAP_PERIODS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={period === p.id}
              onClick={() => setPeriod(p.id)}
              className={cn(
                "rounded-full px-4 py-1.5 text-sm font-medium transition-colors",
                period === p.id
                  ? "bg-[rgb(var(--tint))] text-black"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
      </header>

      {raw === undefined ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-2xl bg-white/[0.05]" />
          ))}
        </div>
      ) : recap === null || recap.isEmpty ? (
        <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-white/10 py-24 text-center">
          <BarChart3 className="size-10 text-muted-foreground/40" />
          <div>
            <p className="font-display text-lg font-semibold">Nothing to recap yet</p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Play a few songs and your {period === "year" ? "year" : "month"} in music
              will show up here.
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Hero */}
          <motion.section
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="relative overflow-hidden rounded-3xl border border-white/[0.08] bg-gradient-to-br from-[rgb(var(--tint)_/_0.18)] to-transparent p-6 sm:p-8"
          >
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                  {recap.label}
                </p>
                <p className="mt-2 font-display text-4xl font-bold sm:text-5xl">
                  {recap.minutes.toLocaleString()}
                  <span className="ml-2 text-xl font-medium text-muted-foreground">minutes</span>
                </p>
                <p className="mt-2 max-w-xl text-sm text-muted-foreground">{recap.headline}</p>
              </div>
              {recap.comparison ? <ComparisonPill comparison={recap.comparison} /> : null}
            </div>
          </motion.section>

          {/* Highlights */}
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {recap.highlights.map((h, i) => {
              const Icon = HIGHLIGHT_ICONS[h.id] ?? Sparkles;
              return (
                <motion.div
                  key={h.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.03 }}
                  className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-4"
                >
                  <Icon className="size-4 text-[rgb(var(--tint))]" />
                  <p className="mt-3 font-display text-2xl font-bold">{h.value}</p>
                  <p className="text-xs text-muted-foreground">{h.label}</p>
                  {h.detail ? (
                    <p className="mt-0.5 text-[11px] text-muted-foreground/70">{h.detail}</p>
                  ) : null}
                </motion.div>
              );
            })}
          </section>

          {/* Top artists */}
          {recap.topArtists.length > 0 ? (
            <section>
              <h2 className="mb-3 font-display text-lg font-semibold">Top artists</h2>
              <div className="flex flex-wrap gap-3">
                {recap.topArtists.map((artist, i) => (
                  <div
                    key={artist.artistName}
                    className="flex w-36 flex-col gap-2 rounded-2xl border border-white/[0.07] bg-white/[0.03] p-3"
                  >
                    <div className="relative">
                      <Cover src={artist.coverUrl} alt={artist.artistName} className="aspect-square w-full" />
                      <span className="absolute left-2 top-2 rounded-full bg-black/70 px-2 py-0.5 text-[11px] font-bold">
                        #{i + 1}
                      </span>
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{artist.artistName}</p>
                      <p className="text-xs text-muted-foreground">
                        {artist.plays} plays · {artist.trackCount} songs
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {/* Top tracks */}
          {recap.topTracks.length > 0 ? (
            <section>
              <h2 className="mb-3 font-display text-lg font-semibold">Top songs</h2>
              <ol className="divide-y divide-white/[0.06] overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.02]">
                {recap.topTracks.map((track, i) => (
                  <li key={track.trackId} className="flex items-center gap-3 px-3 py-2.5">
                    <span className="w-5 text-center text-sm font-semibold text-muted-foreground">
                      {i + 1}
                    </span>
                    <Cover src={track.coverUrl} alt={track.title} className="size-10 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{track.title}</p>
                      <p className="truncate text-xs text-muted-foreground">{track.artistName}</p>
                    </div>
                    <span className="shrink-0 text-xs font-semibold text-muted-foreground">
                      {track.plays}×
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {/* Listening hours */}
          <section>
            <h2 className="mb-3 font-display text-lg font-semibold">
              When you listened
              {recap.peakHour ? (
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  peak at {recap.peakHour.label}
                </span>
              ) : null}
            </h2>
            <div className="flex h-32 items-end gap-1 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-3">
              {recap.hours.map((h) => (
                <div key={h.hour} className="flex flex-1 flex-col items-center gap-1">
                  <div
                    className={cn(
                      "w-full rounded-sm transition-colors",
                      recap.peakHour?.hour === h.hour
                        ? "bg-[rgb(var(--tint))]"
                        : "bg-[rgb(var(--tint)_/_0.35)]",
                    )}
                    style={{ height: `${Math.max(2, (h.plays / maxHour) * 88)}px` }}
                    title={`${h.label}: ${h.plays} plays`}
                  />
                </div>
              ))}
            </div>
            <div className="mt-1 flex justify-between px-3 text-[10px] text-muted-foreground">
              <span>12am</span>
              <span>6am</span>
              <span>12pm</span>
              <span>6pm</span>
              <span>11pm</span>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
