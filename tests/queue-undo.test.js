import { describe, expect, test } from 'vitest';
import { Window } from "happy-dom";
import { setGlobal } from "./helpers/globals.js";

/**
 * Clearing the queue, and undoing it — EXECUTED against the real store.
 *
 * "Clear queue" drops everything Up Next in a single tap, including autoplay
 * picks the recommendation engine chose and cannot regenerate. The Undo in the
 * toast is therefore the only way back, and it has to restore the ACTUAL
 * previous queue — not a fresh set of suggestions dressed up as one. A fake
 * Undo (a toast that shows "Undo" and does nothing meaningful) is exactly the
 * kind of thing this file exists to prevent.
 *
 * The store is imported for real here rather than sliced as text, because the
 * behaviour under test lives in the queue bookkeeping (`lastCleared`,
 * `queueIndex`, the shuffle snapshot) that only exists at runtime.
 */

// MODULE SCOPE: the store reads localStorage and wires an Audio element while
// it is being evaluated, so every DOM global it touches must exist first.
const win = new Window({ url: "https://example.test/" });
globalThis.window = win;
globalThis.document = win.document;
globalThis.localStorage = win.localStorage;
setGlobal("navigator", win.navigator);
globalThis.HTMLElement = win.HTMLElement;
globalThis.Element = win.Element;
globalThis.Node = win.Node;
globalThis.Event = win.Event;
globalThis.Audio = win.Audio;

const { usePlayerStore } = await import("../src/store/player.ts");

/** A minimal playable track; only the queue bookkeeping is under test. */
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

describe("clearing the queue can really be undone", () => {
  test("undo restores the exact queue, index and shuffle snapshot", () => {
    const [a, b, c] = [track("a"), track("b"), track("c")];
    usePlayerStore.setState({
      queue: [a, b, c],
      queueIndex: 0,
      current: a,
      unshuffledQueue: [a, b, c],
      unshuffledIndex: 0,
    });

    usePlayerStore.getState().clearQueue();
    let s = usePlayerStore.getState();
    // Clear keeps only what is playing; everything Up Next is gone.
    expect(s.queue.map((t) => t.id)).toEqual(["a"]);
    expect(s.queueIndex).toBe(0);

    usePlayerStore.getState().undoClearQueue();
    s = usePlayerStore.getState();
    // Restored exactly, not "re-recommended".
    expect(s.queue.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(s.queueIndex).toBe(0);
    // The shuffle snapshot has to come back too, or turning shuffle off after
    // an Undo would silently drop the restored tracks again.
    expect(s.unshuffledQueue?.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(s.unshuffledIndex).toBe(0);
  });

  test("undo is one-shot and cannot resurrect after the queue moved on", () => {
    const [a, b] = [track("a"), track("b")];
    usePlayerStore.setState({
      queue: [a, b],
      queueIndex: 0,
      current: a,
      unshuffledQueue: null,
      unshuffledIndex: -1,
    });

    usePlayerStore.getState().clearQueue();
    usePlayerStore.getState().undoClearQueue();
    expect(usePlayerStore.getState().queue.map((t) => t.id)).toEqual([
      "a",
      "b",
    ]);

    // The snapshot is consumed. A later remove cannot be undone by the stale
    // clear snapshot, and a second `undoClearQueue` must be a no-op.
    usePlayerStore.getState().removeFromQueue(1);
    expect(usePlayerStore.getState().queue.map((t) => t.id)).toEqual(["a"]);
    usePlayerStore.getState().undoClearQueue();
    expect(usePlayerStore.getState().queue.map((t) => t.id)).toEqual(["a"]);
  });

  test("without a prior clear, undo does nothing", () => {
    const a = track("a");
    usePlayerStore.setState({
      queue: [a],
      queueIndex: 0,
      current: a,
      unshuffledQueue: null,
      unshuffledIndex: -1,
    });
    // `undoClearQueue` before any clear must be inert, not clear-to-empty or
    // throw.
    usePlayerStore.getState().undoClearQueue();
    expect(usePlayerStore.getState().queue.map((t) => t.id)).toEqual(["a"]);
  });
});
