import { useNavigate } from "react-router";
import { PlayHeaderButton } from "@/components/tracks/PlayHeaderButton";
import { TrackRow } from "@/components/tracks/TrackRow";
import { trackById } from "@/lib/catalog";
import { formatTime } from "@/lib/format";
import { usePlayerStore } from "@/store/player";
import { Heart } from "lucide-react";

export default function Liked() {
  const navigate = useNavigate();
  const liked = usePlayerStore((s) => s.liked);
  const likedLoaded = usePlayerStore((s) => s.likedLoaded);
  const toggleLike = usePlayerStore((s) => s.toggleLike);

  const likedTracks = Object.entries(liked)
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => trackById(id))
    .filter((t): t is NonNullable<typeof t> => t !== undefined);

  const total = likedTracks.reduce((sum, t) => sum + t.duration, 0);

  return (
    <div className="flex flex-col gap-6">
      {/* header */}
      <div className="relative overflow-hidden rounded-3xl p-6 sm:p-8">
        <div className="absolute inset-0 bg-gradient-to-br from-rose-500/25 via-fuchsia-500/10 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-transparent opacity-70" />
        <div className="relative flex items-end gap-5">
          <div className="flex size-24 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-rose-500 to-fuchsia-600 shadow-2xl sm:size-32">
            <Heart className="size-12 fill-white text-white sm:size-16" />
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold tracking-[0.2em] text-white/60 uppercase">
              Playlist
            </p>
            <h1 className="mt-1 truncate font-display text-3xl font-bold tracking-tight sm:text-4xl">
              Liked Songs
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {likedLoaded
                ? likedTracks.length > 0
                  ? `${likedTracks.length} ${likedTracks.length === 1 ? "song" : "songs"} · ${formatTime(total)}`
                  : "Nothing here yet"
                : "Loading…"}
            </p>
          </div>
        </div>
      </div>

      {likedTracks.length > 0 ? (
        <>
          <div className="flex items-center gap-3 px-2">
            <PlayHeaderButton list={likedTracks} />
          </div>
          <div className="flex flex-col gap-0.5">
            {likedTracks.map((track, i) => (
              <TrackRow
                key={track.id}
                track={track}
                list={likedTracks}
                index={i + 1}
                onRemove={() => toggleLike(track.id)}
              />
            ))}
          </div>
        </>
      ) : likedLoaded ? (
        <div className="flex flex-col items-center gap-4 py-16 text-center">
          <Heart className="size-10 text-muted-foreground/30" />
          <div>
            <p className="font-display text-lg font-semibold">No liked songs yet</p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Tap the heart on any track to save it here for quick playback.
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate("/search")}
            className="mt-1 rounded-full bg-[rgb(var(--tint))] px-5 py-2.5 text-sm font-semibold text-black shadow-[0_8px_30px_rgb(var(--tint)/0.35)] transition-transform hover:scale-[1.03]"
          >
            Find music
          </button>
        </div>
      ) : null}
    </div>
  );
}