import { useNavigate } from "react-router";
import type { Doc } from "@/convex/_generated/dataModel";
import { albumById, trackById } from "@/lib/catalog";
import { coverArt } from "@/lib/covers";
import { formatTime } from "@/lib/format";
import { ListMusic } from "lucide-react";

export function PlaylistCard({ playlist }: { playlist: Doc<"playlists"> }) {
  const navigate = useNavigate();
  const firstTrack = playlist.trackIds.length > 0 ? trackById(playlist.trackIds[0]) : undefined;
  const tracks = playlist.trackIds
    .map((id) => trackById(id))
    .filter((t) => t !== undefined);
  const total = tracks.reduce((sum, t) => sum + t.duration, 0);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => navigate(`/playlist/${playlist._id}`)}
      onKeyDown={(e) => {
        if (e.key === "Enter") navigate(`/playlist/${playlist._id}`);
      }}
      className="group w-36 shrink-0 cursor-pointer sm:w-44"
    >
      <div className="relative aspect-square overflow-hidden rounded-xl ring-1 ring-white/10">
        {firstTrack ? (
          <img
            src={coverArt(albumById(firstTrack.albumId))}
            alt=""
            className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.06]"
          />
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-white/[0.09] to-white/[0.03]">
            <ListMusic className="size-8 text-muted-foreground/50" />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
      </div>
      <div className="mt-2.5 px-0.5">
        <p className="truncate text-sm font-semibold">{playlist.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {playlist.trackIds.length} {playlist.trackIds.length === 1 ? "song" : "songs"}
          {tracks.length > 0 && ` · ${formatTime(total)}`}
        </p>
      </div>
    </div>
  );
}