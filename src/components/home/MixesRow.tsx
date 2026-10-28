import { Play } from "lucide-react";
import { Shelf } from "@/components/core/shelf";
import { Sparkles } from "lucide-react";
import { mixCover, type Mix } from "@/lib/mixes";
import { cn } from "@/lib/utils";

/**
 * The "Your Mixes" row on Home.
 *
 * A mix is NOT a track or an album: it is a standing, revisable set. Each tile
 * therefore reads as a mix — the mix's cover face behind it, the mix name and
 * a real track count — rather than as a song card in a different hat.
 *
 * Cover art: a mix does not have a release. Its face is the opening track's
 * artwork, so a mix with enough tracks always shows a real cover; mixes whose
 * opener has no thumbnail fall back to a private mixed-media gradient instead of
 * a stock app image. Two mixes must never share the same face.
 */
export function MixesRow({
  mixes,
  onPlay,
}: {
  mixes: Mix[];
  onPlay: (mix: Mix) => void;
}) {
  if (mixes.length === 0) return null;

  return (
    <Shelf
      id="shelf-mixes"
      title="Your Mixes"
      subtitle="Personalised sets that keep evolving as you listen"
      icon={<Sparkles className="size-4 text-[rgb(var(--tint))]" />}
    >
      {mixes.map((mix) => {
        const opener = mix.items[0];
        /** The real cover when the mix's opener actually has one. */
        const coverUrl = opener?.thumbnail ?? "";
        /** When the opener has no artwork, build a unique face from the mix's
            own gradient plus a deterministic but not globally-duplicated fill. */
        const fallbackFrom = mix.cardFrom ?? mix.accent ?? "from-black/40 to-transparent";
        return (
          <button
            key={mix.id}
            type="button"
            onClick={() => onPlay(mix)}
            className="group relative flex aspect-square w-36 shrink-0 snap-start flex-col justify-end overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.03] p-3 text-left transition-all hover:-translate-y-0.5 hover:border-[rgb(var(--tint)_/_0.35)] focus-visible:ring-2 focus-visible:ring-[rgb(var(--tint))] focus-visible:outline-none sm:w-40 lg:w-44"
            aria-label={`Play ${mix.name}`}
          >
            {coverUrl ? (
              <img
                src={coverUrl}
                alt=""
                loading="lazy"
                className="absolute inset-0 size-full object-cover opacity-45 transition-transform duration-500 group-hover:scale-105"
              />
            ) : (
              /* No opener art: the mix gets its own face, not a shared app
                  asset. Deterministic rotation keeps neighbours from being
                  identical. */
              <span
                className={cn(
                  "absolute inset-0 overflow-hidden bg-black/40 bg-[length-[400%_400%]] bg-[center_top_left] before:-z-10 before:absolute before:inset-0 before:bg-black/45 before:blur-[14px] before:content-[''] before:scale-150",
                  fallbackFrom,
                  mix.id === "favorites"
                    ? "before:bg-[radial-gradient(circle_at_25%_20%,rgb(244_63_94/0.7),transparent_60%)]"
                    : mix.id === "on_repeat"
                      ? "before:bg-[radial-gradient(circle_at_75%_25%,rgb(var(--tint)/0.75),transparent_55%)]"
                      : mix.id === "recent"
                        ? "before:bg-[radial-gradient(circle_at_50%_70%,rgb(34_211_238/0.8),transparent_60%)]"
                        : mix.id === "sound_alike"
                          ? "before:bg-[radial-gradient(circle_at_30%_15%,rgb(139_92_246/0.75),transparent_55%)]"
                          : mix.id === "discovery"
                            ? "before:bg-[radial-gradient(circle_at_70%_80%,rgb(5_150_105/0.8),transparent_60%)]"
                            : mix.id === "new_music"
                              ? "before:bg-[radial-gradient(circle_at_40%_85%,rgb(245_158_11/0.8),transparent_58%)]"
                              : "before:bg-[radial-gradient(circle_at_50%_50%,rgb(14_165_233/0.7),transparent_60%)]",
                )}
              />
            )}
            <span
              className={cn(
                "pointer-events-none absolute inset-0 bg-gradient-to-t",
                mix.accent,
              )}
            />
            <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-black/25 to-transparent" />

            {/* Press-to-play, revealed on hover/focus so the tile stays clean. */}
            <span className="absolute right-3 top-3 flex size-9 translate-y-1 items-center justify-center rounded-full bg-[rgb(var(--tint))] text-black opacity-0 transition-all duration-200 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100">
              <Play className="size-4 translate-x-[1px] fill-current" />
            </span>

            <span className="relative text-sm font-semibold text-foreground drop-shadow">
              {mix.name}
            </span>
            <span className="relative mt-0.5 text-[10px] text-white/70">
              {mix.items.length} tracks
            </span>
          </button>
        );
      })}
    </Shelf>
  );
}
