/**
 * Card transparency control (Settings → Appearance).
 *
 * The slider stores a single 0–80 "transparency" value. The actual glass
 * opacities are derived from it and written to CSS custom properties, so every
 * glass surface updates instantly without a React re-render.
 */

export const CARD_TRANSPARENCY_KEY = "ss.cardTransparency";
export const MIN_CARD_TRANSPARENCY = 0;
export const MAX_CARD_TRANSPARENCY = 80;
export const DEFAULT_CARD_TRANSPARENCY = 32;

export function clampCardTransparency(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CARD_TRANSPARENCY;
  return Math.min(
    MAX_CARD_TRANSPARENCY,
    Math.max(MIN_CARD_TRANSPARENCY, Math.round(value)),
  );
}

export function readCardTransparency(): number {
  if (typeof localStorage === "undefined") return DEFAULT_CARD_TRANSPARENCY;
  const stored = localStorage.getItem(CARD_TRANSPARENCY_KEY);
  if (stored === null) return DEFAULT_CARD_TRANSPARENCY;
  return clampCardTransparency(Number(stored));
}

/**
 * Writes the derived opacities. The surfaces intentionally sit at different
 * alphas (cards 68%, app chrome 52%, settings 58%), so each one is scaled from
 * the same slider instead of being flattened to a single value.
 * Returns the clamped value so callers can store what was actually applied.
 */
export function applyCardTransparency(transparency: number): number {
  const value = clampCardTransparency(transparency);
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    const alpha = 100 - value;
    root.style.setProperty("--ui-card-alpha", `${alpha}%`);
    root.style.setProperty("--ui-panel-alpha", `${Math.round(alpha * 0.76)}%`);
    root.style.setProperty(
      "--ui-settings-alpha",
      `${Math.round(alpha * 0.85)}%`,
    );
  }
  return value;
}
