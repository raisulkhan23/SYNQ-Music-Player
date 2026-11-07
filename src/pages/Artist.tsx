import { Link, useNavigate, useParams } from "react-router";
import type React from "react";
import {
  REPAIR_SEARCH_ATTEMPTS,
  REPAIR_SEARCH_GAP_MS,
} from "@/lib/importRepair";
import { useAction } from "convex/react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Disc3,
  Loader2,
  Play,
  Radio,
  Search,
  Share2,
  Shuffle,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Shelf } from "@/components/core/shelf";
import { MediaCard } from "@/components/tracks/MediaCard";
import { RemoteTrackRow } from "@/components/tracks/RemoteTrackRow";
import { api } from "@/convex/_generated/api";
import { buildCatalog } from "@/lib/artistCatalog";
import { albumPath, routeParam, uniqueTracks } from "@/lib/artistLinks";
import { copyText } from "@/lib/clipboard";
import type { BrowseTrack, ReleaseType } from "@/lib/musicBrowse";
import { toPlayableYoutube } from "@/lib/playable";
import {
  artistSearchQuery,
  cleanArtistName,
  cleanTrackTitle,
  type YtItem,
} from "@/lib/youtube";
import { usePlayerStore } from "@/store/player";
import { useArtistCatalog, type CatalogRelease } from "@/hooks/useArtistCatalog";

/**
 * An artist page built on the artist's actual discography.
 *
 * WHAT WAS WRONG BEFORE
 * ---------------------
 * The page was assembled from `searchYoutube`. A search shelf is a ranked
 * SAMPLE of an artist — about twenty rows, no albums, no release types, no
 * tracklists — so dropping the limit or slicing more rows could never show a
 * discography. For an artist with dozens of releases the page showed the same
 * ten hits under a "Popular" heading and called it the artist.
 *
 * It now resolves a stable artist id and reads that artist's release list from
 * the source's own catalogue endpoint, then hydrates each release's tracklist.
 * Three genuinely different things sit on the page:
 *
 *   Popular     — the source's ranking, a shortcut, explicitly not the catalog
 *   Discography — every release the provider lists, grouped by its own type
 *   All songs   — tracks from those releases, growing as tracklists arrive
 *
 * Nothing is invented: a release with no tracklist yet says so, the count is
 * "read so far", and the catalog is described as what SYNQ's source exposes
 * rather than as the artist's complete real-world output.
 */
export default function Artist() {
  const params = useParams();
  const navigate = useNavigate();
  // react-router has already decoded this. Decoding again threw a URIError on
  // any artist with a "%" in the name ("50% Hits"), which crashed the page into
  // the root error boundary instead of showing a track list.
  const artistName = routeParam(params.artist);
  const query = artistSearchQuery(artistName);

  const searchYt = useAction(api.youtube.searchYoutube);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const playListOrdered = usePlayerStore((s) => s.playListOrdered);
  const startRadio = usePlayerStore((s) => s.startRadio);

  const catalog = useArtistCatalog(artistName);

  // Results are tagged with the request they belong to, so "still
  // loading" is DERIVED from a mismatch rather than reset inside the effect.
  const [result, setResult] = useState<{
    key: string;
    tracks: YtItem[];
    related: YtItem[];
  } | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [sort, setSort] = useState<"default" | "title" | "album" | "duration">(
    "default",
  );
  const [filter, setFilter] = useState("");
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<ReleaseType | "all">("all");
  const [songLimit, setSongLimit] = useState(100);

  useEffect(() => {
    if (!query) return;
    let cancelled = false;
    const owned = cleanArtistName(query, "").toLowerCase();

    void (async () => {
      // SEQUENTIAL, paced, and retried — never `Promise.all`.
      //
      // `src/convex/playlists.ts` records the finding verbatim: "two concurrent
      // InnerTube searches return `{"items": []}` while the identical two
      // queries run one after the other return full results." The same file
      // notes that even paced, roughly half of all searches from this
      // deployment come back empty, which is why there is a retry here too.
      //
      // Both failures used to land in the same `.catch(() => ({items: []}))`,
      // so a throttled search was rendered as "Nothing found", which is a
      // fabrication: the tracks exist, the request was refused. `failed` now
      // tells those apart.
      const search = async (
        q: string,
      ): Promise<{ items: YtItem[]; empty: boolean; errored: boolean }> => {
        for (let attempt = 0; attempt < REPAIR_SEARCH_ATTEMPTS; attempt++) {
          if (attempt > 0) {
            await new Promise((r) => setTimeout(r, REPAIR_SEARCH_GAP_MS));
          }
          if (cancelled) return { items: [], empty: true, errored: true };
          try {
            const res = await searchYt({ query: q });
            const items = (res?.items ?? []) as YtItem[];
            // A response WITH results is a real answer, even if the filters
            // below end up discarding every one of them.
            if (items.length > 0)
              return { items, empty: false, errored: false };
          } catch {
            // A thrown upstream failure is evidence about the connection, not
            // about the artist.
          }
        }
        return { items: [], empty: true, errored: false };
      };

      const mine = await search(query);
      // Sequential: the second search must not overlap the first.
      const similar = mine.errored
        ? { items: [], empty: true, errored: true }
        : await search(`artists similar to ${query}`);

      if (cancelled) return;
      setResult({
        key: query,
        tracks: uniqueTracks(
          (mine.items ?? []).filter(
            (item) =>
              !!item &&
              item.duration > 0 &&
              cleanArtistName(item.artist, item.title).toLowerCase() === owned,
          ),
        ),
        related: uniqueTracks(
          (similar.items ?? []).filter(
            (item) =>
              !!item &&
              item.duration > 0 &&
              cleanArtistName(item.artist, item.title).toLowerCase() !== owned,
          ),
        ),
      });
      setFailedKey(mine.errored ? query : null);
    })();

    return () => {
      cancelled = true;
    };
  }, [query, searchYt, retryNonce]);

  const popularSource = useMemo(
    () => (result?.key === query ? result.tracks : null),
    [query, result],
  );
  const related = useMemo(
    () => (!query ? [] : result?.key === query ? result.related : null),
    [query, result],
  );
  const searchFailed = query !== "" && failedKey === query;

  // Popular stays provider-ranked, but identity is applied to it: guest
  // appearances are separated instead of being counted as the artist's own.
  const searchView = useMemo(
    () => buildCatalog(popularSource ?? [], artistName),
    [popularSource, artistName],
  );

  const toPlayable = (item: YtItem) =>
    toPlayableYoutube(item, `https://youtu.be/${item.id}`);

  const trackItem = useCallback(
    (track: BrowseTrack, release: CatalogRelease): YtItem => ({
      id: track.videoId,
      title: cleanTrackTitle(track.title),
      artist:
        track.artists.length > 0
          ? track.artists.join(", ")
          : cleanArtistName(catalog.identity?.name ?? artistName),
      duration: track.duration,
      thumbnail: release.thumbnail ?? "",
      album: track.album ?? release.title,
    }),
    [artistName, catalog.identity?.name],
  );

  const catalogItems = useMemo(
    () => catalog.tracks.map(({ track, release }) => trackItem(track, release)),
    [catalog.tracks, trackItem],
  );

  const visibleCatalog = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    let list = catalogItems;
    if (needle) {
      list = list.filter((item) =>
        `${item.title} ${item.artist} ${item.album ?? ""}`
          .toLowerCase()
          .includes(needle),
      );
    }
    if (sort === "title") {
      list = [...list].sort((a, b) => a.title.localeCompare(b.title));
    } else if (sort === "album") {
      list = [...list].sort(
        (a, b) =>
          (a.album ?? "").localeCompare(b.album ?? "") ||
          a.title.localeCompare(b.title),
      );
    } else if (sort === "duration") {
      list = [...list].sort((a, b) => a.duration - b.duration);
    }
    return list;
  }, [catalogItems, filter, sort]);

  const releaseGroups = useMemo(() => {
    const order: ReleaseType[] = [
      "album",
      "ep",
      "single",
      "live",
      "soundtrack",
      "compilation",
      "other",
    ];
    const labels: Record<ReleaseType, string> = {
      album: "Albums",
      ep: "EPs",
      single: "Singles",
      live: "Live & acoustic",
      soundtrack: "Soundtracks",
      compilation: "Compilations",
      other: "Other releases",
    };
    return order
      .map((kind) => ({
        kind,
        label: labels[kind],
        releases: catalog.releases.filter((release) => release.kind === kind),
      }))
      .filter((group) => group.releases.length > 0);
  }, [catalog.releases]);

  const shownGroups = useMemo(
    () =>
      kindFilter === "all"
        ? releaseGroups
        : releaseGroups.filter((group) => group.kind === kindFilter),
    [kindFilter, releaseGroups],
  );

  const playAll = (list: YtItem[]) => {
    const playable = list.map(toPlayable);
    const first = playable[0];
    if (!first) return;
    playTrack(first, playable);
  };

  /** Shuffle THIS list once, without touching the global shuffle preference. */
  const shuffleAll = (list: YtItem[]) => {
    const playable = list.map(toPlayable);
    if (playable.length === 0) return;
    for (let i = playable.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [playable[i], playable[j]] = [playable[j], playable[i]];
    }
    playListOrdered(playable[0], playable);
  };

  const playOne = (item: YtItem, list: YtItem[]) => {
    setResolvingId(item.id);
    void searchYt({ query: `${item.title} ${item.artist}` })
      .then(({ items: found }) => {
        const match = found[0];
        if (!match) {
          toast.error(`Couldn't load "${item.title}"`);
          return;
        }
        const queue = [match, ...found.slice(1)].map(toPlayable);
        playTrack({ ...queue[0], id: item.id, title: item.title }, queue);
      })
      .catch(() => toast.error("Playback failed — try again in a moment"))
      .finally(() => setResolvingId(null));
    void list;
  };

  const shareArtist = async () => {
    const url = `${window.location.origin}/artist/${encodeURIComponent(artistName)}`;
    try {
      if (typeof navigator !== "undefined" && navigator.share) {
        await navigator.share({ title: artistName, url });
        return;
      }
    } catch {
      // A cancelled share sheet is not an error; fall through to copying.
    }
    const copied = await copyText(url);
    if (copied) toast.success("Artist link copied");
    else toast.error("Couldn't copy the link");
  };

  if (!artistName) {
    return (
      <EmptyState
        title="No artist"
        body="That link didn't include an artist name."
      />
    );
  }

  const artwork = catalog.identity?.thumbnail ?? catalogItems[0]?.thumbnail ?? "";
  const canPlay = searchView.popular.length > 0 || catalogItems.length > 0;
  const showAllSongs = expandedFor === query;
  /**
   * How many songs the expanded "All songs" list renders before the listener
   * presses "Show more songs".
   *
   * This is NOT the old silent ceiling: the old hard cap hid songs the page
   * never mentioned, while Play queued a different (50-row) sample, so "all
   * songs" was a lie twice over. The limit here only paces RENDERING — the
   * full loaded list is one "Show more" press away, the button states how
   * many rows are waiting, and Play always queues everything loaded. As
   * tracklists keep arriving the list grows past the limit again, and the
   * button reappears.
   */
  const songsForList = showAllSongs
    ? visibleCatalog.slice(0, songLimit)
    : visibleCatalog.slice(0, 10);
  const songsBeyondLimit = Math.max(0, visibleCatalog.length - songLimit);
  const upstreamEmpty =
    catalog.identity === null && !searchFailed && (popularSource?.length ?? 0) === 0;

  return (
    <div className="flex flex-col gap-9 sm:gap-12">
      {/* ── Artist header ─────────────────────────────────────────────── */}
      <header className="flex flex-col gap-5 sm:flex-row sm:items-end">
        {artwork ? (
          <img
            src={artwork}
            alt=""
            className="size-28 shrink-0 rounded-2xl object-cover ring-1 ring-white/10 sm:size-36"
          />
        ) : (
          <span className="flex size-28 shrink-0 items-center justify-center rounded-2xl bg-[rgb(var(--tint)_/_0.12)] text-[rgb(var(--tint))] sm:size-36">
            <Disc3 className="size-8" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-semibold tracking-[0.2em] text-[rgb(var(--tint))] uppercase">
            Artist
          </p>
          <h1 className="font-display mt-1 text-2xl font-bold tracking-tight sm:text-4xl">
            {artistName}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {catalog.loadingReleases
              ? "Loading discography…"
              : catalog.releases.length > 0
                ? `${catalog.releases.length} releases · ${catalogItems.length} songs loaded${
                    catalog.hasMoreTracks ? " so far" : ""
                  }`
                : canPlay
                  ? `${searchView.catalog.length} songs available`
                  : "No catalogue available yet"}
          </p>
          {catalog.identity?.description ? (
            <p className="mt-1 line-clamp-2 max-w-xl text-xs text-muted-foreground/80">
              {catalog.identity.description}
            </p>
          ) : null}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {canPlay ? (
              <>
                <button
                  type="button"
                  onClick={() =>
                    playAll(
                      // Everything the catalogues have loaded — never a sample.
                      catalogItems.length > 0 ? catalogItems : searchView.popular,
                    )
                  }
                  className="inline-flex items-center gap-2 rounded-full bg-[rgb(var(--tint))] px-5 py-2.5 text-sm font-bold text-black transition-transform hover:scale-[1.02]"
                >
                  <Play className="size-4 fill-current" />
                  Play
                </button>
                <button
                  type="button"
                  onClick={() =>
                    shuffleAll(
                      catalogItems.length > 0
                        ? catalogItems
                        : searchView.catalog,
                    )
                  }
                  className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.05] px-4 py-2.5 text-sm font-semibold transition-colors hover:border-[rgb(var(--tint)_/_0.4)]"
                >
                  <Shuffle className="size-4" />
                  Shuffle
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const seed = catalogItems[0] ?? searchView.popular[0];
                    if (!seed) return;
                    startRadio(toPlayable(seed), artistName);
                  }}
                  className="inline-flex items-center gap-2 rounded-full border border-white/12 bg-white/[0.05] px-4 py-2.5 text-sm font-semibold transition-colors hover:border-[rgb(var(--tint)_/_0.4)]"
                >
                  <Radio className="size-4" />
                  Radio
                </button>
              </>
            ) : null}
            <button
              type="button"
              onClick={() => void shareArtist()}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 px-4 py-2.5 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground"
            >
              <Share2 className="size-4" />
              Share
            </button>
            <Link
              to={`/search?q=${encodeURIComponent(artistName)}`}
              className="inline-flex items-center gap-2 rounded-full border border-white/10 px-4 py-2.5 text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground"
            >
              <Search className="size-4" />
              Search
            </Link>
          </div>
        </div>
      </header>

      {/* A catalogue that stopped early says so. */}
      {catalog.truncated ? (
        <p
          role="status"
          className="rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-xs text-amber-200/90"
        >
          The music source offers more releases than one request returns, so this
          discography may be incomplete.
        </p>
      ) : null}
      {catalog.releases.some((release) => release.failed) ? (
        <p
          role="status"
          className="flex items-center gap-2 rounded-xl border border-rose-400/20 bg-rose-400/[0.06] px-3 py-2 text-xs text-rose-200/90"
        >
          <AlertTriangle className="size-3.5 shrink-0" />
          Some tracklists couldn&apos;t be read, so those releases show no songs.
        </p>
      ) : null}

      {/* ── Popular: the source's ranking, explicitly a shortcut. */}
      {popularSource === null ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading tracks…
        </div>
      ) : searchView.popular.length > 0 ? (
        <section aria-labelledby="artist-top-tracks">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2
              id="artist-top-tracks"
              className="font-display text-lg font-bold tracking-tight sm:text-xl"
            >
              Popular
            </h2>
            <span className="text-[11px] text-muted-foreground">
              Ranked by the music source
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            {searchView.popular.map((item, index) => (
              <RemoteTrackRow
                key={item.id}
                item={item}
                index={index + 1}
                onPlay={() => playOne(item, searchView.popular)}
                resolving={resolvingId === item.id}
              />
            ))}
          </div>
        </section>
      ) : upstreamEmpty ? (
        <EmptyState
          title="Nothing found"
          body={`We couldn't find ${artistName} in the connected source.`}
          searchTerm={artistName}
        />
      ) : searchFailed ? (
        <EmptyState
          title="Couldn't reach YouTube"
          body={`We couldn't load ${artistName} right now — YouTube is rate-limiting this app, so the search came back empty rather than having no results. It usually clears in a few seconds.`}
          searchTerm={artistName}
          action={
            <button
              type="button"
              onClick={() => setRetryNonce((n) => n + 1)}
              className="rounded-full bg-[rgb(var(--tint))] px-3.5 py-1.5 text-xs font-semibold text-black transition-transform hover:scale-[1.03]"
            >
              Try again
            </button>
          }
        />
      ) : null}

      {/* ── Discography: the artist's actual releases. */}
      {releaseGroups.length > 0 ? (
        <section aria-labelledby="artist-discography">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2
                id="artist-discography"
                className="font-display text-lg font-bold tracking-tight sm:text-xl"
              >
                Discography
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Every release the connected source lists for {artistName}
                {catalog.complete ? "" : " · still loading"}
              </p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <FilterChip
                active={kindFilter === "all"}
                onClick={() => setKindFilter("all")}
              >
                All
              </FilterChip>
              {releaseGroups.map((group) => (
                <FilterChip
                  key={group.kind}
                  active={kindFilter === group.kind}
                  onClick={() => setKindFilter(group.kind)}
                >
                  {group.label}
                </FilterChip>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-7">
            {shownGroups.map((group) => (
              <Shelf
                key={group.kind}
                id={`artist-releases-${group.kind}`}
                title={`${group.label} · ${group.releases.length}`}
                icon={<Disc3 className="size-4 text-[rgb(var(--tint))]" />}
              >
                {group.releases.map((release) => (
                  <MediaCard
                    key={release.id}
                    variant="playlist"
                    item={{
                      id: release.id,
                      title: release.title,
                      artist: catalog.identity?.name ?? artistName,
                      duration: 0,
                      thumbnail: release.thumbnail ?? "",
                      album: release.title,
                    }}
                    onOpen={() => {
                      const href = albumPath(
                        catalog.identity?.name ?? artistName,
                        release.title,
                      );
                      if (href) navigate(href);
                    }}
                    meta={[
                      release.year ?? null,
                      release.tracks
                        ? `${release.tracks.length} ${
                            release.tracks.length === 1 ? "track" : "tracks"
                          }`
                        : "tracklist loading…",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  />
                ))}
              </Shelf>
            ))}
          </div>
        </section>
      ) : catalog.loadingReleases ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading the discography…
        </div>
      ) : null}

      {/* ── All songs: everything read from those releases. */}
      {visibleCatalog.length > 0 || catalog.loadingTracks ? (
        <section aria-labelledby="artist-all-songs">
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2
                id="artist-all-songs"
                className="font-display text-lg font-bold tracking-tight sm:text-xl"
              >
                Songs
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {catalogItems.length} loaded
                {catalog.hasMoreTracks
                  ? ` · reading ${catalog.releases.length - catalog.hydrated} more releases…`
                  : " · every listed release read"}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="Filter songs"
                  aria-label="Filter songs"
                  className="w-44 rounded-full border border-white/10 bg-white/[0.04] py-1.5 pr-3 pl-8 text-xs outline-none placeholder:text-muted-foreground/70 focus:border-[rgb(var(--tint)_/_0.5)]"
                />
              </label>
              <select
                value={sort}
                onChange={(event) =>
                  setSort(
                    event.target.value as "default" | "title" | "album" | "duration",
                  )
                }
                aria-label="Sort songs"
                className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs outline-none focus:border-[rgb(var(--tint)_/_0.5)]"
              >
                <option value="default">Release order</option>
                <option value="title">Title A–Z</option>
                <option value="album">Album</option>
                <option value="duration">Shortest first</option>
              </select>
            </div>
          </div>
          <div className="flex flex-col gap-0.5">
            {songsForList.map((item, index) => (
              <RemoteTrackRow
                key={item.id}
                item={item}
                index={index + 1}
                onPlay={() => playOne(item, songsForList)}
                resolving={resolvingId === item.id}
              />
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {showAllSongs && songsBeyondLimit > 0 ? (
              <button
                type="button"
                onClick={() => setSongLimit((limit) => limit + 100)}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 px-4 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
              >
                Show more songs
                <span className="text-[10px] text-muted-foreground/70">
                  ({songsBeyondLimit} more songs loaded)
                </span>
              </button>
            ) : null}
            {visibleCatalog.length > 10 || showAllSongs ? (
              <button
                type="button"
                onClick={() => setExpandedFor(showAllSongs ? null : query)}
                className="inline-flex items-center gap-2 rounded-full border border-white/10 px-4 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
              >
                {showAllSongs ? (
                  <ChevronUp className="size-3.5" />
                ) : (
                  <ChevronDown className="size-3.5" />
                )}
                {showAllSongs
                  ? "Show less"
                  : `Show all ${visibleCatalog.length} songs`}
              </button>
            ) : null}
            {catalog.hasMoreTracks ? (
              <button
                type="button"
                onClick={catalog.loadMore}
                disabled={catalog.loadingTracks}
                className="inline-flex items-center gap-2 rounded-full bg-white/[0.06] px-4 py-2 text-xs font-semibold transition-colors hover:bg-white/[0.1] disabled:opacity-60"
              >
                {catalog.loadingTracks ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Sparkles className="size-3.5" />
                )}
                {catalog.loadingTracks
                  ? "Reading tracklists…"
                  : "Read more tracklists"}
              </button>
            ) : catalogItems.length > 0 ? (
              <span className="text-[11px] text-muted-foreground">
                Every release the source lists has been read.
              </span>
            ) : null}
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground/80">
            This is the complete catalogue available through SYNQ&apos;s
            connected source — provider coverage, regional licensing and
            permissions can differ, so it is not a claim about{" "}
            {artistName}&apos;s entire real-world output.
          </p>
        </section>
      ) : null}

      {/* ── Guest appearances, kept out of the artist's own discography. */}
      {searchView.featured.length > 0 ? (
        <section aria-labelledby="artist-featured">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2
              id="artist-featured"
              className="font-display text-lg font-bold tracking-tight sm:text-xl"
            >
              Appears on
            </h2>
            <span className="text-[11px] text-muted-foreground">
              Guest features, not {artistName}&apos;s own releases
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            {searchView.featured.slice(0, 20).map((item, index) => (
              <RemoteTrackRow
                key={item.id}
                item={item}
                index={index + 1}
                onPlay={() => playOne(item, searchView.featured)}
                resolving={resolvingId === item.id}
              />
            ))}
          </div>
        </section>
      ) : null}

      {/* ── A genuine similarity search, so the listener has somewhere to go. */}
      <Shelf
        id="artist-related"
        title="Fans also like"
        icon={<Sparkles className="size-4 text-[rgb(var(--tint))]" />}
        skeleton={related === null}
        hidden={related !== null && related.length === 0}
      >
        {(related ?? []).slice(0, 14).map((item) => (
          <MediaCard
            key={item.id}
            item={item}
            onOpen={() => playOne(item, related ?? [])}
            onPlay={() => playOne(item, related ?? [])}
            resolving={resolvingId === item.id}
          />
        ))}
      </Shelf>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        active
          ? "rounded-full bg-[rgb(var(--tint))] px-3 py-1 text-[11px] font-bold text-black"
          : "rounded-full border border-white/10 px-3 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
      }
    >
      {children}
    </button>
  );
}

function EmptyState({
  title,
  body,
  searchTerm,
  action,
}: {
  title: string;
  body: string;
  searchTerm?: string;
  /** Shown above the search link; used for a retry on a throttled search. */
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-8 text-center">
      <p className="font-display text-lg font-bold">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
        {body}
      </p>
      {action ? <div className="mt-4">{action}</div> : null}
      {searchTerm ? (
        <Link
          to={`/search?q=${encodeURIComponent(searchTerm)}`}
          className="mt-4 inline-flex items-center gap-2 rounded-full bg-[rgb(var(--tint))] px-4 py-2 text-sm font-bold text-black"
        >
          <Search className="size-4" />
          Search instead
        </Link>
      ) : null}
    </div>
  );
}
