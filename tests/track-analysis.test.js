import { describe, expect, test } from "bun:test";
import {
  ANALYZER_VERSION,
  analyzePcm,
  downmixForAnalysis,
  sanitizeAnalysis,
} from "../src/lib/trackAnalysis.ts";

/**
 * AutoMix analysis.
 *
 * Synthetic signals are used deliberately: they are the only way to assert a
 * KNOWN tempo. They prove the signal processing works; they do NOT prove that a
 * particular commercial master is measured correctly, and nothing here claims
 * otherwise. The confidence fields exist precisely because real music is
 * messier than a click track.
 */

const RATE = 11025;

/** Deterministic noise so two runs of the same fixture are identical. */
function noise(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return (state / 0xffffffff) * 2 - 1;
  };
}

/** An impulse train with decaying noise bursts: a crude but measurable beat. */
function clicks(bpm, seconds, seed = 7, amplitude = 0.6) {
  const samples = new Float32Array(Math.floor(seconds * RATE));
  const random = noise(seed);
  const period = (60 / bpm) * RATE;
  for (let beat = 0; beat * period < samples.length - 400; beat++) {
    const start = Math.floor(beat * period);
    for (let i = 0; i < 260; i++) {
      samples[start + i] += amplitude * Math.exp(-i / 45) * random();
    }
  }
  return samples;
}

describe("tempo and grid", () => {
  test("finds a clear 120 BPM pulse", () => {
    const analysis = analyzePcm({
      trackId: "click-120",
      samples: clicks(120, 26),
      sampleRate: RATE,
    });
    expect(analysis.status).toBe("ready");
    expect(Math.abs(analysis.bpm - 120)).toBeLessThanOrEqual(2);
    expect(analysis.beatConfidence).toBeGreaterThanOrEqual(0.45);
    expect(analysis.beatPositions.length).toBeGreaterThan(20);
  });

  test("finds a slower 96 BPM pulse", () => {
    const analysis = analyzePcm({
      trackId: "click-96",
      samples: clicks(96, 26, 11),
      sampleRate: RATE,
    });
    expect(Math.abs(analysis.bpm - 96)).toBeLessThanOrEqual(2);
  });

  test("the beat grid advances at the measured period", () => {
    const analysis = analyzePcm({
      trackId: "grid",
      samples: clicks(120, 26),
      sampleRate: RATE,
    });
    const beats = analysis.beatPositions.slice(0, 12);
    const gaps = beats.slice(1).map((t, i) => t - beats[i]);
    const average = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    expect(Math.abs(average - 0.5)).toBeLessThan(0.03);
  });

  test("is deterministic for the same buffer", () => {
    const samples = clicks(120, 20, 3);
    const first = analyzePcm({ trackId: "a", samples, sampleRate: RATE });
    const second = analyzePcm({ trackId: "a", samples, sampleRate: RATE });
    expect({ ...first, analyzedAt: 0 }).toEqual({ ...second, analyzedAt: 0 });
  });
});

describe("honest unavailability", () => {
  test("silence reports no tempo and no false confidence", () => {
    const analysis = analyzePcm({
      trackId: "silence",
      samples: new Float32Array(RATE * 20),
      sampleRate: RATE,
    });
    expect(analysis.bpm).toBeUndefined();
    expect(analysis.beatConfidence).toBe(0);
    expect(analysis.status).toBe("partial");
  });

  test("very short audio is unavailable, not guessed", () => {
    const analysis = analyzePcm({
      trackId: "sting",
      samples: clicks(120, 4),
      sampleRate: RATE,
    });
    expect(analysis.status).toBe("unavailable");
    expect(analysis.bpm).toBeUndefined();
    expect(analysis.reason).toMatch(/short/i);
  });

  test("empty input does not throw", () => {
    const analysis = analyzePcm({
      trackId: "empty",
      samples: new Float32Array(0),
      sampleRate: RATE,
    });
    expect(analysis.status).toBe("unavailable");
  });

  test("a rhythm-less noise bed never reports a confident grid", () => {
    const random = noise(42);
    const samples = new Float32Array(RATE * 20);
    for (let i = 0; i < samples.length; i++) samples[i] = random() * 0.3;
    const analysis = analyzePcm({
      trackId: "noise",
      samples,
      sampleRate: RATE,
    });
    // Noise has no pulse; whatever it reports must not be trusted.
    expect(analysis.beatConfidence).toBeLessThan(0.5);
  });
});

describe("energy facts", () => {
  test("a track that is quiet then loud has a rising energy curve", () => {
    const samples = clicks(120, 24);
    const half = Math.floor(samples.length / 2);
    for (let i = half; i < samples.length; i++) samples[i] *= 3;
    const analysis = analyzePcm({
      trackId: "rise",
      samples,
      sampleRate: RATE,
    });
    const curve = analysis.energyCurve;
    const early = curve.slice(2, 20).reduce((a, b) => a + b, 0) / 18;
    const late = curve.slice(-20).reduce((a, b) => a + b, 0) / 20;
    expect(late).toBeGreaterThan(early);
  });

  test("silence is detected as a quiet section", () => {
    const samples = clicks(120, 20);
    // Replace the middle 4 seconds with digital silence.
    const from = Math.floor(samples.length / 2);
    samples.fill(0, from, from + RATE * 4);
    const analysis = analyzePcm({
      trackId: "gap",
      samples,
      sampleRate: RATE,
    });
    expect(analysis.quietSections.length).toBeGreaterThan(0);
    const quiet = analysis.quietSections[0];
    expect(quiet.end - quiet.start).toBeGreaterThanOrEqual(1.2);
  });

  test("mix-out candidate stays inside the track", () => {
    const analysis = analyzePcm({
      trackId: "mix",
      samples: clicks(120, 30),
      sampleRate: RATE,
    });
    expect(analysis.mixOutCandidates.length).toBeGreaterThan(0);
    for (const candidate of analysis.mixOutCandidates) {
      expect(candidate.time).toBeGreaterThan(0);
      expect(candidate.time).toBeLessThanOrEqual(analysis.duration);
      expect(candidate.confidence).toBeGreaterThanOrEqual(0);
      expect(candidate.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe("stored analysis is validated", () => {
  test("a different analyzer version is discarded", () => {
    expect(
      sanitizeAnalysis({
        trackId: "old",
        analyzerVersion: "synq-automix-analysis/0",
        status: "ready",
        bpm: 120,
      }),
    ).toBeNull();
  });

  test("an impossible bpm is dropped rather than used", () => {
    const analysis = sanitizeAnalysis({
      trackId: "bad-bpm",
      analyzerVersion: ANALYZER_VERSION,
      status: "ready",
      duration: 200,
      bpm: 900,
      beatConfidence: 4,
    });
    expect(analysis.bpm).toBeUndefined();
    expect(analysis.beatConfidence).toBe(1);
  });

  test("bad beat positions are filtered and clamped", () => {
    const analysis = sanitizeAnalysis({
      trackId: "beats",
      analyzerVersion: ANALYZER_VERSION,
      status: "ready",
      duration: 100,
      beatPositions: [-3, 0, 0.5, "x", 500, 3],
      beatConfidence: 0.7,
      bpmConfidence: 0.7,
    });
    expect(analysis.beatPositions).toEqual([0, 0.5, 3]);
  });

  test("a stale track id is never confused for another track", () => {
    expect(sanitizeAnalysis({ analyzerVersion: ANALYZER_VERSION })).toBeNull();
  });
});

describe("downmix", () => {
  test("stereo is averaged into one channel", () => {
    const left = new Float32Array([1, 1, 1, 1]);
    const right = new Float32Array([-1, -1, -1, -1]);
    const mono = downmixForAnalysis([left, right], RATE);
    expect(Array.from(mono)).toEqual([0, 0, 0, 0]);
  });

  test("a higher source rate is resampled to the analysis rate", () => {
    const source = new Float32Array(44100);
    const mono = downmixForAnalysis([source], 44100, 11025);
    expect(mono.length).toBe(11025);
  });
});
