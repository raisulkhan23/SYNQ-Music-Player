import { useState } from "react";
import { PlaylistCard } from "@/components/playlists/PlaylistCard";
import { PlaylistDialog } from "@/components/playlists/PlaylistDialog";
import { api } from "@/convex/_generated/api";
import { useQuery } from "convex/react";
import { ListMusic, Plus } from "lucide-react";

export default function Playlists() {
  const playlists = useQuery(api.playlists.myPlaylists);
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

      {playlists !== undefined && playlists.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-white/10 py-20 text-center">
          <ListMusic className="size-10 text-muted-foreground/40" />
          <div>
            <p className="font-display text-lg font-semibold">No playlists yet</p>
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
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
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
      )}

      <PlaylistDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}