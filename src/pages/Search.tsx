import { useState } from "react";
import { useNavigate } from "react-router";
import { AlbumCard } from "@/components/tracks/AlbumCard";
import { PlayCircle } from "@/components/player/PlayCircle";
import { TrackRow } from "@/components/tracks/TrackRow";
import {
  albumById,
  ALBUMS,
  ARTISTS,
  artistById,
  artistTracks,
  searchCatalog,
} from "@/lib/catalog";
import { coverArt } from "@/lib/covers";
import { usePlayerStore } from "@/store/player";
import { Search as SearchIcon, SearchX } from "lucide-react";

const MOOD_CHIPS = ["night", "chill", "dance", "synth", "ambient", "lo-fi", "dream", "golden", "indie"];

export default function Search() {
  const [query, setQuery] = useState("");
  const navigate = useNavigate();
  const playTrack = usePlayerStore((s) => s.playTrack);

  const results = searchCatalog(query);
  const hasQuery = query.trim().length > 0;
  const topTrack = results.tracks[0];
  const topAlbum = !topTrack ? results.albums[0] : undefined;

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">Search</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Find tracks, albums and artists across the demo catalog.
        </p>
      </header>

      {/* search input */}
      <div className="relative max-w-xl">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-muted-foreground" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="What do you want to listen to?"
          className="h-12 w-full rounded-full border border-white/10 bg-white/[0.05] pr-4 pl-12 text-[15px] text-foreground placeholder:text-muted-foreground/70 focus:border-[rgb(var(--tint)_/_0.6)] focus:ring-2 focus:ring-[rgb(var(--tint)_/_0.25)] focus:outline-none"
        />
      </div>

      {!hasQuery ? (
        <BrowseView onPick={(q) => setQuery(q)} onAlbum={(id) => navigate(`/album/${id}`)} />
      ) : results.tracks.length === 0 &&
        results.albums.length === 0 &&
        results.artists.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <SearchX className="size-10 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            No results for “{query}”. Try a mood like “chill” or an artist name.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-10">
          {/* top result + songs */}
          <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-8">
            <section>
              <h2 className="mb-3 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
                Top result
              </h2>
              {topTrack ? (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => playTrack(topTrack, results.tracks)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") playTrack(topTrack, results.tracks);
                  }}
                  className="group relative flex h-full min-h-40 cursor-pointer flex-col justify-between overflow-hidden rounded-2xl bg-white/[0.04] p-5 transition-colors hover:bg-white/[0.07]"
                >
                  <div className="flex items-center gap-4">
                    <img
                      src={coverArt(albumById(topTrack.albumId))}
                      alt=""
                      className="size-20 rounded-xl object-cover shadow-xl ring-1 ring-white/10 sm:size-24"
                    />
                    <div className="min-w-0">
                      <p className="mb-2 inline-flex rounded-full bg-white/[0.08] px-2.5 py-0.5 text-[11px] font-semibold tracking-wide uppercase">
                        Song
                      </p>
                      <h3 className="truncate font-display text-xl font-bold tracking-tight sm:text-2xl">
                        {topTrack.title}
                      </h3>
                      <p className="truncate text-sm text-muted-foreground">
                        {artistById(topTrack.artistId).name} ·{" "}
                        {albumById(topTrack.albumId).title}
                      </p>
                    </div>
                  </div>
                  <PlayCircle
                    size="md"
                    className="absolute right-5 bottom-5 translate-y-2 opacity-0 transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100"
                  />
                </div>
              ) : topAlbum ? (
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate(`/album/${topAlbum.id}`)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") navigate(`/album/${topAlbum.id}`);
                  }}
                  className="group flex h-full min-h-40 cursor-pointer items-center gap-4 rounded-2xl bg-white/[0.04] p-5 transition-colors hover:bg-white/[0.07]"
                >
                  <img
                    src={coverArt(topAlbum)}
                    alt=""
                    className="size-24 rounded-xl object-cover shadow-xl ring-1 ring-white/10"
                  />
                  <div className="min-w-0">
                    <p className="mb-2 inline-flex rounded-full bg-white/[0.08] px-2.5 py-0.5 text-[11px] font-semibold tracking-wide uppercase">
                      Album
                    </p>
                    <h3 className="truncate font-display text-xl font-bold tracking-tight sm:text-2xl">
                      {topAlbum.title}
                    </h3>
                    <p className="truncate text-sm text-muted-foreground">
                      {artistById(topAlbum.artistId).name} · {topAlbum.year}
                    </p>
                  </div>
                </div>
              ) : null}
            </section>

            <section>
              <h2 className="mb-2 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
                Songs
              </h2>
              <div className="flex flex-col gap-0.5">
                {results.tracks.slice(0, 10).map((track, i) => (
                  <TrackRow
                    key={track.id}
                    track={track}
                    list={results.tracks}
                    index={i + 1}
                  />
                ))}
                {results.tracks.length === 0 && (
                  <p className="px-3 py-6 text-sm text-muted-foreground">
                    No songs matched — check the albums below.
                  </p>
                )}
              </div>
            </section>
          </div>

          {/* albums */}
          {results.albums.length > 0 && (
            <section>
              <h2 className="mb-3 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
                Albums
              </h2>
              <div className="hide-scrollbar -mx-4 flex gap-4 overflow-x-auto px-4 pb-2">
                {results.albums.map((album) => (
                  <AlbumCard key={album.id} album={album} />
                ))}
              </div>
            </section>
          )}

          {/* artists */}
          {results.artists.length > 0 && (
            <section>
              <h2 className="mb-3 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
                Artists
              </h2>
              <div className="hide-scrollbar -mx-4 flex gap-4 overflow-x-auto px-4 pb-2">
                {results.artists.map((artist) => {
                  const album = ALBUMS.find((a) => a.artistId === artist.id);
                  return (
                    <button
                      key={artist.id}
                      type="button"
                      onClick={() => album && navigate(`/album/${album.id}`)}
                      className="group w-32 shrink-0 text-center"
                    >
                      <div className="mx-auto size-28 overflow-hidden rounded-full ring-1 ring-white/10 transition-transform duration-300 group-hover:scale-105">
                        {album && (
                          <img
                            src={coverArt(album)}
                            alt=""
                            className="size-full object-cover"
                          />
                        )}
                      </div>
                      <p className="mt-2 truncate text-sm font-semibold">{artist.name}</p>
                      <p className="truncate text-xs text-muted-foreground">Artist</p>
                    </button>
                  );
                })}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function BrowseView({
  onPick,
  onAlbum,
}: {
  onPick: (q: string) => void;
  onAlbum: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-10">
      <section>
        <h2 className="mb-3 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
          Browse by mood
        </h2>
        <div className="flex flex-wrap gap-2">
          {MOOD_CHIPS.map((mood) => (
            <button
              key={mood}
              type="button"
              onClick={() => onPick(mood)}
              className="rounded-full border border-white/10 bg-white/[0.04] px-4 py-1.5 text-sm font-medium text-foreground/90 transition-all hover:border-[rgb(var(--tint)_/_0.5)] hover:bg-[rgb(var(--tint)_/_0.1)]"
            >
              {mood}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
          All albums
        </h2>
        <div className="hide-scrollbar -mx-4 flex gap-4 overflow-x-auto px-4 pb-2">
          {ALBUMS.map((album) => (
            <AlbumCard key={album.id} album={album} />
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
          All artists
        </h2>
        <div className="hide-scrollbar -mx-4 flex gap-4 overflow-x-auto px-4 pb-2">
          {ARTISTS.map((artist) => {
            const album = ALBUMS.find((a) => a.artistId === artist.id);
            const tracks = artistTracks(artist.id);
            return (
              <button
                key={artist.id}
                type="button"
                onClick={() => album && onAlbum(album.id)}
                className="group w-32 shrink-0 text-center"
              >
                <div className="mx-auto size-28 overflow-hidden rounded-full ring-1 ring-white/10 transition-transform duration-300 group-hover:scale-105">
                  {album && (
                    <img src={coverArt(album)} alt="" className="size-full object-cover" />
                  )}
                </div>
                <p className="mt-2 truncate text-sm font-semibold">{artist.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {tracks.length} songs
                </p>
              </button>
            );
          })}
        </div>
      </section>

    </div>
  );
}