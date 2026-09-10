import { useState } from "react";
import { useNavigate } from "react-router";
import { PlaylistCard } from "@/components/playlists/PlaylistCard";
import { PlaylistDialog } from "@/components/playlists/PlaylistDialog";
import { AlbumCard } from "@/components/tracks/AlbumCard";
import { api } from "@/convex/_generated/api";
import { ALBUMS, albumsByNewest } from "@/lib/catalog";
import { usePlayerStore } from "@/store/player";
import { useQuery } from "convex/react";
import { Heart, ListMusic, Plus } from "lucide-react";

export default function Library() {
  const navigate = useNavigate();
  const playlists = useQuery(api.playlists.myPlaylists);
  const likedLoaded = usePlayerStore((s) => s.likedLoaded);
  const likedCount = usePlayerStore((s) => Object.keys(s.liked).length);
  const [dialogOpen, setDialogOpen] = useState(false);
  const albums = albumsByNewest();

  return (
    <div className="flex flex-col gap-10">
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
          Your Library
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything you collect, in one place.
        </p>
      </header>

      {/* quick links */}
      <section className="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => navigate("/liked")}
          className="group flex h-28 items-center gap-4 rounded-2xl bg-gradient-to-br from-rose-500/25 via-fuchsia-500/15 to-transparent p-5 text-left ring-1 ring-white/10 transition-transform hover:scale-[1.015]"
        >
          <span className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-rose-500 to-fuchsia-600 text-white shadow-lg">
            <Heart className="size-6 fill-current" />
          </span>
          <span>
            <span className="block font-display text-lg font-bold">Liked Songs</span>
            <span className="mt-0.5 block text-sm text-muted-foreground">
              {likedLoaded ? `${likedCount} ${likedCount === 1 ? "song" : "songs"}` : "Loading…"}
            </span>
          </span>
        </button>

        <button
          type="button"
          onClick={() => navigate("/playlists")}
          className="group flex h-28 items-center gap-4 rounded-2xl bg-gradient-to-br from-emerald-500/25 via-teal-500/15 to-transparent p-5 text-left ring-1 ring-white/10 transition-transform hover:scale-[1.015]"
        >
          <span className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-lg">
            <ListMusic className="size-6" />
          </span>
          <span>
            <span className="block font-display text-lg font-bold">Playlists</span>
            <span className="mt-0.5 block text-sm text-muted-foreground">
              {playlists === undefined
                ? "Loading…"
                : `${playlists.length} ${playlists.length === 1 ? "playlist" : "playlists"}`}
            </span>
          </span>
        </button>
      </section>

      {/* playlists */}
      <section>
        <div className="mb-3 flex items-center justify-between gap-4">
          <div>
            <h2 className="font-display text-lg font-bold tracking-tight sm:text-xl">
              Playlists
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Collections you build from the catalog.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-2 text-sm font-medium transition-colors hover:bg-white/[0.08]"
          >
            <Plus className="size-4" />
            New playlist
          </button>
        </div>
        {playlists !== undefined && playlists.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-white/10 py-10 text-center">
            <ListMusic className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              No playlists yet. Create one and start adding songs.
            </p>
            <button
              type="button"
              onClick={() => setDialogOpen(true)}
              className="mt-1 text-sm font-semibold text-[rgb(var(--tint))] hover:underline"
            >
              Create your first playlist
            </button>
          </div>
        ) : (
          <div className="hide-scrollbar -mx-4 flex gap-4 overflow-x-auto px-4 pb-2">
            {playlists?.map((p) => (
              <PlaylistCard key={p._id} playlist={p} />
            ))}
            {playlists === undefined &&
              [0, 1, 2].map((i) => (
                <div key={i} className="w-36 shrink-0 sm:w-44">
                  <div className="aspect-square animate-pulse rounded-xl bg-white/[0.05]" />
                  <div className="mt-2.5 h-4 w-2/3 animate-pulse rounded bg-white/[0.05]" />
                </div>
              ))}
          </div>
        )}
      </section>

      {/* albums */}
      <section>
        <h2 className="mb-3 font-display text-lg font-bold tracking-tight sm:text-xl">
          Albums
        </h2>
        <p className="-mt-2 mb-3 text-sm text-muted-foreground">
          The complete SoundScape demo catalog · {ALBUMS.length} albums
        </p>
        <div className="hide-scrollbar -mx-4 flex gap-4 overflow-x-auto px-4 pb-2">
          {albums.map((album) => (
            <AlbumCard key={album.id} album={album} />
          ))}
        </div>
      </section>

      <PlaylistDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </div>
  );
}