import type { Track } from "@/lib/catalog";
import { usePlayerStore } from "@/store/player";
import { Play } from "lucide-react";

export function PlayHeaderButton({
  list,
  label = "Play",
}: {
  list: Track[];
  label?: string;
}) {
  const playTrack = usePlayerStore((s) => s.playTrack);
  if (list.length === 0) return null;
  return (
    <button
      type="button"
      onClick={() => playTrack(list[0], list)}
      className="flex shrink-0 items-center gap-2 rounded-full bg-[rgb(var(--tint))] px-5 py-2.5 text-sm font-semibold text-black shadow-[0_8px_30px_rgb(var(--tint)/0.35)] transition-all hover:scale-[1.03] active:scale-95"
    >
      <Play className="size-4 fill-current" />
      {label}
    </button>
  );
}