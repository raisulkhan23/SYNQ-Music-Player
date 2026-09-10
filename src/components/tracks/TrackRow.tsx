import { Link } from "react-router";
import { AddToPlaylistMenu } from "@/components/playlists/AddToPlaylistMenu";
import { Equalizer } from "@/components/player/Equalizer";
import { albumById, artistById, type Track } from "@/lib/catalog";
import { coverArt } from "@/lib/covers";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { usePlayerStore } from "@/store/player";
import { Heart, Pause, Play, X } from "lucide-react";

interface TrackRowProps {
  track: Track;
  list: Track[];
  index: number;
  showAlbum?: boolean;
  onRemove?: () => void;
}

export function TrackRow({ track, list, index, showAlbum = true, onRemove }: TrackRowProps) {
  const currentId = usePlayerStore((s) => s.current?.id);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const liked = usePlayerStore((s) => s.liked);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const toggleLike = usePlayerStore((s) => s.toggleLike);

  const album = albumById(track.albumId);
  const artist = artistById(track.artistId);
  const isCurrent = currentId === track.id;
  const isLiked = liked[track.id] !== undefined;

  const handleRowClick = () => {
    if (isCurrent) togglePlay();
    else playTrack(track, list);
  };

  const handleCellClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isCurrent) togglePlay();
    else playTrack(track, list);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleRowClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleRowClick();
        }
      }}
      className={cn(
        "group grid cursor-pointer grid-cols-[28px_minmax(0,1fr)_56px_76px] items-center gap-2 rounded-xl px-3 py-1.5 transition-colors hover:bg-white/[0.05] sm:grid-cols-[28px_minmax(0,1fr)_minmax(0,1fr)_56px_76px]",
        isCurrent && "bg-white/[0.04]",
      )}
    >
      {/* index / now-playing indicator */}
      <div className="relative flex items-center justify-center">
        {isCurrent && isPlaying ? (
          <Equalizer className="scale-90" />
        ) : isCurrent ? (
          <Pause className="size-3.5 text-[rgb(var(--tint))]" />
        ) : (
          <span className="text-sm tabular-nums text-muted-foreground/60">
            {index}
          </span>
        )}
        <button
          type="button"
          aria-label={isCurrent && isPlaying ? "Pause" : "Play"}
          onClick={handleCellClick}
          className={cn(
            "absolute inset-0 hidden items-center justify-center group-hover:flex",
            isCurrent && "flex md:hidden md:group-hover:flex",
          )}
        >
          {isCurrent && isPlaying ? (
            <Pause className="size-4 fill-current text-foreground" />
          ) : (
            <Play className="ml-0.5 size-4 fill-current text-foreground" />
          )}
        </button>
      </div>

      {/* title */}
      <div className="flex min-w-0 items-center gap-3">
        <img
          src={coverArt(album)}
          alt=""
          className="size-10 shrink-0 rounded-md object-cover ring-1 ring-white/10"
        />
        <div className="min-w-0">
          <p
            className={cn(
              "truncate text-sm font-medium",
              isCurrent && "text-[rgb(var(--tint))]",
            )}
          >
            {track.title}
          </p>
          <Link
            to={`/album/${album.id}`}
            onClick={(e) => e.stopPropagation()}
            className="block truncate text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline"
          >
            {artist.name}
          </Link>
        </div>
      </div>

      {/* album */}
      <div className={cn("hidden min-w-0 sm:block", !showAlbum && "hidden")}>
        <Link
          to={`/album/${album.id}`}
          onClick={(e) => e.stopPropagation()}
          className="block truncate text-sm text-muted-foreground transition-colors hover:text-foreground hover:underline"
        >
          {album.title}
        </Link>
      </div>

      {/* duration */}
      <span className="text-right text-sm tabular-nums text-muted-foreground/70">
        {formatTime(track.duration)}
      </span>

      {/* actions */}
      <div className="flex items-center justify-end gap-0.5">
        <button
          type="button"
          aria-label={isLiked ? "Remove from liked songs" : "Add to liked songs"}
          onClick={(e) => {
            e.stopPropagation();
            toggleLike(track.id);
          }}
          className={cn(
            "rounded-full p-1.5 transition-all hover:scale-110 md:opacity-0 md:group-hover:opacity-100",
            isLiked
              ? "text-[rgb(var(--tint))] md:opacity-100"
              : "text-muted-foreground/70 hover:text-foreground",
          )}
        >
          <Heart className={cn("size-4", isLiked && "fill-current")} />
        </button>
        <AddToPlaylistMenu
          track={track}
          className="hidden md:inline-flex md:opacity-0 md:group-hover:opacity-100"
        />
        {onRemove && (
          <button
            type="button"
            aria-label={`Remove ${track.title}`}
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            className="rounded-full p-1.5 text-muted-foreground/70 transition-colors hover:bg-white/10 hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}