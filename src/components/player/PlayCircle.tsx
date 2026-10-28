import { cn } from "@/lib/utils";
import { Pause, Play } from "lucide-react";

interface PlayCircleProps {
  playing?: boolean;
  size?: "sm" | "md" | "lg";
  onClick?: (e: React.MouseEvent) => void;
  className?: string;
  label?: string;
}

const sizes = {
  sm: "size-9",
  md: "size-11",
  lg: "size-14",
};

const iconSizes = {
  sm: "size-4",
  md: "size-5",
  lg: "size-6",
};

export function PlayCircle({
  playing = false,
  size = "md",
  onClick,
  className,
  label,
}: PlayCircleProps) {
  return (
    <button
      type="button"
      aria-label={label ?? (playing ? "Pause" : "Play")}
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-[rgb(var(--tint))] text-black shadow-[0_6px_24px_rgb(var(--tint)/0.45)] transition-all duration-200 hover:scale-105 active:scale-95",
        sizes[size],
        className,
      )}
    >
      {playing ? (
        <Pause className={cn(iconSizes[size], "fill-current")} />
      ) : (
        <Play className={cn(iconSizes[size], "ml-0.5 fill-current")} />
      )}
    </button>
  );
}
