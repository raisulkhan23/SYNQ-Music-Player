import { Link, useParams } from "react-router";
import { useAction } from "convex/react";
import { Disc3, Loader2, Play, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { RemoteTrackRow } from "@/components/tracks/RemoteTrackRow";
import { api } from "@/convex/_generated/api";
import {
  matchesAlbum,
  normaliseAlbumName,
  parseAlbumRoute,
  uniqueTracks,
} from "@/lib/artistLinks";
import { toPlayableYoutube } from "@/lib/playable";
import { type YtItem } from "@/lib/youtube";
import { readPlayHistory, usePlayerStore } from "@/store/player";

/**
 * An album page.
 *
 * The hard constraint here is honesty. SYNQ has no album table, no album id
 * and no album tracklist endpoint — so this page cannot "know" an album's
 * running order. What it CAN do is search for the album and keep only the
 * tracks the source itself reports as belonging to it.
 *
 * A result with no album name is therefore NOT counted. Showing one would be
 * inventing a tracklist, which is the exact failure the recommendation engine
 * is built to avoid.
 */
export default function Album() {
  const params = useParams();
  const route = useMemo(
    () => parseAlbumRoute(params.artist, params.album),
    [params.artist, params.album],
  );

  const searchYt = useAction(api.youtube.searchYoutube);
  const playTrack = usePlayerStore((s) => s.playTrack);

  // Tagged with the request it belongs to, so "loading" is derived from a
  // mismatch instead of being reset synchronously inside the effect — which
  // would cascade an extra render on every navigation between two albums.
  const [result, setResult] = useState<{ key: string; items: YtItem[] } | null>(
    null,
  );
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const requestKey = route
    ? `${route.artist}|normaliseAlbumName(route.album)`
    : "";

  // Tracks the listener already has, carrying this album, are real data too —
  // and they cost nothing to find.
  const knownTracks = useMemo(() => {
    if (!route) return [];
    return uniqueTracks(
      readPlayHistory()
        .map((entry) => ({
          id: entry.youtubeId ?? entry.id,
          title: entry.title,
          artist: entry.artistName ?? "",
          duration: entry.duration,
          thumbnail: entry.coverUrl,
          album: entry.albumName,
        }))
        .filter((item) => matchesAlbum(item, route.album)),
    );
  }, [route]);

  useEffect(() => {
    if (!route) return;
    let cancelled = false;
    const wanted = normaliseAlbumName(route.album);

    void (async () => {
      const found = await searchYt({
        query: `${route.artist} ${route.album}`,
      }).catch(() => ({ items: [] as YtItem[] }));
      if (cancelled) return;
      // Strictly the requested album: anything else in the search result is a
      // different record and is dropped rather than padded in.
      const matching = uniqueTracks(
        (found.items ?? []).filter(
          (item) => !!item && item.duration > 0 && matchesAlbum(item, wanted),
        ),
      );
      setResult({
        key: requestKey,
        items: uniqueTracks([...knownTracks, ...matching]),
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [route, requestKey, searchYt, knownTracks]);

  const resolved = !route
    ? null
    : result?.key === requestKey
      ? result.items
      : null;

  if (!route) {
    return (
      <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-8 text-center">
        <p className="font-display text-lg font-bold">Album not found</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
          That link didn&apos;t include an album name.
        </p>
      </div>
    );
  }

  const tracks = resolved ?? [];
  const artwork = tracks[0]?.thumbnail ?? knownTracks[0]?.thumbnail ?? "";

  const playAll = () => {
    const playable = tracks.map((item) =>
      toPlayableYoutube(item, `https://youtu.be/${item.id}`),
    );
    const first = playable[0];
    if (!first) return;
    playTrack(first, playable);
  };

  const playOne = (item: YtItem) => {
    setResolvingId(item.id);
    void searchYt({ query: `${item.title} ${item.artist}` })
      .then(({ items: found }) => {
        const match = found[0];
        if (!match) {
          toast.error(`Couldn't load "${item.title}"`);
          return;
        }
        const queue = [match, ...found.slice(1)].map((entry) =>
          toPlayableYoutube(entry, `https://youtu.be/${entry.id}`),
        );
        playTrack({ ...queue[0], id: item.id, title: item.title }, queue);
      })
      .catch(() => toast.error("Playback failed — try again in a moment"))
      .finally(() => setResolvingId(null));
  };

  return (
    <div className="flex flex-col gap-9 sm:gap-12">
      <header className="flex flex-col gap-5 sm:flex-row sm:items-end">
        {artwork ? (
          <img
            src={artwork}
            alt=""
            className="size-28 shrink-0 rounded-2xl object-cover ring-1 ring-white/10 sm:size-40"
          />
        ) : (
          <span className="flex size-28 shrink-0 items-center justify-center rounded-2xl bg-[rgb(var(--tint)_/_0.12)] text-[rgb(var(--tint))] sm:size-40">
            <Disc3 className="size-8" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold tracking-[0.2em] text-[rgb(var(--tint))] uppercase">
            Album
          </p>
          <h1 className="font-display mt-1 text-2xl font-bold tracking-tight sm:text-4xl">
            {route.album}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {resolved === null
              ? "Loading…"
              : `${tracks.length} ${tracks.length === 1 ? "track" : "tracks"} found`}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {tracks.length > 0 ? (
              <button
                type="button"
                onClick={playAll}
                className="inline-flex items-center gap-2 rounded-full bg-[rgb(var(--tint))] px-5 py-2.5 text-sm font-bold text-black transition-transform hover:scale-[1.02]"
              >
                <Play className="size-4 fill-current" />
                Play album
              </button>
            ) : null}
            <Link
              to={`/search?q=${encodeURIComponent(`${route.artist} ${route.album}`)}`}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 px-4 py-2.5 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground"
            >
              <Search className="size-4" />
              Search
            </Link>
          </div>
        </div>
      </header>

      {resolved === null ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading tracks…
        </div>
      ) : tracks.length > 0 ? (
        <section aria-labelledby="album-tracks">
          <h2
            id="album-tracks"
            className="font-display mb-3 text-lg font-bold tracking-tight sm:text-xl"
          >
            Tracks
          </h2>
          <div className="flex flex-col gap-0.5">
            {tracks.map((item, index) => (
              <RemoteTrackRow
                key={item.id}
                item={item}
                index={index + 1}
                onPlay={() => playOne(item)}
                resolving={resolvingId === item.id}
              />
            ))}
          </div>
        </section>
      ) : (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-8 text-center">
          <p className="font-display text-lg font-bold">
            Tracklist unavailable
          </p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Our sources didn&apos;t report any tracks for {route.album} by{" "}
            {route.artist}. We won&apos;t guess one — try the search instead.
          </p>
          <Link
            to={`/search?q=${encodeURIComponent(`${route.artist} ${route.album}`)}`}
            className="mt-4 inline-flex items-center gap-2 rounded-full bg-[rgb(var(--tint))] px-4 py-2 text-sm font-bold text-black"
          >
            <Search className="size-4" />
            Search instead
          </Link>
        </div>
      )}
    </div>
  );
}
