import { PlayCircle } from "@/components/player/PlayCircle";
import type { Mix } from "@/lib/catalog";
import { tracksByIds } from "@/lib/catalog";
import { formatTime } from "@/lib/format";
import { usePlayerStore } from "@/store/player";

export function MixCard({ mix }: { mix: Mix }) {
  const playTrack = usePlayerStore((s) => s.playTrack);
  const tracks = tracksByIds(mix.trackIds);
  const total = tracks.reduce((sum, t) => sum + t.duration, 0);

  if (tracks.length === 0) return null;

  const play = () => playTrack(tracks[0], tracks);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={play}
      onKeyDown={(e) => {
        if (e.key === "Enter") play();
      }}
      className="group relative flex h-24 w-full shrink-0 cursor-pointer items-center gap-4 overflow-hidden rounded-xl p-4 transition-transform duration-200 hover:scale-[1.015] sm:w-[420px]"
    >
      <div
        className="absolute inset-0 transition-transform duration-500 group-hover:scale-110"
        style={{
          background: `linear-gradient(120deg, ${mix.gradient[0]}, ${mix.gradient[1]})`,
        }}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/10 to-transparent" />
      <div className="relative min-w-0 flex-1">
        <p className="truncate font-display text-base font-semibold">{mix.title}</p>
        <p className="mt-0.5 truncate text-xs text-white/75">{mix.description}</p>
        <p className="mt-1 text-[11px] font-medium text-white/55">
          {tracks.length} tracks · {formatTime(total)}
        </p>
      </div>
      <PlayCircle
        size="sm"
        className="relative z-10 mr-1 shrink-0 translate-y-2 opacity-0 transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          play();
        }}
      />
    </div>
  );
}