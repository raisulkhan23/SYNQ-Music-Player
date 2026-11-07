// ---------------------------------------------------------------------------
// Song transition decisions — pure, no DOM, no store, no engine.
//
// Everything about *whether* a song should crossfade, gapless-play or cut
// abruptly is decided here so it can be unit tested without a browser, a
// Web Audio context or a running queue. `src/store/player.ts` owns the audio
// and asks this module what to do; it never re-derives the rules itself.
//
// Why a separate module at all: the transition rules are the part most likely
// to regress quietly. "Repeat one must never crossfade" or "an A-B loop must
// not be interrupted" are one-line guards that are invisible in a 3,700-line
// store, so they live here with tests next to them.
// ---------------------------------------------------------------------------

/** User-selectable crossfade lengths, in seconds. 0 means off. */
export const CROSSFADE_CHOICES = [0, 2, 4, 6, 8, 10] as const;

/**
 * Default is 0 (off). A crossfade is an opinionated listening choice — it
 * overlaps two songs and hides the outro of one — so it must be opted into,
 * not inflicted. Gapless is the default because removing a *gap* is not the
 * same as blending anything: it just stops inventing silence that was never
 * in the recording.
 */
export const DEFAULT_CROSSFADE = 0;

/** Gapless removes artificial silence; it never overlaps two songs. */
export const DEFAULT_GAPLESS = true;

/**
 * Manual skips get a much shorter blend than an automatic one. Asking for the
 * next song means "play it now", so a long crossfade would make the control
 * feel broken — you press Next and then wait several seconds for the song you
 * asked for.
 */
export const MANUAL_SKIP_FADE_SECONDS = 0.9;

/**
 * Longest fade we will ever run. Beyond this two songs overlap for so long
 * that listeners report it as the previous song "still playing", and on a slow
 * connection the incoming stream may not have buffered that far in.
 */
export const MAX_FADE_SECONDS = 12;

/**
 * Don't crossfade across most of a very short clip (an intro sting, a 20s
 * skit). Overlapping half of a short track destroys it rather than smoothing
 * it, so short tracks cut normally.
 */
export const MIN_TRACK_FOR_FADE_SECONDS = 30;

/**
 * Ceiling on the pre-roll. The incoming track has to have loaded by the time
 * the fade starts; resolving a stream and buffering takes real time, so a very
 * long crossfade would begin on silence. Above this we shorten the fade rather
 * than start it early enough that the listener notices the last chorus missing.
 */
export const MAX_PREP_SECONDS = 20;

/** How long before the fade begins we start preparing the next track. */
export const PRELOAD_LEAD_SECONDS = 12;

/**
 * How long before a gapless boundary the next track is resolved and buffered.
 *
 * Generous, because nothing is lost by preparing early: the spare deck is
 * silent and holds no network cost until it is played. It exists to move the
 * resolver round-trip and the first bytes of the stream OUT of the gap.
 */
export const GAPLESS_PRELOAD_LEAD_SECONDS = 20;

/** Why we are transitioning. Drives the fade length and the guards. */
export type TransitionReason =
  | "track-ended"
  | "manual-next"
  | "manual-prev"
  | "autoplay";

export type TransitionMode =
  /** Overlap two songs, fading one out as the other fades in. */
  | "crossfade"
  /**
   * Start the next song at the exact moment the current one stops, with no
   * overlap. This is what an album, a live set or a DJ mix wants.
   */
  | "gapless"
  /** No transition: stop and start. The safe default when in doubt. */
  | "cut";

export interface TransitionPlan {
  mode: TransitionMode;
  /** Total transition length in seconds. 0 for `cut`. */
  seconds: number;
  /**
   * Seconds before the current track's end at which the transition begins.
   * `seconds` for a crossfade (that is the overlap), 0 for gapless/cut.
   */
  leadSeconds: number;
  reason: TransitionReason;
  /** Human-readable justification, surfaced in tests and debugging. */
  because: string;
}

export interface TransitionRequest {
  /** Configured crossfade length in seconds (0 = off). */
  crossfadeSeconds: number;
  /** Whether the listener enabled gapless playback. */
  gaplessEnabled: boolean;
  reason: TransitionReason;
  /** Duration of the track that is playing right now, in seconds. */
  currentDuration: number;
  /** How far into the current track we are, in seconds. */
  currentTime: number;
  /** Is there a next track queued at all? */
  hasNext: boolean;
  /** Both tracks must be on the <audio> element for a real crossfade. */
  canCrossfade: boolean;
  /** The next track belongs to the same album/collection as the current one. */
  sameAlbum: boolean;
  /** A-B repeat is armed and looping — never interrupt it. */
  abRepeatActive: boolean;
  /** Repeat-one restarts the same track; a transition would be wrong. */
  repeatOne: boolean;
  /** The listener paused; there is nothing to transition out of. */
  paused: boolean;
}

/** Coerce anything (storage, a stale value, NaN) into a sane crossfade length. */
export function normalizeCrossfade(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n > MAX_FADE_SECONDS) return MAX_FADE_SECONDS;
  // Sub-second fades are a click, not a crossfade. Treat anything under a
  // perceptible threshold as "off" rather than pretending to blend.
  if (n < 0.4) return 0;
  return Math.round(n * 10) / 10;
}

/** True when `seconds` is one of the offered preset lengths. */
export function isPresetCrossfade(seconds: number): boolean {
  return (CROSSFADE_CHOICES as readonly number[]).includes(seconds);
}

/**
 * Clamp a requested fade so it can never swallow the track.
 *
 * Two independent limits apply: never fade for more than half the track's own
 * length (a 20s clip with a 12s fade is 60% gone before the new song is
 * audible), and never fade for longer than we have left to play.
 */
export function clampFade(
  requested: number,
  currentDuration: number,
  remaining: number,
): number {
  let seconds = Math.min(requested, MAX_FADE_SECONDS);
  if (Number.isFinite(currentDuration) && currentDuration > 0) {
    if (currentDuration < MIN_TRACK_FOR_FADE_SECONDS) return 0;
  }
  if (Number.isFinite(remaining) && remaining > 0) {
    // Leave a sliver of the outgoing track audible so the change is a blend
    // rather than an early cut.
    seconds = Math.min(seconds, Math.max(0, remaining - 0.05));
  }
  return Math.max(0, Math.round(seconds * 100) / 100);
}

/**
 * Decide how to get from the current song to the next one.
 *
 * Order matters. The guards that must never be overridden come first (a repeat
 * or an A-B loop is the listener explicitly asking for the *same* audio), then
 * the source capability (no tappable source means no real crossfade), then the
 * context, and only then the listener's configured length.
 */
export function planTransition(req: TransitionRequest): TransitionPlan {
  const cut = (because: string): TransitionPlan => ({
    mode: "cut",
    seconds: 0,
    leadSeconds: 0,
    reason: req.reason,
    because,
  });

  // Repeat-one and A-B repeat both mean "play this again", not "move on".
  // A crossfade here would fade the track out while the repeat restarts it and
  // the listener would hear the same song twice at once.
  if (req.repeatOne) return cut("repeat-one restarts the same track");
  if (req.abRepeatActive) return cut("A-B repeat is looping a section");
  if (req.paused) return cut("playback is paused");
  if (!req.hasNext) return cut("nothing queued after this track");

  const remaining = Math.max(
    0,
    (Number.isFinite(req.currentDuration) ? req.currentDuration : 0) -
      (Number.isFinite(req.currentTime) ? req.currentTime : 0),
  );

  // Manual skips are a "now" request: blend quickly, never make the listener
  // wait out their configured crossfade. Resolved up here because the
  // album-boundary rule below now needs it.
  const requested =
    req.reason === "manual-next"
      ? Math.min(req.crossfadeSeconds, MANUAL_SKIP_FADE_SECONDS)
      : req.crossfadeSeconds;

  // Album boundaries are the artist's own transition. Overlapping two of them
  // destroys the seam they wrote, so gapless is preferred here — but an
  // EXPLICIT crossfade setting WINS.
  //
  // This used to return gapless unconditionally, which silently overrode the
  // listener: crossfade was switched on in Settings, and for any two
  // consecutive tracks that shared an album name the app quietly did
  // something else. No message, no log, no hint in the UI — so it presented as
  // "crossfade is broken", and it did so on exactly the tracks most likely to
  // be listened to together (an album, or a playlist imported from one).
  //
  // The album-seam reasoning still holds when no crossfade is configured:
  // then the boundary is preserved rather than blended.
  if (req.sameAlbum) {
    const explicit = clampFade(requested, req.currentDuration, remaining);
    if (requested > 0 && req.canCrossfade && explicit > 0) {
      return {
        mode: "crossfade",
        seconds: explicit,
        leadSeconds: explicit,
        reason: req.reason,
        because: "an explicit crossfade overrides the album-boundary rule",
      };
    }
    return req.gaplessEnabled
      ? {
          mode: "gapless",
          seconds: 0,
          leadSeconds: 0,
          reason: req.reason,
          because: "gapless keeps a continuous album boundary intact",
        }
      : cut("album boundaries are never crossfaded");
  }

  // Previous is a NAVIGATION intent, not a skip. It must never take the
  // end-of-track crossfade path: the listener asked to go back, and the
  // store's own "restart if you are past 3s" behaviour owns what happens next.
  if (req.reason === "manual-prev") {
    return cut("previous is handled by the player, not the fade path");
  }

  const wantsCrossfade = requested > 0;
  if (wantsCrossfade && req.canCrossfade) {
    const seconds = clampFade(requested, req.currentDuration, remaining);
    if (seconds > 0) {
      return {
        mode: "crossfade",
        seconds,
        leadSeconds: seconds,
        reason: req.reason,
        because:
          req.reason === "track-ended" || req.reason === "autoplay"
            ? "crossfade into the next track"
            : "short blend on a manual skip",
      };
    }
  }

  // Gapless: the next song starts exactly where this one stops. It overlaps
  // nothing, so it is the safe improvement whenever a real crossfade is not
  // on the table.
  if (req.gaplessEnabled) {
    return {
      mode: "gapless",
      seconds: 0,
      leadSeconds: 0,
      reason: req.reason,
      because: "gapless removes the silence between tracks",
    };
  }

  if (wantsCrossfade && !req.canCrossfade) {
    return cut("the current source cannot be crossfaded");
  }
  return cut("no transition configured");
}

// --- fade curves -------------------------------------------------------------

/**
 * Volume multipliers for a crossfade at normalised progress `t` (0 → 1).
 *
 * Uses an equal-power (sin/cos) curve rather than linear. Two linearly
 * crossfading tracks sum to a dip in the middle — at t=0.5 each is at half
 * volume, which is −6dB of perceived loudness, and the transition audibly
 * sags. sin/cos keeps the summed power constant, so the blend holds its level
 * all the way through.
 *
 * Returns the OUTGOING track's multiplier; the incoming is returned explicitly
 * too so the pair can never be mismatched at a call site.
 */
export function fadeGains(t: number): { outgoing: number; incoming: number } {
  const p = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  const angle = (p * Math.PI) / 2;
  return {
    outgoing: Math.cos(angle),
    incoming: Math.sin(angle),
  };
}

/**
 * True when a crossfade should begin, given where we are in the track.
 *
 * Kept separate from the scheduler so the "start at the right moment" rule can
 * be tested directly: a plan must fire exactly once, at `remaining <= lead`,
 * and never before.
 */
export function shouldStartFade(
  plan: TransitionPlan,
  remaining: number,
  lastRemaining: number | null,
): boolean {
  if (plan.mode === "cut") return false;
  if (plan.leadSeconds <= 0) return false;
  if (!Number.isFinite(remaining) || remaining < 0) return false;
  if (remaining > plan.leadSeconds) return false;
  // `timeupdate` can skip several seconds on a slow device or a buffering
  // stall. Crossing the boundary from above is what identifies the moment;
  // without it, any late poll would re-trigger the same transition.
  if (lastRemaining === null) return true;
  return lastRemaining > plan.leadSeconds;
}

/** How early to start preparing (resolving + buffering) the next track. */
export function preloadLead(plan: TransitionPlan): number {
  if (plan.mode !== "crossfade") return 0;
  return Math.min(MAX_PREP_SECONDS, plan.leadSeconds + PRELOAD_LEAD_SECONDS);
}

/**
 * True when this transition must begin IMMEDIATELY rather than when the
 * outgoing track runs down to `leadSeconds`.
 *
 * Only a manual skip qualifies. The listener has already pressed the button, so
 * the whole point of the short `MANUAL_SKIP_FADE_SECONDS` blend is that it is
 * over almost at once. Routing it through `shouldStartFade` instead — which
 * fires at `remaining <= leadSeconds` — meant a manual Next armed a plan that
 * could never satisfy its own trigger, because the track had seconds or minutes
 * left to run. The blend silently never happened.
 */
export function shouldStartNow(plan: TransitionPlan): boolean {
  if (plan.mode !== "crossfade") return false;
  if (plan.seconds <= 0) return false;
  return plan.reason === "manual-next";
}

/**
 * Earliest moment to begin preparing the next track, in seconds before the
 * end of the current one.
 *
 * Used for BOTH modes. A crossfade needs its fade window plus buffering time; a
 * gapless hand-off needs only the buffering time, because it does not overlap —
 * it just needs the stream resolved and buffered so that the `play()` at the
 * end of the track is instant. Returning 0 for gapless (which it used to do, via
 * `preloadLead`) is precisely why gapless was not implemented: nothing was ever
 * prepared before `ended`, so the hand-off had to resolve a stream mid-gap.
 */
export function prepareLead(plan: TransitionPlan): number {
  if (plan.mode === "crossfade") return preloadLead(plan);
  if (plan.mode === "gapless") return GAPLESS_PRELOAD_LEAD_SECONDS;
  return 0;
}

// --- gapless hand-off readiness ---------------------------------------------

/**
 * `HTMLMediaElement.HAVE_CURRENT_DATA`.
 *
 * A hand-off below this has nothing decoded to start, so `play()` would stall
 * mid-note — audible as a stutter, and worse than the gap gapless exists to
 * remove. Kept as a named constant because the gate below is executed by tests
 * and a bare `2` at the call site reads as a magic number.
 */
export const GAPLESS_MIN_READY_STATE = 2;

export interface GaplessReadinessRequest {
  /** The track the spare deck was prepared for, if any. */
  preparedFor: string | null;
  /** The track the hand-off intends to start. */
  trackId: string;
  /** The spare element's resolved source, if any. */
  currentSrc: string | null;
  /** The spare element's `readyState`. */
  readyState: number;
}

export type GaplessReadiness =
  | { ready: true }
  | { ready: false; because: string };

/**
 * Can the buffered spare deck be started INSTANTLY, with no gap?
 *
 * This is the whole decision a gapless hand-off rests on, lifted out of the
 * store so it can be executed directly instead of asserted as source text. It
 * used to be three nested `if`s inside `tryGaplessHandoff`, and every one of
 * them could regress without any test noticing: a track that was never
 * resolved, a resolver that answered with a non-http marker, or a buffer that
 * had not reached HAVE_CURRENT_DATA would all start the next song from a stall
 * — which sounds *worse* than the plain gap the setting was meant to remove.
 *
 * Each rejection carries its own reason so the dev trace can say WHICH of the
 * three failed rather than the old single "skipped".
 */
export function canHandOffGapless(
  req: GaplessReadinessRequest,
): GaplessReadiness {
  if (req.preparedFor !== req.trackId) {
    return { ready: false, because: "nothing preloaded" };
  }
  // `blob:` is the object URL of a downloaded copy in OPFS — as playable as
  // any network URL, and the ONLY form a downloaded track's src takes.
  // Rejecting it meant downloaded tracks could never gapless-hand-off, which
  // is the exact situation a listener's offline library lives in.
  const src = req.currentSrc ?? "";
  if (!src.startsWith("http") && !src.startsWith("blob:")) {
    return { ready: false, because: "no resolved src" };
  }
  if (!(req.readyState >= GAPLESS_MIN_READY_STATE)) {
    return { ready: false, because: "not buffered" };
  }
  return { ready: true };
}
