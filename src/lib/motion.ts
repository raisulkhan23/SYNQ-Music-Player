/**
 * Animation budget — the one place that decides how much motion SYNQ uses.
 *
 * THREE LEVELS, and the difference between them is real:
 *
 *  - `full`    — every transition, sheen, parallax and spring as designed.
 *  - `reduced` — decorative motion is calmed: long transitions are shortened,
 *                infinite ambient animations (drifting aurora, marquee, the
 *                glass sheen) are paused, and large entrance transforms are
 *                dropped. Short feedback (a hover tint, a 150ms fade) stays,
 *                because removing it makes the app feel broken rather than
 *                calm.
 *  - `off`     — non-essential motion is removed outright. This is the same
 *                contract as the OS "reduce motion" preference, and it is the
 *                level that ALSO has to reach framer-motion: the library drives
 *                its animations from JavaScript, so a CSS rule cannot stop it
 *                (`MotionConfig reducedMotion="always"` is the supported hook).
 *
 * WHY A MODULE AND NOT JUST A STORE FIELD. The level has to be applied before
 * the first paint (a returning user must never see one frame of full motion)
 * and it is read from three places — boot, the store, and the settings UI. A
 * tiny pure applier is what keeps those three from each inventing their own
 * class names and drifting apart.
 *
 * The legacy `ss.reduceMotion` boolean is deliberately still written: it is the
 * key the old toggle used, and leaving it in step means nothing that still
 * reads it silently disagrees with the new control.
 */

export type AnimationLevel = "full" | "reduced" | "off";

export const ANIMATION_LEVELS: readonly AnimationLevel[] = [
  "full",
  "reduced",
  "off",
];

export const ANIMATION_LEVEL_KEY = "ss.animationLevel";
/** The older boolean the Reduce-motion toggle persisted. Kept in step. */
export const LEGACY_REDUCE_MOTION_KEY = "ss.reduceMotion";

export function isAnimationLevel(value: unknown): value is AnimationLevel {
  return value === "full" || value === "reduced" || value === "off";
}

/**
 * The stored level, with a migration from the older boolean.
 *
 * Exported because BOTH boot and the store need the same answer, and a second
 * copy of this logic is exactly how "it resets on reload" bugs are born.
 */
export function readAnimationLevel(): AnimationLevel {
  try {
    const saved = localStorage.getItem(ANIMATION_LEVEL_KEY);
    if (isAnimationLevel(saved)) return saved;
    if (localStorage.getItem(LEGACY_REDUCE_MOTION_KEY) === "1") return "off";
  } catch {
    // Storage can be unavailable (private mode, blocked cookies) — default
    // to full motion rather than throwing during boot.
  }
  return "full";
}

/**
 * Reflect the level onto `<html>`.
 *
 * `reduce-motion` is the existing, already-styled class that collapses every
 * animation to ~0ms, so it is REUSED for `off` rather than duplicated.
 * `data-motion` carries the level for the cheaper `reduced` rules, which need
 * to distinguish "calm this" from "remove this".
 */
export function applyAnimationLevel(level: AnimationLevel): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.motion = level;
  root.classList.toggle("reduce-motion", level === "off");
  // The legacy boolean is mirrored so anything still reading it agrees.
  try {
    localStorage.setItem(LEGACY_REDUCE_MOTION_KEY, level === "off" ? "1" : "0");
  } catch {
    // Storage unavailable; the class above is what actually matters.
  }
}

/** Human labels and descriptions for the settings control. */
export const ANIMATION_LEVEL_META: Record<
  AnimationLevel,
  { label: string; description: string }
> = {
  full: {
    label: "Full",
    description: "Every transition and ambient effect as designed",
  },
  reduced: {
    label: "Reduced",
    description: "Calmer motion — ambient drift pauses, transitions shorten",
  },
  off: {
    label: "Off",
    description: "Motion removed, keeping only the feedback you need to use it",
  },
};
