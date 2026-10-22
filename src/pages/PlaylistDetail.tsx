import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  ListMusic,
  Loader2,
  Play,
  Radio,
  Search as SearchIcon,
  Share2,
  Shuffle,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { RemoteTrackRow } from "@/components/tracks/RemoteTrackRow";
import { ShareDialog } from "@/components/playlists/ShareDialog";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { isPlayable } from "@/lib/eligibility";
import { useAuth } from "@/hooks/use-auth";
import { formatTime } from "@/lib/format";
import {
  chunkRepairBatches,
  needsRepair,
  REPAIR_EMPTY_STREAK_LIMIT,
  REPAIR_MAX_PASSES,
  type ImportedRow,
  type RepairResult,
} from "@/lib/importRepair";
import { toPlayableYoutube, type Playable } from "@/lib/playable";
import { shuffleList } from "@/lib/queueOrder";
import { cleanArtistName, type YtItem } from "@/lib/youtube";
import { cn } from "@/lib/utils";
import { usePlayerStore } from "@/store/player";

interface PlaylistRow {
  id: string;
  title: string;
  artist: string;
  thumbnail: string;
  duration: number;
  youtubeId?: string;
  hasSnapshot: boolean;
}

export default function PlaylistDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const playlist = useQuery(api.playlists.get, {
    playlistId: id as Id<"playlists">,
  });
  const removePlaylist = useMutation(api.playlists.remove);
  const removeTrack = useMutation(api.playlists.removeTrack);
  const addTrack = useMutation(api.playlists.addTrack);
  const searchYt = useAction(api.youtube.searchYoutube);
  const resolveImported = useAction(api.playlists.resolveImportedTracks);
  const applyRepairs = useMutation(api.playlists.applyImportedRepairs);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const playListOrdered = usePlayerStore((s) => s.playListOrdered);
  const startPlaylistRadio = usePlayerStore((s) => s.startPlaylistRadio);
  const stopRadio = usePlayerStore((s) => s.stopRadio);
  const radioSource = usePlayerStore((s) => s.radioSource);

  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const { user } = useAuth();

  // Rows straight off the document, before the display mapping below. The
  // repair pass reads THESE, because it needs to know exactly what is still
  // missing rather than what the screen chose to render.
  const storedRows = useMemo<ImportedRow[]>(() => {
    const snapshots = playlist?.trackSnapshots ?? [];
    const byId = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
    return (playlist?.trackIds ?? []).map((trackId) => {
      const snapshot = byId.get(trackId);
      return {
        id: trackId,
        title: snapshot?.title ?? "",
        artist: snapshot?.artist ?? "",
        coverUrl: snapshot?.coverUrl ?? "",
        duration: snapshot?.duration ?? 0,
        ...(snapshot?.youtubeId ? { youtubeId: snapshot.youtubeId } : {}),
      };
    });
  }, [playlist]);

  /**
   * Fill in what an older import never stored: cover art, length, and a real
   * playable id.
   *
   * An imported row arrives as a title and an artist. The importers had
   * artwork and durations and threw them away on the way to the database, so
   * those playlists rendered as a grid of empty black boxes reading `0:00`.
   * New imports carry their own artwork now; this is the pass that repairs
   * the ones already in the library, and it works because the song itself is
   * the only honest source for the missing data.
   *
   * Reliability notes, because this runs unprompted on page open:
   *  - Only rows that still need something are sent, so a repaired playlist
   *    costs nothing.
   *  - Each row is attempted at most once per visit. A row YouTube cannot
   *    place keeps its honest placeholder instead of retrying forever.
   *  - One pass in flight at a time, in bounded parallel batches.
   *  - Every failure path is swallowed. A repair that cannot run must never
   *    take the playlist page down with it.
   */
  const repairInFlight = useRef(false);
  const repairAttempted = useRef<Set<string>>(new Set());
  // The loop below outlives the render that started it, so it reads the rows
  // through a ref rather than closing over one render's copy. The ref is
  // synced in an effect (declared first, so it lands before the repair pass
  // reads it) rather than during render.
  const storedRowsRef = useRef(storedRows);
  useEffect(() => {
    storedRowsRef.current = storedRows;
  }, [storedRows]);
  const [repairedCount, setRepairedCount] = useState(0);

  useEffect(() => {
    if (!playlist || repairInFlight.current) return;
    let cancelled = false;

    const run = async () => {
      let passes = 0;
      let emptyStreak = 0;
      while (passes < REPAIR_MAX_PASSES && !cancelled) {
        const pending = storedRowsRef.current.filter(
          (row) => needsRepair(row) && !repairAttempted.current.has(row.id),
        );
        const batches = chunkRepairBatches(pending);
        if (batches.length === 0) return;

        repairInFlight.current = true;
        setRepairing(true);
        let result: {
          resolved: RepairResult[];
          answered: string[];
          empty: number;
        } | null = null;
        try {
          const settled = await Promise.allSettled(
            batches.map((batch) =>
              resolveImported({
                tracks: batch.map((row) => ({
                  id: row.id,
                  title: row.title,
                  artist: row.artist,
                })),
              }),
            ),
          );
          result = {
            resolved: settled.flatMap((outcome) =>
              outcome.status === "fulfilled"
                ? (outcome.value?.resolved ?? [])
                : [],
            ),
            // Only rows upstream actually ANSWERED are marked done. A row
            // whose search came back empty stays retryable, because empty here
            // means "we are being throttled", not "this song does not exist".
            answered: settled.flatMap((outcome) =>
              outcome.status === "fulfilled"
                ? (outcome.value?.answered ?? [])
                : [],
            ),
            // A rejected batch counts as empty for every row it held: it is
            // the same "upstream gave us nothing" signal from the caller's
            // point of view, and it has to trigger the same backoff.
            empty: settled.reduce(
              (total, outcome, index) =>
                total +
                (outcome.status === "fulfilled"
                  ? (outcome.value?.empty ?? 0)
                  : batches[index].length),
              0,
            ),
          };
        } catch {
          return;
        } finally {
          repairInFlight.current = false;
        }
        if (!result || cancelled) return;

        for (const id of result.answered) repairAttempted.current.add(id);
        if (result.resolved.length > 0) {
          try {
            await applyRepairs({
              playlistId: playlist._id,
              repairs: result.resolved,
            });
            setRepairedCount((count) => count + result!.resolved.length);
          } catch {
            return;
          }
        }

        passes += 1;
        // Upstream answered with silence twice running: stop here rather than
        // keep spending a quota that has already said no. Repaired rows leave
        // the backlog on their own, so the next visit resumes from here.
        emptyStreak = result.empty > 0 ? emptyStreak + 1 : 0;
        if (emptyStreak >= REPAIR_EMPTY_STREAK_LIMIT) return;
        if (result.resolved.length === 0 && result.empty > 0) return;
      }
    };

    void run().finally(() => {
      if (!cancelled) setRepairing(false);
    });
    return () => {
      cancelled = true;
    };
  }, [playlist, resolveImported, applyRepairs]);

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
          <p className="font-display text-lg font-semibold">
            Playlist not found
          </p>
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

  const snapshots = new Map(
    (playlist.trackSnapshots ?? []).map((snapshot) => [snapshot.id, snapshot]),
  );
  const rows: PlaylistRow[] = playlist.trackIds.map((trackId) => {
    const snapshot = snapshots.get(trackId);
    return {
      id: trackId,
      title: snapshot?.title ?? "Playlist song",
      artist: cleanArtistName(snapshot?.artist, snapshot?.title),
      thumbnail: snapshot?.coverUrl ?? "",
      duration: snapshot?.duration ?? 0,
      youtubeId: snapshot?.youtubeId,
      hasSnapshot: snapshot !== undefined,
    };
  });
  const total = rows.reduce(
    (sum, row) => sum + (Number.isFinite(row.duration) ? row.duration : 0),
    0,
  );
  const query = filter.trim().toLocaleLowerCase();
  const visibleRows = rows
    .map((track, index) => ({ track, index }))
    .filter(({ track }) => {
      if (!query) return true;
      return `${track.title} ${track.artist}`
        .toLocaleLowerCase()
        .includes(query);
    });

  const directPlayable = (row: PlaylistRow): Playable | null => {
    // A REAL YouTube id is the only thing that can be played directly.
    //
    // This used to accept any row that had a snapshot and fall back to
    // `row.id`. That is fine for a song added from a search result, but a track
    // that arrived through a playlist import has a synthetic namespaced id like
    // `import:spotify|bjork|...` and NO `youtubeId`. Handing that to the player
    // as if it were a video id produces a row that looks playable, is
    // playable, and plays nothing — and because this function runs first in
    // `resolveLegacyRow`, the search-based fallback was never reached for
    // imported tracks at all.
    if (!row.hasSnapshot || !row.youtubeId) return null;
    // The shared queue-eligibility rule (`lib/eligibility`): an id that is not
    // the 11-character YouTube shape is metadata, not a recording. A snapshot
    // carrying a corrupted or truncated id used to stream silence and still
    // advance the queue; this sends such a row to the search resolution path
    // below like any other unmatched import.
    if (!isPlayable(row)) return null;
    const item: YtItem = {
      id: row.youtubeId,
      title: row.title,
      artist: cleanArtistName(row.artist, row.title),
      thumbnail: row.thumbnail,
      duration: row.duration,
    };
    return toPlayableYoutube(item, `https://youtu.be/${item.id}`);
  };

  const directQueue = rows.flatMap((row) => {
    const playable = directPlayable(row);
    return playable ? [playable] : [];
  });

  const resolveLegacyRow = async (
    row: PlaylistRow,
  ): Promise<Playable | null> => {
    const direct = directPlayable(row);
    if (direct) return direct;
    const searchQuery = row.hasSnapshot
      ? `${row.title} ${row.artist}`.trim()
      : row.id;
    const { items } = await searchYt({ query: searchQuery });
    const best =
      items.find((item) => item.id === row.youtubeId || item.id === row.id) ??
      items.find(
        (item) =>
          item.title.toLocaleLowerCase() === row.title.toLocaleLowerCase(),
      ) ??
      items[0];
    return best
      ? toPlayableYoutube(
          best,
          `https://youtu.be/${best.id}`,
          items.filter((item) => item.id !== best.id),
        )
      : null;
  };

  const playRow = async (row: PlaylistRow, options?: { shuffle?: boolean }) => {
    if (resolvingId) return;
    setResolvingId(row.id);
    try {
      const playable = await resolveLegacyRow(row);
      if (!playable) {
        toast.error(`Couldn't find a playable version of "${row.title}"`);
        return;
      }
      const base = directQueue.length > 0 ? directQueue : [playable];
      const queue = options?.shuffle ? shuffleList(base) : base;
      const start = options?.shuffle ? playListOrdered : playTrack;
      start(playable, queue);
    } catch {
      toast.error("Playback failed — try again in a moment");
    } finally {
      setResolvingId(null);
    }
  };

  /** Every row resolved to a playable, in playlist order. */
  const resolveAll = async (): Promise<Playable[]> => {
    const resolved: Playable[] = [];
    // New playlists are fully playable without a network round-trip. Only
    // legacy id-only rows need the compatibility resolver.
    for (const row of rows) {
      const playable = await resolveLegacyRow(row);
      if (playable) resolved.push(playable);
    }
    return resolved;
  };

  const playAll = async () => {
    if (rows.length === 0 || resolvingId) return;
    setResolvingId("__all__");
    try {
      const resolved = await resolveAll();
      if (resolved.length === 0) {
        toast.error("None of these tracks could be resolved right now");
        return;
      }
      playTrack(resolved[0], resolved);
      if (resolved.length < rows.length) {
        toast.warning(
          `Playing ${resolved.length} of ${rows.length} available tracks`,
        );
      }
    } catch {
      toast.error("Couldn't start this playlist — try again");
    } finally {
      setResolvingId(null);
    }
  };

  /**
   * "Playlist radio": play this playlist, then keep going with similar music
   * instead of stopping at the last track.
   */
  const startRadio = async () => {
    if (rows.length === 0 || resolvingId) return;
    setResolvingId("__radio__");
    try {
      const resolved = await resolveAll();
      if (resolved.length === 0) {
        toast.error("None of these tracks could be resolved right now");
        return;
      }
      startPlaylistRadio(resolved, playlist.name);
      toast.success(`Radio on — ${playlist.name} and similar`);
    } catch {
      toast.error("Couldn't start the radio — try again");
    } finally {
      setResolvingId(null);
    }
  };

  const shuffleAll = () => {
    // Both branches have to be guarded: reading past the end of an empty array
    // throws inside the click handler, which the user sees as a dead button.
    //
    // The list is shuffled HERE and played with `playListOrdered`, rather than
    // flipping the app's global shuffle preference. That switch is a sticky,
    // persisted mode: leaving it on meant this page's own "Play all" — and
    // every other list's — played in random order from then on, with the
    // transport's shuffle button lit to show why.
    if (directQueue.length > 0) {
      const queue = shuffleList(directQueue);
      const candidate = queue[0];
      if (!candidate) return;
      playListOrdered(candidate, queue);
    } else {
      if (rows.length === 0) return;
      // eslint-disable-next-line react-hooks/purity -- user-triggered shuffle
      const i = Math.floor(Math.random() * rows.length);
      const candidate = rows[i];
      if (!candidate) return;
      void playRow(candidate, { shuffle: true });
    }
    toast.success("Shuffling the playlist");
  };

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    try {
      await removePlaylist({ playlistId: playlist._id });
      toast.success(`Deleted "${playlist.name}"`);
      navigate("/playlists");
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Unknown error";
      toast.error("Could not delete the playlist", { description: message });
      setConfirmDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  const handleRemove = async (row: PlaylistRow) => {
    try {
      await removeTrack({
        playlistId: playlist._id,
        trackId: row.id,
        detail: row.title,
      });
      toast("Removed from playlist", {
        action: {
          label: "Undo",
          onClick: () => {
            void addTrack({
              playlistId: playlist._id,
              trackId: row.id,
              detail: row.title,
              track: row.hasSnapshot
                ? {
                    id: row.id,
                    title: row.title,
                    artist: row.artist,
                    coverUrl: row.thumbnail,
                    duration: row.duration,
                    youtubeId: row.youtubeId,
                  }
                : undefined,
            }).catch(() => toast.error("Couldn't restore the song"));
          },
        },
      });
    } catch {
      toast.error("Couldn't remove the song");
    }
  };

  // Ownership is the server's answer, not a client guess: `playlists.get`
  // only hands this document to the owner or to a recipient of a live grant.
  // Every destructive control below keys off this local boolean purely for
  // rendering; the mutations it gates re-check ownership server-side anyway.
  const isOwner = user != null && user._id === playlist.userId;
  const sharedBy = !isOwner && playlist.userId != null ? "shared with you" : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end">
        <PlaylistCover urls={rows.map((row) => row.thumbnail)} />
        <div className="min-w-0">
          <p className="text-[11px] font-semibold tracking-[0.2em] text-muted-foreground uppercase">
            Playlist
          </p>
          <h1 className="mt-1 truncate font-display text-3xl font-bold tracking-tight sm:text-4xl">
            {playlist.name}
          </h1>
          {playlist.description && (
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              {playlist.description}
            </p>
          )}
          <p className="mt-2 text-sm text-muted-foreground">
            {rows.length} {rows.length === 1 ? "song" : "songs"}
            {total > 0 && ` · ${formatTime(total)}`}
          </p>
          {/* The repair pass is silent by design: it is bookkeeping, not an
              event. It is only worth mentioning while it is actually running,
              and only when this playlist is the kind that needed it. The
              remaining count is the honest denominator: "found 3 of 41 to
              check" tells the listener where the pass actually is, whereas a
              bare spinner on a 107-row import read as stuck forever. */}
          {repairing && storedRows.some(needsRepair) && (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Looking up artwork and track lengths · {storedRows.filter(needsRepair).length} remaining
              {repairedCount > 0 ? ` · ${repairedCount} found` : ""}
            </p>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void playAll()}
              disabled={resolvingId !== null}
              className="flex items-center gap-2 rounded-full bg-[rgb(var(--tint))] px-5 py-2.5 text-sm font-semibold text-black shadow-[0_8px_30px_rgb(var(--tint)/0.35)] transition-all hover:scale-[1.03] active:scale-95 disabled:opacity-60"
            >
              <Play className="size-4 fill-current" />
              {resolvingId === "__all__" ? "Loading…" : "Play all"}
            </button>
            {rows.length > 0 && (
              <button
                type="button"
                onClick={shuffleAll}
                className="flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.05] px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-white/[0.1]"
              >
                <Shuffle className="size-4" />
                Shuffle
              </button>
            )}
            {rows.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  if (radioSource === playlist.name) {
                    stopRadio();
                    toast("Radio off — playing the playlist only");
                  } else {
                    void startRadio();
                  }
                }}
                disabled={resolvingId !== null}
                aria-pressed={radioSource === playlist.name}
                className={cn(
                  "flex items-center gap-2 rounded-full border px-5 py-2.5 text-sm font-semibold transition-colors disabled:opacity-60",
                  radioSource === playlist.name
                    ? "border-[rgb(var(--tint))] bg-[rgb(var(--tint)_/_0.14)] text-[rgb(var(--tint))]"
                    : "border-white/15 bg-white/[0.05] hover:bg-white/[0.1]",
                )}
              >
                <Radio className="size-4" />
                {resolvingId === "__radio__" ? "Loading…" : "Radio"}
              </button>
            )}
            {/* Delete is the owner's control. Recipients see neither the
                button nor the confirmation — and the `playlists.remove`
                mutation would refuse them regardless, server-side. */}
            {isOwner && (
              <>
                <button
                  type="button"
                  onClick={() => setShareOpen(true)}
                  disabled={user == null}
                  className="flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-sm transition-colors hover:border-[rgb(var(--tint)_/_0.5)] hover:text-[rgb(var(--tint))]"
                >
                  <Share2 className="size-4" />
                  Share
                </button>
                <button
                  type="button"
                  aria-label="Delete playlist"
                  disabled={deleting}
                  onClick={() => void handleDelete()}
                  onBlur={() => setConfirmDelete(false)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-3.5 py-2 text-sm transition-colors disabled:opacity-60",
                    confirmDelete
                      ? "border-red-500 bg-red-500/20 text-red-300"
                      : "border-white/10 text-muted-foreground hover:border-red-500/40 hover:text-red-400",
                  )}
                >
                  <Trash2 className="size-4" />
                  {confirmDelete ? "Click to confirm" : "Delete"}
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {!isOwner && sharedBy && (
        <div className="flex items-center gap-2 rounded-2xl border border-[rgb(var(--tint)_/_0.3)] bg-[rgb(var(--tint)_/_0.08)] px-4 py-2.5 text-sm">
          <UserRound className="size-4 shrink-0 text-[rgb(var(--tint))]" />
          <span className="min-w-0 truncate text-muted-foreground">
            Shared with you — you can play it, but only its owner can edit or
            delete it.
          </span>
        </div>
      )}

      {rows.length > 0 ? (
        <div className="flex flex-col gap-0.5">
          {rows.length > 5 && (
            <div className="relative mb-3 max-w-sm">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Search in playlist…"
                aria-label="Search in playlist"
                className="h-10 w-full rounded-full border border-white/10 bg-white/[0.05] pr-4 pl-9 text-sm text-foreground placeholder:text-muted-foreground/70 focus:border-[rgb(var(--tint)_/_0.6)] focus:outline-none"
              />
            </div>
          )}
          {visibleRows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No songs in this playlist match "{filter}".
            </p>
          ) : (
            visibleRows.map(({ track, index }) => (
              <RemoteTrackRow
                key={`${track.id}-${index}`}
                item={toYtItem(track)}
                index={index + 1}
                resolving={resolvingId === track.id}
                onPlay={() => void playRow(track)}
                source="youtube"
                menuItems={
                  isOwner ? (
                    <DropdownMenuItem
                      className="gap-2"
                      onSelect={(event) => {
                        event.stopPropagation();
                        void handleRemove(track);
                      }}
                    >
                      <X className="size-4" />
                      Remove from playlist
                    </DropdownMenuItem>
                  ) : undefined
                }
              />
            ))
          )}
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-3xl border border-dashed border-white/10 py-16 text-center">
          <ListMusic className="size-10 text-muted-foreground/40" />
          <p className="max-w-sm text-sm text-muted-foreground">
            This playlist is empty. Add songs from search results.
          </p>
          <Link
            to="/search"
            className="mt-1 rounded-full bg-[rgb(var(--tint))] px-5 py-2.5 text-sm font-semibold text-black"
          >
            Find music
          </Link>
        </div>
      )}

      <ChangeHistory playlistId={playlist._id} />

      <ShareDialog
        playlistId={playlist._id}
        playlistName={playlist.name}
        isOwner={isOwner}
        open={shareOpen}
        onOpenChange={setShareOpen}
      />
    </div>
  );
}

function toYtItem(track: PlaylistRow): YtItem {
  return {
    id: track.youtubeId ?? track.id,
    title: track.title,
    artist: cleanArtistName(track.artist, track.title),
    thumbnail: track.thumbnail,
    duration: track.duration,
  };
}

/**
 * The playlist's cover.
 *
 * An import has no single playlist image of its own, so this mosaics the
 * covers of the tracks inside it — which is what the services themselves do
 * for a playlist nobody art-directed, and it is honest: every tile is a real
 * song from this playlist.
 *
 * Falls back through one image, then the plain icon. A hero that is a
 * deliberately quiet grey tile reads as "no art yet"; a hero that is a broken
 * image reads as a bug, which is what the imported playlists looked like.
 */
function PlaylistCover({ urls }: { urls: string[] }) {
  const tiles = urls.filter((url) => url.trim()).slice(0, 4);
  const frame =
    "flex size-40 shrink-0 overflow-hidden rounded-2xl bg-gradient-to-br from-white/[0.09] to-white/[0.03] shadow-2xl ring-1 ring-white/10 sm:size-48";
  if (tiles.length === 0) {
    return (
      <div className={`${frame} items-center justify-center`}>
        <ListMusic className="size-10 text-muted-foreground/50" />
      </div>
    );
  }
  if (tiles.length === 1) {
    return (
      <div className={frame}>
        <img
          src={tiles[0]}
          alt=""
          className="size-full object-cover"
          loading="lazy"
        />
      </div>
    );
  }
  return (
    <div className={`${frame} grid grid-cols-2 grid-rows-2 gap-px bg-white/10`}>
      {/* Two or three covers still fill the grid: the tile set repeats rather
          than leaving holes, which is what every playlist mosaic does and
          what a half-empty hero looks like it doesn't. */}
      {Array.from({ length: 4 }, (_, index) => tiles[index % tiles.length]).map(
        (url, index) => (
          <img
            key={`${url}-${index}`}
            src={url}
            alt=""
            className="size-full object-cover"
            loading="lazy"
          />
        ),
      )}
    </div>
  );
}

const KIND_LABELS: Record<string, { text: string; className: string }> = {
  created: { text: "created", className: "text-[rgb(var(--tint))]" },
  renamed: { text: "renamed", className: "text-amber-400" },
  added: { text: "added", className: "text-emerald-400" },
  removed: { text: "removed", className: "text-rose-400" },
  deleted: { text: "deleted", className: "text-red-500" },
};

function ChangeHistory({ playlistId }: { playlistId: Id<"playlists"> }) {
  const events = useQuery(api.playlists.changeHistory, { playlistId });
  const [open, setOpen] = useState(false);
  if (!events || events.length === 0) return null;
  const shown = open ? events : events.slice(0, 3);
  return (
    <section className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-sm font-bold tracking-tight">
          Recent activity
        </h2>
        {events.length > 3 && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
          >
            {open ? "Show less" : `Show all (${events.length})`}
          </button>
        )}
      </div>
      <ul className="mt-2 space-y-1.5">
        {shown.map((event) => {
          const kind = KIND_LABELS[event.kind] ?? {
            text: event.kind,
            className: "text-muted-foreground",
          };
          return (
            <li key={event._id} className="text-xs text-muted-foreground">
              <span className={cn("font-semibold", kind.className)}>
                {kind.text}
              </span>{" "}
              {event.detail ? (
                <span className="text-foreground">{event.detail}</span>
              ) : null}
              {event.kind === "renamed" && event.detail
                ? ` (was "${event.detail}")`
                : null}
              <span className="ml-2 opacity-60">
                {new Date(event.at).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
