/**
 * Track analysis for AutoMix — PURE signal processing.
 *
 * ## What this module is
 *
 * Given decoded PCM, it measures what a transition planner actually needs: a
 * tempo estimate, a beat grid, how trustworthy that grid is, an energy curve,
 * approximate loudness, quiet sections, and candidate points to mix in and out.
 * It reads no DOM, no network, no store and no clock, so every number below can
 * be reproduced from the same buffer in a test (see
 * `tests/track-analysis.test.js`) and in a worker.
 *
 * ## What it deliberately does NOT claim
 *
 * * **Key / vocals / structure.** A chroma histogram from a mix cannot identify a
 *   key reliably enough to make a musical decision on (relative major/minor and
 *   mastering EQ both shift it), and there is no vocal model in this bundle.
 *   Rather than emit a confident-looking `key`, the field is absent and the
 *   planner never uses it.
 * * **Exact tempo.** Autocorrelation on an onset envelope is a very good
 *   estimate for music with a clear pulse and an unreliable one for rubato,
 *   speech or ambient. That is why every value ships next to a confidence and
 *   the planner has an explicit fallback below the threshold.
 * * **Sample-accurate beats.** The grid is derived from frame-rate onsets; it is
 *   accurate to tens of milliseconds, which is enough to start a blend on a
 *   beat, and not enough to claim beat-perfect beatmatching.
 */

/** Bump when any number this module produces changes meaning or scale. */
export const ANALYZER_VERSION = "synq-automix-analysis/1";

/** Analysis sample rate. Onsets and energy need no more than this. */
const ANALYSIS_RATE = 11025;
/** STFT frame / hop. ~93 ms window, ~23 ms hop at 11.025 kHz. */
const FRAME = 1024;
const HOP = 256;
/** Energy sampling: one RMS block every 0.25 s, stored at 2 Hz. */
const ENERGY_BLOCK_SECONDS = 0.25;
const ENERGY_RATE = 2;

export type AnalysisStatus = "ready" | "partial" | "unavailable";

/** A place where a transition could start or end, with its own evidence. */
export interface MixCandidate {
  time: number;
  confidence: number;
  reason: string;
}

export interface QuietSection {
  start: number;
  end: number;
}

/**
 * Everything the planner is allowed to know about one track.
 *
 * `status` is the honest summary: `ready` means tempo + grid are measured,
 * `partial` means only energy-level facts survived (tempo was too ambiguous to
 * report), and `unavailable` means no PCM was analysed at all.
 */
export interface TrackAnalysis {
  trackId: string;
  status: AnalysisStatus;
  /** Where the numbers came from. Only `pcm` is ever produced here. */
  source: "pcm" | "none";
  duration: number;
  bpm?: number;
  /** 0..1, from autocorrelation peak prominence. Never above the grid's. */
  bpmConfidence: number;
  beatPositions?: number[];
  /** 0..1, how well onsets line up with the grid. */
  beatConfidence: number;
  /** 0..1, how steady the grid is across the track. */
  tempoStability?: number;
  /** Normalised RMS, 2 samples per second, 0..1. */
  energyCurve?: number[];
  /** Approximate loudness in dBFS over the loud sections (NOT EBU R128). */
  loudness?: number;
  quietSections?: QuietSection[];
  mixInCandidates?: MixCandidate[];
  mixOutCandidates?: MixCandidate[];
  /** Beats where the section's energy changes most (approximate). */
  phraseBoundaries?: number[];
  analyzedAt: number;
  analyzerVersion: string;
  /** Why this is partial/unavailable, in words a listener could read. */
  reason?: string;
}

export interface AnalysisInput {
  trackId: string;
  /** Mono PCM. Multichannel input must be downmixed by the caller. */
  samples: Float32Array;
  sampleRate: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * p)),
  );
  return sorted[idx];
}

/** In-place iterative radix-2 FFT. `re` and `im` must have the same length. */
function fftInPlace(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < half; k++) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + half] * curRe - im[i + k + half] * curIm;
        const bIm = re[i + k + half] * curIm + im[i + k + half] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + half] = aRe - bRe;
        im[i + k + half] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

function hannWindow(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  }
  return w;
}

/**
 * Half-wave-rectified spectral flux per frame, mean-removed and rectified.
 *
 * Spectral flux (not amplitude) is what survives a quiet master and a loud
 * one equally: a kick, a snare and a chord change all raise high-frequency
 * energy at the same instant, while a sustained pad contributes almost nothing
 * frame to frame. Mean removal stops a loud section from dominating the
 * autocorrelation just because it is loud.
 */
function onsetEnvelope(
  samples: Float32Array,
  sampleRate: number,
): { env: Float32Array; fps: number } {
  const fps = sampleRate / HOP;
  const frames = Math.max(0, Math.floor((samples.length - FRAME) / HOP) + 1);
  const window = hannWindow(FRAME);
  const re = new Float32Array(FRAME);
  const im = new Float32Array(FRAME);
  const prev = new Float32Array(FRAME >> 1);
  const raw = new Float32Array(frames);
  const mag = new Float32Array(FRAME >> 1);

  for (let f = 0; f < frames; f++) {
    const offset = f * HOP;
    for (let i = 0; i < FRAME; i++) {
      re[i] = samples[offset + i] * window[i];
      im[i] = 0;
    }
    fftInPlace(re, im);
    let flux = 0;
    for (let k = 0; k < FRAME >> 1; k++) {
      // log1p compresses the dynamic range so a loud kick does not swamp the
      // hi-hats, while still keeping the difference meaningful.
      const m = Math.log1p(Math.hypot(re[k], im[k]));
      mag[k] = m;
      const diff = m - prev[k];
      if (diff > 0) flux += diff;
      prev[k] = m;
    }
    raw[f] = flux;
  }

  // Remove the local mean over 0.8 s, then keep only positive excursions: a
  // track that gets louder must not read as a track that gets faster.
  const radius = Math.max(2, Math.round(fps * 0.8));
  const env = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    let count = 0;
    const from = Math.max(0, f - radius);
    const to = Math.min(frames - 1, f + radius);
    for (let j = from; j <= to; j++) {
      sum += raw[j];
      count++;
    }
    const localMean = count ? sum / count : 0;
    env[f] = Math.max(0, raw[f] - localMean);
  }
  // Three-frame smoothing kills single-frame noise without smearing onsets.
  const smooth = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const a = env[Math.max(0, f - 1)];
    const b = env[f];
    const c = env[Math.min(frames - 1, f + 1)];
    smooth[f] = (a + 2 * b + c) / 4;
  }
  return { env: smooth, fps };
}

interface TempoEstimate {
  bpm: number;
  confidence: number;
  /** Beat period in frames, fractional. */
  periodFrames: number;
  /** Phase of the first beat, in frames. */
  phaseFrames: number;
}

/**
 * Tempo from the autocorrelation of the onset envelope, with octave correction.
 *
 * A plain peak pick reports half or double the real tempo on a large share of
 * tracks (a four-on-the-floor kick at 128 also correlates at 64 and 256). The
 * correction step prefers the interpretation inside 80–160 BPM when it scores
 * nearly as well, which is where almost all dance/pop/soul lives, and the
 * reported confidence falls when the two interpretations score equally — that
 * ambiguity is real evidence and must not be rounded up.
 */
function estimateTempo(env: Float32Array, fps: number): TempoEstimate | null {
  const minLag = Math.max(2, Math.floor((fps * 60) / 200));
  const maxLag = Math.min(env.length - 2, Math.ceil((fps * 60) / 55));
  if (maxLag <= minLag || env.length < fps * 4) return null;

  const scores = new Float64Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    let energy = 0;
    let energyLag = 0;
    for (let i = 0; i + lag < env.length; i++) {
      sum += env[i] * env[i + lag];
      energy += env[i] * env[i];
      energyLag += env[i + lag] * env[i + lag];
    }
    const norm = Math.sqrt(energy * energyLag) || 1;
    scores[lag] = sum / norm;
  }

  let bestLag = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (scores[lag] > bestScore) {
      bestScore = scores[lag];
      bestLag = lag;
    }
  }
  if (!Number.isFinite(bestScore) || bestScore <= 0) return null;

  const scoreAt = (lag: number): number =>
    lag >= minLag && lag <= maxLag ? scores[Math.round(lag)] : 0;

  // Octave correction: compare the double-tempo (half-lag) and half-tempo
  // (double-lag) readings and prefer 80–160 when it is nearly as strong.
  const half = bestLag / 2;
  const double = bestLag * 2;
  if (half >= minLag && scoreAt(half) >= bestScore * 0.85) {
    bestLag = Math.round(half);
    bestScore = scoreAt(bestLag);
  } else if (double <= maxLag && scoreAt(double) >= bestScore * 0.85) {
    const bpm = (fps * 60) / double;
    if (bpm >= 78 && bpm <= 165) {
      bestLag = Math.round(double);
      bestScore = scoreAt(bestLag);
    }
  }
  const bpm = (fps * 60) / bestLag;
  if (!Number.isFinite(bpm) || bpm < 50 || bpm > 200) return null;

  // Refine period and phase on the envelope itself: autocorrelation gives a
  // whole-frame lag, but a 0.5% period error is a whole beat by the end of a
  // long blend, so the grid has to be fitted, not just rounded.
  const values = Array.from(env);
  const at = (frame: number): number => {
    if (frame < 0 || frame >= values.length) return 0;
    const i = Math.floor(frame);
    const frac = frame - i;
    const a = values[i] ?? 0;
    const b = values[Math.min(values.length - 1, i + 1)] ?? 0;
    return a * (1 - frac) + b * frac;
  };
  let period = bestLag;
  let phase = 0;
  let gridScore = -Infinity;
  for (let p = bestLag * 0.97; p <= bestLag * 1.03; p += 0.02) {
    for (let ph = 0; ph < p; ph += 0.25) {
      let sum = 0;
      let count = 0;
      for (let frame = ph; frame < env.length; frame += p) {
        sum += at(frame);
        count++;
      }
      if (count < 4) continue;
      const score = sum / count;
      if (score > gridScore) {
        gridScore = score;
        period = p;
        phase = ph;
      }
    }
  }

  const meanOnset = values.reduce((a, b) => a + b, 0) / (values.length || 1);
  const ratio = meanOnset > 0 ? gridScore / meanOnset : 0;
  const confidence = clamp01((ratio - 1) / 2);
  const prominences = [];
  for (let lag = minLag; lag <= maxLag; lag++) prominences.push(scores[lag]);
  const baseline = median(prominences);
  // How far the best lag stands above the correlation floor, in normalised
  // correlation units.
  //
  // This used to be a RATIO to the median — and the median is exactly 0 for a
  // clean, sparse pulse train (most lags correlate nothing at all), which made
  // `bestScore / baseline` infinite and the guarded fallback score the track as
  // 0% confident. Real four-on-the-floor tracks produced the same "no confidence"
  // verdict as random noise, so no boundary could ever be beat-aligned. A floor
  // keeps the scale meaningful for both, and the result is clamped to 0..1 so a
  // single lucky lag cannot masquerade as certainty.
  const floor = Math.max(baseline, 0.05);
  const peakStrength = clamp01(
    (bestScore - floor) / Math.max(0.1, 1 - floor),
  );

  return {
    bpm: Math.round(((fps * 60) / period) * 10) / 10,
    // Confidence needs BOTH a clear autocorrelation peak and onsets that sit on
    // the resulting grid. Either one alone is a coincidence often enough that
    // acting on it would start blends on the wrong beat.
    confidence: clamp01(Math.min(confidence, peakStrength)),
    periodFrames: period,
    phaseFrames: phase,
  };
}

/** Beat grid from the fitted period/phase, checked against the onsets. */
function buildBeatGrid(
  tempo: TempoEstimate,
  env: Float32Array,
  fps: number,
  duration: number,
): { beats: number[]; beatConfidence: number; stability: number } {
  const beats: number[] = [];
  for (let frame = tempo.phaseFrames; frame < env.length; frame += tempo.periodFrames) {
    const time = frame / fps;
    if (time > duration) break;
    beats.push(Math.round(time * 1000) / 1000);
  }
  if (beats.length < 4) {
    return { beats, beatConfidence: 0, stability: 0 };
  }

  // How much the onsets prefer THIS grid over the same grid shifted by half a
  // beat.
  //
  // The obvious measure — "onsets on the grid vs the average frame" — is
  // biased upward for ANY signal, because it samples the envelope where the
  // grid says a beat is and compares that with the mean of everything. Noise
  // scored a perfect confidence under it. A half-beat-shifted grid is the right
  // control: a real pulse scores high on the grid and low between beats, while
  // noise scores the same in both places, giving a contrast near zero.
  const values = Array.from(env);
  const at = (frame: number): number => {
    if (frame < 0 || frame >= values.length) return 0;
    const i = Math.floor(frame);
    const frac = frame - i;
    const a = values[i] ?? 0;
    const b = values[Math.min(values.length - 1, i + 1)] ?? 0;
    return a * (1 - frac) + b * frac;
  };
  let onGrid = 0;
  let offGrid = 0;
  for (const beat of beats) {
    const frame = beat * fps;
    onGrid += at(frame);
    offGrid += at(frame + tempo.periodFrames / 2);
  }
  const onMean = onGrid / beats.length;
  const offMean = offGrid / beats.length;
  const contrast =
    onMean + offMean > 1e-9 ? (onMean - offMean) / (onMean + offMean) : 0;

  // Stability: how far each beat's strongest local onset sits from the grid.
  let deviation = 0;
  for (const beat of beats) {
    const frame = beat * fps;
    let bestPeak = 0;
    let bestOffset = 0;
    const reach = Math.max(1, Math.round(tempo.periodFrames * 0.3));
    for (let d = -reach; d <= reach; d++) {
      const v = values[Math.round(frame) + d] ?? 0;
      if (v > bestPeak) {
        bestPeak = v;
        bestOffset = d;
      }
    }
    deviation += Math.abs(bestOffset) / tempo.periodFrames;
  }
  const stability = clamp01(1 - deviation / beats.length / 0.25);

  // Both halves are required. Contrast alone flattered sparse/noisy audio: a
  // handful of random onsets could line up with one phase well enough to score
  // high while the beat-to-beat spacing was visibly inconsistent (stability
  // ~0.5). A grid you cannot measure consistently is not a grid, so the two
  // multiply. Clean, steady pulses keep a high score on both (≈0.99 × 0.99).
  const beatConfidence = clamp01(contrast * stability);

  return {
    beats,
    beatConfidence,
    stability,
  };
}

/** Per-block RMS in dBFS, plus the normalised energy curve the planner reads. */
function measureEnergy(
  samples: Float32Array,
  sampleRate: number,
): { curve: number[]; loudness: number; quiet: QuietSection[] } {
  const block = Math.max(1, Math.round(sampleRate * ENERGY_BLOCK_SECONDS));
  const blocks = Math.max(1, Math.floor(samples.length / block));
  const db: number[] = [];
  const rms: number[] = [];
  for (let b = 0; b < blocks; b++) {
    let sum = 0;
    const start = b * block;
    const end = Math.min(samples.length, start + block);
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    const value = Math.sqrt(sum / Math.max(1, end - start));
    rms.push(value);
    db.push(value > 1e-6 ? 20 * Math.log10(value) : -120);
  }

  const reference = Math.max(1e-6, percentile(rms, 0.95));
  const curve: number[] = [];
  const perEnergySample = Math.max(
    1,
    Math.round(1 / (ENERGY_RATE * ENERGY_BLOCK_SECONDS)),
  );
  for (let i = 0; i < rms.length; i += perEnergySample) {
    let peak = 0;
    for (let k = i; k < Math.min(rms.length, i + perEnergySample); k++) {
      peak = Math.max(peak, rms[k]);
    }
    curve.push(Math.round(clamp01(peak / reference) * 1000) / 1000);
  }

  // Approximate loudness: the level of the loudest 30% of the track. This is a
  // level estimate for balancing two tracks, NOT a standards-compliant LUFS
  // measurement, and it is never presented to the listener as one.
  const loudDb = percentile(db, 0.7);
  const loudness = Number.isFinite(loudDb)
    ? Math.round(Math.max(-60, loudDb) * 10) / 10
    : -60;

  const quiet: QuietSection[] = [];
  let runStart: number | null = null;
  for (let b = 0; b < db.length; b++) {
    const isQuiet = db[b] <= Math.max(-45, loudness - 30);
    if (isQuiet && runStart === null) runStart = b;
    if ((!isQuiet || b === db.length - 1) && runStart !== null) {
      const endBlock = isQuiet ? b + 1 : b;
      const start = runStart * ENERGY_BLOCK_SECONDS;
      const end = endBlock * ENERGY_BLOCK_SECONDS;
      if (end - start >= 1.2) quiet.push({ start, end });
      runStart = null;
    }
  }
  return { curve, loudness, quiet };
}

/**
 * Candidate mix points, with reasons a person can read.
 *
 * These are NOT "song structure": without a segmentation model, all this can
 * honestly say is where the energy rises and falls relative to the beat grid.
 * The reasons say exactly that, and the planner treats them as hints whose
 * weight is capped by the beat confidence.
 */
function findMixCandidates(
  beats: number[],
  energy: number[],
  duration: number,
  beatConfidence: number,
): { mixIn: MixCandidate[]; mixOut: MixCandidate[] } {
  if (beats.length < 8 || energy.length < 4) {
    return { mixIn: [], mixOut: [] };
  }
  const span = beats.length >= 2 ? beats[1] - beats[0] : 0.5;
  const energyAt = (time: number): number => {
    const idx = Math.round(time * ENERGY_RATE);
    return energy[Math.min(energy.length - 1, Math.max(0, idx))] ?? 0;
  };
  const windowMean = (from: number, seconds: number): number => {
    let sum = 0;
    let count = 0;
    for (let t = from; t < from + seconds; t += 0.5) {
      sum += energyAt(t);
      count++;
    }
    return count ? sum / count : 0;
  };
  const typical = median(energy.filter((v) => v > 0.05));

  const mixIn: MixCandidate[] = [];
  for (let i = 0; i < beats.length; i++) {
    const time = beats[i];
    if (time < 1.5 || time > duration * 0.45) continue;
    const forward = windowMean(time, 6);
    const before = windowMean(Math.max(0, time - 4), 4);
    if (forward >= typical * 0.55 && forward >= before * 1.05) {
      mixIn.push({
        time,
        confidence: Math.round(clamp01(0.3 + beatConfidence * 0.6) * 100) / 100,
        reason: "first beat where the track reaches its main level",
      });
      break;
    }
  }

  const mixOut: MixCandidate[] = [];
  for (let i = beats.length - 1; i >= 0; i--) {
    const time = beats[i];
    if (time > duration - 2) continue;
    if (time < duration * 0.5) break;
    const forward = windowMean(time, 4);
    if (forward <= typical * 0.6) {
      mixOut.push({
        time,
        confidence:
          Math.round(clamp01(0.3 + beatConfidence * 0.55) * 100) / 100,
        reason: "last beat before the energy drops away",
      });
      break;
    }
  }
  if (mixOut.length === 0) {
    // No fader-out to aim at: the honest fallback is the last beat that still
    // leaves room for a blend, not a guess at a "section".
    const last = beats[beats.length - 1] ?? duration;
    const target = Math.min(duration - 1.5, last - span * 2);
    mixOut.push({
      time: Math.max(0, Math.round(target * 1000) / 1000),
      confidence: Math.round(clamp01(0.2 + beatConfidence * 0.4) * 100) / 100,
      reason: "last beat with room left for a blend",
    });
  }
  return { mixIn, mixOut };
}

/** Beats where the 4-bar-ahead energy differs most from the 4-bar-behind. */
function findPhraseBoundaries(
  beats: number[],
  energy: number[],
): number[] {
  if (beats.length < 32 || energy.length < 8) return [];
  const energyAt = (time: number): number => {
    const idx = Math.round(time * ENERGY_RATE);
    return energy[Math.min(energy.length - 1, Math.max(0, idx))] ?? 0;
  };
  const meanBetween = (a: number, b: number): number => {
    let sum = 0;
    let count = 0;
    for (let t = a; t < b; t += 0.5) {
      sum += energyAt(t);
      count++;
    }
    return count ? sum / count : 0;
  };
  const scored: { time: number; change: number }[] = [];
  for (let i = 8; i < beats.length - 8; i += 4) {
    const before = meanBetween(beats[i - 8], beats[i]);
    const after = meanBetween(beats[i], beats[i + 8]);
    scored.push({ time: beats[i], change: Math.abs(after - before) });
  }
  const sorted = [...scored].sort((a, b) => b.change - a.change);
  const top = sorted.slice(0, 12).filter((s) => s.change >= 0.18);
  return top.map((s) => s.time).sort((a, b) => a - b);
}

/**
 * The whole pipeline.
 *
 * Returns `unavailable` (never throws) for audio too short to measure: a 3 s
 * sting has no tempo a DJ could use, and pretending otherwise would let the
 * planner snap a blend to a grid that is really just noise.
 */
export function analyzePcm(input: AnalysisInput): TrackAnalysis {
  const { trackId, samples, sampleRate } = input;
  const base: TrackAnalysis = {
    trackId,
    status: "unavailable",
    source: "none",
    duration: 0,
    bpmConfidence: 0,
    beatConfidence: 0,
    analyzedAt: Date.now(),
    analyzerVersion: ANALYZER_VERSION,
  };
  if (
    !trackId ||
    !samples ||
    samples.length === 0 ||
    !Number.isFinite(sampleRate) ||
    sampleRate < 8000
  ) {
    return { ...base, reason: "no decodable audio" };
  }

  const duration = samples.length / sampleRate;
  if (duration < 8) {
    return {
      ...base,
      duration: Math.round(duration * 1000) / 1000,
      reason: "too short to estimate a tempo",
    };
  }

  const { curve, loudness, quiet } = measureEnergy(samples, sampleRate);
  const { env, fps } = onsetEnvelope(samples, sampleRate);
  const tempo = estimateTempo(env, fps);
  if (!tempo) {
    return {
      ...base,
      status: "partial",
      source: "pcm",
      duration: Math.round(duration * 1000) / 1000,
      energyCurve: curve,
      loudness,
      quietSections: quiet,
      reason: "no clear pulse found",
    };
  }

  const grid = buildBeatGrid(tempo, env, fps, duration);
  const { mixIn, mixOut } = findMixCandidates(
    grid.beats,
    curve,
    duration,
    grid.beatConfidence,
  );
  const reliable =
    grid.beatConfidence >= 0.45 &&
    tempo.confidence >= 0.5 &&
    grid.stability >= 0.4 &&
    grid.beats.length >= 16;

  return {
    trackId,
    status: reliable ? "ready" : "partial",
    source: "pcm",
    duration: Math.round(duration * 1000) / 1000,
    bpm: tempo.bpm,
    bpmConfidence: Math.round(tempo.confidence * 100) / 100,
    ...(grid.beats.length > 0 ? { beatPositions: grid.beats } : {}),
    beatConfidence: Math.round(grid.beatConfidence * 100) / 100,
    tempoStability: Math.round(grid.stability * 100) / 100,
    energyCurve: curve,
    loudness,
    quietSections: quiet,
    mixInCandidates: mixIn,
    mixOutCandidates: mixOut,
    phraseBoundaries: findPhraseBoundaries(grid.beats, curve),
    analyzedAt: base.analyzedAt,
    analyzerVersion: ANALYZER_VERSION,
    ...(reliable ? {} : { reason: "beat grid too weak to act on" }),
  };
}

/**
 * Downmix and resample decoded audio to the analysis rate.
 *
 * Linear interpolation is deliberate: the analysis only needs onset timing and
 * broadband energy, both of which survive a cheap resample, and a windowed-sinc
 * resampler would cost more CPU than the whole FFT pass.
 */
export function downmixForAnalysis(
  channels: readonly Float32Array[],
  sourceRate: number,
  targetRate = ANALYSIS_RATE,
): Float32Array {
  const length = channels[0]?.length ?? 0;
  if (length === 0) return new Float32Array(0);
  const mono = new Float32Array(length);
  for (const channel of channels) {
    for (let i = 0; i < length; i++) mono[i] += channel[i] / channels.length;
  }
  if (Math.abs(sourceRate - targetRate) < 1) return mono;
  const ratio = targetRate / sourceRate;
  const outLength = Math.max(1, Math.floor(length * ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i / ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = mono[Math.min(i0, length - 1)] ?? 0;
    const b = mono[Math.min(i0 + 1, length - 1)] ?? 0;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/**
 * Validate anything read back from storage or a worker.
 *
 * Parsed JSON is untrusted input: a stale or hand-edited cache entry must never
 * put a 900 BPM grid into the planner, because that produces a transition
 * duration of a few milliseconds and reads as a broken player.
 */
export function sanitizeAnalysis(raw: unknown): TrackAnalysis | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<TrackAnalysis>;
  if (typeof value.trackId !== "string" || !value.trackId) return null;
  if (value.analyzerVersion !== ANALYZER_VERSION) return null;

  const status: AnalysisStatus =
    value.status === "ready" || value.status === "partial"
      ? value.status
      : "unavailable";
  const finite = (n: unknown, fallback = 0): number =>
    typeof n === "number" && Number.isFinite(n) ? n : fallback;
  const duration = Math.max(0, finite(value.duration));
  const bpm =
    typeof value.bpm === "number" && Number.isFinite(value.bpm)
      ? value.bpm >= 40 && value.bpm <= 220
        ? Math.round(value.bpm * 10) / 10
        : undefined
      : undefined;
  const beats = Array.isArray(value.beatPositions)
    ? value.beatPositions
        .filter((b): b is number => typeof b === "number" && Number.isFinite(b))
        .filter((b) => b >= 0 && b <= duration + 1)
        .slice(0, 4000)
        .map((b) => Math.round(b * 1000) / 1000)
    : undefined;
  const energy = Array.isArray(value.energyCurve)
    ? value.energyCurve
        .filter((e): e is number => typeof e === "number" && Number.isFinite(e))
        .slice(0, 20000)
        .map(clamp01)
    : undefined;
  const candidates = (list: unknown): MixCandidate[] | undefined => {
    if (!Array.isArray(list)) return undefined;
    const out: MixCandidate[] = [];
    for (const entry of list.slice(0, 8)) {
      if (!entry || typeof entry !== "object") continue;
      const c = entry as Partial<MixCandidate>;
      const time = finite(c.time, -1);
      if (time < 0 || time > duration) continue;
      out.push({
        time,
        confidence: clamp01(finite(c.confidence)),
        reason:
          typeof c.reason === "string" ? c.reason.slice(0, 120) : "candidate",
      });
    }
    return out;
  };

  return {
    trackId: value.trackId,
    status,
    source: value.source === "pcm" ? "pcm" : "none",
    duration,
    ...(bpm !== undefined ? { bpm } : {}),
    bpmConfidence: clamp01(finite(value.bpmConfidence)),
    ...(beats && beats.length > 0 ? { beatPositions: beats } : {}),
    beatConfidence: clamp01(finite(value.beatConfidence)),
    tempoStability:
      typeof value.tempoStability === "number" &&
      Number.isFinite(value.tempoStability)
        ? clamp01(value.tempoStability)
        : undefined,
    ...(energy ? { energyCurve: energy } : {}),
    loudness:
      typeof value.loudness === "number" && Number.isFinite(value.loudness)
        ? value.loudness
        : undefined,
    quietSections: Array.isArray(value.quietSections)
      ? value.quietSections
          .filter(
            (q): q is QuietSection =>
              !!q &&
              typeof q.start === "number" &&
              typeof q.end === "number" &&
              Number.isFinite(q.start) &&
              Number.isFinite(q.end) &&
              q.start >= 0 &&
              q.end > q.start,
          )
          .slice(0, 40)
      : undefined,
    mixInCandidates: candidates(value.mixInCandidates),
    mixOutCandidates: candidates(value.mixOutCandidates),
    phraseBoundaries: Array.isArray(value.phraseBoundaries)
      ? value.phraseBoundaries
          .filter((t): t is number => typeof t === "number" && Number.isFinite(t))
          .filter((t) => t >= 0 && t <= duration)
          .slice(0, 32)
      : undefined,
    analyzedAt: finite(value.analyzedAt, Date.now()),
    analyzerVersion: ANALYZER_VERSION,
    ...(typeof value.reason === "string"
      ? { reason: value.reason.slice(0, 160) }
      : {}),
  };
}

/** Energy at a moment, read from the stored 2 Hz curve. */
export function energyAt(analysis: TrackAnalysis, time: number): number {
  const curve = analysis.energyCurve;
  if (!curve || curve.length === 0) return 0;
  const idx = Math.round(time * ENERGY_RATE);
  return curve[Math.min(curve.length - 1, Math.max(0, idx))] ?? 0;
}
