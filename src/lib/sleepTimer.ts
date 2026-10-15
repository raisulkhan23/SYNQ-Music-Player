import { useEffect, useState } from "react";

/**
 * What the listener picked for the sleep timer.
 *
 * `song-end` and `queue-end` are MODES, not durations: they stop at a musical
 * boundary rather than at a wall-clock instant, which is what someone actually
 * wants when they fall asleep — the end of the song, or the end of the album
 * they queued, not "three minutes into the next one". A number is a countdown
 * in minutes.
 */
export type SleepSelection = "off" | "song-end" | "queue-end" | number;

/** The three store fields a choice resolves to. */
export interface SleepPlan {
  /** Epoch ms when playback should stop, or null for a boundary mode. */
  endsAt: number | null;
  /** Stop once the current song finishes. */
  atSongEnd: boolean;
  /** Stop once the queue runs dry instead of autoplaying more music. */
  atQueueEnd: boolean;
}

/** The longest a countdown may be, so a bad value can't arm a multi-day timer. */
export const MAX_SLEEP_MINUTES = 24 * 60;

/**
 * Resolve a selection into the store fields, as a pure function.
 *
 * The store used to branch on the raw value inline, which is why adding a mode
 * meant touching several `else` branches at once and could easily leave a stale
 * flag set (arming "queue end" after "song end" must clear the song flag, for
 * instance). Folding the whole decision into one testable function removes that
 * class of bug: every plan explicitly states all three fields.
 */
export function planSleep(
  selection: SleepSelection,
  now: number = Date.now(),
): SleepPlan {
  if (selection === "song-end") {
    return { endsAt: null, atSongEnd: true, atQueueEnd: false };
  }
  if (selection === "queue-end") {
    return { endsAt: null, atSongEnd: false, atQueueEnd: true };
  }
  if (selection === "off") {
    return { endsAt: null, atSongEnd: false, atQueueEnd: false };
  }
  const minutes =
    typeof selection === "number" && Number.isFinite(selection) && selection > 0
      ? Math.min(MAX_SLEEP_MINUTES, Math.round(selection))
      : 0;
  if (minutes <= 0) {
    return { endsAt: null, atSongEnd: false, atQueueEnd: false };
  }
  return {
    endsAt: now + minutes * 60_000,
    atSongEnd: false,
    atQueueEnd: false,
  };
}

/**
 * Sleep-timer countdown, shared by every surface that shows it.
 *
 * It lived inside the fullscreen player, which meant the timer was invisible
 * everywhere else: on a phone the bar is the only chrome most of the time, so
 * a listener who armed a 30-minute timer had no way to see it counting down or
 * cancel it without opening the fullscreen view.
 */

/** `4:07`, or `9s` under a minute — a timer has to read at a glance. */
export function formatRemaining(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

/**
 * A ticking `Date.now()` while a timer is armed, and a frozen one otherwise.
 *
 * Ticks on a 1s interval rather than aligning to the second boundary: the
 * label rounds to whole seconds anyway, and a per-second `setTimeout` chain
 * that reschedules itself keeps a timer running forever in a background tab.
 */
export function useSleepCountdown(sleepEndsAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (sleepEndsAt === null) return;
    // No synchronous `setNow` here: it would be a second render pass on every
    // arm/cancel, and `now` is at most one tick stale without it.
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [sleepEndsAt]);

  return now;
}
