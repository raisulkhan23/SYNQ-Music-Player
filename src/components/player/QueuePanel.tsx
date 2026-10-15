import { useEffect, useState } from "react";
import { Reorder, useDragControls } from "framer-motion";
import { useMutation } from "convex/react";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Equalizer } from "@/components/player/Equalizer";
import { api } from "@/convex/_generated/api";
import { formatTime } from "@/lib/format";
import { toPlayableYoutube, type Playable } from "@/lib/playable";
import type { YtItem } from "@/lib/youtube";
import { usePlayerStore } from "@/store/player";
import { toast } from "sonner";
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronUp,
  Clock3,
  CopyMinus,
  Eraser,
  GripVertical,
  Link2,
  ListMusic,
  Plus,
  Save,
  Shuffle,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/clipboard";
import { buildTrackShareUrl } from "@/lib/shareLink";
import { moveQueueRow, queueReorderKeys } from "@/lib/queueOrder";

type QueueReorderRowProps = {
  track: Playable;
  rowIndex: number;
  rowCount: number;
  queueIndex: number;
  playIndex: (index: number) => void;
  removeFromQueue: (index: number) => void;
  undoRemoveFromQueue: () => void;
  onMove: (from: number, to: number) => void;
  reorderKey: string;
};

function QueueReorderRow({
  track,
  rowIndex,
  rowCount,
  queueIndex,
  playIndex,
  removeFromQueue,
  undoRemoveFromQueue,
  onMove,
  reorderKey,
}: QueueReorderRowProps) {
  const controls = useDragControls();

  return (
    <Reorder.Item
      value={reorderKey}
      dragListener={false}
      className="group flex items-center gap-2 rounded-lg px-1 py-1.5 transition-colors hover:bg-white/[0.05]"
    >
      <button
        type="button"
        aria-label={`Drag ${track.title} to reorder`}
        title="Drag to reorder"
        onPointerDown={(event) => {
          // Only the grip starts reordering. The rest of the row keeps the
          // browser's native touch scrolling behavior.
          event.stopPropagation();
          controls.start(event);
        }}
        onClick={(event) => event.stopPropagation()}
        className="flex size-6 shrink-0 touch-none cursor-grab items-center justify-center rounded text-muted-foreground/50 active:cursor-grabbing hover:text-muted-foreground"
      >
        <GripVertical className="size-4" />
      </button>
      <img
        src={track.coverUrl}
        alt=""
        className="size-10 shrink-0 rounded-md object-cover"
      />
      <div
        className="min-w-0 flex-1 touch-pan-y"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => playIndex(queueIndex + 1 + rowIndex)}
      >
        <p className="truncate text-sm font-medium">{track.title}</p>
        <p className="truncate text-xs text-muted-foreground">
          {track.artistName}
        </p>
      </div>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">
        {formatTime(track.duration)}
      </span>
      {/* Drag-to-reorder is unreliable on a touch surface inside a scrollable
          sheet, so every row also gets explicit move controls. They work with
          one tap and are keyboard reachable. Grouped into one pill with a
          divider so they read as a single control rather than two loose
          chevrons squashed against the remove button. */}
      <span className="flex shrink-0 flex-col divide-y divide-white/[0.08] overflow-hidden rounded-md border border-white/10 bg-white/[0.03]">
        <button
          type="button"
          aria-label={`Move ${track.title} up`}
          title="Move up"
          disabled={rowIndex === 0}
          onClick={(event) => {
            event.stopPropagation();
            onMove(rowIndex, rowIndex - 1);
          }}
          className="flex size-7 touch-manipulation items-center justify-center text-muted-foreground/70 transition-colors hover:bg-white/10 hover:text-foreground active:bg-white/15 disabled:pointer-events-none disabled:opacity-25"
        >
          <ChevronUp className="size-4" />
        </button>
        <button
          type="button"
          aria-label={`Move ${track.title} down`}
          title="Move down"
          disabled={rowIndex >= rowCount - 1}
          onClick={(event) => {
            event.stopPropagation();
            onMove(rowIndex, rowIndex + 1);
          }}
          className="flex size-7 touch-manipulation items-center justify-center text-muted-foreground/70 transition-colors hover:bg-white/10 hover:text-foreground active:bg-white/15 disabled:pointer-events-none disabled:opacity-25"
        >
          <ChevronDown className="size-4" />
        </button>
      </span>
      <button
        type="button"
        aria-label={`Remove ${track.title} from queue`}
        onClick={() => {
          removeFromQueue(queueIndex + 1 + rowIndex);
          toast("Removed from queue", {
            action: {
              label: "Undo",
              onClick: () => undoRemoveFromQueue(),
            },
          });
        }}
        className="shrink-0 rounded-full p-1.5 text-muted-foreground/60 transition-colors hover:bg-white/10 hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </Reorder.Item>
  );
}

/** Fetch a related-mix for the current track (any source) as suggestions. */
async function fetchRelatedSuggestions(seed: Playable): Promise<Playable[]> {
  try {
    const client = (
      window as unknown as {
        __ssSuggestSearch?: {
          action: (fn: unknown, args: unknown) => Promise<{ items?: YtItem[] }>;
        };
      }
    ).__ssSuggestSearch;
    if (!client) return [];
    const primary = seed.artistName.split(",")[0]?.trim() ?? seed.artistName;
    const res = await client.action("youtube:searchYoutube", {
      query: `${seed.title} ${primary} similar songs`,
    });
    return (res?.items ?? [])
      .slice(0, 6)
      .map((it) => toPlayableYoutube(it, ""));
  } catch {
    return [];
  }
}

export function QueuePanel() {
  const open = usePlayerStore((s) => s.queueOpen);
  const setOpen = usePlayerStore((s) => s.setQueueOpen);
  const current = usePlayerStore((s) => s.current);
  const queue = usePlayerStore((s) => s.queue);
  const queueIndex = usePlayerStore((s) => s.queueIndex);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playIndex = usePlayerStore((s) => s.playIndex);
  const removeFromQueue = usePlayerStore((s) => s.removeFromQueue);
  const undoRemoveFromQueue = usePlayerStore((s) => s.undoRemoveFromQueue);
  const reorderUpcoming = usePlayerStore((s) => s.reorderUpcoming);
  const clearQueue = usePlayerStore((s) => s.clearQueue);
  const undoClearQueue = usePlayerStore((s) => s.undoClearQueue);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const smartShuffle = usePlayerStore((s) => s.smartShuffle);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const toggleSmartShuffle = usePlayerStore((s) => s.toggleSmartShuffle);
  const autoplay = usePlayerStore((s) => s.autoplay);
  const toggleAutoplay = usePlayerStore((s) => s.toggleAutoplay);
  const addToQueue = usePlayerStore((s) => s.addToQueue);
  const removeQueueDuplicates = usePlayerStore((s) => s.removeQueueDuplicates);
  const clearPlayedTracks = usePlayerStore((s) => s.clearPlayedTracks);
  const shuffleUpcoming = usePlayerStore((s) => s.shuffleUpcoming);
  const extendQueueWithSimilar = usePlayerStore(
    (s) => s.extendQueueWithSimilar,
  );
  const createPlaylist = useMutation(api.playlists.create);

  const upcoming = queueIndex >= 0 ? queue.slice(queueIndex + 1) : queue;
  // Reorder needs UNIQUE values that stay stable across a move — see
  // `queueReorderKeys`.
  const upcomingKeys = queueReorderKeys(upcoming);

  // Queue suggestions: fetched related mix for what's playing (any source),
  // filtered against what's already queued. Loaded lazily via an effect.
  const [suggestions, setSuggestions] = useState<Playable[]>([]);
  const currentKey = current?.id ?? null;
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing suggestions on track change
    setSuggestions([]);
    if (!current || upcoming.length >= 15) return;
    let cancelled = false;
    void fetchRelatedSuggestions(current).then((items) => {
      if (cancelled) return;
      setSuggestions(
        items
          .filter(
            (t) => !queue.some((q) => q.id === t.id) && t.id !== current.id,
          )
          .slice(0, 3),
      );
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey]);

  const extendQueue = () => {
    extendQueueWithSimilar();
  };

  const saveQueueAsPlaylist = async () => {
    if (queue.length === 0) {
      toast.error("The queue is empty");
      return;
    }
    // Store metadata with the ids in one mutation. Saving ids alone made the
    // playlist render placeholders and forced playback to search for a raw
    // YouTube id, which commonly returned no result.
    try {
      const name = `Queue · ${new Date().toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
      await createPlaylist({
        name,
        description: "Saved from your queue",
        tracks: queue.map((track) => ({
          id: track.id,
          title: track.title,
          artist: track.artistName,
          album: track.albumName || undefined,
          coverUrl: track.coverUrl,
          duration: Number.isFinite(track.duration) ? track.duration : 0,
          youtubeId: track.youtubeId,
        })),
      });
      toast.success(`Saved ${queue.length} songs as "${name}"`);
    } catch {
      toast.error("Couldn't save the queue as a playlist");
    }
  };

  const handleReorder = (keys: string[]) => {
    // Reorder keys are `${id}#${rowIndex}` of the list this render produced, so
    // `upcoming` IS the "base" the store compares against to tell a real
    // reorder apart from a stale render. It has to be passed in: without it the
    // store cannot validate anything and silently discards every change, which
    // is why the arrows and drag both looked broken.
    if (keys.length !== upcoming.length) return;
    // Nothing actually moved (e.g. a cancelled drag) — don't touch the queue.
    if (keys.every((k, i) => k === upcomingKeys[i])) return;
    const byKey = new Map(upcoming.map((t, i) => [upcomingKeys[i], t]));
    const reordered = keys
      .map((k) => byKey.get(k))
      .filter((t): t is NonNullable<typeof t> => t !== undefined);
    if (reordered.length !== upcoming.length) return;
    reorderUpcoming(reordered, upcoming);
  };

  /** Move one row to an absolute position in the upcoming list. */
  const moveRow = (from: number, to: number) => {
    const keys = moveQueueRow(upcomingKeys, from, to);
    if (keys) handleReorder(keys);
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="right"
        /* The sheet is `fixed inset-y-0`, so on a notched phone the "Queue"
           header sat under the status bar and the bottom controls under the
           home indicator. */
        className="w-full border-l border-white/[0.08] bg-[#0e0f15]/95 p-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] backdrop-blur-2xl sm:max-w-md"
      >
        <SheetHeader className="flex flex-row flex-wrap items-center justify-between gap-y-2 border-b border-white/[0.06] py-3 pr-12 pl-4 sm:py-4 sm:pl-5">
          <SheetTitle className="flex items-center gap-2 font-display text-base">
            <ListMusic className="size-4 text-[rgb(var(--tint))]" />
            Queue
          </SheetTitle>
          <div className="flex flex-wrap items-center gap-1">
            {/* smart shuffle */}
            <button
              type="button"
              aria-label="Smart shuffle"
              title={smartShuffle ? "Smart shuffle on" : "Smart shuffle off"}
              onClick={() => {
                toggleSmartShuffle();
                toast(
                  smartShuffle
                    ? "Smart shuffle off"
                    : "Smart shuffle on — avoids repeats",
                );
              }}
              className={cn(
                "flex items-center gap-1 rounded-full px-2 py-1 text-xs transition-colors",
                smartShuffle
                  ? "bg-[rgb(var(--tint)_/_0.15)] text-[rgb(var(--tint))]"
                  : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
              )}
            >
              <Sparkles className="size-3.5" />
              Smart
            </button>
            {/* plain shuffle */}
            <button
              type="button"
              aria-label="Shuffle"
              title={shuffle ? "Shuffle on" : "Shuffle off"}
              onClick={() => {
                toggleShuffle();
                toast(shuffle ? "Shuffle off" : "Shuffle on");
              }}
              className={cn(
                "flex items-center gap-1 rounded-full px-2 py-1 text-xs transition-colors",
                shuffle
                  ? "bg-[rgb(var(--tint)_/_0.15)] text-[rgb(var(--tint))]"
                  : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
              )}
            >
              <ArrowLeftRight className="size-3.5" />
            </button>
            {/* autoplay similar music */}
            <button
              type="button"
              aria-label="Autoplay similar music"
              title={
                autoplay
                  ? "Autoplay on — similar music plays when the queue ends"
                  : "Autoplay off"
              }
              onClick={() => {
                toggleAutoplay();
                toast(
                  autoplay
                    ? "Autoplay off"
                    : "Autoplay on — similar music when queue ends",
                );
              }}
              className={cn(
                "flex items-center gap-1 rounded-full px-2 py-1 text-xs transition-colors",
                autoplay
                  ? "bg-[rgb(var(--tint)_/_0.15)] text-[rgb(var(--tint))]"
                  : "text-muted-foreground hover:bg-white/5 hover:text-foreground",
              )}
            >
              <Sparkles className="size-3.5" />
              Auto
            </button>
            {/* save queue as playlist */}
            {queue.length > 1 && (
              <button
                type="button"
                aria-label="Save queue as playlist"
                title="Save queue as playlist"
                onClick={() => void saveQueueAsPlaylist()}
                className="flex items-center gap-1 rounded-full px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
              >
                <Save className="size-3.5" />
                Save
              </button>
            )}
            {/* Queue housekeeping: a long session queue collects repeats (radio,
                a track added from two places) and already-heard songs, and
                there was no way to tidy either without reordering one by one. */}
            {upcoming.length > 1 && (
              <button
                type="button"
                aria-label="Randomize playing next"
                title="Randomize the playing next list"
                onClick={() => {
                  shuffleUpcoming();
                  toast.success("Shuffled what's next");
                }}
                className="flex items-center gap-1 rounded-full px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
              >
                <Shuffle className="size-3.5" />
              </button>
            )}
            {queue.length > 1 && (
              <button
                type="button"
                aria-label="Remove duplicate songs"
                title="Remove duplicate songs"
                onClick={() => {
                  const removed = removeQueueDuplicates();
                  toast(
                    removed > 0
                      ? `Removed ${removed} duplicate${removed === 1 ? "" : "s"}`
                      : "No duplicates in the queue",
                  );
                }}
                className="flex items-center gap-1 rounded-full px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
              >
                <CopyMinus className="size-3.5" />
              </button>
            )}
            {queueIndex > 0 && (
              <button
                type="button"
                aria-label="Remove already played songs"
                title="Remove already played songs"
                onClick={() => {
                  const removed = clearPlayedTracks();
                  toast(
                    removed > 0
                      ? `Cleared ${removed} played song${removed === 1 ? "" : "s"}`
                      : "Nothing played yet",
                  );
                }}
                className="flex items-center gap-1 rounded-full px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
              >
                <Eraser className="size-3.5" />
              </button>
            )}
            {queue.length > 1 && (
              <button
                type="button"
                onClick={() => {
                  clearQueue();
                  // Clearing the queue is the most destructive control in the
                  // panel — it drops the listener's whole Up Next in one tap,
                  // including autoplay picks that cannot be regenerated. The
                  // Undo restores the exact previous queue (see
                  // `undoClearQueue`), not a fresh set of recommendations.
                  toast.success("Queue cleared", {
                    action: {
                      label: "Undo",
                      onClick: () => undoClearQueue(),
                    },
                  });
                }}
                className="flex items-center gap-1 rounded-full px-2 py-1 text-xs text-red-400/80 transition-colors hover:bg-red-500/10 hover:text-red-400"
              >
                <Trash2 className="size-3.5" />
                Clear
              </button>
            )}
          </div>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-3 py-4">
          {current ? (
            <section className="rounded-xl bg-white/[0.04] p-3">
              <p className="px-1 pb-2 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
                Now playing
              </p>
              <div className="flex items-center gap-3">
                <img
                  src={current.coverUrl}
                  alt=""
                  className="size-11 shrink-0 rounded-md object-cover"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">
                    {current.title}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {current.artistName}
                  </p>
                </div>
                {isPlaying && <Equalizer className="shrink-0" />}
                {current.youtubeId && (
                  <button
                    type="button"
                    aria-label="Copy current track link"
                    title="Copy current track link"
                    onClick={() => {
                      // Awaited: the old code toasted success immediately, so a
                      // failed copy (no clipboard API / denied permission) still
                      // told the user the link was on their clipboard.
                      //
                      // An in-app deep link, not `youtu.be/…`: the recipient is
                      // on a sharing app, and a YouTube URL drops them out of
                      // SYNQ onto someone else's player with ads and no queue.
                      void copyText(
                        buildTrackShareUrl(window.location.origin, current),
                      ).then((ok) => {
                        if (ok) toast.success("Track link copied");
                        else toast.error("Couldn't copy the link");
                      });
                    }}
                    className="flex size-8 shrink-0 items-center justify-center rounded-full border border-white/10 text-muted-foreground transition-colors hover:border-white/25 hover:text-foreground"
                  >
                    <Link2 className="size-3.5" />
                  </button>
                )}
              </div>
            </section>
          ) : (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <ListMusic className="size-10 text-muted-foreground/40" />
              <p className="text-sm text-muted-foreground">
                Nothing in the queue yet.
                <br />
                Press play on any track to get started.
              </p>
            </div>
          )}

          {upcoming.length > 0 && (
            <section className="min-h-0">
              <p className="flex items-center gap-1.5 px-1 pb-2 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
                <Clock3 className="size-3" />
                Playing next · {upcoming.length}
              </p>
              {/* Own scroll area, capped height — long queues used to push the
                  suggestions block into the drag rows and they collided. */}
              <Reorder.Group
                axis="y"
                values={upcomingKeys}
                onReorder={handleReorder}
                layoutScroll
                className="max-h-[42vh] space-y-1 overflow-y-auto overscroll-contain pr-1"
              >
                {upcoming.map((track, rowIndex) => (
                  <QueueReorderRow
                    key={upcomingKeys[rowIndex]}
                    reorderKey={upcomingKeys[rowIndex]}
                    track={track}
                    rowIndex={rowIndex}
                    rowCount={upcoming.length}
                    queueIndex={queueIndex}
                    playIndex={playIndex}
                    removeFromQueue={removeFromQueue}
                    undoRemoveFromQueue={undoRemoveFromQueue}
                    onMove={moveRow}
                  />
                ))}
              </Reorder.Group>
            </section>
          )}

          {/* queue suggestions — related songs for what's playing */}
          {(suggestions.length > 0 || current) && (
            <section>
              <p className="flex items-center gap-1.5 px-1 pb-2 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
                <Sparkles className="size-3" />
                Suggested for the queue
              </p>
              <div className="space-y-1">
                {suggestions.map((track) => (
                  <div
                    key={track.id}
                    className="group flex items-center gap-2 rounded-lg px-1 py-1.5 transition-colors hover:bg-white/[0.05]"
                  >
                    <img
                      src={track.coverUrl}
                      alt=""
                      className="size-10 shrink-0 rounded-md object-cover opacity-80"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {track.title}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        Matches what&apos;s playing
                      </p>
                    </div>
                    <button
                      type="button"
                      aria-label={`Add ${track.title} to queue`}
                      onClick={() => {
                        addToQueue(track);
                        setSuggestions((prev) =>
                          prev.filter((t) => t.id !== track.id),
                        );
                        toast.success(`Added "${track.title}" to queue`);
                      }}
                      className="shrink-0 rounded-full p-1.5 text-muted-foreground/60 transition-colors hover:bg-white/10 hover:text-foreground"
                    >
                      <Plus className="size-4" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={extendQueue}
                  className="mt-1 flex w-full items-center justify-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5 text-sm font-semibold transition-colors hover:border-[rgb(var(--tint)_/_0.35)] hover:bg-white/[0.05]"
                >
                  <Sparkles className="size-4 text-[rgb(var(--tint))]" />
                  Add similar songs automatically
                </button>
              </div>
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
