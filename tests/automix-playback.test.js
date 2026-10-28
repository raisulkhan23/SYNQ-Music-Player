import { afterAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { readSource } from "./helpers/tailwind-css.js";

/**
 * AutoMix, wired into playback.
 *
 * Two different kinds of question are asked here.
 *
 * 1. Does the ANALYSIS SCHEDULER behave under the conditions the browser
 *    creates — readable bytes, a CORS refusal, a track measured twice? This
 *    drives the real module against fake audio, because the scheduler is where
 *    "we analysed it" is decided, and a scheduler that silently reports
 *    success without PCM is how a fake BPM reading reaches the planner.
 *
 * 2. Does the PLAYER follow the contract the engine needs — arm before the cut
 *    branch, seek cancels before moving the element, a cancel stops the
 *    incoming deck, a commit advances the queue exactly once? These are read
 *    from the source, the same way this repository's other playback
 *    integrations are pinned, because the store is a module-scope singleton
 *    bound to real media elements that a unit test cannot instantiate. They are
 *    SHAPE checks, and the report says so: they prove the order of operations,
 *    not that a crossfade was heard.
 */

// --- a browser-ish environment for the scheduler -----------------------------

const RATE = 44100;
const window_ = new Window({ url: "https://synq.local/" });
globalThis.window = window_;
globalThis.localStorage = window_.localStorage;
globalThis.Worker = undefined; // force the inline analysis path

/** A click track with a decaying noise burst per beat. */
function clicks(bpm, seconds) {
  const samples = new Float32Array(Math.floor(seconds * RATE));
  let seed = 11;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 0xffffffff) * 2 - 1;
  };
  const period = (60 / bpm) * RATE;
  for (let beat = 0; beat * period < samples.length - 400; beat++) {
    const start = Math.floor(beat * period);
    for (let i = 0; i < 260; i++) {
      samples[start + i] += 0.6 * Math.exp(-i / 45) * random();
    }
  }
  return samples;
}

/** The decoded shape `decodeAudioData` returns, backed by our synthetic PCM. */
function fakeAudio(samples) {
  return {
    duration: samples.length / RATE,
    numberOfChannels: 1,
    sampleRate: RATE,
    getChannelData: () => samples,
  };
}

let decoded = clicks(128, 30);
class FakeOfflineAudioContext {
  constructor() {}
  async decodeAudioData() {
    return fakeAudio(decoded);
  }
}
globalThis.OfflineAudioContext = FakeOfflineAudioContext;
// The scheduler reads `window.OfflineAudioContext`, not the bare global.
window_.OfflineAudioContext = FakeOfflineAudioContext;
window_.Worker = undefined;

let fetchCount = 0;
let fetchedUrls = [];
// Saved BEFORE the stub. Bun runs test files in one process, so a module-scope
// global left behind here follows every later file — and the download tests
// legitimately need real sockets.
const realFetchBeforeStub = globalThis.fetch;
globalThis.fetch = async (url) => {
  fetchCount += 1;
  fetchedUrls.push(String(url));
  return new Response(new ArrayBuffer(64), { status: 200 });
};

afterAll(() => {
  globalThis.fetch = realFetchBeforeStub;
});

const {
  analyzeTrack,
  clearAnalysisCache,
  getCachedAnalysis,
  hasUsableAnalysis,
  setAnalysisResolver,
  warmAnalysis,
} = await import("../src/lib/analysisScheduler.ts");

describe("analysis scheduler reads the bytes it is allowed to read", () => {
  test("a readable stream is measured, cached and not fetched twice", async () => {
    clearAnalysisCache();
    fetchCount = 0;
    const track = { id: "track-readable", audioUrl: "https://cdn.test/a.mp3" };
    const first = await analyzeTrack(track);
    expect(first.status).toBe("ready");
    expect(first.source).toBe("pcm");
    expect(first.bpm).toBeGreaterThan(120);
    expect(first.bpm).toBeLessThan(136);
    expect(fetchCount).toBe(1);

    // The planner reads this cache synchronously while arming, so the second
    // call must be answered without any network or decode work at all.
    const second = await analyzeTrack(track);
    expect(second).toBe(first);
    expect(fetchCount).toBe(1);
    expect(hasUsableAnalysis(track.id)).toBe(true);
  });

  test("a CORS refusal is unavailable, never a silent empty analysis", async () => {
    clearAnalysisCache();
    const saved = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    try {
      const analysis = await analyzeTrack({
        id: "track-cors",
        audioUrl: "https://direct.test/b.mp3",
      });
      expect(analysis.status).toBe("unavailable");
      expect(analysis.source).toBe("none");
      expect(analysis.bpm).toBeUndefined();
      expect(analysis.beatPositions).toBeUndefined();
      expect(analysis.reason).toMatch(/cannot be read/i);
      // Deliberately NOT cached as usable: the planner must fall back.
      expect(hasUsableAnalysis("track-cors")).toBe(false);
    } finally {
      globalThis.fetch = saved;
    }
  });

  test("a YouTube page URL is resolved to a stream, not fetched as HTML", async () => {
    // Every queued YouTube track carries `audioUrl: https://youtu.be/<id>`,
    // which is a web page. Fetching it returned HTML and decodeAudioData
    // rejected it, so AutoMix reported every normal track as unreadable.
    clearAnalysisCache();
    setAnalysisResolver(async (videoId) => `https://cdn.test/${videoId}.mp3`);
    fetchCount = 0;
    fetchedUrls = [];
    const analysis = await analyzeTrack({
      id: "track-page-url",
      audioUrl: "https://youtu.be/abc123xyz",
      youtubeId: "abc123xyz",
    });
    expect(analysis.status).toBe("ready");
    expect(fetchedUrls).toEqual(["https://cdn.test/abc123xyz.mp3"]);
    expect(fetchedUrls.some((url) => url.includes("youtu.be"))).toBe(false);
    setAnalysisResolver(null);
  });

  test("a queued track without a resolved URL is not analysed from an id", async () => {
    clearAnalysisCache();
    const analysis = await analyzeTrack({ id: "track-bare", audioUrl: "abc123" });
    expect(analysis.status).toBe("unavailable");
    expect(analysis.bpm).toBeUndefined();
  });

  test("warmAnalysis uses the engine's resolver and stops repeating itself", async () => {
    clearAnalysisCache();
    let resolutions = 0;
    setAnalysisResolver(async () => {
      resolutions += 1;
      return "https://cdn.test/resolved.mp3";
    });
    fetchCount = 0;
    const track = { id: "track-queued", youtubeId: "abc123" };
    warmAnalysis(track);
    warmAnalysis(track);
    // Wait for the chained job rather than assuming it ran synchronously.
    while (getCachedAnalysis(track.id) === null) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(resolutions).toBe(1);
    expect(fetchCount).toBe(1);
    expect(getCachedAnalysis(track.id).status).toBe("ready");
    setAnalysisResolver(null);
  });
});

// --- the engine wiring -------------------------------------------------------

const store = readSource("src/store/player.ts");
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

/** Body of a module-scope `function name(` … `\n}`. */
function bodyOf(code, name, async = false) {
  const start = code.indexOf(
    `\n${async ? "async " : ""}function ${name}(`,
  );
  if (start === -1) throw new Error(`no top-level function ${name}`);
  const next = Math.min(
    ...[code.indexOf("\nfunction ", start + 1), code.indexOf("\nasync function ", start + 1)]
      .filter((i) => i !== -1)
      .concat([code.length]),
  );
  return code.slice(start, next);
}

const code = stripComments(store);

describe("AutoMix reaches the real deck, not just the settings", () => {
  test("the planner runs before the cut branch and can decide the length", () => {
    const arm = bodyOf(code, "armTransition");
    const planCall = arm.indexOf("planAutoMix({");
    const planTransition = arm.indexOf("planTransition({");
    const cutBranch = arm.indexOf('if (plan.mode === "cut")');
    expect(planTransition).toBeGreaterThan(-1);
    expect(planCall).toBeGreaterThan(-1);
    // AutoMix needs to feed the base plan's crossfade length, otherwise a
    // listener with AutoMix on and crossfade off would never arm a blend.
    expect(planCall).toBeLessThan(planTransition);
    expect(cutBranch).toBeGreaterThan(planTransition);
    // Only a real crossfade may carry the measured timing.
    expect(arm).toMatch(/autoPlan\.apply && plan\.mode === "crossfade"/);
    expect(arm).toMatch(/seconds: autoPlan\.seconds/);
    expect(arm).toMatch(/leadSeconds: autoPlan\.leadSeconds/);
    expect(arm).toMatch(/incomingStart = autoPlan\.incomingStart/);
  });

  test("the incoming deck is seeked to the planned entry beat before it sounds", () => {
    const prepare = bodyOf(code, "prepareIncoming");
    expect(prepare).toMatch(/t\.incomingStart > 0/);
    expect(prepare).toMatch(/el\.currentTime = t\.incomingStart/);
    const run = bodyOf(code, "maybeRunCrossfade", true);
    const guard = run.indexOf("t.incomingStart > 0");
    const play = run.search(/incoming\s*\.play\(\)/);
    expect(guard).toBeGreaterThan(-1);
    expect(play).toBeGreaterThan(guard);
    // A failed seek must abandon the blend instead of revealing the wrong bar.
    expect(run.slice(guard)).toMatch(/cancelTransition\("incoming-seek-failed"\)/);
  });

  test("the store's position begins where the incoming track actually entered", () => {
    const commit = bodyOf(code, "commitTransition");
    expect(commit).toMatch(/t\.incomingStart \|\| undefined/);
    expect(commit).toMatch(/autoMixIndicator: null/);
  });

  test("analysis is warmed from the position updates, not on the arm itself", () => {
    const tick = bodyOf(code, "tickTransition");
    expect(tick).toMatch(/warmAnalysis\(s\.current\)/);
    expect(tick).toMatch(/warmAnalysis\(ahead\.track\)/);
    // Cache-only at arm time: a fetch/decode there would stall a timeupdate.
    const arm = bodyOf(code, "armTransition");
    expect(arm).toMatch(/getCachedAnalysis/);
    expect(arm).not.toMatch(/warmAnalysis|analyzeTrack/);
  });

  test("AutoMix cannot arm early without both tracks measured READY", () => {
    const tick = bodyOf(code, "tickTransition");
    expect(tick).toMatch(/getCachedAnalysis\(id\)\?\.status === "ready"/);
    expect(tick).toMatch(/ready\(s\.current\.id\)/);
    expect(tick).toMatch(/ready\(ahead\.track\.id\)/);
  });
});

describe("a seek during a blend cannot orphan a deck", () => {
  test("seeking cancels before it moves the element that is playing", () => {
    const seekStart = code.indexOf("  const seek = (time: number) => {");
    expect(seekStart).toBeGreaterThan(-1);
    const seekEnd = code.indexOf("\n  const ", seekStart + 10);
    const seek = code.slice(seekStart, seekEnd);
    const cancel = seek.indexOf('cancelTransition("seek")');
    const assign = seek.indexOf("getAudio().currentTime = t");
    expect(cancel).toBeGreaterThan(-1);
    expect(assign).toBeGreaterThan(cancel);
    // The YouTube path must be abandoned too, or the IFrame keeps the old song.
    expect(seek).toMatch(/ytEngine\.seek\(t\)/);
  });

  test("cancelling pauses the incoming element and restores both gains", () => {
    const cancel = bodyOf(code, "cancelTransition");
    const pause = cancel.indexOf("t.incomingEl?.pause()");
    const reset = cancel.indexOf("resetAllDeckGains()");
    expect(pause).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(pause);
    // The obvious bug — resetting gains to unity while the incoming song keeps
    // playing — is what produced two songs at once.
    expect(cancel).toMatch(/if \(t\.incomingStarted\)/);
    expect(cancel).toMatch(/autoMixIndicator: null/);
  });

  test("Next, Previous and pause all abandon the blend the same way", () => {
    expect(code).toMatch(/cancelTransition\("manual-next"\)/);
    expect(code).toMatch(/cancelTransition\("manual-prev"\)/);
    expect(code).toMatch(/cancelTransition\("pause"\)/);
    expect(code).toMatch(/cancelTransition\("resume"\)/);
    expect(code).toMatch(/pauseAllDecks\(\)/);
  });

  test("a committed blend advances the queue exactly once", () => {
    const run = bodyOf(code, "runManualBlend", true);
    // Told apart by `committed`, because a commit and an abandon both null the
    // transition and calling advance() after a commit skipped a song.
    expect(run).toMatch(/if \(t\.committed\) return;/);
    const commit = bodyOf(code, "commitTransition");
    expect(commit).toMatch(/commitCrossfadeAdvance\?\.\(t\.index, t\.track/);
    expect(code).toMatch(/commitCrossfadeAdvance = advanceTrackForTransition/);
  });
});

describe("settings reach the engine", () => {
  test("turning AutoMix on or off re-plans an in-flight blend", () => {
    const setter = code.slice(
      code.indexOf("setAutomix: (on: boolean) => {"),
      code.indexOf("setAutomixLevel: (level: AutoMixLevel) => {"),
    );
    expect(setter).toMatch(/writeSetting\("ss\.automix"/);
    expect(setter).toMatch(/cancelTransition\("setting-changed"\)/);
    expect(setter).toMatch(/automix: on/);
  });

  test("the persisted level is validated before it is used", () => {
    expect(code).toMatch(/raw === "conservative" \|\| raw === "experimental"/);
    expect(code).toMatch(/writeSetting\("ss\.automixLevel", next\)/);
  });
});

// --- analysis → planner, end to end -----------------------------------------

const { analyzePcm } = await import("../src/lib/trackAnalysis.ts");
const { planAutoMix } = await import("../src/lib/automix.ts");

/** A click track at the analysis rate, with a little noise between beats. */
function measure(bpm, id) {
  const rate = 11025;
  const seconds = 40;
  const samples = new Float32Array(rate * seconds);
  let seed = 7;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 0xffffffff) * 2 - 1;
  };
  const period = (60 / bpm) * rate;
  for (let beat = 0; beat * period < samples.length - 400; beat++) {
    const start = Math.floor(beat * period);
    for (let i = 0; i < 260; i++) {
      samples[start + i] += 0.6 * Math.exp(-i / 45) * random();
      // A quiet bed so the envelope is not a perfect impulse train.
      samples[start + i] += 0.02 * random();
    }
  }
  return analyzePcm({ trackId: id, samples, sampleRate: rate });
}

describe("what the analyser measures is what the planner decides on", () => {
  const outgoing = measure(128, "out-128");
  const close = measure(126, "in-126");
  const far = measure(100, "in-100");

  test("two measured tracks close in tempo plan a beat-aligned blend", () => {
    expect(outgoing.status).toBe("ready");
    expect(close.status).toBe("ready");
    const plan = planAutoMix({
      outgoing,
      incoming: close,
      outgoingDuration: 40,
      outgoingTime: 35,
      reason: "track-ended",
      canCrossfade: true,
      sameAlbum: false,
      config: { enabled: true, level: "standard", crossfadeSeconds: 0 },
    });
    expect(plan.apply).toBe(true);
    expect(plan.tier).toBe("beat-align");
    // The blend length is a whole number of beats at the OUTGOING tempo, near
    // the 5s default the planner uses when no crossfade length is set.
    const beat = 60 / outgoing.bpm;
    const beats = plan.seconds / beat;
    expect(beats).toBeGreaterThan(9.5);
    expect(beats).toBeLessThan(12.5);
    expect(Math.abs(beats - Math.round(beats))).toBeLessThan(0.02);
    expect(plan.seconds).toBeGreaterThan(4);
    expect(plan.seconds).toBeLessThan(6.5);
    // It must fit before the end of the track and be reachable by the arming
    // window (`min(20, seconds + 12)`), or the engine would fire it instantly.
    expect(plan.leadSeconds).toBeGreaterThan(plan.seconds - 0.001);
    expect(plan.leadSeconds).toBeLessThan(40);
    expect(plan.incomingStart).toBeGreaterThanOrEqual(0);
    expect(plan.tempoMatched).toBe(false);
  });

  test("a tempo gap wider than the engine can fix falls back, with a reason", () => {
    const plan = planAutoMix({
      outgoing,
      incoming: far,
      outgoingDuration: 40,
      outgoingTime: 35,
      reason: "track-ended",
      canCrossfade: true,
      sameAlbum: false,
      config: { enabled: true, level: "standard", crossfadeSeconds: 0 },
    });
    expect(plan.apply).toBe(false);
    expect(plan.tier).toBe("crossfade");
    expect(plan.refusal).toMatch(/BPM|tempo/i);
  });

  test("the same inputs always produce the same plan", () => {
    const make = () =>
      planAutoMix({
        outgoing,
        incoming: close,
        outgoingDuration: 40,
        outgoingTime: 35,
        reason: "track-ended",
        canCrossfade: true,
        sameAlbum: false,
        config: { enabled: true, level: "standard", crossfadeSeconds: 0 },
      });
    expect(make()).toEqual(make());
  });
});
