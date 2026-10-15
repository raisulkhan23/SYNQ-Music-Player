import { Slider } from "@/components/ui/slider";
import { DEFAULT_EXPLORATION, buildTuning } from "@/lib/recommend";
import { usePlayerStore } from "@/store/player";
import { Compass } from "lucide-react";

/**
 * Settings → Recommendations control: how adventurous the engine should be.
 *
 * It tunes real behaviour, not a label: the value is sent to the same
 * recommendation actions that power both the Home shelves and autoplay, where
 * it scales the discovery bonus on unknown artists, the familiarity nudge on
 * known ones, how many candidate seeds are spent on discovery, and how hard
 * repeated artists are penalised.
 *
 * The label under the slider is derived from the tuning profile rather than
 * written by hand, so the description can never drift from what the number
 * actually does.
 */
export function ExplorationSection() {
  const exploration = usePlayerStore((s) => s.exploration);
  const setExploration = usePlayerStore((s) => s.setExploration);

  const tuning = buildTuning(exploration);

  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Discover new music</p>
          <p className="text-xs text-muted-foreground">
            {describe(exploration, tuning)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="text-xs tabular-nums text-muted-foreground">
            {exploration}%
          </span>
          <Compass className="size-4 text-[rgb(var(--tint))]" />
        </div>
      </div>
      <Slider
        value={[exploration]}
        min={0}
        max={100}
        step={5}
        onValueChange={([value]) =>
          setExploration(value ?? DEFAULT_EXPLORATION)
        }
        className="mt-2"
        aria-label="Discover new music"
      />
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>Stay close</span>
        <span>Surprise me</span>
      </div>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground/80">
        SYNQ also adapts this on its own: if you skip what it suggests, it eases
        toward music you already like, and if you finish and replay it, it opens
        up more discovery — never more than a small nudge from your setting.
      </p>
      {exploration === DEFAULT_EXPLORATION ? (
        <button
          type="button"
          onClick={() => setExploration(DEFAULT_EXPLORATION)}
          className="mt-1.5 text-[11px] font-semibold text-[rgb(var(--tint))] hover:underline"
        >
          Reset to balanced
        </button>
      ) : null}
    </div>
  );
}

/**
 * Plain-language description of the current setting.
 *
 * Banded rather than continuous on purpose: "you're mostly hearing artists you
 * know" is useful, a percentage readout of an internal weight is not.
 */
function describe(exploration: number, tuning: ReturnType<typeof buildTuning>) {
  if (exploration <= 15) {
    return "Stays close to the artists you already play";
  }
  if (exploration <= 40) {
    return "Mostly your favourites, with the occasional new face";
  }
  if (exploration <= 60) {
    return "A balance of what you love and what you haven't heard";
  }
  if (exploration <= 85) {
    return "Leans adventurous — more unfamiliar artists and albums";
  }
  void tuning;
  return "Maximum discovery — expect to meet artists you've never played";
}
