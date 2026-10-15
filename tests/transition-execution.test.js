import { beforeAll, describe, expect, test, vi } from 'vitest';
import { Window } from "happy-dom";
import {
  canHandOffGapless,
  fadeGains,
  GAPLESS_MIN_READY_STATE,
  isDeckSource,
} from "../src/lib/transition.ts";

/**
 * The transition ENGINE, executed.
 *
 * `crossfade-engine.test.js` and `song-transitions.test.js` pin the transition
 * code down as SHAPE: they regex the source for strings like
 * `if (incoming.readyState < 2)` and `linearRampToValueAtTime`. That proves the
 * text was written, not that it runs — and shape assertions cannot see the two
 * classes of defect this feature keeps producing:
 *
 *   1. the decision is right but the value that reaches the audio graph is
 *      wrong (the equal-power curve was computed and then thrown away, leaving
 *      a straight-line fade), and
 *   2. the mechanism works once and is dead afterwards (a released deck losing
 *      its graph nodes).
 *
 * So this file drives the REAL `src/lib/audio.ts` against a recording Web Audio
 * graph and the REAL `canHandOffGapless` gate, and asserts on what actually got
 * scheduled and on what the decks look like afterwards.
 *
 * Everything below the fade is faked on purpose: happy-dom has no media engine
 * and no `AudioContext`. The fakes record rather than simulate, so the
 * assertions are about SYNQ's own decisions, not about the stub.
 */

// --- a recording Web Audio graph ---------------------------------------------

class FakeParam {
  constructor() {
    this.value = 1;
    this.events = [];
    /** Set when the implementation hands Web Audio a SAMPLED curve. */
    this.curve = null;
  }
  cancelScheduledValues(t) {
    this.events.push({ type: "cancel", t });
  }
  setValueAtTime(v, t) {
    this.value = v;
    this.events.push({ type: "setValueAtTime", v, t });
  }
  linearRampToValueAtTime(v, t) {
    this.value = v;
    this.events.push({ type: "linearRamp", v, t });
  }
  setValueCurveAtTime(values, t, duration) {
    const copy = Float32Array.from(values);
    this.curve = { values: copy, t, duration };
    this.value = copy[copy.length - 1];
    this.events.push({ type: "curve", t, duration });
  }
}

class FakeNode {
  constructor(kind) {
    this.kind = kind;
    this.outputs = [];
    this.disconnected = false;
  }
  connect(dst) {
    this.outputs.push(dst);
    return dst;
  }
  disconnect() {
    this.disconnected = true;
  }
}

class FakeGain extends FakeNode {
  constructor() {
    super("gain");
    this.gain = new FakeParam();
  }
}

class FakeBiquad extends FakeNode {
  constructor() {
    super("biquad");
    this.type = "peaking";
    this.frequency = new FakeParam();
    this.gain = new FakeParam();
    this.Q = new FakeParam();
  }
}

class FakePanner extends FakeNode {
  constructor() {
    super("panner");
    this.pan = new FakeParam();
  }
}

class FakeAnalyser extends FakeNode {
  constructor() {
    super("analyser");
    this.fftSize = 2048;
    this.frequencyBinCount = 1024;
  }
  getByteTimeDomainData(out) {
    out.fill(128);
  }
}

/** Every context built during the run, so the deck gain nodes can be found. */
const contexts = [];

class FakeAudioContext {
  constructor() {
    this.state = "running";
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.destination = new FakeNode("destination");
    /** Gains in creation order: [fxIn, gainOut, deckA, deckB]. */
    this.createdGains = [];
    this.capturedElements = [];
    // The spec allows exactly ONE MediaElementSource per ELEMENT, ever. The
    // fake enforces it, because that constraint is the whole reason a released
    // deck could not be re-attached and crossfade died after one use.
    this._captured = new WeakSet();
    contexts.push(this);
  }
  createGain() {
    const g = new FakeGain();
    this.createdGains.push(g);
    return g;
  }
  createBiquadFilter() {
    return new FakeBiquad();
  }
  createStereoPanner() {
    return new FakePanner();
  }
  createAnalyser() {
    return new FakeAnalyser();
  }
  createMediaElementSource(el) {
    if (this._captured.has(el)) {
      const err = new Error("HTMLMediaElement already connected");
      err.name = "InvalidStateError";
      throw err;
    }
    this._captured.add(el);
    this.capturedElements.push(el);
    const node = new FakeNode("media-element-source");
    node.element = el;
    return node;
  }
  resume() {
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    this.state = "closed";
    return Promise.resolve();
  }
}

/**
 * A context missing the OPTIONAL Web Audio APIs.
 *
 * This is what older Safari and a number of WebViews actually look like, and
 * it is the configuration that made crossfade a hard cut on real devices while
 * every test here stayed green: the shared `FakeAudioContext` implemented
 * `createStereoPanner`, so no test ever exercised its absence.
 *
 * Setting the prototype properties to `undefined` models "the API does not
 * exist" faithfully — `typeof ctx.createStereoPanner` becomes `"undefined"`,
 * which is precisely the guard the production code now uses.
 */
class BareAudioContext extends FakeAudioContext {
  createStereoPanner() {
    return undefined;
  }
  createAnalyser() {
    return undefined;
  }
}
BareAudioContext.prototype.createStereoPanner = undefined;
BareAudioContext.prototype.createAnalyser = undefined;

// MODULE SCOPE, not beforeAll: `audio.ts` reads `window`/`document` while it is
// being evaluated, so the DOM globals must exist before the dynamic import.
const win = new Window({ url: "https://example.test/" });
globalThis.window = win;
globalThis.document = win.document;
try { Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true, writable: true }); } catch (e) { Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true }); }
globalThis.localStorage = win.localStorage;
globalThis.HTMLElement = win.HTMLElement;
globalThis.Element = win.Element;
globalThis.Node = win.Node;
globalThis.Event = win.Event;
globalThis.Audio = win.Audio;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};
win.AudioContext = FakeAudioContext;

// A fresh module instance: `decks` is memoised at module scope, so sharing an
// instance with another test file would hand back elements belonging to a
// document that no longer exists.
//
// `vi.resetModules()` between imports, not a cache-busted
// `import(\`../src/lib/audio.ts?fresh=${Math.random()}\`)`: a template-literal
// specifier is a VARIABLE dynamic import, which the bundler refuses to resolve
// ("Unknown variable dynamic import") so the file never loaded at all.
// Dropping the module registry gives the same thing on purpose — each import
// below re-evaluates `audio.ts` into its own instance.
vi.resetModules();
const audio = await import("../src/lib/audio.ts");

/** A SECOND, independent instance, driven by the API-less context above. */
vi.resetModules();
const audioBare = await import("../src/lib/audio.ts");

/** A THIRD instance that never builds a graph, to observe the "no graph" reason. */
vi.resetModules();
const audioNoGraph = await import("../src/lib/audio.ts");

/**
 * The two per-deck transition GainNodes, found by CREATION ORDER:
 * `ensureGraph()` creates `fxIn` and `gainOut` first, then one gain per deck in
 * `[a, b]` order. Asserted against `createdGains.length` below so a future
 * reorder fails loudly here instead of silently pointing at the wrong node.
 */
let deckGainA;
let deckGainB;

beforeAll(() => {
  expect(audio.ensureGraph()).toBe(true);
  const ctx = contexts.at(-1);
  expect(ctx.createdGains.length).toBe(4);
  deckGainA = ctx.createdGains[2];
  deckGainB = ctx.createdGains[3];
  expect(deckGainA.kind).toBe("gain");
  expect(deckGainB.kind).toBe("gain");
});

describe("an executed crossfade", () => {
  test("the graph is built and both decks can blend", () => {
    // The premise: a graph that reaches `destination` with a gain on each deck.
    expect(audio.canCrossfadeNow()).toBe(true);
    expect(contexts.at(-1).capturedElements).toHaveLength(2);
  });

  test("Web Audio is handed the SAMPLED equal-power curve, not a straight line", () => {
    const ok = audio.scheduleCrossfade("a", "b", 6, fadeGains);
    expect(ok).toBe(true);

    const outCurve = deckGainA.gain.curve;
    const inCurve = deckGainB.gain.curve;
    expect(outCurve).not.toBeNull();
    expect(inCurve).not.toBeNull();
    expect(outCurve.duration).toBeCloseTo(6, 5);

    const steps = outCurve.values.length;
    expect(steps).toBeGreaterThan(2);
    expect(inCurve.values.length).toBe(steps);

    // Every sample is the equal-power curve — the outgoing cos and the
    // incoming sin of the SAME angle. This is the assertion the old
    // implementation failed: it computed these arrays and then scheduled a
    // pair of linear ramps between their endpoints, so only index 0 and
    // steps-1 ever reached the graph.
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      expect(outCurve.values[i]).toBeCloseTo(fadeGains(t).outgoing, 5);
      expect(inCurve.values[i]).toBeCloseTo(fadeGains(t).incoming, 5);
    }

    // Constant power across the WHOLE blend: sin^2 + cos^2 = 1. A linear fade
    // sums to 0.5 in the middle, which is the audible ~6dB sag.
    for (let i = 0; i < steps; i++) {
      const power = outCurve.values[i] ** 2 + inCurve.values[i] ** 2;
      expect(power).toBeCloseTo(1, 5);
    }

    // Explicitly not a straight line: the midpoint is ~0.707, not 0.5. A
    // regression to `linearRampToValueAtTime` between the endpoints leaves no
    // curve at all, and a "curve" of [1, 0] would put 0.5 here.
    const mid = Math.round((steps - 1) / 2);
    expect(Math.abs(outCurve.values[mid] - 0.5)).toBeGreaterThan(0.15);
    expect(outCurve.values[mid]).toBeCloseTo(Math.SQRT1_2, 2);
    expect(inCurve.values[mid]).toBeCloseTo(Math.SQRT1_2, 2);
  });

  test("the fade is scheduled as automation on the deck gains, not stepped", () => {
    // Clicking/zipper noise comes from stepping gain once per `timeupdate`.
    // Both decks must be driven by one scheduled event each.
    for (const node of [deckGainA, deckGainB]) {
      const types = node.gain.events.map((e) => e.type);
      expect(types).toContain("curve");
      // Nothing is stepped sample-by-sample from JS.
      expect(types.filter((t) => t === "setValueAtTime").length).toBe(0);
    }
  });

  test("a released deck stays blendable, so crossfade runs more than once", () => {
    // The old `releaseDeck` disconnected the MediaElementSource and nulled the
    // gain, so the released deck was silent forever and `canCrossfadeNow()`
    // (needing a gain on BOTH decks) went false — crossfade ran at most once
    // per page load. Executed: release a deck, then blend again.
    const outgoing = audio.activeDeckSlot();
    const spare = audio.spareDeckSlot();
    expect(outgoing).toBe("a");

    // Park the incoming deck silent, the way `maybeRunCrossfade` does.
    audio.setDeckGainNow(spare, 0);
    expect(deckGainB.gain.events.length).toBeGreaterThan(0);

    const promoted = audio.swapActiveDeck();
    expect(promoted).toBeTruthy();
    expect(audio.activeDeckSlot()).toBe(spare);

    audio.releaseDeck(outgoing);
    audio.resetAllDeckGains();

    // The graph survives the release…
    expect(deckGainA.disconnected).toBe(false);
    expect(deckGainA.gain).toBeTruthy();
    expect(audio.canCrossfadeNow()).toBe(true);

    // …so a SECOND crossfade still schedules. This is the regression the
    // source-text test could only describe.
    const again = audio.scheduleCrossfade(spare, outgoing, 4, fadeGains);
    expect(again).toBe(true);
    expect(deckGainA.gain.curve).not.toBeNull();
    expect(deckGainA.gain.curve.duration).toBeCloseTo(4, 5);
  });
});

describe("refusals name themselves", () => {
  test("a running graph reports itself as ready", () => {
    expect(audio.crossfadeReadiness()).toEqual({ ok: true });
  });

  test("a module with no graph says so, instead of returning a bare false", () => {
    // `canCrossfadeNow()` collapses "never built", "suspended" and "deck
    // detached" into one `false`. The UI now has to name which one it is.
    const readiness = audioNoGraph.crossfadeReadiness();
    expect(readiness.ok).toBe(false);
    expect(readiness).toEqual({ ok: false, reason: "no-graph" });
    // And the boolean wrapper still agrees with it.
    expect(audioNoGraph.canCrossfadeNow()).toBe(false);
  });
});

describe("a browser missing the optional Web Audio APIs", () => {
  // The regression that shipped a broken crossfade to real devices: an
  // unguarded `createStereoPanner()` threw, `ensureGraph()` nulled every node,
  // the decks were never captured (so playback sounded completely normal,
  // straight to the speakers), and `canCrossfadeNow()` was then false for the
  // rest of the session — every track ending in a hard cut, silently.
  test("the graph still builds without createStereoPanner", () => {
    const previous = win.AudioContext;
    win.AudioContext = BareAudioContext;
    try {
      expect(audioBare.ensureGraph()).toBe(true);
      expect(audioBare.audioGraphFailed()).toBe(false);
    } finally {
      win.AudioContext = previous;
    }
  });

  test("and a real crossfade can still be scheduled on it", () => {
    const previous = win.AudioContext;
    win.AudioContext = BareAudioContext;
    try {
      audioBare.ensureGraph();
      // The decisive assertion: the fade is scheduled, not refused.
      expect(audioBare.canCrossfadeNow()).toBe(true);
      const ok = audioBare.scheduleCrossfade("a", "b", 6, fadeGains);
      expect(ok).toBe(true);
      const gains = contexts.at(-1).createdGains;
      const curve = gains.at(-2).gain.curve;
      expect(curve).not.toBeNull();
      expect(curve.values.length).toBeGreaterThan(2);
      // And it is still the equal-power curve, not a straight line.
      expect(Math.abs(curve.values[0] - 1)).toBeLessThan(1e-9);
      expect(Math.abs(curve.values.at(-1))).toBeLessThan(1e-9);
    } finally {
      win.AudioContext = previous;
    }
  });

  test("balance degrades to neutral instead of taking the graph down", () => {
    // The fallback node is a plain GainNode with no `pan`. Writing pan to it
    // must be a no-op, not a throw that kills the chain.
    const previous = win.AudioContext;
    win.AudioContext = BareAudioContext;
    try {
      audioBare.ensureGraph();
      expect(() => audioBare.setEqBalance(0.8)).not.toThrow();
      expect(() => audioBare.setEqMono(true)).not.toThrow();
      expect(() => audioBare.setEqBass(4)).not.toThrow();
    } finally {
      win.AudioContext = previous;
    }
  });
});

describe("an executed gapless hand-off", () => {
  describe("the readiness gate", () => {
    const ready = {
      preparedFor: "track-b",
      trackId: "track-b",
      currentSrc: "https://media.example.test/audio/track-b",
      readyState: GAPLESS_MIN_READY_STATE,
    };

    test("a buffered, resolved, correctly-prepared track is ready", () => {
      expect(GAPLESS_MIN_READY_STATE).toBe(2);
      expect(canHandOffGapless(ready)).toEqual({ ready: true });
    });

    test("a track that was never preloaded is refused, and says why", () => {
      const out = canHandOffGapless({ ...ready, preparedFor: "another" });
      expect(out.ready).toBe(false);
      expect(out.because).toBe("nothing preloaded");
    });

    test("an unresolved source is refused, and says why", () => {
      // `"stream"` stays in this list on purpose: it is a MARKER meaning
      // "resolve this", not a URL. An element's `currentSrc` is never literally
      // that, so seeing it means the source genuinely was never resolved.
      for (const src of [null, "", undefined, "stream", "  "]) {
        const out = canHandOffGapless({ ...ready, currentSrc: src });
        expect(out.ready).toBe(false);
        expect(out.because).toBe("no resolved src");
      }
    });

    test("a DOWNLOADED copy is a resolved source", () => {
      // This assertion used to be the opposite, and the old expectation was the
      // bug rather than the specification: a `blob:` URL is the object URL for
      // a copy of the track the app already downloaded to disk. It is fully
      // buffered, it is local, and it is played by the same `<audio>` element
      // as any streamed track — so refusing to hand off to it meant gapless
      // silently never applied to a single downloaded song, which is precisely
      // the music a listener expects to run seamlessly.
      //
      // It is not a weakening of the gate: the deck must still have been
      // prepared AND still be buffered, which the surrounding tests assert.
      const out = canHandOffGapless({
        ...ready,
        currentSrc: "blob:https://example.test/8f2a-1c",
      });
      expect(out.ready).toBe(true);
    });

    test("a buffer below HAVE_CURRENT_DATA is refused", () => {
      // Starting here stalls mid-note — worse than the gap gapless removes.
      for (const state of [0, 1]) {
        const out = canHandOffGapless({ ...ready, readyState: state });
        expect(out.ready).toBe(false);
        expect(out.because).toBe("not buffered");
      }
      // HAVE_CURRENT_DATA is the first state with something decoded to play.
      expect(
        canHandOffGapless({ ...ready, readyState: GAPLESS_MIN_READY_STATE })
          .ready,
      ).toBe(true);
      expect(canHandOffGapless({ ...ready, readyState: 4 }).ready).toBe(true);
    });

    test("the source predicate is ONE rule, shared by both consumers", () => {
      // The defect this pins: the gapless gate and the crossfade readiness
      // check each had their own copy of "is this a real source", written as
      // `startsWith("http")`, while `prepareIncoming` used a third that also
      // accepted `blob:`. They disagreed, and nothing compared them — so a
      // downloaded track was refused at the boundary while being loaded
      // perfectly well beforehand.
      expect(isDeckSource("https://media.example.test/a")).toBe(true);
      expect(isDeckSource("http://localhost:8787/audio-proxy?id=a")).toBe(true);
      expect(isDeckSource("blob:https://example.test/8f2a-1c")).toBe(true);
      // A marker, not a URL. An element's currentSrc is never literally this.
      expect(isDeckSource("stream")).toBe(false);
      expect(isDeckSource("")).toBe(false);
      expect(isDeckSource("   ")).toBe(false);
      expect(isDeckSource(null)).toBe(false);
      expect(isDeckSource(undefined)).toBe(false);
    });
  });

  test("the prepared deck becomes live with the graph intact", async () => {
    // Drive the hand-off the way `tryGaplessHandoff` does, against the real
    // module: start the buffered spare element, promote it, release the spent
    // outgoing deck. The point is that the track change leaves the audio graph
    // alive for the NEXT boundary.
    const outgoingSlot = audio.activeDeckSlot();
    const spareSlot = audio.spareDeckSlot();
    const incoming = audio.getSpareAudio();

    let played = false;
    incoming.play = () => {
      played = true;
      return Promise.resolve();
    };
    audio.setDeckGainNow(spareSlot, 1);

    await incoming.play();
    expect(played).toBe(true);

    audio.swapActiveDeck();
    audio.releaseDeck(outgoingSlot);
    audio.resetAllDeckGains();

    expect(audio.activeDeckSlot()).toBe(spareSlot);
    // The hand-off did not tear the graph down: the next boundary can still
    // blend or hand off.
    expect(audio.canCrossfadeNow()).toBe(true);
  });
});
