import { beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * The melo-derived audio features: the 10-band graphic EQ, tape-style pitch,
 * reverb, distortion and volume normalization.
 *
 * happy-dom has no Web Audio, so the graph never builds here — and that is
 * exactly the point of most of these tests. Every setter must work (and be
 * readable back) BEFORE any graph exists, because a settings restore runs at
 * startup, before any user gesture. The state the setters hold is what a
 * later successful `ensureGraph()` would paint onto the nodes, so testing the
 * state is testing the feature; a graph-node test would need a real browser.
 *
 * The honest degraded state is asserted too: with no graph, the setters must
 * not throw, and `hasAudioProcessing()` must still report the truth so the
 * player routes playback through the <audio> element when it can.
 */

let win;
let audio;

beforeAll(async () => {
  win = new Window({ url: "https://example.test/" });
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.navigator = win.navigator;
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.Audio = win.Audio;
  // Fresh module instance — the audio module memoises decks and state on the
  // window/module, and other test files already built it against their own
  // happy-dom document. See audio-decks.test.js for the full story.
  audio = await import(`../src/lib/audio.ts?fresh=${Math.random()}`);
});

describe("the 10-band graphic EQ", () => {
  test("exposes the melo band plan: 10 one-octave bands, 32 Hz to 16 kHz", () => {
    expect(audio.EQ_BAND_FREQUENCIES).toHaveLength(10);
    expect([...audio.EQ_BAND_FREQUENCIES]).toEqual([
      32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
    ]);
  });

  test("every band starts flat and reads back after being set", () => {
    expect(audio.getEqBands()).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    audio.setEqBand(1, 6);
    expect(audio.getEqBands()[1]).toBe(6);
    audio.setEqBand(1, 0);
  });

  test("band gains are clamped to ±12 dB — no out-of-range node writes", () => {
    audio.setEqBand(0, 99);
    expect(audio.getEqBands()[0]).toBe(12);
    audio.setEqBand(0, -99);
    expect(audio.getEqBands()[0]).toBe(-12);
    audio.setEqBand(0, 0);
  });

  test("an out-of-range band index is ignored, not thrown or written", () => {
    const before = audio.getEqBands();
    audio.setEqBand(-1, 5);
    audio.setEqBand(10, 5);
    audio.setEqBand(999, 5);
    expect(audio.getEqBands()).toEqual(before);
  });

  test("setEqBands applies a whole curve (the persistence restore path)", () => {
    audio.setEqBands([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(audio.getEqBands()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    audio.resetEqBands();
    expect(audio.getEqBands()).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  test("a boosted band counts as audio processing, so playback routes to the deck", () => {
    audio.setEqBand(2, 4);
    expect(audio.hasAudioProcessing()).toBe(true);
    audio.setEqBand(2, 0);
    expect(audio.hasAudioProcessing()).toBe(false);
  });

  test("setters never throw without a Web Audio graph", () => {
    // happy-dom has no AudioContext, so ensureGraph fails here; the setters
    // must hold state anyway (a later graph paints it onto the nodes).
    expect(() => audio.setEqBand(3, 5)).not.toThrow();
    expect(() => audio.setEqBands([1, 1, 1, 1, 1, 1, 1, 1, 1, 1])).not.toThrow();
    expect(() => audio.resetEqBands()).not.toThrow();
    audio.resetEqBands();
  });
});

describe("tape-style pitch", () => {
  test("pitch is clamped to ±12 semitones and read back", () => {
    audio.setDeckPitch(19);
    expect(audio.getDeckPitch()).toBe(12);
    audio.setDeckPitch(-30);
    expect(audio.getDeckPitch()).toBe(-12);
    audio.setDeckPitch(3.9);
    expect(audio.getDeckPitch()).toBe(4); // whole semitones only
    audio.setDeckPitch(0);
    expect(audio.getDeckPitch()).toBe(0);
  });

  test("rate is remembered so pitch composes with speed on both decks", () => {
    // The observable contract: after setRate(1.5) + setDeckPitch(+2), the
    // deck's playbackRate is 1.5 × 2^(2/12) ≈ 1.687, with pitch preservation
    // OFF (that is what makes it raise the key). With pitch 0 the listener's
    // preserve preference rules again.
    const deck = audio.getAudio();
    audio.setDeckRate(1.5);
    audio.setRatePreservesPitch(true);
    audio.setDeckPitch(2);
    expect(deck.playbackRate).toBeCloseTo(1.5 * Math.pow(2, 2 / 12), 5);
    expect(deck.preservesPitch).toBe(false);
    audio.setDeckPitch(0);
    expect(deck.playbackRate).toBeCloseTo(1.5, 5);
    expect(deck.preservesPitch).toBe(true);
    audio.setDeckRate(1);
  });

  test("pitch counts as audio processing so the IFrame path re-resolves", () => {
    audio.setDeckPitch(-5);
    expect(audio.hasAudioProcessing()).toBe(true);
    audio.setDeckPitch(0);
    expect(audio.hasAudioProcessing()).toBe(false);
  });
});

describe("reverb and distortion", () => {
  test("reverb mix is clamped to 0..1 and reports audio processing when wet", () => {
    audio.setReverbMix(5);
    expect(audio.getReverbMix()).toBe(1);
    audio.setReverbMix(-1);
    expect(audio.getReverbMix()).toBe(0);
    audio.setReverbMix(0.35);
    expect(audio.getReverbMix()).toBeCloseTo(0.35, 5);
    expect(audio.hasAudioProcessing()).toBe(true);
    audio.setReverbMix(0);
    expect(audio.hasAudioProcessing()).toBe(false);
  });

  test("distortion is clamped to 0..100 and reports audio processing when driven", () => {
    audio.setDistortion(500);
    expect(audio.getDistortion()).toBe(100);
    audio.setDistortion(-5);
    expect(audio.getDistortion()).toBe(0);
    audio.setDistortion(40);
    expect(audio.hasAudioProcessing()).toBe(true);
    audio.setDistortion(0);
    expect(audio.hasAudioProcessing()).toBe(false);
  });

  test("vibe setters never throw without a graph", () => {
    expect(() => {
      audio.setReverbMix(0.3);
      audio.setDistortion(25);
      audio.setReverbMix(0);
      audio.setDistortion(0);
    }).not.toThrow();
  });
});

describe("volume normalization", () => {
  test("toggles read back and count as processing while enabled", () => {
    audio.setVolumeNormalization(true);
    expect(audio.isVolumeNormalizationEnabled()).toBe(true);
    expect(audio.hasAudioProcessing()).toBe(true);
    audio.setVolumeNormalization(false);
    expect(audio.isVolumeNormalizationEnabled()).toBe(false);
    expect(audio.hasAudioProcessing()).toBe(false);
  });

  test("toggling never throws without a graph, and enabling does not lie about one", () => {
    // ensureGraph fails under happy-dom (no AudioContext) — the toggle must
    // hold the REQUESTED state regardless, because the startup restore runs
    // before any gesture and a later graph honours it.
    expect(() => audio.setVolumeNormalization(true)).not.toThrow();
    expect(() => audio.setVolumeNormalization(false)).not.toThrow();
    expect(audio.isVolumeNormalizationEnabled()).toBe(false);
  });
});
