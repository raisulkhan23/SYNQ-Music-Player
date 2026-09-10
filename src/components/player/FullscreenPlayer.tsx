import { AnimatePresence, motion } from "framer-motion";
import { SeekBar } from "@/components/player/SeekBar";
import { TransportControls } from "@/components/player/TransportControls";
import { VisualizerCanvas } from "@/components/player/VisualizerCanvas";
import { VolumeControl } from "@/components/player/VolumeControl";
import { albumById, artistById } from "@/lib/catalog";
import { coverArt } from "@/lib/covers";
import { formatTime } from "@/lib/format";
import { usePlayerStore } from "@/store/player";
import { ChevronDown, Heart, ListMusic } from "lucide-react";
import { cn } from "@/lib/utils";

export function FullscreenPlayer() {
  const fullscreen = usePlayerStore((s) => s.fullscreen);
  const current = usePlayerStore((s) => s.current);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const liked = usePlayerStore((s) => s.liked);
  const toggleLike = usePlayerStore((s) => s.toggleLike);
  const accent = usePlayerStore((s) => s.accent);
  const setFullscreen = usePlayerStore((s) => s.setFullscreen);
  const setQueueOpen = usePlayerStore((s) => s.setQueueOpen);

  const album = current ? albumById(current.albumId) : null;
  const artist = current ? artistById(current.artistId) : null;
  const a = accent ?? { r: 196, g: 246, b: 152 };

  return (
    <AnimatePresence>
      {fullscreen && current && album && artist && (
        <motion.div
          key="fullscreen-player"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.22 }}
          className="fixed inset-0 z-[70] overflow-hidden bg-[#090a0f]"
        >
          {/* ambient accent glows */}
          <div
            className="pointer-events-none absolute -top-48 left-1/2 h-[520px] w-[780px] -translate-x-1/2 rounded-full blur-3xl"
            style={{
              background: `radial-gradient(closest-side, rgb(${a.r} ${a.g} ${a.b} / 0.2), transparent)`,
            }}
          />
          <div
            className="pointer-events-none absolute -bottom-56 -left-32 size-[560px] rounded-full blur-3xl"
            style={{
              background: `radial-gradient(closest-side, rgb(${a.r} ${a.g} ${a.b} / 0.12), transparent)`,
            }}
          />

          <VisualizerCanvas className="absolute inset-x-0 bottom-0 h-[44vh] w-full opacity-70" />

          <div className="relative z-10 flex h-full flex-col px-5 pt-4 pb-5 sm:px-10">
            {/* top row */}
            <div className="flex items-center justify-between">
              <button
                type="button"
                aria-label="Exit full-screen player"
                onClick={() => setFullscreen(false)}
                className="flex items-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
              >
                <ChevronDown className="size-5" />
                <span className="hidden sm:inline">Minimize</span>
              </button>
              <div className="hidden text-center sm:block">
                <p className="font-display text-sm font-semibold tracking-tight">
                  {album.title}
                </p>
                <p className="text-xs text-muted-foreground">{album.year} · Demo catalog</p>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label={liked[current.id] ? "Remove from liked songs" : "Add to liked songs"}
                  onClick={() => toggleLike(current.id)}
                  className={cn(
                    "rounded-full p-2.5 transition-all hover:scale-110",
                    liked[current.id]
                      ? "text-[rgb(var(--tint))]"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Heart className={cn("size-5", liked[current.id] && "fill-current")} />
                </button>
                <button
                  type="button"
                  aria-label="Open queue"
                  onClick={() => {
                    setFullscreen(false);
                    setQueueOpen(true);
                  }}
                  className="rounded-full p-2.5 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
                >
                  <ListMusic className="size-5" />
                </button>
              </div>
            </div>

            {/* artwork */}
            <div className="flex flex-1 items-center justify-center py-6">
              <motion.img
                src={coverArt(album)}
                alt={`${album.title} cover art`}
                className="size-[min(38vh,340px)] rounded-2xl object-cover shadow-[0_30px_80px_rgba(0,0,0,0.6)] ring-1 ring-white/10"
                animate={{ y: [0, -12, 0] }}
                transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
              />
            </div>

            {/* metadata + controls */}
            <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-3">
              <div className="w-full text-center">
                <h2 className="truncate font-display text-2xl font-bold tracking-tight sm:text-3xl">
                  {current.title}
                </h2>
                <p className="mt-1 truncate text-sm text-muted-foreground">
                  {artist.name} · {album.title}
                </p>
              </div>

              <div className="flex w-full items-center gap-2">
                <span className="w-11 shrink-0 text-right text-[11px] font-medium tabular-nums text-muted-foreground">
                  {formatTime(currentTime)}
                </span>
                <SeekBar className="min-w-0 flex-1" />
                <span className="w-11 shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground">
                  {formatTime(duration || current.duration)}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <TransportControls />
                <div className="mx-3 h-5 w-px bg-white/10" />
                <VolumeControl />
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}