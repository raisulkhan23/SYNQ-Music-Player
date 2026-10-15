import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Window } from "happy-dom";

/**
 * The audio graph must never be able to silence the player.
 *
 * `createMediaElementSource` permanently diverts an `<audio>` element's output
 * into a Web Audio graph. Once it has been called for an element, that element
 * can NEVER sound on its own again — its audio exists only if the graph reaches
 * `destination`.
 *
 * The graph used to be built in the wrong order: the elements were captured
 * FIRST, and the chain to the speakers was wired afterwards. Any throw in
 * between (`createStereoPanner` is absent on older Safari and some WebViews)
 * left a captured element feeding nothing at all. `mediaSourceAttached` was
 * already true, so the catch block refused to close the context — and because
 * the flag is sticky for the life of the page, no later attempt could ever
 * clean up either. The retry then hit `InvalidStateError` on the already-claimed
 * element forever.
 *
 * The listener-visible result was exactly this: the progress bar advances,
 * `currentTime` moves, `isPlaying` is true — and there is no sound at all.
 *
 * These tests drive `ensureGraph` against a stub AudioContext that can be told
 * to fail at any node factory, and assert the invariant that actually matters:
 * **a failed build must never leave an element captured.**
 */

let win;
let audio;

/** Records what the graph was asked to do, so leaks are observable. */
const log = {
  captured: 0,
  closed: 0,
  resumed: 0,
  destinationWired: 0,
  order: [],
};

/** Factory kind that should throw, once, on its first use. */
let failOn = null;
let alreadyFailed = false;

/** Elements that have already been captured, per spec. */
const claimed = new WeakSet();

function makeParam() {
  return { value: 0, setValueAtTime() {}, cancelScheduledValues() {} };
}

function makeNode(kind) {
  // Fail on the FIRST use of the named factory. Counting to an Nth call would
  // make every assertion depend on the exact order of unrelated node
  // creations, which is not what these tests are about.
  if (failOn === kind && !alreadyFailed) {
    alreadyFailed = true;
    throw new Error(`synthetic ${kind} failure`);
  }
  const node = {
    kind,
    type: "",
    frequency: makeParam(),
    gain: makeParam(),
    Q: makeParam(),
    pan: makeParam(),
    fftSize: 0,
    outputs: [],
    connect(dest) {
      this.outputs.push(dest);
      if (dest === log.destinationRef) {
        log.destinationWired += 1;
        log.order.push("wired");
      }
      return dest;
    },
    disconnect() {},
    getByteTimeDomainData() {},
    getByteFrequencyData() {},
  };
  return node;
}

function installAudioContext() {
  log.captured = 0;
  log.closed = 0;
  log.resumed = 0;
  log.destinationWired = 0;
  log.order = [];
  alreadyFailed = false;

  const ctx = {
    state: "running",
    currentTime: 0,
    sampleRate: 48000,
    destination: (log.destinationRef = { kind: "destination" }),
    resume() {
      log.resumed += 1;
      return Promise.resolve();
    },
    close() {
      log.closed += 1;
      return Promise.resolve();
    },
    createMediaElementSource(el) {
      // The spec forbids a second source for the same element. Reproducing that
      // is what makes an orphaned graph permanently unfixable.
      if (claimed.has(el)) {
        const err = new Error("InvalidStateError");
        err.name = "InvalidStateError";
        throw err;
      }
      claimed.add(el);
      log.captured += 1;
      log.order.push("capture");
      return makeNode("MediaElementSource");
    },
    createBiquadFilter: () => makeNode("biquad"),
    createStereoPanner: () => makeNode("panner"),
    createGain: () => makeNode("gain"),
    createAnalyser: () => makeNode("analyser"),
  };

  win.AudioContext = function AudioContext() {
    return ctx;
  };
  globalThis.AudioContext = win.AudioContext;
}

beforeEach(async () => {
  // A fresh module registry per test: the audio module memoises its decks,
  // its AudioContext and its element map for the life of the page, and this
  // file asserts on exactly that state.
  //
  // `vi.resetModules()` is what actually makes that true — without it the
  // import below hands back the SAME instance for every test, `ensureGraph()`
  // short-circuits as already-built, and eight of the tests in this file passed
  // or failed on state left behind by whichever test ran first.
  vi.resetModules();
  win = new Window({ url: "https://example.test/" });
  globalThis.window = win;
  globalThis.document = win.document;
  try { Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true, writable: true }); } catch (e) { Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true }); } finally { Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true }); }
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.Audio = win.Audio;
  installAudioContext();
  audio = await import('../src/lib/audio.ts');
});

describe("a working graph", () => {
  test("captures both decks and reaches the speakers", async () => {
    expect(await audio.ensureGraph()).toBe(true);
    expect(log.captured).toBe(2);
    expect(log.destinationWired).toBe(1);
    expect(audio.isGraphReady()).toBe(true);
  });

  test("the chain is connected before anything is captured", async () => {
    // Ordering is the whole fix. If a build ever captures first again, this
    // fails even though every other test in this file still passes.
    expect(await audio.ensureGraph()).toBe(true);
    expect(log.order).toEqual(["wired", "capture", "capture"]);
  });
});

describe("a graph that fails to build", () => {
  // Every failure-prone factory, in the order the graph creates them. For each
  // one the invariant is identical: nothing was captured, so the elements can
  // still play straight to the speakers.
  //
  // `analyser` is deliberately NOT here any more. It sits INLINE in the chain
  // (gainOut → analyser → destination), and a missing/throwing analyser used
  // to abort the whole build — costing the listener their playback AND their
  // crossfading over a node that only drives the visualizer and the level
  // probe. The graph now wires straight to the destination instead; that case
  // has its own test below.
  const FAILURES = [
    ["biquad"], // the EQ shelves
    ["panner"], // a StereoPanner factory that throws
    ["gain"], // effects tap-in and the output stage
  ];

  for (const [kind] of FAILURES) {
    test(`a ${kind} failure captures nothing and closes the context`, async () => {
      failOn = kind;
      expect(await audio.ensureGraph()).toBe(false);
      expect(log.captured).toBe(0);
      expect(log.destinationWired).toBe(0);
      expect(log.closed).toBe(1);
      expect(audio.isGraphReady()).toBe(false);
    });
  }

  test("a retry after a failure can still succeed", async () => {
    failOn = "panner";
    expect(await audio.ensureGraph()).toBe(false);
    expect(log.captured).toBe(0);

    failOn = null;
    expect(await audio.ensureGraph()).toBe(true);
    expect(log.captured).toBe(2);
    expect(audio.isGraphReady()).toBe(true);
  });

  test("an analyser failure no longer costs playback or blending", async () => {
    // The analyser is inline in the chain, so it must degrade rather than abort:
    // audio still reaches the speakers, the decks are still captured, and a
    // crossfade is still schedulable. Losing a spectrum display the listener
    // cannot see must never cost them their music.
    failOn = "analyser";
    expect(await audio.ensureGraph()).toBe(true);
    expect(log.destinationWired).toBe(1);
    expect(log.captured).toBe(2);
    expect(audio.isGraphReady()).toBe(true);
    expect(audio.canCrossfadeNow()).toBe(true);
  });

  test("a captured element is never re-captured on retry", async () => {
    // The retry that used to make this permanent: a second
    // createMediaElementSource for the same element throws InvalidStateError
    // in a real browser. If a failure left the element captured, every
    // subsequent attempt would fail here and audio could never come back.
    // Uses `gain`, a factory whose failure genuinely aborts the build.
    failOn = "gain";
    expect(await audio.ensureGraph()).toBe(false);
    expect(log.captured).toBe(0);

    failOn = null;
    expect(await audio.ensureGraph()).toBe(true);
    expect(log.captured).toBe(2);
  });

  test("the deck elements stay usable for plain playback after a failure", async () => {
    // The property the whole thing is protecting: with nothing captured, the
    // elements are ordinary <audio> elements again and sound directly.
    failOn = "panner";
    expect(await audio.ensureGraph()).toBe(false);
    audio.getAudio();
    audio.getSpareAudio();
    expect(log.captured).toBe(0);
  });
});
