import { Link, useParams } from "react-router";
import { PlayHeaderButton } from "@/components/tracks/PlayHeaderButton";
import { TrackRow } from "@/components/tracks/TrackRow";
import { albumById, albumTracks, artistById } from "@/lib/catalog";
import { coverArt } from "@/lib/covers";
import { formatTime } from "@/lib/format";
import { Disc3 } from "lucide-react";

export default function Album() {
  const { id } = useParams<{ id: string }>();
  const album = albumById(id ?? "");
  const artist = artistById(album.artistId);
  const tracks = albumTracks(album.id);
  const total = tracks.reduce((sum, t) => sum + t.duration, 0);

  return (
    <div className="flex flex-col gap-6">
      {/* header */}
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end">
        <img
          src={coverArt(album)}
          alt={`${album.title} cover art`}
          className="size-40 shrink-0 rounded-2xl object-cover shadow-2xl ring-1 ring-white/10 sm:size-48"
        />
        <div className="min-w-0">
          <p className="text-[11px] font-semibold tracking-[0.2em] text-muted-foreground uppercase">
            Album
          </p>
          <h1 className="mt-1 truncate font-display text-3xl font-bold tracking-tight sm:text-4xl">
            {album.title}
          </h1>
          <Link
            to={`/album/${album.id}`}
            className="mt-2 block w-fit text-sm font-semibold text-foreground/90 transition-colors hover:underline"
          >
            {artist.name}
          </Link>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {album.year} · {tracks.length} {tracks.length === 1 ? "song" : "songs"} ·{" "}
            {formatTime(total)}
          </p>
          <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground/90">
            {album.description}
          </p>
          <div className="mt-4">
            <PlayHeaderButton list={tracks} />
          </div>
        </div>
      </div>

      {/* track list */}
      <div className="flex flex-col gap-0.5">
        {tracks.map((track, i) => (
          <TrackRow key={track.id} track={track} list={tracks} index={i + 1} />
        ))}
      </div>

      <p className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground/60">
        <Disc3 className="size-3.5" />
        Demo catalog · audio streamed from the fixed SoundScape library
      </p>
    </div>
  );
}