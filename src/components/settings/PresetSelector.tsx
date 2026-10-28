import { useMemo, useState, useEffect } from "react";
import { Sparkles, Palette, Check, Moon, Cloud, Sun, Monitor, Zap } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type PresetId,
  type PresetMeta,
  PRESET_BY_ID,
  PRESETS,
  presetsByCategory,
  type PresetCategory,
  type PresetTokens,
} from "@/lib/presets";

/**
 * A compact preset picker for Settings → Appearance.
 *
 * It does not own accent / themeMode / trackPalettes / wallpaper. It only sets
 * the compact preset id and, when a preset ships a scene or tint, the
 * coordinated CSS tokens the rest of the app already reads. Preset switching
 * therefore never resets playback, the queue, or account state — it is a CSS
 * surface switch plus a small number of coordinated accent tokens.
 */
export function PresetSelector() {
  const [category, setCategory] = useState<PresetCategory>("Recommended");
  const [groups] = useState(() => presetsByCategory());

  // Keep the selected row in sync with the session stored preset id once the
  // first render has read it. The picker is a UI layer; persistence is owned
  // by the same localStorage keys the store reads.
  const storedId = useMemo(() => {
    try {
      return localStorage.getItem("ss.presetId") as PresetId | null;
    } catch {
      return null;
    }
  }, []);

  // When a preset is already stored, keep the picker in sync after the first
  // render without re-choosing on every key press.
  const [activeId, setActiveId] = useState<PresetId | null>(storedId);

  useEffect(() => {
    if (storedId && activeId !== storedId) {
      setActiveId(storedId);
    }
  }, [storedId]);

  const selectedMeta = activeId ? PRESET_BY_ID[activeId] : null;

  const applyPreset = (preset: PresetMeta) => {
    setActiveId(preset.id);
    try {
      localStorage.setItem("ss.presetId", preset.id);
    } catch {
      /* storage unavailable; the picker stays usable */
    }
    applyTokens(preset.id);
  };

  const toggleCategory = (next: PresetCategory) => {
    setCategory(next);
  };

  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] p-3.5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Theme & personalization</p>
          <p className="text-xs text-muted-foreground">
            Pick an atmosphere, then keep the controls you like.
          </p>
        </div>
        <Sparkles className="size-4 text-[rgb(var(--tint))]" />
      </div>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {[
          Palette,
          Sparkles,
          Moon,
          Sun,
          Cloud,
          Monitor,
          Zap,
        ].map((Icon, index) => {
          const label =
            [
              "Recommended",
              "SYNQ Originals",
              "Cinematic",
              "Seasonal",
              "Minimal",
              "Colorful",
              "Mood",
            ][index] ?? "";
          return (
            <button
              key={label}
              type="button"
              onClick={() => toggleCategory(label as PresetCategory)}
              aria-pressed={category === label}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-widest transition-colors",
                category === label
                  ? "border-[rgb(var(--tint))] bg-[rgb(var(--tint)_/_0.14)] text-[rgb(var(--tint))]"
                  : "border-white/10 text-muted-foreground hover:border-white/30 hover:text-foreground",
              )}
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {groups
          .find((g) => g.category === category)
          ?.presets.map((preset) => {
            const meta = preset;
            return (
              <PresetCard
                key={meta.id}
                meta={meta}
                selected={activeId === meta.id}
                onSelect={() => applyPreset(meta)}
              />
            );
          })}
      </div>

      {selectedMeta && (
        <div className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
          <Check className="size-3.5 shrink-0 text-emerald-300/80" />
          <span className="truncate">
            {selectedMeta.name} — {selectedMeta.tagline}
          </span>
        </div>
      )}
    </div>
  );
}

interface PresetCardProps {
  meta: PresetMeta;
  selected: boolean;
  onSelect: () => void;
}

function PresetCard({ meta, selected, onSelect }: PresetCardProps) {
  const preview = useMemo(() => {
    const rgba = (value: string, alpha = 1) =>
      `rgb(${value} / ${alpha})`;
    const swatch = meta.preview ?? "203 244 143";
    // A minimal face: depth, surface glass, accent glow. Enough to signal
    // the preset without shipping a wallpapers pack.
    return (
      <span
        className="absolute inset-0 size-full rounded-xl"
        style={{
          background: `
            radial-gradient(70% 60% at 50% 0%, ${rgba(swatch, 0.12)}, transparent 72%),
            radial-gradient(90% 70% at 50% 80%, ${rgba(swatch, 0.05)}, transparent 70%),
            ${rgba(swatch, 0.0)}
          `,
        }}
      >
        <span
          className="absolute inset-0 rounded-xl"
          style={{
            background: `color-mix(in oklab, ${rgba(swatch, 1)} 14%, transparent)`,
          }}
        />
        <span
          className="absolute bottom-2 left-2 right-2 h-1 rounded-full"
          style={{
            background: `linear-gradient(90deg, transparent, ${rgba(swatch, 0.7)} 40%, ${rgba(swatch, 0.7)} 60%, transparent)`,
          }}
        />
      </span>
    );
  }, [meta]);

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "group relative flex flex-col gap-2 rounded-xl border p-3 text-left transition-all",
        selected
          ? "border-[rgb(var(--tint))] bg-white/[0.06] text-foreground shadow-[0_0_0_1px_rgba(var(--tint)/0.25)]"
          : "border-white/[0.08] bg-white/[0.03] text-muted-foreground hover:border-white/25 hover:text-foreground",
      )}
    >
      {/* Preview face */}
      <span className="relative flex aspect-video w-full overflow-hidden rounded-lg">
        {preview}
        <span className="absolute inset-0 rounded-lg ring-1 ring-inset ring-white/10" />
        <span
          className="absolute left-2 top-2 flex size-3 rounded-full ring-1 ring-white/20"
          style={{ background: `rgb(${meta.preview ?? "203 244 143"})` }}
        />
      </span>

      <span className="text-sm font-semibold leading-tight">{meta.name}</span>
      <span className="truncate text-[10px] text-muted-foreground leading-snug">
        {meta.tagline}
      </span>

      {selected ? (
        <span className="pointer-events-none absolute right-2 top-2 flex size-5 items-center justify-center rounded-full bg-[rgb(var(--tint))] text-black">
          <Check className="size-3" />
        </span>
      ) : null}
    </button>
  );
}

/** Write the tokens the rest of the app reads. */
function applyTokens(presetId: PresetId): void {
  const tokens = tokenContribution(presetId);
  applyPresetTokens(tokens);
}

/** Read the compact preset contribution for a given id. */
function tokenContribution(presetId: PresetId): PresetTokens {
  const preset = PRESET_BY_ID[presetId];
  if (!preset) return {};
  return {
    presetId: preset.id,
    scene: preset.scene,
    tint: preset.tint,
    calm: preset.calm ?? false,
  };
}

/** Apply a preset token contribution to the DOM surfaces the app already reads. */
function applyPresetTokens(tokens: PresetTokens): void {
  const root = document.documentElement;
  if (tokens.scene) {
    root.dataset.scene = tokens.scene;
  }
  if (tokens.tint) {
    root.style.setProperty("--tint", tokens.tint);
  }
  if (tokens.calm) {
    root.dataset.calm = "";
  } else {
    root.removeAttribute("data-calm");
  }
  // Fire the scene change event so the shell and any listener can sync derived
  // state without a full re-render of playback.
  window.dispatchEvent(
    new CustomEvent("synq:scene-change", { detail: tokens.scene ?? "" }),
  );
}
