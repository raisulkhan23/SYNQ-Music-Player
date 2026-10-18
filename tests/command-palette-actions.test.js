import { describe, expect, test } from "bun:test";
import { readSource } from "./helpers/tailwind-css.js";

/**
 * The ⌘K palette's ACTIONS, rather than its affordance.
 *
 * `sidebar-search-hint.test.js` covers the button that OPENS the palette. This
 * covers what happens after: that every entry runs something the app already
 * does, and that nothing it advertises is a dead end.
 *
 * Two rules this file exists to enforce, both of which the palette violated
 * when it was smaller:
 *
 *   1. **No fake actions.** A command that names an action the store does not
 *      have would render, be selectable, and do nothing — the single worst
 *      failure mode a command menu has. Every store action the palette selects
 *      must exist.
 *   2. **No dead shortcuts.** The palette shows `CommandShortcut` hints. A hint
 *      for a key the global handler does not implement is a lie printed in the
 *      UI, and the global handler lives in a DIFFERENT file — so the two drift
 *      silently unless something compares them.
 */

const palette = readSource("src/components/core/CommandPalette.tsx");
const player = readSource("src/store/player.ts");
const shell = readSource("src/components/layout/AppShell.tsx");

/** Store actions the palette binds via a selector. */
function selectedActions(source) {
  return [...source.matchAll(/usePlayerStore\(\(s\) => s\.([A-Za-z0-9_]+)\)/g)]
    .map((m) => m[1])
    .filter((name) => !name.startsWith("s.") && name.length > 1);
}

/** The key hints the palette prints next to its commands. */
function advertisedShortcuts(source) {
  return [
    ...source.matchAll(/<CommandShortcut>([^<]+)<\/CommandShortcut>/g),
  ].map((m) => m[1].trim());
}

describe("every palette action is a real action", () => {
  const actions = selectedActions(palette);

  test("the palette binds a useful set of controls", () => {
    // A guard on the extraction itself: an empty list would make every
    // assertion below pass vacuously.
    expect(actions.length).toBeGreaterThanOrEqual(8);
  });

  test("every store member it selects actually exists", () => {
    // The palette reads a mix of ACTIONS and STATE (it needs `isPlaying` to
    // label Play vs Pause), so this asserts membership rather than
    // callability. A name that is neither would be `undefined` at runtime, and
    // the command would render, be selectable, and do nothing — the exact
    // failure this file exists to prevent.
    for (const name of actions) {
      expect(player).toMatch(new RegExp(`\\b${name}\\s*[,:]`));
    }
  });

  test("the actions this cycle added are present and real", () => {
    // Repeat / like / queue were added to close gaps the store already had the
    // store actions for.
    for (const name of ["cycleRepeat", "setQueueOpen", "toggleLike"]) {
      expect(actions).toContain(name);
      // Implemented in the store factory, not merely on the interface.
      expect(player).toMatch(
        new RegExp(`const ${name} = \\(|\\n\\s*${name}[,:]`),
      );
    }
  });

  test("opening the queue is a real call, not a route that does not exist", () => {
    expect(palette).toMatch(/run\(\(\) => setQueueOpen\(true\)\)/);
  });

  test("liking reads the current track at invoke time", () => {
    // Closing over render state would like whichever song was playing when the
    // palette opened, not the one playing when the command ran.
    expect(palette).toMatch(
      /usePlayerStore\.getState\(\)\.current\?\.id[\s\S]{0,80}?toggleLike\(id\)/,
    );
  });
});

describe("actions that need a track are disabled without one", () => {
  test("next, previous and like are all gated on a loaded track", () => {
    const gated = (palette.match(/disabled=\{!hasTrack\}/g) ?? []).length;
    // Next, previous, like. None of them mean anything with no current track.
    expect(gated).toBeGreaterThanOrEqual(3);
  });

  test("hasTrack really is derived from a loaded track", () => {
    expect(palette).toMatch(
      /const hasTrack = usePlayerStore\(\(s\) => Boolean\(s\.current\)\)/,
    );
  });
});

describe("every advertised shortcut is actually implemented", () => {
  const hints = advertisedShortcuts(palette);

  test("the palette advertises a set of shortcuts", () => {
    expect(hints.length).toBeGreaterThanOrEqual(5);
  });

  test("each advertised key is handled by the global key handler", () => {
    // The handler and the palette are different files. Without this
    // comparison, deleting a shortcut from one silently leaves the other
    // advertising a key that does nothing.
    for (const hint of hints) {
      if (hint === "Space") {
        expect(shell).toMatch(/e\.code === "Space"/);
        continue;
      }
      const key = hint.toLowerCase();
      expect(shell).toMatch(new RegExp(`toLowerCase\\(\\) === "${key}"`));
    }
  });

  test("and the handler does not advertise keys the palette omits silently", () => {
    // The inverse direction, so the two cannot drift apart in the other way
    // either: every single-letter transport shortcut the app implements should
    // be reachable from the palette's hints or explicitly listed here.
    const implemented = [
      ...shell.matchAll(/toLowerCase\(\) === "([a-z])"/g),
    ].map((m) => m[1].toUpperCase());
    const advertised = hints.map((h) => h.toUpperCase());
    // Sleep/quiet toggles are player-bar affordances, not palette commands.
    const notInPalette = ["M", "F"];
    for (const key of implemented) {
      if (notInPalette.includes(key)) continue;
      expect(advertised).toContain(key);
    }
  });
});
