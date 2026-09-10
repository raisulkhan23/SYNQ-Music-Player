import { useNavigate } from "react-router";
import { PlayCircle } from "@/components/player/PlayCircle";
import { albumTracks, artistById, type Album } from "@/lib/catalog";
import { coverArt } from "@/lib/covers";
import { usePlayerStore } from "@/store/player";

export function AlbumCard({ album }: { album: Album }) {
  const navigate = useNavigate();
  const playTrack = usePlayerStore((s) => s.playTrack);
  const tracks = albumTracks(album.id);
  const artist = artistById(album.artistId);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => navigate(`/album/${album.id}`)}
      onKeyDown={(e) => {
        if (e.key === "Enter") navigate(`/album/${album.id}`);
      }}
      className="group w-36 shrink-0 cursor-pointer sm:w-44"
    >
      <div className="relative aspect-square overflow-hidden rounded-xl ring-1 ring-white/10">
        <img
          src={coverArt(album)}
          alt={`${album.title} cover art`}
          className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.06]"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
        <PlayCircle
          size="sm"
          className="absolute right-2 bottom-2 translate-y-2 opacity-0 transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            if (tracks.length > 0) playTrack(tracks[0], tracks);
          }}
        />
      </div>
      <div className="mt-2.5 px-0.5">
        <p className="truncate text-sm font-semibold">{album.title}</p>
        <p className="truncate text-xs text-muted-foreground">
          {artist.name} · {album.year}
        </p>
      </div>
    </div>
  );
}