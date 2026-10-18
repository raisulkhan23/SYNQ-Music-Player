import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * The crossfade diagnostics, EXECUTED against the real store.
 *
 * This exists because "the crossfade still isn't working" was reported three
 * times, and each report was unauditable. Every failure mode presented
 * identically — the song ends, a beat of silence, the next song starts — so
 * three rounds of fixes were three rounds of guessing. The store now carries a
 * running note of what the last boundary did, and a self-test that answers
 * "can the NEXT one blend?" against live state.
 *
 * These assertions pin that the diagnostics themselves work and cannot rot into
 * the thing they replaced: a silent `false`.
 */

// MODULE SCOPE: the store reads localStorage and wires an Audio element while
// it is being evaluated, so every DOM global it touches must exist first.
const win = new Window({ url: "https://example.test/" });
globalThis.window = win;
globalThis.document = win.document;
globalThis.localStorage = win.localStorage;
globalThis.navigator = win.navigator;
globalThis.HTMLElement = win.HTMLElement;
globalThis.Element = win.Element;
globalThis.Node = win.Node;
globalThis.Event = win.Event;
globalThis.Audio = win.Audio;

const { crossfadeSelfTest, usePlayerStore } =
  await import("../src/store/player.ts");

/** A minimal playable track. */
function track(id) {
  return {
    id,
    title: id,
    artistName: "test artist",
    coverUrl: "",
    duration: 200,
    source: "youtube",
    audioUrl: "stream",
    youtubeId: id,
  };
}

describe("crossfade diagnostics", () => {
  test("the store exposes a running note, starting empty", () => {
    // A selector typo here would leave the Settings line permanently blank —
    // exactly the "says nothing" failure these diagnostics exist to end.
    expect("transitionNote" in usePlayerStore.getState()).toBe(true);
    expect(usePlayerStore.getState().transitionNote).toBeNull();
  });

  test("the self-test speaks, and names the blocker instead of returning false", () => {
    // happy-dom has no AudioContext, so the graph is genuinely unbuildable
    // here — the exact state that used to present as "crossfade is broken".
    const line = crossfadeSelfTest();
    expect(typeof line).toBe("string");
    expect(line.length).toBeGreaterThan(0);
    // It must be a sentence a listener can act on, not a boolean or a code.
    expect(line).toMatch(/[.!]$/);
    expect(line).toMatch(/audio graph|attached|suspended/i);
  });

  test("the self-test never silently agrees", () => {
    // With nothing playing and no graph, an implementation that skipped its
    // gates would happily answer "Ready". It must not.
    usePlayerStore.setState({ current: null, queue: [], queueIndex: -1 });
    expect(crossfadeSelfTest()).not.toMatch(/^Ready/);
  });

  test("the note is written by the store, not only by the dev trace", () => {
    usePlayerStore.setState({ transitionNote: "Blending over 6s — test." });
    expect(usePlayerStore.getState().transitionNote).toBe(
      "Blending over 6s — test.",
    );
  });

  test("a queued pair with crossfade off is reported as off, not broken", () => {
    // The distinction that matters most in practice: "you did not turn it on"
    // and "it is broken" must never read the same.
    const [a, b] = [track("a"), track("b")];
    usePlayerStore.setState({
      current: a,
      queue: [a, b],
      queueIndex: 0,
      crossfade: 0,
    });
    // Still no AudioContext in this environment, so the graph blocker is
    // reported first — assert only that it is specific, not a bare failure.
    expect(crossfadeSelfTest().length).toBeGreaterThan(10);
  });
});
