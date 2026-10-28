import { cn } from "@/lib/utils";
import {
  shuffleLabelFor,
  shuffleStateOf,
  shuffleToastFor,
} from "@/lib/shuffleState";
import { usePlayerStore } from "@/store/player";
import { toast } from "sonner";
import {
  Loader2,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Sparkles,
} from "lucide-react";
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
        "relative touch-manipulation flex size-9 items-center justify-center rounded-full text-foreground/70 transition-[color,background-color,transform,opacity] duration-200 hover:bg-white/[0.07] hover:text-foreground active:scale-90 disabled:pointer-events-none disabled:opacity-35",
        active &&
          "bg-[rgb(var(--tint)_/_0.1)] text-[rgb(var(--tint))] hover:bg-[rgb(var(--tint)_/_0.16)]",
      )}
    >
      {children}
    </button>
  );
}

export function TransportControls({
  className,
  compact = false,
}: {
  className?: string;
  /** Mobile miniplayer mode: play/next only — prev, shuffle & repeat live in the fullscreen player. */ compact?: boolean;
}) {
  const current = usePlayerStore((s) => s.current);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const isBuffering = usePlayerStore((s) => s.isBuffering);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const repeat = usePlayerStore((s) => s.repeat);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const next = usePlayerStore((s) => s.next);
  const prev = usePlayerStore((s) => s.prev);
  const cycleShuffle = usePlayerStore((s) => s.cycleShuffle);
  const smartShuffle = usePlayerStore((s) => s.smartShuffle);
  const cycleRepeat = usePlayerStore((s) => s.cycleRepeat);

  // The button's whole presentation comes from one place, so the toast, the
  // label and the badge can never describe different states.
  const shuffleState = shuffleStateOf(shuffle, smartShuffle);

  return (
    <div
      className={cn(
        "grid items-center justify-items-center",
        // compact: play + next. full: shuffle, prev, play, next, repeat.
        compact
          ? "grid-cols-[repeat(2,2.25rem)] gap-1"
          : "grid-cols-[repeat(5,2.25rem)] gap-0.5",
        className,
      )}
    >
      {!compact && (
        // Three states, one control, exactly like Spotify's shuffle button:
        // off -> shuffle -> smart shuffle -> off. The next state is what the
        // label and the toast describe, so the button always says what the
        // press will do rather than only what the current mode is.
        <IconButton
          active={shuffleState !== "off"}
          onClick={() => {
            cycleShuffle();
            toast(shuffleToastFor(shuffleState));
          }}
          label={shuffleLabelFor(shuffleState)}
        >
          <Shuffle className="size-[18px] stroke-[1.9]" />
          {/* Smart shuffle has no icon of its own, so the badge is the only way
              to tell the second state from the third. Without it both looked
              identical and there was no way to know which mode was running. */}
          {shuffleState === "smart" && (
            <span className="absolute -top-0.5 -right-0.5 flex size-3 items-center justify-center rounded-full bg-[rgb(var(--tint))] text-black ring-2 ring-[rgb(var(--background))]">
              <Sparkles className="size-2" strokeWidth={2.5} />
              <span className="sr-only">Smart shuffle on</span>
            </span>
          )}
        </IconButton>
      )}
      {/* The miniplayer has no previous button: the compact row is play/next
          only, and going back lives in the fullscreen player. */}
      {!compact && (
        <IconButton disabled={!current} onClick={prev} label="Previous">
          <SkipBack className="size-[19px] fill-current stroke-[1.6]" />
        </IconButton>
      )}
      <button
        type="button"
        aria-label={isPlaying ? "Pause" : "Play"}
        onClick={togglePlay}
        disabled={!current}
        className={cn(
          "touch-manipulation flex size-10 shrink-0 items-center justify-center self-center rounded-full bg-[rgb(var(--tint))] text-black shadow-[0_5px_22px_rgb(var(--tint)_/_0.2)] ring-1 ring-white/20 transition-[transform,background-color,opacity] duration-200 hover:scale-105 hover:brightness-105 active:scale-90 disabled:pointer-events-none disabled:opacity-35",
          !compact && "col-start-3",
        )}
      >
        {isBuffering && current ? (
          <Loader2 className="size-[18px] animate-spin" />
        ) : isPlaying ? (
          <Pause className="size-[18px] stroke-[2.4]" />
        ) : (
          <Play className="ml-0.5 size-[18px] fill-current stroke-[1.8]" />
        )}
      </button>
      <IconButton disabled={!current} onClick={next} label="Next">
        <SkipForward className="size-[19px] fill-current stroke-[1.6]" />
      </IconButton>
      {!compact && (
        <IconButton
          active={repeat !== "off"}
          onClick={cycleRepeat}
          label={
            repeat === "one"
              ? "Repeat one"
              : repeat === "all"
                ? "Repeat all"
                : "Repeat off"
          }
        >
          {repeat === "one" ? (
            <Repeat1 className="size-[18px] stroke-[1.9]" />
          ) : (
            <Repeat className="size-[18px] stroke-[1.9]" />
          )}
        </IconButton>
      )}
    </div>
  );
}
