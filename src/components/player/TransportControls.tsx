import { cn } from "@/lib/utils";
import { usePlayerStore } from "@/store/player";
import { Loader2, Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward } from "lucide-react";
import type { ReactNode } from "react";

function IconButton({
  active,
  disabled,
  onClick,
  label,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "rounded-full p-2 text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
        active && "text-[rgb(var(--tint))]",
      )}
    >
      {children}
    </button>
  );
}

export function TransportControls({ className }: { className?: string }) {
  const current = usePlayerStore((s) => s.current);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const isBuffering = usePlayerStore((s) => s.isBuffering);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const repeat = usePlayerStore((s) => s.repeat);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const next = usePlayerStore((s) => s.next);
  const prev = usePlayerStore((s) => s.prev);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const cycleRepeat = usePlayerStore((s) => s.cycleRepeat);

  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      <IconButton active={shuffle} onClick={toggleShuffle} label="Shuffle">
        <Shuffle className="size-4" />
      </IconButton>
      <IconButton disabled={!current} onClick={prev} label="Previous">
        <SkipBack className="size-4 fill-current" />
      </IconButton>
      <button
        type="button"
        aria-label={isPlaying ? "Pause" : "Play"}
        onClick={togglePlay}
        disabled={!current}
        className="mx-1 flex size-9 shrink-0 items-center justify-center rounded-full bg-white text-black shadow-[0_4px_20px_rgba(255,255,255,0.18)] transition-transform hover:scale-105 active:scale-95 disabled:pointer-events-none disabled:opacity-40"
      >
        {isBuffering && current ? (
          <Loader2 className="size-4 animate-spin" />
        ) : isPlaying ? (
          <Pause className="size-4 fill-current" />
        ) : (
          <Play className="ml-0.5 size-4 fill-current" />
        )}
      </button>
      <IconButton disabled={!current} onClick={next} label="Next">
        <SkipForward className="size-4 fill-current" />
      </IconButton>
      <IconButton
        active={repeat !== "off"}
        onClick={cycleRepeat}
        label={repeat === "one" ? "Repeat one" : repeat === "all" ? "Repeat all" : "Repeat off"}
      >
        {repeat === "one" ? <Repeat1 className="size-4" /> : <Repeat className="size-4" />}
      </IconButton>
    </div>
  );
}