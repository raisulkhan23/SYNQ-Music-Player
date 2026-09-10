import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { usePlayerStore } from "@/store/player";
import { Volume1, Volume2, VolumeX } from "lucide-react";

export function VolumeControl({ className }: { className?: string }) {
  const volume = usePlayerStore((s) => s.volume);
  const muted = usePlayerStore((s) => s.muted);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const toggleMute = usePlayerStore((s) => s.toggleMute);

  const Icon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <button
        type="button"
        onClick={toggleMute}
        aria-label={muted ? "Unmute" : "Mute"}
        className="rounded-full p-1.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        <Icon className="size-4" />
      </button>
      <Slider
        aria-label="Volume"
        value={[muted ? 0 : volume]}
        min={0}
        max={1}
        step={0.01}
        onValueChange={([v]) => {
          if (muted) toggleMute();
          setVolume(v);
        }}
        className="w-20 sm:w-24"
      />
    </div>
  );
}