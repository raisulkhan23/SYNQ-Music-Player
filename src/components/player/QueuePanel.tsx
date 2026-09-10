import { Reorder } from "framer-motion";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Equalizer } from "@/components/player/Equalizer";
import { albumById, artistById, trackById, type Track } from "@/lib/catalog";
import { coverArt } from "@/lib/covers";
import { formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { usePlayerStore } from "@/store/player";
import { GripVertical, ListMusic, Trash2, X } from "lucide-react";

export function QueuePanel() {
  const open = usePlayerStore((s) => s.queueOpen);
  const setOpen = usePlayerStore((s) => s.setQueueOpen);
  const current = usePlayerStore((s) => s.current);
  const queue = usePlayerStore((s) => s.queue);
  const queueIndex = usePlayerStore((s) => s.queueIndex);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const playIndex = usePlayerStore((s) => s.playIndex);
  const removeFromQueue = usePlayerStore((s) => s.removeFromQueue);
  const replaceUpcoming = usePlayerStore((s) => s.replaceUpcoming);
  const clearQueue = usePlayerStore((s) => s.clearQueue);

  const upcoming = queueIndex >= 0 ? queue.slice(queueIndex + 1) : queue;
  const upcomingIds = upcoming.map((t) => t.id);

  const handleReorder = (ids: string[]) => {
    const reordered = ids
      .map((id) => trackById(id))
      .filter((t): t is Track => t !== undefined);
    replaceUpcoming(reordered);
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent
        side="right"
        className="w-full border-l border-white/[0.08] bg-[#0e0f15]/95 p-0 backdrop-blur-2xl sm:max-w-md"
      >
        <SheetHeader className="flex flex-row items-center justify-between border-b border-white/[0.06] py-4 pr-12 pl-5">
          <SheetTitle className="flex items-center gap-2 font-display text-base">
            <ListMusic className="size-4 text-[rgb(var(--tint))]" />
            Queue
          </SheetTitle>
          <div className="flex items-center gap-2">
            {queue.length > 1 && (
              <button
                type="button"
                onClick={clearQueue}
                className="flex items-center gap-1 rounded-full px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-white/5 hover:text-foreground"
              >
                <Trash2 className="size-3.5" />
                Clear
              </button>
            )}
          </div>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-3 py-4">
          {current ? (
            <section className="rounded-xl bg-white/[0.04] p-3">
              <p className="px-1 pb-2 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
                Now playing
              </p>
              <div className="flex items-center gap-3">
                <img
                  src={coverArt(albumById(current.albumId))}
                  alt=""
                  className="size-11 shrink-0 rounded-md object-cover"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{current.title}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {artistById(current.artistId).name}
                  </p>
                </div>
                {isPlaying && <Equalizer className="shrink-0" />}
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
              <p className="px-1 pb-2 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
                Next up · {upcoming.length}
              </p>
              <Reorder.Group
                axis="y"
                values={upcomingIds}
                onReorder={handleReorder}
                className="space-y-1"
              >
                {upcoming.map((track) => (
                  <Reorder.Item
                    key={track.id}
                    value={track.id}
                    className="group flex cursor-grab items-center gap-2 rounded-lg px-1 py-1.5 transition-colors hover:bg-white/[0.05] active:cursor-grabbing"
                  >
                    <GripVertical className="size-4 shrink-0 text-muted-foreground/50 group-hover:text-muted-foreground" />
                    <img
                      src={coverArt(albumById(track.albumId))}
                      alt=""
                      className="size-10 shrink-0 rounded-md object-cover"
                    />
                    <div
                      className="min-w-0 flex-1"
                      onClick={() => playIndex(queueIndex + 1 + upcoming.indexOf(track))}
                    >
                      <p className="truncate text-sm font-medium">{track.title}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {artistById(track.artistId).name}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">
                      {formatTime(track.duration)}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove ${track.title} from queue`}
                      onClick={() =>
                        removeFromQueue(queueIndex + 1 + upcoming.indexOf(track))
                      }
                      className={cn(
                        "shrink-0 rounded-full p-1.5 text-muted-foreground/60 transition-colors hover:bg-white/10 hover:text-foreground",
                      )}
                    >
                      <X className="size-3.5" />
                    </button>
                  </Reorder.Item>
                ))}
              </Reorder.Group>
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}