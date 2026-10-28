import { describe, expect, test } from "bun:test";
import { AUTOMIX_THRESHOLDS, planAutoMix } from "../src/lib/automix.ts";

/**
 * AutoMix planning.
 *
 * The planner's whole job is to be honest: beat-align only when there is
 * measured evidence, and otherwise say exactly what was missing so the listener
 * gets a plain crossfade instead of a silent downgrade. These tests exercise
 * the returned decisions directly — they do NOT prove that audio was mixed
 * correctly, which only a playback test can show.
 */

const beats = (bpm, duration) => {
  const out = [];
  for (let t = 0; t <= duration + 0.001; t += 60 / bpm) {
    out.push(Math.round(t * 1000) / 1000);
  }
  return out;
};

const analysis = (id, { bpm = 120, duration = 210, ...overrides } = {}) => ({
  trackId: id,
  status: "ready",
  source: "pcm",
  duration,
  bpm,
  bpmConfidence: 0.9,
  beatConfidence: 0.8,
  tempoStability: 0.85,
  beatPositions: beats(bpm, duration),
  energyCurve: Array.from({ length: 420 }, (_, i) => 0.4 + 0.4 * Math.sin(i / 20)),
  mixOutCandidates: [{ time: 198, confidence: 0.7, reason: "fixture" }],
  mixInCandidates: [{ time: 12.3, confidence: 0.7, reason: "fixture" }],
  analyzedAt: 1,
  analyzerVersion: "fixture",
  ...overrides,
});

const request = (overrides = {}) => ({
  outgoing: analysis("a"),
  incoming: analysis("b", { bpm: 122 }),
  outgoingDuration: 210,
  outgoingTime: 195,
  reason: "track-ended",
  canCrossfade: true,
  sameAlbum: false,
  config: { enabled: true, level: "standard", crossfadeSeconds: 4 },
  ...overrides,
});

const refusal = (plan) => plan.refusal ?? "";

describe("beat-aligned tier", () => {
  test("applies when both grids are reliable and tempos agree", () => {
    const plan = planAutoMix(request());
    expect(plan.apply).toBe(true);
    expect(plan.tier).toBe("beat-align");
    expect(plan.seconds).toBeGreaterThan(0);
    expect(plan.leadSeconds).toBeGreaterThanOrEqual(plan.seconds - 0.2);
  });

  test("the blend length is a whole number of beats", () => {
    const plan = planAutoMix(request());
    const beatsInBlend = plan.seconds / 0.5;
    expect(Math.abs(beatsInBlend - Math.round(beatsInBlend))).toBeLessThan(0.05);
  });

  test("the incoming track starts on its grid near the detected entry", () => {
    const plan = planAutoMix(request());
    expect(plan.incomingStart).toBeGreaterThan(11.5);
    expect(plan.incomingStart).toBeLessThan(13.5);
  });

  test("never claims tempo matching", () => {
    expect(planAutoMix(request()).tempoMatched).toBe(false);
  });

  test("is deterministic", () => {
    expect(planAutoMix(request())).toEqual(planAutoMix(request()));
  });

  test("a mix-out far outside the arming window is ignored", () => {
    const plan = planAutoMix(
      request({
        outgoing: analysis("a", {
          mixOutCandidates: [{ time: 150, confidence: 0.9, reason: "way out" }],
        }),
      }),
    );
    // 60s before the end could never be honoured; the blend must fall back to
    // the last beat that leaves room rather than pretending to schedule it.
    expect(plan.leadSeconds).toBeLessThanOrEqual(20);
  });
});

describe("fallback tier", () => {
  test("missing analysis falls back and says so", () => {
    const plan = planAutoMix(request({ incoming: null }));
    expect(plan.apply).toBe(false);
    expect(plan.seconds).toBe(0);
    expect(refusal(plan)).toMatch(/not been analysed/i);
  });

  test("a weak beat grid falls back", () => {
    const plan = planAutoMix(
      request({ outgoing: analysis("a", { beatConfidence: 0.3 }) }),
    );
    expect(plan.apply).toBe(false);
    expect(refusal(plan)).toMatch(/confiden/i);
  });

  test("tempos too far apart are not aligned", () => {
    const plan = planAutoMix(request({ incoming: analysis("b", { bpm: 150 }) }));
    expect(plan.apply).toBe(false);
    expect(refusal(plan)).toMatch(/too far apart/i);
  });

  test("a drifting tempo falls back", () => {
    const plan = planAutoMix(
      request({ outgoing: analysis("a", { tempoStability: 0.2 }) }),
    );
    expect(plan.apply).toBe(false);
    expect(refusal(plan)).toMatch(/drift/i);
  });

  test("an album seam keeps the artist's own transition", () => {
    const plan = planAutoMix(request({ sameAlbum: true }));
    expect(plan.apply).toBe(false);
    expect(refusal(plan)).toMatch(/album/i);
  });

  test("a manual skip keeps its short blend", () => {
    const plan = planAutoMix(request({ reason: "manual-next" }));
    expect(plan.apply).toBe(false);
    expect(refusal(plan)).toMatch(/manual/i);
  });

  test("unblendable sources fall back", () => {
    const plan = planAutoMix(request({ canCrossfade: false }));
    expect(plan.apply).toBe(false);
    expect(refusal(plan)).toMatch(/cannot be blended/i);
  });

  test("AutoMix off never applies", () => {
    const plan = planAutoMix(
      request({ config: { enabled: false, level: "standard", crossfadeSeconds: 4 } }),
    );
    expect(plan.apply).toBe(false);
    expect(refusal(plan)).toMatch(/off/i);
  });

  test("partial analysis is not treated as ready", () => {
    const plan = planAutoMix(
      request({ incoming: analysis("b", { status: "partial", reason: "no clear pulse" }) }),
    );
    expect(plan.apply).toBe(false);
    expect(refusal(plan)).toMatch(/pulse|beat grid/i);
  });
});

describe("evidence levels", () => {
  const borderline = {
    outgoing: analysis("a", { beatConfidence: 0.65, bpmConfidence: 0.65 }),
    incoming: analysis("b", { bpm: 122, beatConfidence: 0.65, bpmConfidence: 0.65 }),
  };

  test("strict rejects what balanced accepts", () => {
    const strict = planAutoMix(
      request({
        ...borderline,
        config: { enabled: true, level: "conservative", crossfadeSeconds: 4 },
      }),
    );
    const balanced = planAutoMix(
      request({
        ...borderline,
        config: { enabled: true, level: "standard", crossfadeSeconds: 4 },
      }),
    );
    expect(strict.apply).toBe(false);
    expect(balanced.apply).toBe(true);
  });

  test("thresholds rise monotonically from adventurous to strict", () => {
    const { conservative, standard, experimental } = AUTOMIX_THRESHOLDS;
    expect(conservative.beatConfidence).toBeGreaterThan(standard.beatConfidence);
    expect(standard.beatConfidence).toBeGreaterThan(experimental.beatConfidence);
    expect(conservative.maxTempoRatio).toBeLessThan(standard.maxTempoRatio);
    expect(standard.maxTempoRatio).toBeLessThan(experimental.maxTempoRatio);
  });
});
