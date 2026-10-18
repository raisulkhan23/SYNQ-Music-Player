import { describe, expect, test } from "bun:test";
import { readSource } from "./helpers/tailwind-css.js";

/**
 * Why the ⌘K hint was clipped.
 *
 * `CommandPaletteHint` rendered a `⌕ Search ⌘K` pill — a magnifier, the word
 * "Search" and a bordered `⌘K` badge, roughly 110px wide with its padding.
 *
 * The only place it was mounted was the **collapsed** sidebar rail, which is
 * `w-[72px]`. A 110px button in a 72px rail cannot fit: the rail's children
 * are centred in a 40px-wide column, so the pill overflowed on both sides and
 * the right-hand `⌘K` badge was sliced off by the rail's own edge. That is
 * exactly what the screenshot showed.
 *
 * It is now width-aware. `compact` is the icon-only form for the 72px rail;
 * the full pill, which genuinely fits, lives in the expanded 240px sidebar —
 * where it did not exist before. So the rail that could not fit it is the one
 * that lost it, and the rail that can fit it gained it.
 *
 * The invariant that matters, and the one that was violated: **a fixed-width
 * rail must never contain a full pill.** The `compact` prop has to exist and
 * has to be used there.
 */

const sidebar = readSource("src/components/layout/Sidebar.tsx");
const palette = readSource("src/components/core/CommandPalette.tsx");

/** Comments explain the fix and quote the old markup verbatim, so they must
 *  come out before an assertion about what the rail *renders*. */
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

/** The collapsed rail block: from `width: 72` to the expanded `</motion.aside>`. */
function collapsedRail(source) {
  const start = source.indexOf("width: 72");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf('key="expanded"', start);
  expect(end).toBeGreaterThan(start);
  return stripComments(source.slice(start, end));
}

/** The expanded rail block: from `key="expanded"` to the end of the file. */
function expandedRail(source) {
  const start = source.indexOf('key="expanded"');
  expect(start).toBeGreaterThan(-1);
  return stripComments(source.slice(start));
}

describe("the collapsed 72px rail cannot contain a pill", () => {
  test("the hint mounted in the rail is the compact, icon-only form", () => {
    const rail = collapsedRail(sidebar);
    const mount = rail.match(/<CommandPaletteHint[^>]*\/>/);
    expect(mount).not.toBeNull();
    // No `compact` prop means the full `⌕ Search ⌘K` pill, which is the bug.
    expect(mount[0]).toMatch(/\bcompact\b/);
  });

  test("the rail block itself never contains the pill's own markup", () => {
    // The compact form is icon-only. If the `Search` word and the `⌘K` badge
    // ever come back into the collapsed rail, the pill is back in a 72px box.
    const rail = collapsedRail(sidebar);
    expect(rail).not.toMatch(/⌘K/);
  });
});

describe("CommandPaletteHint is width-aware", () => {
  test("it takes a `compact` prop that defaults to the full pill", () => {
    expect(palette).toMatch(/compact = false/);
    // The full form has to stay the default so every other caller is
    // unaffected, and so the expanded sidebar gets the label + shortcut.
    // The span carries a layout class, so match the element, not the text.
    expect(palette).toMatch(/<span[^>]*>Search<\/span>/);
    expect(palette).toMatch(/<kbd[^>]*>\s*⌘K\s*<\/kbd>/);
  });

  test("the compact form is a fixed square that fits a 40px column", () => {
    // `size-9` (36px) matches the rail's other icon buttons (`size-9` for
    // settings, `size-10` for the primary actions) and is comfortably inside
    // the 72px rail even with the rail's own padding.
    expect(palette).toMatch(/if \(compact\) \{/);
    const compactBranch = palette.slice(
      palette.indexOf("if (compact) {"),
      palette.indexOf("if (compact) {") + 900,
    );
    expect(compactBranch).toMatch(/size-9/);
    // It must not carry text content.
    expect(compactBranch).not.toMatch(/<span[^>]*>Search<\/span>/);
    expect(compactBranch).not.toMatch(/<kbd/);
  });

  test("both forms stay reachable and labelled for assistive tech", () => {
    // An icon-only button with no accessible name is invisible to a screen
    // reader, so `aria-label` and the `title` shortcut hint are load-bearing
    // in the compact form specifically.
    const compactBranch = palette.slice(
      palette.indexOf("if (compact) {"),
      palette.indexOf("if (compact) {") + 900,
    );
    expect(compactBranch).toMatch(/aria-label="Open command palette"/);
    expect(compactBranch).toMatch(/title="Search \(⌘K\)"/);
  });
});

describe("the hint exists in both rails", () => {
  test("the expanded 240px sidebar has it too, where the pill does fit", () => {
    // The rail that could not fit the pill is the one that lost it, so the
    // discoverability it was there to provide would be gone entirely. The
    // expanded rail is where the full pill belongs.
    const expanded = expandedRail(sidebar);
    const mount = expanded.match(/<CommandPaletteHint[^>]*\/>/);
    expect(mount).not.toBeNull();
    // And it must NOT be compact — that rail is 240px wide.
    expect(mount[0]).not.toMatch(/\bcompact\b/);
  });

  test("both mounts drive the same store as the ⌘K hotkey", () => {
    // Two buttons, one store — the hint can never disagree with the hotkey.
    expect(palette).toMatch(
      /export function CommandPaletteHint[\s\S]{0,400}usePalette\(\(s\) => s\.setOpen\)/,
    );
  });
});
