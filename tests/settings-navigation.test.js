import { describe, expect, test } from 'vitest';
import { readSource } from "./helpers/tailwind-css.js";

/**
 * Settings section navigation.
 *
 * The rail used to scroll with `scrollTo({ behavior: "smooth" })` while a
 * scroll listener recomputed the highlighted chip from the same geometry, and
 * those two fought: the chip raced through every section the animation passed
 * and a second click mid-animation computed its destination from a target that
 * was itself moving. These lock in the properties that make it stable.
 */
const nav = readSource("src/components/settings/useSettingsNavigation.ts");
const dialog = readSource("src/components/settings/SettingsDialog.tsx");
const flatNav = nav.replace(/\s+/g, " ");
const flatDialog = dialog.replace(/\s+/g, " ");
// The hook's comments explain the old broken implementation by name, so an
// assertion that something is GONE has to look at code only.
const codeNav = nav.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("one source of truth for the active section", () => {
  test("the hook owns it and the dialog only reads it", () => {
    expect(dialog).toMatch(/activeId: activeSection/);
    // The dialog used to call setActiveSection itself; now a click is just a
    // navigation request.
    expect(dialog).not.toMatch(/setActiveSection\(/);
    expect(dialog).toMatch(/onClick=\{\(\) => goToSection\(id\)\}/);
  });

  test("the highlight state lives in exactly one hook", () => {
    expect(nav).toMatch(/const \[activeId, setActiveId\] = useState/);
    expect(nav).toContain("export function useSettingsNavigation");
  });
});

describe("rapid clicks cannot produce competing scrolls", () => {
  test("a new request cancels the animation already in flight", () => {
    // cancelAnimationFrame BEFORE a new animation is started is the whole
    // fix for two smooth scrolls interleaving their writes to scrollTop.
    const stop = nav.indexOf("const stopAnimation");
    expect(stop).toBeGreaterThan(-1);
    expect(nav.slice(stop, stop + 400)).toContain("cancelAnimationFrame");
    // goTo cancels first, then claims the highlight.
    const goTo = nav.slice(nav.indexOf("const goTo = useCallback"));
    const cancel = goTo.indexOf("stopAnimation()");
    const set = goTo.indexOf("setActive(id)");
    expect(cancel).toBeGreaterThan(-1);
    expect(set).toBeGreaterThan(-1);
    expect(cancel).toBeLessThan(set);
  });

  test("scrolling is animated on our own clock, not the browser's", () => {
    // The browser's `behavior: "smooth"` cannot be interrupted reliably,
    // which is why it was replaced.
    expect(codeNav).not.toMatch(/behavior:\s*"smooth"/);
    expect(nav).toContain("requestAnimationFrame(step)");
  });
});

describe("the destination does not depend on where we currently are", () => {
  test("it is an absolute offset in the container's content", () => {
    // Whitespace-tolerant: prettier wraps this arithmetic across lines.
    expect(flatNav).toMatch(
      /container\.scrollTop\s*\+\s*\(\s*element\.getBoundingClientRect\(\)\.top\s*-\s*container\.getBoundingClientRect\(\)\.top\s*\)/,
    );
  });

  test("it is clamped to the real scroll range, so the footer is not a target", () => {
    expect(nav).toMatch(
      /const max = Math\.max\(0, container\.scrollHeight - container\.clientHeight\)/,
    );
    expect(nav).toContain("return clamp(contentTop - offset, 0, max)");
  });
});

describe("the sticky rail is measured, not assumed", () => {
  test("the offset comes from the rail's own height", () => {
    // A hardcoded 96px silently aimed the section underneath the rail
    // whenever it wrapped to two rows on a narrow viewport.
    expect(codeNav).not.toMatch(/PROBE_PX|96/);
    expect(flatNav).toContain(
      "stickyRef.current?.getBoundingClientRect().height",
    );
  });

  test("a real gap is kept below the rail", () => {
    expect(nav).toMatch(/const offset = stickyHeight \+ SECTION_GAP_PX/);
  });
});

describe("sections are registered, not searched for", () => {
  test("the hook keeps its own element map", () => {
    expect(flatNav).toContain(
      "const elements = useRef(new Map<string, HTMLElement>());",
    );
    expect(codeNav).not.toContain("getElementById");
  });

  test("every settings section registers itself", () => {
    for (const id of [
      "settings-playback",
      "settings-audio",
      "settings-appearance",
      "settings-personalization",
      "settings-profile",
      "settings-shortcuts",
      "settings-data",
    ]) {
      expect(flatDialog).toContain(`ref={registerSection("${id}")}`);
    }
  });
});

describe("the observer cannot feed back into programmatic scrolling", () => {
  test("both observation paths stand down while we are animating", () => {
    // The observer callback bails first thing, before touching the visible
    // set, so our own scroll can never re-enter the state it is driving.
    const observer = nav.slice(
      nav.indexOf("new IntersectionObserver"),
      nav.indexOf("for (const id of ids)"),
    );
    expect(observer).toMatch(/if \(animating\.current\) return;/);
    // The rAF-throttled scroll pass bails before scheduling a re-derive.
    expect(flatNav).toMatch(/if \(raf \|\| animating\.current\) return;/);
  });

  test("the animation settles the highlight on the destination", () => {
    // Re-deriving from the geometry at the end is what reported the wrong
    // section when the scroll range clamped short of the target.
    const step = nav.slice(nav.indexOf("const step = (now: number)"));
    expect(step).toContain("setActive(id)");
  });
});

describe("the reader's position is tracked while scrolling by hand", () => {
  test("an observer roots the sections in the scroll container", () => {
    expect(nav).toContain("new IntersectionObserver");
    expect(nav).toMatch(/root: container/);
  });

  test("the observer's band excludes the sticky rail", () => {
    expect(nav).toMatch(/rootMargin: `-\$\{Math\.round\(/);
  });

  test("a section that is not laid out is never scrolled to", () => {
    // The keyboard panel is hidden below `lg`; a zero rect used to throw the
    // reader to the top of the shell.
    expect(nav).toMatch(
      /if \(!element \|\| element\.offsetParent === null\) return;/,
    );
    expect(nav).toContain("element.getBoundingClientRect().height === 0");
  });

  test("hidden sections are left out of the position sweep", () => {
    expect(nav).toMatch(/element != null && element\.offsetParent !== null/);
  });
});

describe("the compact dialog is untouched by the hook", () => {
  test("the reader is only tracked on the full settings page", () => {
    expect(dialog).toMatch(/enabled: pageMode && open/);
  });
});

describe("the old machinery is gone", () => {
  test("the free-function scroller and the probe offset no longer exist", () => {
    expect(dialog).not.toContain("function jumpToSetting");
    expect(dialog).not.toContain("PROBE_PX");
  });

  test("there is no competing scrollIntoView fallback", () => {
    // It scrolled the whole document, behind the fixed player and nav, which
    // is how a chip click could land on the footer.
    expect(nav).not.toContain("scrollIntoView");
  });
});
