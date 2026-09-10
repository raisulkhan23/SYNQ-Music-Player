import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { formatTime } from "@/lib/format";
import { usePlayerStore } from "@/store/player";

export function SeekBar({ className }: { className?: string }) {
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const bufferedEnd = usePlayerStore((s) => s.bufferedEnd);
  const seek = usePlayerStore((s) => s.seek);

  const trackRef = useRef<HTMLDivElement>(null);
  const [hoverPos, setHoverPos] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const ratio = duration > 0 ? currentTime / duration : 0;
  const bufferedRatio = duration > 0 ? Math.min(1, bufferedEnd / duration) : 0;

  const posFromEvent = (clientX: number): number => {
    const el = trackRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  };

  const seekTo = (p: number) => seek(p * (duration || 0));

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = posFromEvent(e.clientX);
    setDragging(true);
    setHoverPos(p);
    seekTo(p);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = posFromEvent(e.clientX);
    setHoverPos(p);
    if (dragging) seekTo(p);
  };

  const handlePointerUp = () => setDragging(false);

  return (
    <div
      className={cn(
        "group relative flex h-5 touch-none items-center select-none",
        className,
      )}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => setDragging(false)}
      onPointerLeave={() => {
        if (!dragging) setHoverPos(null);
      }}
    >
      <div
        ref={trackRef}
        className="relative h-[4px] w-full rounded-full bg-white/10 transition-all duration-150 group-hover:h-[6px]"
      >
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-white/15"
          style={{ width: `${bufferedRatio * 100}%` }}
        />
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-[rgb(var(--tint))]"
          style={{ width: `${ratio * 100}%` }}
        />
        <div
          className="absolute top-1/2 size-3 -translate-y-1/2 rounded-full bg-white opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100"
          style={{ left: `calc(${ratio * 100}% - 6px)` }}
        />
      </div>
      {hoverPos !== null && duration > 0 && (
        <div
          className="pointer-events-none absolute -top-6 z-10 -translate-x-1/2 rounded-md bg-white px-1.5 py-0.5 text-[10px] font-semibold tracking-tight text-black shadow-lg"
          style={{ left: `${hoverPos * 100}%` }}
        >
          {formatTime(hoverPos * duration)}
        </div>
      )}
    </div>
  );
}