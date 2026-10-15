/**
 * Smart intro trimming.
 *
 * Cinematic uploads (visualisers, lyric videos, extended mixes) routinely open
 * with 30–60 seconds of a near-silent or barely-there lead-in before the track
 * proper starts. That dead time is a real usability problem: the user pressed
 * play on a 4-minute song and nothing happens for a minute.
 *
 * The fix is to watch the actual signal level while the first seconds play and
 * seek past the lead-in once real audio has clearly arrived. Two properties
 * make this safe rather than annoying:
 *
 * 1. It only ever looks at the first `maxSkipSeconds` of a track, and never
 *    skips more than that, so a loud second half of an ambient piece can never
 *    cause a jump.
 * 2. It requires the level to hold above a threshold for `sustainSeconds`
 *    before committing. A single spike — a door slam, a breath, a fade — is
 *    not a track start.
 *
 * Everything in this module is pure so the decision is unit-testable without
 * an audio device; the sampling and seeking live elsewhere.
 */

export interface IntroSample {
  /** Seconds into the track. */
  t: number;
  /** RMS level 0..1 as reported by the Web Audio analyser. */
  level: number;
}

export interface IntroTrimOptions {
  /** Hard ceiling on the skip. Also how long the probe watches. */
  maxSkipSeconds: number;
  /** Below this a seek isn't worth the disruption. */
  minSkipSeconds: number;
  /**
   * A sample must be at least this many times the track's own noise floor to
   * count as content. Relative, so it works at any master volume.
   */
  loudnessRatio: number;
  /** How long the content must hold to be believed. */
  sustainSeconds: number;
  /**
   * Seconds of the very start to ignore. Stream priming and container start-up
   * routinely emit a click or a partial frame that is neither silence nor
   * music, and trimming on that produces a pointless 0.2s jump.
   */
  headSeconds: number;
}

export const DEFAULT_INTRO_TRIM_OPTIONS: IntroTrimOptions = {
  maxSkipSeconds: 60,
  minSkipSeconds: 8,
  loudnessRatio: 4,
  sustainSeconds: 1.5,
  headSeconds: 1.5,
};

/**
 * Absolute silence bar for the analyser's RMS output. Matches the threshold
 * the player already uses to prove audio is flowing through the EQ chain, so
 * "audible" means the same thing in both places.
 */
export const SILENCE_FLOOR = 0.004;

/** How often the probe samples the analyser. */
export const INTRO_SAMPLE_INTERVAL_MS = 250;

/** Default jump for the manual control, which has no level data to work from. */
export const DEFAULT_MANUAL_INTRO_SKIP = 30;

/** Quantile of a numeric array, 0..1. Used to find the noise floor. */
function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * q)),
  );
  return sorted[idx] ?? 0;
}

/**
 * Decide how far into a track to seek, in seconds. 0 means "leave it alone".
 *
 * Returns 0 whenever the evidence is thin — too few samples, an already-loud
 * start, content that never arrives inside the probe window, or a lead-in
 * shorter than `minSkipSeconds`. Being conservative is the point: a needless
 * seek is a worse bug than a missed trim.
 */
export function detectIntroEnd(
  samples: IntroSample[],
  options: Partial<IntroTrimOptions> = {},
): number {
  const opts = { ...DEFAULT_INTRO_TRIM_OPTIONS, ...options };
  if (samples.length < 4) return 0;

  const usable = samples
    .filter((s) => s.t >= opts.headSeconds && s.t <= opts.maxSkipSeconds)
    .sort((a, b) => a.t - b.t);
  if (usable.length < 4) return 0;

  // The noise floor is the quiet fifth of the window. Using the minimum would
  // make a single digital-silence frame drag the whole threshold to zero and
  // then every sample would read as "content".
  const floor = quantile(
    usable.map((s) => s.level),
    0.2,
  );
  const threshold = Math.max(
    SILENCE_FLOOR,
    floor * opts.loudnessRatio,
    floor + (0.02 - floor) * 0.25,
  );

  // Walk forward looking for the first run of audible samples that holds long
  // enough to be the real start of the track. A run that is already in progress
  // at the first considered sample means the track opens loud — never trim.
  let runStart: number | null = null;
  for (const sample of usable) {
    if (sample.level >= threshold) {
      if (runStart === null) runStart = sample.t;
      if (sample.t - runStart >= opts.sustainSeconds) break;
    } else {
      runStart = null;
    }
  }
  if (runStart === null) return 0;

  const skip = runStart;
  // Audio was already present before the probe had a chance to look: not an
  // intro, so leave the track alone.
  if (skip < opts.headSeconds) return 0;
  if (skip < opts.minSkipSeconds) return 0;
  return Math.min(skip, opts.maxSkipSeconds);
}

/** Human summary of a skip, e.g. 72 → "1m 12s". */
export function formatSkipped(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total}s`;
  const mins = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${mins}m` : `${mins}m ${rest}s`;
}

/**
 * Clamp a user-entered or preset manual skip into something playable.
 * The ceiling is the lower of the max-skip cap and the track's own length, so
 * the control can never park the playhead past the end of a short song.
 */
export function clampIntroSkip(
  seconds: number,
  duration: number,
  options: Partial<IntroTrimOptions> = {},
): number {
  const opts = { ...DEFAULT_INTRO_TRIM_OPTIONS, ...options };
  if (!Number.isFinite(seconds)) return 0;
  const cap = Math.min(opts.maxSkipSeconds, Math.max(0, duration - 1));
  return Math.max(0, Math.min(Math.round(seconds), cap));
}
