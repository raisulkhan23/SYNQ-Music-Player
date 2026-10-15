import {
  Bar,
  BarChart,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "@/convex/_generated/api";
import { Link } from "react-router";

import { formatTime } from "@/lib/format";
import { useQuery } from "convex/react";
import { BarChart3, Flame, Hourglass, Music2, Trophy } from "lucide-react";

// Recharts lives behind this page's lazy() route — it never loads until the
// user opens Stats, keeping the initial bundle small.

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Music2;
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="size-4 text-[rgb(var(--tint))]" />
        <p className="text-xs font-semibold tracking-widest uppercase">
          {label}
        </p>
      </div>
      <p className="mt-2 font-display text-2xl font-bold tracking-tight">
        {value}
      </p>
    </div>
  );
}

export default function Stats() {
  const stats = useQuery(api.history.listeningStats);

  if (stats === undefined) {
    return (
      <div className="flex flex-col gap-4 py-10">
        <div className="h-8 w-52 animate-pulse rounded bg-white/[0.05]" />
        <div className="grid gap-3 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-2xl bg-white/[0.05]"
            />
          ))}
        </div>
        <div className="h-48 animate-pulse rounded-2xl bg-white/[0.05]" />
      </div>
    );
  }

  const isEmpty = stats === null || stats.totalPlays === 0;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
            Your listening stats
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Everything you've played through SYNQ, visualized.
          </p>
        </div>
        <Link
          to="/recap"
          className="rounded-full border border-[rgb(var(--tint)_/_0.35)] bg-[rgb(var(--tint)_/_0.1)] px-4 py-2 text-sm font-semibold text-[rgb(var(--tint))] transition-colors hover:bg-[rgb(var(--tint)_/_0.18)]"
        >
          Open your Recap
        </Link>
      </header>

      {isEmpty ? (
        <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-white/10 py-16 text-center">
          <BarChart3 className="size-10 text-muted-foreground/40" />
          <p className="max-w-sm text-sm text-muted-foreground">
            Play some music and your stats will appear here — top tracks,
            listening streaks, monthly history and more.
          </p>
          <Link
            to="/home"
            className="mt-1 rounded-full bg-[rgb(var(--tint))] px-5 py-2.5 text-sm font-semibold text-black"
          >
            Start listening
          </Link>
        </div>
      ) : (
        <>
          {/* headline numbers */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              icon={Music2}
              label="Unique songs"
              value={stats.uniqueSongs}
            />
            <StatCard
              icon={Trophy}
              label="Total plays"
              value={stats.totalPlays}
            />
            <StatCard icon={Flame} label="Day streak" value={stats.streak} />
            <StatCard
              icon={Hourglass}
              label="Avg. per song"
              value={`${Math.round(stats.totalPlays / Math.max(1, stats.uniqueSongs))}×`}
            />
          </div>

          {/* daily activity — last 30 days */}
          <section className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-5">
            <h2 className="font-display text-lg font-bold tracking-tight">
              Last 30 days
            </h2>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart
                data={stats.dailyActivity}
                margin={{ top: 12, right: 8, bottom: 0, left: -20 }}
              >
                <XAxis
                  dataKey="label"
                  tick={{
                    fill: "rgb(var(--tint))",
                    fontSize: 10,
                    opacity: 0.6,
                  }}
                  interval={4}
                  stroke="rgba(255,255,255,0.1)"
                />
                <YAxis
                  tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 10 }}
                  stroke="rgba(255,255,255,0.1)"
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{
                    background: "#12141c",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 12,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: "rgba(255,255,255,0.6)" }}
                />
                <Line
                  type="monotone"
                  dataKey="plays"
                  stroke="rgb(var(--tint))"
                  strokeWidth={2.5}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </section>

          {/* monthly history */}
          <section className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-5">
            <h2 className="font-display text-lg font-bold tracking-tight">
              Monthly history
            </h2>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart
                data={stats.monthlyActivity}
                margin={{ top: 12, right: 8, bottom: 0, left: -20 }}
              >
                <XAxis
                  dataKey="month"
                  tick={{ fill: "rgba(255,255,255,0.45)", fontSize: 10 }}
                  stroke="rgba(255,255,255,0.1)"
                />
                <YAxis
                  tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 10 }}
                  stroke="rgba(255,255,255,0.1)"
                  allowDecimals={false}
                />
                <Tooltip
                  cursor={{ fill: "rgba(255,255,255,0.04)" }}
                  contentStyle={{
                    background: "#12141c",
                    border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 12,
                    fontSize: 12,
                  }}
                />
                <Bar
                  dataKey="plays"
                  fill="rgb(var(--tint))"
                  radius={[6, 6, 0, 0]}
                  maxBarSize={36}
                />
              </BarChart>
            </ResponsiveContainer>
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            {/* top tracks */}
            <section className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-5">
              <h2 className="font-display text-lg font-bold tracking-tight">
                Most played
              </h2>
              <div className="mt-3 flex flex-col gap-2">
                {stats.topTracks.map((t, i) => (
                  <div
                    key={t.trackId}
                    className="flex items-center gap-3 rounded-xl px-2 py-1.5 transition-colors hover:bg-white/[0.05]"
                  >
                    <span className="w-5 text-center text-sm tabular-nums text-muted-foreground">
                      {i + 1}
                    </span>
                    {t.coverUrl ? (
                      <img
                        src={t.coverUrl}
                        alt=""
                        className="size-10 rounded-md object-cover ring-1 ring-white/10"
                        loading="lazy"
                      />
                    ) : (
                      <span className="flex size-10 items-center justify-center rounded-md bg-white/[0.06] ring-1 ring-white/10">
                        <Music2 className="size-4 text-muted-foreground" />
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{t.title}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {t.artistName}
                      </p>
                    </div>
                    <span className="text-sm tabular-nums text-[rgb(var(--tint))]">
                      {t.playCount}×
                    </span>
                  </div>
                ))}
              </div>
            </section>

            {/* most active hours */}
            <section className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-5">
              <h2 className="font-display text-lg font-bold tracking-tight">
                When you listen
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Plays by hour of day
              </p>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart
                  data={stats.activeHours.map((plays, hour) => ({
                    hour: `${hour}`,
                    plays,
                  }))}
                  margin={{ top: 12, right: 8, bottom: 0, left: -20 }}
                >
                  <XAxis
                    dataKey="hour"
                    tick={{ fill: "rgba(255,255,255,0.45)", fontSize: 9 }}
                    interval={2}
                    stroke="rgba(255,255,255,0.1)"
                  />
                  <YAxis
                    tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 10 }}
                    stroke="rgba(255,255,255,0.1)"
                    allowDecimals={false}
                  />
                  <Tooltip
                    cursor={{ fill: "rgba(255,255,255,0.04)" }}
                    contentStyle={{
                      background: "#12141c",
                      border: "1px solid rgba(255,255,255,0.1)",
                      borderRadius: 12,
                      fontSize: 12,
                    }}
                    formatter={(v: number) => [`${v} plays`]}
                  />
                  <Bar
                    dataKey="plays"
                    fill="rgb(var(--tint))"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
              <p className="mt-2 text-xs text-muted-foreground">
                Total listening logged: {formatTime(stats.totalSeconds)} across
                all songs
              </p>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
