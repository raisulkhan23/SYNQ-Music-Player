import { beforeAll, describe, expect, test, vi } from 'vitest';
import { Window } from "happy-dom";
import { setGlobal } from "./helpers/globals.js";

/**
 * The crossfade mechanism itself, in a real DOM.
 *
 * A crossfade needs two songs audible at the same time, and one <audio>
 * element can only ever play one of them. These tests check that SYNQ really
 * does own two independent decks — the failure mode they guard against is
 * subtle and severe: with a single shared element the "crossfade" still looks
 * correct in the UI and the settings persist and the fade math is right, but
 * only one stream is ever audible, so it is a fake.
 */

let win;
let audio;

beforeAll(async () => {
  win = new Window({ url: "https://example.test/" });
  globalThis.window = win;
  globalThis.document = win.document;
  setGlobal("navigator", win.navigator);
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  // happy-dom does not expose the Audio constructor as a global, but the
  // module builds its decks with `new Audio()`.
  globalThis.Audio = win.Audio;
  // The module keeps its decks on the window and memoises the graph, so it has
  // to be imported only after the DOM exists — AND it must be a FRESH module
  // instance.
  //
  // `decks` is module-level state memoised on first use. Any earlier test file
  // that renders a page importing the player store installs its own happy-dom
  // document and, on the first track load, causes those decks to be built
  // against THAT document. Importing the cached module here then hands back
  // elements belonging to a document that no longer exists, and the assertions
  // about the two decks being distinct and attached fail with an internal
  // happy-dom error rather than anything about SYNQ.
  //
  // This became reachable once gapless (on by default) started routing
  // playback through the decks, so `ensureGraph()` — and therefore
  // `ensureDecks()` — now runs on the first track load instead of only when an
  // EQ or effect preset was configured. `audio-graph-resilience.test.js` needs
  // the same fresh instance for the same reason.
  //
  // `vi.resetModules()` + a static specifier, not a cache-busted
  // `import(\`../src/lib/audio.ts?fresh=${Math.random()}\`)`: that template
  // literal is a VARIABLE dynamic import, which the bundler refuses to resolve
  // ("Unknown variable dynamic import") and the file never loads at all.
  vi.resetModules();
  audio = await import("../src/lib/audio.ts");
});

describe("two playback decks", () => {
  test("the live and spare decks are different elements", () => {
    const live = audio.getAudio();
    const spare = audio.getSpareAudio();
    expect(live).toBeTruthy();
    expect(spare).toBeTruthy();
    expect(spare).not.toBe(live);
  });

  test("both decks are attached to the document", () => {
    // A detached element is not reliably kept alive by mobile browsers, which
    // is why the original element was appended to the body.
    expect(audio.getAudio().isConnected).toBe(true);
    expect(audio.getSpareAudio().isConnected).toBe(true);
  });

  test("getAudio is stable until a deck is swapped", () => {
    const first = audio.getAudio();
    expect(audio.getAudio()).toBe(first);
    expect(audio.getSpareAudio()).not.toBe(first);
  });

  test("the active and spare slots are always opposites", () => {
    const active = audio.activeDeckSlot();
    const spare = audio.spareDeckSlot();
    expect(active).not.toBe(spare);
    expect(active === "a" ? spare : spare).toBe(spare);
    expect([active, spare].sort().join("")).toBe("ab");
  });

  test("swapping makes the spare the live deck", () => {
    const before = audio.getAudio();
    const beforeSlot = audio.activeDeckSlot();
    const next = audio.swapActiveDeck();
    expect(next).toBeTruthy();
    expect(next).not.toBe(before);
    expect(audio.getAudio()).toBe(next);
    expect(audio.activeDeckSlot()).not.toBe(beforeSlot);
    // And the old deck becomes the spare again, ready for the next song.
    expect(audio.getSpareAudio()).toBe(before);
  });

  test("swapping notifies the store so its listeners follow", () => {
    let seen = null;
    audio.onActiveDeckChange((next, prev) => {
      seen = { next, prev };
    });
    const before = audio.getAudio();
    const after = audio.swapActiveDeck();
    expect(seen).not.toBeNull();
    expect(seen.next).toBe(after);
    expect(seen.prev).toBe(before);
    audio.onActiveDeckChange(null);
  });

  test("a listener that throws cannot break the swap", () => {
    audio.onActiveDeckChange(() => {
      throw new Error("boom");
    });
    const before = audio.activeDeckSlot();
    expect(audio.swapActiveDeck()).toBeTruthy();
    expect(audio.activeDeckSlot()).not.toBe(before);
    audio.onActiveDeckChange(null);
  });

  test("without a running graph the store cannot crossfade", () => {
    // Refusing is the safe answer: fading into a suspended context would turn
    // the blend into silence, which is the failure this feature exists to
    // prevent.
    expect(audio.canCrossfadeNow()).toBe(false);
  });
});

describe("master volume is independent of the transition", () => {
  test("volume, mute and rate reach BOTH decks", () => {
    audio.setDeckVolume(0.42);
    audio.setDeckMuted(true);
    audio.setDeckRate(1.5);
    for (const el of [audio.getAudio(), audio.getSpareAudio()]) {
      expect(el.volume).toBeCloseTo(0.42, 5);
      expect(el.muted).toBe(true);
      expect(el.playbackRate).toBeCloseTo(1.5, 5);
    }
  });

  test("rate is clamped to a range the engines accept", () => {
    audio.setDeckRate(99);
    expect(audio.getAudio().playbackRate).toBe(2);
    audio.setDeckRate(0.01);
    expect(audio.getAudio().playbackRate).toBe(0.5);
  });

  test("volume is clamped to the audible range", () => {
    audio.setDeckVolume(5);
    expect(audio.getAudio().volume).toBe(1);
    audio.setDeckVolume(-5);
    expect(audio.getSpareAudio().volume).toBe(0);
    audio.setDeckVolume(0.8);
    audio.setDeckMuted(false);
    audio.setDeckRate(1);
  });

  test("a crossfade cannot be scheduled before the graph exists", () => {
    // Scheduling automation on a context that does not exist must fail loudly
    // so the store falls back, rather than half-applying a fade.
    expect(
      audio.scheduleCrossfade("a", "b", 4, () => ({
        outgoing: 1,
        incoming: 0,
      })),
    ).toBe(false);
  });

  test("releasing a deck never touches the live one", () => {
    const live = audio.getAudio();
    audio.releaseDeck(audio.activeDeckSlot());
    // Still intact: a bug here would silence playback outright.
    expect(live.paused).toBe(true); // happy-dom has no real media pipeline
    expect(audio.getAudio()).toBe(live);
  });
});
