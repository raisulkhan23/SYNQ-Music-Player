import { useNavigate, useParams, Link } from "react-router";
import { PlayHeaderButton } from "@/components/tracks/PlayHeaderButton";
import { TrackRow } from "@/components/tracks/TrackRow";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { albumById, trackById } from "@/lib/catalog";
import { coverArt } from "@/lib/covers";
import { formatTime } from "@/lib/format";
import { useMutation, useQuery } from "convex/react";
import { ListMusic, Trash2 } from "lucide-react";
import { toast } from "sonner";

export default function PlaylistDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const playlist = useQuery(api.playlists.get, {
    playlistId: id as Id<"playlists">,
  });
  const removeTrack = useMutation(api.playlists.removeTrack);
  const removePlaylist = useMutation(api.playlists.remove);

  if (playlist === undefined) {
    return (
      <div className="flex flex-col gap-3 py-10">
        <div className="h-40 w-40 animate-pulse rounded-2xl bg-white/[0.05]" />
        <div className="h-8 w-56 animate-pulse rounded bg-white/[0.05]" />
        <div className="h-4 w-40 animate-pulse rounded bg-white/[0.05]" />
      </div>
    );
  }

  if (playlist === null) {
    return (
      <div className="flex flex-col items-center gap-4 py-20 text-center">
        <ListMusic className="size-10 text-muted-foreground/40" />
        <div>
          <p className="font-display text-lg font-semibold">Playlist not found</p>
          <p className="mt-1 text-sm text-muted-foreground">
            It may have been deleted, or it belongs to another account.
          </p>
        </div>
        <Link
          to="/playlists"
          className="mt-1 rounded-full bg-[rgb(var(--tint))] px-5 py-2.5 text-sm font-semibold text-black"
        >
          Back to playlists
        </Link>
      </div>
    );
  }

  const tracks = playlist.trackIds
    .map((trackId) => trackById(trackId))
    .filter((t) => t !== undefined);
  const total = tracks.reduce((sum, t) => sum + t.duration, 0);
  const firstTrack = tracks[0];
  const cover = firstTrack ? coverArt(albumById(firstTrack.albumId)) : null;

  const handleDelete = async () => {
    try {
      await removePlaylist({ playlistId: playlist._id });
      toast.success(`Deleted "${playlist.name}"`);
      navigate("/playlists");
    } catch {
      toast.error("Could not delete the playlist");
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* header */}
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end">
        <div className="size-40 shrink-0 overflow-hidden rounded-2xl shadow-2xl ring-1 ring-white/10 sm:size-48">
          {cover ? (
            <img src={cover} alt="" className="size-full object-cover" />
          ) : (
            <div className="flex size-full items-center justify-center bg-gradient-to-br from-white/[0.09] to-white/[0.03]">
              <ListMusic className="size-10 text-muted-foreground/50" />
            </div>
          )}
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold tracking-[0.2em] text-muted-foreground uppercase">
            Playlist
          </p>
          <h1 className="mt-1 truncate font-display text-3xl font-bold tracking-tight sm:text-4xl">
            {playlist.name}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {playlist.trackIds.length}{" "}
            {playlist.trackIds.length === 1 ? "song" : "songs"}
            {tracks.length > 0 && ` · ${formatTime(total)}`}
          </p>
          <div className="mt-4 flex items-center gap-3">
            <PlayHeaderButton list={tracks} />
            {playlist.trackIds.length > 0 && (
              <button
                type="button"
                aria-label="Delete playlist"
                onClick={handleDelete}
                className="flex items-center gap-1.5 rounded-full border border-white/10 px-3.5 py-2 text-sm text-muted-foreground transition-colors hover:border-red-500/40 hover:text-red-400"
              >
                <Trash2 className="size-4" />
                Delete
              </button>
            )}
          </div>
        </div>
      </div>

      {/* tracks */}
      {tracks.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          {tracks.map((track, i) => (
            <TrackRow
              key={`${track.id}-${i}`}
              track={track}
              list={tracks}
              index={i + 1}
              onRemove={() => removeTrack({ playlistId: playlist._id, trackId: track.id })}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-white/10 py-16 text-center">
          <ListMusic className="size-10 text-muted-foreground/40" />
          <p className="max-w-sm text-sm text-muted-foreground">
            This playlist is empty. Add songs from search results or album pages.
          </p>
          <Link
            to="/search"
            className="mt-1 rounded-full bg-[rgb(var(--tint))] px-5 py-2.5 text-sm font-semibold text-black"
          >
            Find music
          </Link>
        </div>
      )}
    </div>
  );
}