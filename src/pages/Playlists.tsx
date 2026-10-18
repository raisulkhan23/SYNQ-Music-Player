import { useState } from "react";
import { Link } from "react-router";
import { PlaylistCard } from "@/components/playlists/PlaylistCard";
import { PlaylistDialog } from "@/components/playlists/PlaylistDialog";
import { LikedSongsCard } from "@/components/playlists/LikedSongsCard";
import { SmartPlaylists } from "@/components/playlists/SmartPlaylists";
import { api } from "@/convex/_generated/api";
import { useQuery } from "convex/react";
import { useLocation } from "react-router";
import {
  BarChart3,
  ChevronRight,
  History,
  ListMusic,
  Plus,
  Radio,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Destinations that live in the `lg:`-only sidebar and have no place in the
 * 4-item phone bottom bar. Without them the Library tab was the one page a
 * mobile listener could land on and still find no way to reach their history,
 * rooms or stats. Liked Songs is deliberately absent — it already has its own
 * pinned card below.
 */
const LIBRARY_SHORTCUTS = [
  {
    to: "/recent",
    label: "Recently played",
    detail: "Your listening history, newest first",
    icon: History,
  },
  {
    to: "/social",
    label: "Listening rooms",
    detail: "Listen in sync with friends",
    icon: Radio,
  },
  {
    to: "/stats",
    label: "Listening stats",
    detail: "Top songs, artists and habits",
    icon: BarChart3,
  },
] as const;

export default function Playlists() {
  const playlists = useQuery(api.playlists.myPlaylists);
  const location = useLocation();
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
            Playlists
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your custom collections, built from the demo catalog.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="flex items-center gap-1.5 rounded-full bg-[rgb(var(--tint))] px-4 py-2.5 text-sm font-semibold text-black shadow-[0_8px_30px_rgb(var(--tint)/0.35)] transition-transform hover:scale-[1.03]"
        >
          <Plus className="size-4" />
          New playlist
        </button>
      </header>

      <nav className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {LIBRARY_SHORTCUTS.map(({ to, label, detail, icon: Icon }) => {
          const isActive = location.pathname === to;
          return (
            <Link
              key={to}
              to={to}
              className={cn(
                "flex items-center gap-3 rounded-2xl border px-4 py-3 transition-colors",
                isActive
                  ? "border-[rgb(var(--tint)_/_0.3)] bg-[rgb(var(--tint)_/_0.1)]"
                  : "border-white/[0.07] bg-white/[0.03] hover:border-[rgb(var(--tint)_/_0.35)] hover:bg-white/[0.05]",
              )}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[rgb(var(--tint)_/_0.14)]">
                <Icon className="size-4 text-[rgb(var(--tint))]" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">
                  {label}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {detail}
                </span>
              </span>
              <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground" />
            </Link>
          );
        })}
      </nav>

      <SmartPlaylists />

      {/* Liked Songs is pinned above the user's own playlists. */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        <LikedSongsCard />
        {playlists?.map((p) => (
          <PlaylistCard key={p._id} playlist={p} />
        ))}
        {playlists === undefined &&
          Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="w-full">
              <div className="aspect-square animate-pulse rounded-xl bg-white/[0.05]" />
              <div className="mt-2.5 h-4 w-2/3 animate-pulse rounded bg-white/[0.05]" />
              <div className="mt-1.5 h-3 w-1/2 animate-pulse rounded bg-white/[0.05]" />
            </div>
          ))}
      </div>

      {playlists !== undefined && playlists.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-white/10 py-20 text-center">
          <ListMusic className="size-10 text-muted-foreground/40" />
          <div>
            <p className="font-display text-lg font-semibold">
              No playlists yet
            </p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Create one and add songs from any search result or album.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="mt-2 rounded-full bg-[rgb(var(--tint))] px-5 py-2.5 text-sm font-semibold text-black shadow-[0_8px_30px_rgb(var(--tint)/0.35)] transition-transform hover:scale-[1.03]"
          >
            Create your first playlist
          </button>
        </div>
      ) : null}

      <PlaylistDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}
