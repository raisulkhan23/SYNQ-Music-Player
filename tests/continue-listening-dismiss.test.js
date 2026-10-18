import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { readSource } from "./helpers/tailwind-css.js";

/**
 * Dismissing a "Continue listening" card.
 *
 * The complaint was a shelf holding a single stale, unplayable entry with no
 * way to get rid of it. A resume entry is an OFFER, not a record — without a
 * way to decline, the only options are to play it or scroll past it forever.
 *
 * The subtle part is the memo. `resumableItems` reads the saved position out
 * of localStorage, and clearing that writes to localStorage too — which React
 * cannot observe. So the card does not disappear on its own. That is why there
 * is a `resumeVersion` cache-busting key, and it is the whole reason this test
 * exists: a remove button that leaves the card on screen until a reload reads
 * as broken even though the data really was cleared.
 */

// MODULE SCOPE, not beforeAll: `src/store/player.ts` reads localStorage AND
// wires an Audio element while it is being evaluated, so every DOM global it
// touches has to exist before the dynamic import below. A beforeAll runs too
// late and the import throws.
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

// The store reads localStorage at MODULE EVALUATION time, so it has to be
// imported only once the DOM globals above exist — not in a beforeAll.
const { forgetResumePosition, peekResumePosition } =
  await import("../src/store/player.ts");

const KEY = "ss.resume";

/**
 * Seed the saved-position map directly.
 *
 * Deliberately writing the raw storage format rather than exporting a helper
 * from the store: a production export added purely for a test is a second API
 * to keep in sync, and this asserts the real persisted shape anyway.
 */
function seed(id, t) {
  const map = JSON.parse(win.localStorage.getItem(KEY) ?? "{}");
  map[id] = { t, at: Date.now() };
  win.localStorage.setItem(KEY, JSON.stringify(map));
}

describe("forgetting a resume position removes the card", () => {
  test("a saved position is what puts a card in the shelf", () => {
    win.localStorage.clear();
    seed("track-a", 120);
    expect(peekResumePosition("track-a", 300)).toBe(120);
  });

  test("after forgetting, the shelf no longer offers it", () => {
    win.localStorage.clear();
    seed("track-a", 120);
    expect(forgetResumePosition("track-a")).toBe(true);
    // This is the assertion the whole feature rests on: the shelf filters on
    // `peekResumePosition(...) > 0`, so a zero here removes the card.
    expect(peekResumePosition("track-a", 300)).toBe(0);
  });

  test("it touches nothing else in the map", () => {
    win.localStorage.clear();
    seed("track-a", 120);
    seed("track-b", 60);
    forgetResumePosition("track-a");
    expect(peekResumePosition("track-b", 300)).toBe(60);
  });

  test("it reports honestly instead of claiming a no-op", () => {
    win.localStorage.clear();
    // Nothing saved, so nothing was removed. A UI that says "Removed" here
    // would be lying, and the card would still be sitting there.
    expect(forgetResumePosition("never-seen")).toBe(false);
  });

  test("a blank id is refused rather than writing a junk key", () => {
    win.localStorage.clear();
    seed("track-a", 120);
    expect(forgetResumePosition("")).toBe(false);
    expect(forgetResumePosition("   ")).toBe(false);
    // The map must be exactly as it was: no "", no "   " entry.
    expect(
      Object.keys(JSON.parse(win.localStorage.getItem(KEY) ?? "{}")),
    ).toEqual(["track-a"]);
  });

  test("storage being unavailable does not throw at the menu", () => {
    // Private browsing with localStorage disabled. The card simply stays,
    // which is recoverable; an exception here would break the whole menu.
    //
    // Swapping the whole object is deliberate. An earlier version overrode
    // `getItem`/`setItem` on happy-dom's Storage, and it silently did nothing
    // — the proxy kept serving the real implementation, so the test exercised
    // the happy path and passed while proving nothing. Measured, not assumed.
    const original = globalThis.localStorage;
    const denied = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
      removeItem() {
        throw new Error("denied");
      },
    };
    globalThis.localStorage = denied;
    let threw = false;
    let result = null;
    try {
      result = forgetResumePosition("track-a");
    } catch {
      threw = true;
    }
    globalThis.localStorage = original;

    expect(threw).toBe(false);
    // And it must not claim success for something it could not do.
    expect(result).toBe(false);
  });

  test("a successful removal really does report true", () => {
    // Guards the test above: if every call returned false, "did not throw"
    // would pass for the wrong reason.
    win.localStorage.clear();
    seed("track-a", 120);
    expect(forgetResumePosition("track-a")).toBe(true);
  });

  test("playing a track again brings it back", () => {
    // Deliberate: the listener chose to return to it, so the app offers it
    // again. Dismissal is not a permanent ban — that is what "Not interested"
    // is for, and having both would mean one silently overrode the other.
    win.localStorage.clear();
    seed("track-a", 120);
    forgetResumePosition("track-a");
    expect(peekResumePosition("track-a", 300)).toBe(0);
    seed("track-a", 200);
    expect(peekResumePosition("track-a", 300)).toBe(200);
  });
});

describe("the shelf offers the action and uses it", () => {
  const home = readSource("src/pages/Home.tsx");

  test("there is a remove entry on the card", () => {
    expect(home).toContain("Remove from Continue listening");
  });

  test("it is wired to the store function, not a local set", () => {
    // A local "hidden" set would look identical in the UI and then lose the
    // removal on reload, and would also stop the card returning if the
    // listener genuinely came back to the track.
    expect(home).toContain("forgetResumePosition(item.id)");
  });

  test("the shelf recomputes when a position is cleared", () => {
    // localStorage is not reactive, so without a cache-busting dependency the
    // dismissed card stays on screen until a reload.
    //
    // Asserted on the DEPENDENCY ARRAY specifically. An earlier version of
    // this test only checked that the strings "resumeVersion" and
    // "setResumeVersion" appeared somewhere in the file — which they still do,
    // in the useState declaration. So deleting the memo dependency, the exact
    // bug, left the suite green. Scoping to the array is what makes it real.
    const memo = home.slice(
      home.indexOf("const resumableItems"),
      home.indexOf("const dismissResume"),
    );
    // The dep array is the thing that must name it…
    expect(memo).toMatch(/\[historyItems,\s*resumeVersion\]/);
    // …and something has to actually bump it, which happens in the handler
    // just after the memo, not inside it.
    const handler = home.slice(home.indexOf("const dismissResume"));
    expect(handler.slice(0, 600)).toContain("setResumeVersion");
  });

  test("it clears the position and NOT the play history", () => {
    // Wiping history would quietly poison the recommender, which reads the
    // same play and signal rows. "Don't show me this in one shelf" is not
    // "pretend I never listened to it".
    const store = readSource("src/store/player.ts");
    const fn = store.slice(
      store.indexOf("export function forgetResumePosition"),
      store.indexOf("// --- smart-shuffle memory"),
    );
    expect(fn).not.toMatch(/deleteHistory|clearHistory|playHistory/);
  });

  test("a failure is reported rather than silently doing nothing", () => {
    expect(home).toContain("Couldn't remove that here");
  });
});
