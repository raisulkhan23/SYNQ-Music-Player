/**
 * AutoMix transition planning — PURE decision logic.
 *
 * ## What this decides
 *
 * Given what we measured about two tracks (`lib/trackAnalysis`), what the
 * listener configured, and what the engine can actually do, decide whether a
 * boundary should be a **beat-aligned blend** or the ordinary crossfade — and
 * if beat-aligned, exactly when the outgoing blend starts and where the
 * incoming track begins.
 *
 * ## What this deliberately does NOT claim
 *
 * There is no tempo-matching tier here. Tempo adjustment would need a
 * pitch-preserving time-stretch we can drive on a media element; the current
 * engine plays at the listener's chosen rate, and changing it for a blend then
 * restoring it would audibly change the tempo of a song mid-play. Without that
 * capability, a transition can begin ON a beat of each track, but it is not
 * beat-matched, and this module says so in its result instead of letting the UI
 * imply otherwise. If a stretch engine is added later, `tempoMatched` and the
 * tier list are where that capability belongs.
 *
 * ## Why the fallback is explicit
 *
 * A transition that silently becomes a plain fade is indistinguishable from
 * broken AutoMix. Every refusal below carries a sentence naming the actual
 * missing evidence, so Settings can show it.
 */

import type { MixCandidate, TrackAnalysis } from "./trackAnalysis";
import type { TransitionReason } from "./transition";

export type AutoMixLevel = "conservative" | "standard" | "experimental";

export type AutoMixTier = "beat-align" | "crossfade";

export interface AutoMixConfig {
  enabled: boolean;
  level: AutoMixLevel;
  /** The listener's crossfade length; 0 means "AutoMix chooses". */
  crossfadeSeconds: number;
}

/** Per-level evidence requirements. Deliberately conservative by default. */
export const AUTOMIX_THRESHOLDS: Record<
  AutoMixLevel,
  {
    beatConfidence: number;
    bpmConfidence: number;
    stability: number;
    /** Largest allowed tempo difference for a beat-aligned blend (ratio). */
    maxTempoRatio: number;
    minBeats: number;
    maxBeats: number;
    /** Blend length used when the crossfade setting is 0. */
    defaultSeconds: number;
    /** Smallest confidence for a mix-in/mix-out candidate to be trusted. */
    candidateConfidence: number;
  }
> = {
  conservative: {
    beatConfidence: 0.7,
    bpmConfidence: 0.75,
    stability: 0.7,
    maxTempoRatio: 0.04,
    minBeats: 12,
    maxBeats: 24,
    defaultSeconds: 6,
    candidateConfidence: 0.6,
  },
  standard: {
    beatConfidence: 0.55,
    bpmConfidence: 0.6,
    stability: 0.55,
    maxTempoRatio: 0.06,
    minBeats: 8,
    maxBeats: 32,
    defaultSeconds: 5,
    candidateConfidence: 0.5,
  },
  experimental: {
    beatConfidence: 0.45,
    bpmConfidence: 0.5,
    stability: 0.4,
    maxTempoRatio: 0.09,
    minBeats: 4,
    maxBeats: 32,
    defaultSeconds: 8,
    candidateConfidence: 0.4,
  },
};

export interface AutoMixRequest {
  outgoing: TrackAnalysis | null;
  incoming: TrackAnalysis | null;
  /** Authoritative duration from the player, in seconds. */
  outgoingDuration: number;
  outgoingTime: number;
  reason: TransitionReason;
  /** Both songs must be tappable by Web Audio for any blend to be real. */
  canCrossfade: boolean;
  /** Two tracks from one album keep the artist's own seam. */
  sameAlbum: boolean;
  config: AutoMixConfig;
}

export interface AutoMixPlan {
  /**
   * false = "no opinion, run the transition the store already planned".
   * A deferred plan still carries `refusal`, which is what Settings shows.
   */
  apply: boolean;
  tier: AutoMixTier;
  /** Total blend length in seconds (0 when deferred). */
  seconds: number;
  /** Seconds before the outgoing track's end at which the blend begins. */
  leadSeconds: number;
  /** Where the incoming track should start, in seconds (0 = its start). */
  incomingStart: number;
  confidence: number;
  because: string;
  refusal?: string;
  /** Always false today — see the module header. */
  tempoMatched: boolean;
  bpm?: { outgoing: number; incoming: number };
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/** Nearest beat to `time`, or null when the grid is empty. */
export function nearestBeat(
  beats: readonly number[] | undefined,
  time: number,
  maxDistance = Infinity,
): number | null {
  if (!beats || beats.length === 0) return null;
  let best = beats[0];
  let bestDistance = Math.abs(best - time);
  for (const beat of beats) {
    const distance = Math.abs(beat - time);
    if (distance < bestDistance) {
      best = beat;
      bestDistance = distance;
    }
  }
  return bestDistance <= maxDistance ? best : null;
}

/** The last beat at or before `time`. */
export function beatAtOrBefore(
  beats: readonly number[] | undefined,
  time: number,
): number | null {
  if (!beats || beats.length === 0) return null;
  let best: number | null = null;
  for (const beat of beats) {
    if (beat <= time + 1e-6) best = beat;
    else break;
  }
  return best;
}

/** A mix point the planner is willing to use, if any. */
function trustedCandidate(
  list: readonly MixCandidate[] | undefined,
  minConfidence: number,
): MixCandidate | null {
  if (!list || list.length === 0) return null;
  const sorted = [...list].sort((a, b) => b.confidence - a.confidence);
  return sorted[0].confidence >= minConfidence ? sorted[0] : null;
}

function deferred(
  tier: AutoMixTier,
  refusal: string,
  because = "using the configured crossfade",
): AutoMixPlan {
  return {
    apply: false,
    tier,
    seconds: 0,
    leadSeconds: 0,
    incomingStart: 0,
    confidence: 0,
    because,
    refusal,
    tempoMatched: false,
  };
}

/**
 * Decide the transition.
 *
 * Deterministic for the same inputs: no clock, no randomness, no I/O. The
 * ordering of the guards is deliberate — cheap, unconditional reasons first
 * (off, wrong reason, unblendable sources), then evidence, then arithmetic.
 */
export function planAutoMix(request: AutoMixRequest): AutoMixPlan {
  const { config, outgoing, incoming, reason } = request;
  if (!config.enabled) return deferred("crossfade", "AutoMix is off");

  // A manual skip is a "play the next song NOW" request. Beat-aligning it would
  // delay the song the listener just asked for, so the short manual blend is
  // correct and AutoMix stays out of it.
  if (reason === "manual-next" || reason === "manual-prev") {
    return deferred("crossfade", "manual skips keep their short blend");
  }
  if (!request.canCrossfade) {
    return deferred(
      "crossfade",
      "these tracks cannot be blended by the audio engine",
    );
  }
  if (request.sameAlbum) {
    return deferred("crossfade", "album tracks keep their own seam");
  }
  if (!outgoing || outgoing.status === "unavailable") {
    return deferred(
      "crossfade",
      outgoing?.reason ?? "the current track has not been analysed yet",
    );
  }
  if (!incoming || incoming.status === "unavailable") {
    return deferred(
      "crossfade",
      incoming?.reason ?? "the next track has not been analysed yet",
    );
  }
  if (outgoing.status !== "ready" || incoming.status !== "ready") {
    return deferred(
      "crossfade",
      outgoing.status !== "ready"
        ? `the current track's ${outgoing.reason ?? "beat grid is unreliable"}`
        : `the next track's ${incoming.reason ?? "beat grid is unreliable"}`,
    );
  }

  const rules = AUTOMIX_THRESHOLDS[config.level];
  const bpmOut = outgoing.bpm;
  const bpmIn = incoming.bpm;
  if (!bpmOut || !bpmIn) {
    return deferred("crossfade", "no measured tempo for one of the tracks");
  }
  if (outgoing.beatConfidence < rules.beatConfidence) {
    return deferred(
      "crossfade",
      `the current track's beat grid is only ${Math.round(outgoing.beatConfidence * 100)}% confident`,
    );
  }
  if (incoming.beatConfidence < rules.beatConfidence) {
    return deferred(
      "crossfade",
      `the next track's beat grid is only ${Math.round(incoming.beatConfidence * 100)}% confident`,
    );
  }
  if (outgoing.bpmConfidence < rules.bpmConfidence) {
    return deferred("crossfade", "the current track's tempo is ambiguous");
  }
  if (incoming.bpmConfidence < rules.bpmConfidence) {
    return deferred("crossfade", "the next track's tempo is ambiguous");
  }
  if ((outgoing.tempoStability ?? 0) < rules.stability) {
    return deferred("crossfade", "the current track's tempo drifts");
  }
  if ((incoming.tempoStability ?? 0) < rules.stability) {
    return deferred("crossfade", "the next track's tempo drifts");
  }

  const ratio = Math.abs(bpmOut / bpmIn - 1);
  if (ratio > rules.maxTempoRatio) {
    return deferred(
      "crossfade",
      `${Math.round(bpmOut)} and ${Math.round(bpmIn)} BPM are too far apart to align (no tempo matching available)`,
    );
  }

  const duration = Number.isFinite(request.outgoingDuration)
    ? request.outgoingDuration
    : outgoing.duration;
  const beatSeconds = 60 / bpmOut;
  if (!Number.isFinite(duration) || duration < 20 || beatSeconds <= 0) {
    return deferred("crossfade", "the current track is too short to blend");
  }

  const wantedSeconds =
    config.crossfadeSeconds > 0
      ? config.crossfadeSeconds
      : rules.defaultSeconds;
  const beats = clamp(
    Math.round(wantedSeconds / beatSeconds),
    rules.minBeats,
    rules.maxBeats,
  );
  const seconds = Math.round(clamp(beats * beatSeconds, 1.5, 12) * 100) / 100;

  // Where the outgoing blend starts. A trustworthy mix-out point is where the
  // track is actually going somewhere; otherwise the last whole beat that
  // still leaves room for the blend.
  const mixOut = trustedCandidate(
    outgoing.mixOutCandidates,
    rules.candidateConfidence,
  );
  const latestStart = duration - seconds;
  // The engine arms a boundary at most `preloadLead` = min(20, fade + 12)
  // before the end. A mix-out point further back than that could never be
  // honoured — the plan would fire as soon as it was armed and start the blend
  // early — so an out-of-window candidate is ignored rather than pretended to
  // be a schedule.
  const maxLead = Math.min(20, seconds + 12);
  const usableMixOut =
    mixOut && duration - mixOut.time <= maxLead ? mixOut : null;
  const targetStart = clamp(
    usableMixOut ? Math.min(usableMixOut.time, latestStart) : latestStart,
    0,
    latestStart,
  );
  const snappedStart =
    beatAtOrBefore(outgoing.beatPositions, targetStart) ?? targetStart;
  const start = clamp(snappedStart, 0, latestStart);
  const leadSeconds = Math.round((duration - start) * 100) / 100;
  if (leadSeconds <= 0) {
    return deferred("crossfade", "no room left before the end of the track");
  }

  // Start the incoming track on ITS grid too, when the analysis found a genuine
  // entry point near the top. This is the difference between "two songs
  // overlapping" and "the next song enters on a beat".
  const mixIn = trustedCandidate(
    incoming.mixInCandidates,
    rules.candidateConfidence,
  );
  const introLimit = Math.min(30, incoming.duration * 0.35);
  let incomingStart = 0;
  if (mixIn && mixIn.time >= 1.5 && mixIn.time <= introLimit) {
    const beat = nearestBeat(
      incoming.beatPositions,
      mixIn.time,
      beatSeconds * 0.5,
    );
    incomingStart = Math.round((beat ?? mixIn.time) * 100) / 100;
  }

  const confidence = Math.min(
    outgoing.beatConfidence,
    incoming.beatConfidence,
    outgoing.bpmConfidence,
    incoming.bpmConfidence,
    outgoing.tempoStability ?? 0,
    incoming.tempoStability ?? 0,
  );

  return {
    apply: true,
    tier: "beat-align",
    seconds,
    leadSeconds,
    incomingStart,
    confidence: Math.round(confidence * 100) / 100,
    because: `beat-aligned blend: ${beats} beats at ${Math.round(bpmOut)} BPM (${seconds.toFixed(1)}s)${
      incomingStart > 0 ? `, next track enters at ${incomingStart.toFixed(1)}s` : ""
    }`,
    tempoMatched: false,
    bpm: { outgoing: Math.round(bpmOut), incoming: Math.round(bpmIn) },
  };
}

/** One line for the UI: what the last plan did, or why it could not. */
export function describeAutoMix(plan: AutoMixPlan | null): string {
  if (!plan) return "AutoMix is off";
  if (!plan.apply) return `AutoMix fell back to a crossfade — ${plan.refusal}.`;
  return `AutoMix ${plan.because}.`;
}
