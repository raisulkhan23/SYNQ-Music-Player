import { Link, useParams } from "react-router";
import { useAction } from "convex/react";
import { Disc3, Loader2, Play, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { RemoteTrackRow } from "@/components/tracks/RemoteTrackRow";
import { api } from "@/convex/_generated/api";
import {
  artistPath,
  matchesAlbum,
  normaliseAlbumName,
  parseAlbumRoute,
  uniqueTracks,
} from "@/lib/artistLinks";
import { matchesRelease } from "@/lib/artistCatalog";
import type { BrowseTrack } from "@/lib/musicBrowse";
import { toPlayableYoutube } from "@/lib/playable";
import { cleanTrackTitle, type YtItem } from "@/lib/youtube";
import { readPlayHistory, usePlayerStore } from "@/store/player";
import { readTracklist, useArtistCatalog } from "@/hooks/useArtistCatalog";

/**
 * An album page.
 *
 * It used to be a search page in disguise: SYNQ had no album id, so the page
 * searched "<artist> <album>" and kept whatever rows claimed that album name.
 * That produced partial tracklists (a search shelf holds ~20 rows) and mixed
 * editions, because the only signal was a string.
 *
 * The catalogue now gives every release a stable `MPREb_…` id, so this page
 * finds the release in the artist's real release list and asks the source for
 * THAT release's tracklist, page by page. The search path stays as a fallback
 * for anything the release list does not contain, and says so when it is used.
 */
export default function Album() {
  const params = useParams();
  const route = useMemo(
    () => parseAlbumRoute(params.artist, params.album),
    [params.artist, params.album],
  );

  const searchYt = useAction(api.youtube.searchYoutube);
  const fetchTracks = useAction(api.artistCatalog.releaseTracks);
  const playTrack = usePlayerStore((s) => s.playTrack);

  const catalog = useArtistCatalog(route?.artist ?? "");

  const [result, setResult] = useState<{
    key: string;
    tracks: BrowseTrack[];
    year?: string;
    kind?: string;
  } | null>(null);
  const [fallback, setFallback] = useState<{
    key: string;
    items: YtItem[];
    mixedEditions: boolean;
  } | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const requestKey = route ? `${route.artist}|${route.album}` : "";

  /**
   * The release this route points at.
   *
   * Exact edition first: "Thriller (Deluxe)" and "Thriller" are different
   * releases with different tracklists, so a loose match is only used when no
   * release carries the exact title.
   */
  const release = useMemo(() => {
    if (!route) return null;
    const wanted = normaliseAlbumName(route.album);
    const exact = catalog.releases.find(
      (entry) =>
        entry.title.trim().toLowerCase() === route.album.trim().toLowerCase(),
    );
    if (exact) return exact;
    return (
      catalog.releases.find(
        (entry) => normaliseAlbumName(entry.title) === wanted,
      ) ??
      catalog.releases.find((entry) => matchesRelease({ album: entry.title } as never, route.album)) ??
      null
    );
  }, [catalog.releases, route]);

  // Read the release's OWN tracklist once the release is known. This is a
  // single, cached request (plus continuation pages for long albums), so it is
  // faster than waiting for the artist page's batch hydrator.
  useEffect(() => {
    if (!release || !route) return;
    let cancelled = false;
    void (async () => {
      try {
        const tracks = await readTracklist(
          fetchTracks as unknown as (args: {
            releaseId: string;
            cursor?: string;
          }) => Promise<{ tracks: BrowseTrack[]; nextCursor: string | null }>,
          release.id,
          () => cancelled,
        );
        if (cancelled) return;
        setResult({
          key: requestKey,
          tracks,
          year: release.year,
          kind: release.kind,
        });
      } catch {
        if (cancelled) return;
        setResult({ key: requestKey, tracks: [], year: release.year });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchTracks, release, requestKey, route]);

  // ── Fallback: the release list did not contain this title. ────────────────
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
    // Only when the catalogue has settled WITHOUT this release.
    if (!route || release || catalog.loadingReleases || catalog.identity === undefined)
      return;
    let cancelled = false;
    const wanted = normaliseAlbumName(route.album);

    void (async () => {
      const found = await searchYt({
        query: `${route.artist} ${route.album}`,
      }).catch(() => ({ items: [] as YtItem[] }));
      if (cancelled) return;
      const usable = (found.items ?? []).filter(
        (item) => !!item && item.duration > 0,
      );
      const exact = uniqueTracks(
        usable.filter((item) => matchesRelease(item, route.album)),
      );
      const matching = uniqueTracks(
        exact.length > 0
          ? exact
          : usable.filter(
              (item) => matchesRelease(item, route.album) || matchesAlbum(item, wanted),
            ),
      );
      setFallback({
        key: requestKey,
        items: uniqueTracks([...knownTracks, ...matching]),
        mixedEditions: exact.length === 0 && matching.length > 0,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [
    catalog.identity,
    catalog.loadingReleases,
    knownTracks,
    release,
    requestKey,
    route,
    searchYt,
  ]);

  // Derived BEFORE the early return below: `useMemo` is a hook, and a hook
  // placed after a conditional return is called in a different order on every
  // render — which React forbids and eslint caught here.
  const catalogueTracks = result?.key === requestKey ? result.tracks : null;
  // Kept as a plain conjunction (not wrapped in `Boolean(...)`) so TypeScript's
  // aliased narrowing still proves `fallback` is non-null wherever
  // `usingFallback` is checked.
  const usingFallback = !release && fallback?.key === requestKey;
  const loading = !route
    ? false
    : release !== null
      ? catalogueTracks === null
      : catalog.loadingReleases || (fallback?.key !== requestKey && !release);

  // One row shape for the renderer, whichever source answered.
  const items: YtItem[] = useMemo(() => {
    if (!route) return [];
    if (catalogueTracks) {
      return catalogueTracks.map((track) => ({
        id: track.videoId,
        title: cleanTrackTitle(track.title),
        artist: track.artists.join(", ") || catalog.identity?.name || route.artist,
        duration: track.duration,
        thumbnail: release?.thumbnail ?? "",
        album: track.album ?? release?.title ?? route.album,
      }));
    }
    return usingFallback && fallback ? fallback.items : [];
  }, [
    catalogueTracks,
    catalog.identity?.name,
    fallback,
    release?.thumbnail,
    release?.title,
    route,
    usingFallback,
  ]);

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

  const artistHref = artistPath(route.artist);

  const artwork = release?.thumbnail ?? items[0]?.thumbnail ?? knownTracks[0]?.thumbnail ?? "";

  const playAll = () => {
    const playable = items.map((item) =>
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
            {release?.kind === "single"
              ? "Single"
              : release?.kind === "ep"
                ? "EP"
                : release?.kind === "live"
                  ? "Live release"
                  : "Album"}
          </p>
          {artistHref ? (
            <Link
              to={artistHref}
              className="mt-1 inline-block text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground"
            >
              {route.artist}
            </Link>
          ) : null}
          <h1 className="font-display mt-1 text-2xl font-bold tracking-tight sm:text-4xl">
            {route.album}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {loading
              ? "Loading tracklist…"
              : `${items.length} ${items.length === 1 ? "track" : "tracks"}${
                  release?.year ? ` · ${release.year}` : ""
                }`}
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {items.length > 0 ? (
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

      {usingFallback && fallback.mixedEditions ? (
        <p
          role="status"
          className="rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-xs text-amber-200/90"
        >
          This release isn&apos;t in the artist&apos;s catalogue listing, so these
          tracks were matched by album name and may come from another edition.
        </p>
      ) : null}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading the tracklist…
        </div>
      ) : items.length > 0 ? (
        <section aria-labelledby="album-tracks">
          <h2
            id="album-tracks"
            className="font-display mb-3 text-lg font-bold tracking-tight sm:text-xl"
          >
            Tracks
          </h2>
          <div className="flex flex-col gap-0.5">
            {items.map((item, index) => (
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
