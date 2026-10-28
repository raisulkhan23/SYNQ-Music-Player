import { Slider } from "@/components/ui/slider";
import {
  DEFAULT_CARD_TRANSPARENCY,
  MAX_CARD_TRANSPARENCY,
  MIN_CARD_TRANSPARENCY,
} from "@/lib/cardTransparency";
import { usePlayerStore } from "@/store/player";
import { Blend } from "lucide-react";

/**
 * Settings → Appearance control for how see-through the glass surfaces are.
 * The value is applied as CSS custom properties, so every card, panel and
 * surface updates live without a re-render.
 */
export function CardTransparencySection() {
  const cardTransparency = usePlayerStore((s) => s.cardTransparency);
  const setCardTransparency = usePlayerStore((s) => s.setCardTransparency);
  const liquidGlass = usePlayerStore((s) => s.liquidGlass);

  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Card transparency</p>
          <p className="text-xs text-muted-foreground">
            Slide to make every card and panel more or less see-through
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="text-xs tabular-nums text-muted-foreground">
            {cardTransparency}%
          </span>
          <Blend className="size-4 text-[rgb(var(--tint))]" />
        </div>
      </div>
      <Slider
        value={[cardTransparency]}
        min={MIN_CARD_TRANSPARENCY}
        max={MAX_CARD_TRANSPARENCY}
        step={2}
        onValueChange={([value]) =>
          setCardTransparency(value ?? DEFAULT_CARD_TRANSPARENCY)
        }
        className="mt-2"
        aria-label="Card transparency"
      />
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>Solid</span>
        <span>See-through</span>
      </div>
      {!liquidGlass && (
        <p className="mt-1.5 text-[11px] text-muted-foreground/80">
          Turn Liquid glass back on to see this take effect.
        </p>
      )}
    </div>
  );
}
