import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Window } from "happy-dom";
import { setGlobal } from "./helpers/globals.js";
import React, { act } from "react";
import { createRoot } from "react-dom/client";

/**
 * The settings rail, EXECUTED.
 *
 * `tests/settings-navigation.test.js` asserts eighteen properties of this hook
 * by reading its source text and matching regexes. Every one of them passed
 * while the rail did not scroll, because "the hook contains an absolute-offset
 * calculation" and "clicking a chip moves the reader to that section" are
 * different claims and only the second one matters to a person.
 *
 * This file drives the real hook against a real DOM tree shaped like the app's
 * page-mode settings route, with layout numbers stubbed (happy-dom does no
 * layout, and neither does a jsdom-style box model). Everything below the box
 * model — element registration, container resolution, destination maths, the
 * clamp, the animation and the highlight — is the production code.
 *
 * The shape matters. In page mode the settings panel is a PLAIN `<div>` inside
 * the shell's scrolling `<main data-app-scroll>`; Radix's Content primitive is
 * deliberately bypassed, so there is no `role="dialog"` anywhere in the chain.
 */

let win;
let useSettingsNavigation;

const IDS = [
  "settings-playback",
  "settings-audio",
  "settings-appearance",
  "settings-personalization",
  "settings-profile",
  "settings-shortcuts",
  "settings-app",
  "settings-data",
];

/** Where each section starts, in the scroll container's content. */
const SECTION_TOP = {
  "settings-playback": 0,
  "settings-audio": 320,
  "settings-appearance": 640,
  "settings-personalization": 980,
  "settings-profile": 1200,
  "settings-shortcuts": 1500,
  "settings-app": 2400,
  "settings-data": 2700,
};

const STICKY_HEIGHT = 96;
const VIEWPORT = 800;
const CONTENT_HEIGHT = 4000;

/** Overridable so a test can make an element report a different box. */
const layout = {
  stickyHeight: STICKY_HEIGHT,
  viewport: VIEWPORT,
  contentHeight: CONTENT_HEIGHT,
  hidden: new Set(),
};

beforeAll(async () => {
  win = new Window({ url: "https://example.test/settings" });
  globalThis.window = win;
  globalThis.document = win.document;
  setGlobal("navigator", win.navigator);
  globalThis.location = win.location;
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.Element = win.Element;
  globalThis.Node = win.Node;
  globalThis.Event = win.Event;
  globalThis.MouseEvent = win.MouseEvent;
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);

  // The animation runs on requestAnimationFrame; drive it off a controllable
  // clock so a test can land it deterministically instead of sleeping.
  let rafQueue = [];
  let rafId = 0;
  globalThis.requestAnimationFrame = (cb) => {
    rafId += 1;
    rafQueue.push([rafId, cb]);
    return rafId;
  };
  globalThis.cancelAnimationFrame = (id) => {
    rafQueue = rafQueue.filter(([queued]) => queued !== id);
  };
  globalThis.__flushFrames = (count = 200, stepMs = 16) => {
    // Start from the SAME clock the hook reads (`performance.now()`), not from
    // zero. The hook computes progress as `(now - began) / duration`, so a
    // frame clock starting at 0 against a real `performance.now()` of several
    // seconds makes every frame look like "before the animation started" and
    // the scroll never moves — a broken harness that looks exactly like the
    // bug being hunted.
    let now = performance.now();
    for (let i = 0; i < count; i += 1) {
      now += stepMs;
      const due = rafQueue;
      rafQueue = [];
      for (const [, cb] of due) cb(now);
    }
  };

  // The hook only needs the observer to exist and to never fire: this file
  // asserts where a chip TAKES you, not where the reader is.
  globalThis.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  win.matchMedia = (query) => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    query,
  });
  globalThis.matchMedia = win.matchMedia;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  win.HTMLElement.prototype.getBoundingClientRect = function rect() {
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  };

  const mod =
    await import("../src/components/settings/useSettingsNavigation.ts");
  useSettingsNavigation = mod.useSettingsNavigation;
});

afterAll(() => {
  win?.close?.();
});

/**
 * Stub the box model on a real element tree.
 *
 * `scrollTop` has to be a real writable property that the container's own
 * scrollHeight/clientHeight describe, because `destinationFor` clamps to the
 * real range — a container that claims to be unscrollable would make every
 * destination 0 and the test would pass for the wrong reason.
 */
function stubLayout(container, sections) {
  // A get/set pair rather than a data property: happy-dom's HTMLElement
  // already exposes `scrollTop`, and shadowing it with a plain value made the
  // hook's writes vanish — which looks precisely like "the rail does not
  // scroll", the very failure under test.
  let scrollTop = 0;
  Object.defineProperty(container, "scrollTop", {
    get: () => scrollTop,
    set: (v) => {
      scrollTop = v;
    },
    configurable: true,
  });
  Object.defineProperty(container, "scrollHeight", {
    get: () => layout.contentHeight,
    configurable: true,
  });
  Object.defineProperty(container, "clientHeight", {
    get: () => layout.viewport,
    configurable: true,
  });
  container.getBoundingClientRect = () => ({
    top: 0,
    left: 0,
    right: 800,
    bottom: layout.viewport,
    width: 800,
    height: layout.viewport,
  });

  for (const section of sections) {
    const id = section.id;
    const contentTop = SECTION_TOP[id] ?? 0;
    // The rect is viewport-relative, so it has to move as the container does.
    section.getBoundingClientRect = () => ({
      top: contentTop - container.scrollTop,
      left: 0,
      right: 800,
      bottom: contentTop - container.scrollTop + 200,
      width: 800,
      height: 200,
    });
    Object.defineProperty(section, "offsetParent", {
      get: () => (layout.hidden.has(id) ? null : container),
      configurable: true,
    });
  }
}

/** Mount the hook over a page-mode-shaped tree; returns a driver. */
function mount(options = {}) {
  layout.stickyHeight = STICKY_HEIGHT;
  layout.hidden = new Set();

  // Exactly the app's shape: a plain panel div inside the shell's <main>,
  // with the sticky rail inside the panel. No role="dialog" in the chain.
  const main = win.document.createElement("main");
  main.setAttribute("data-app-scroll", "");
  const panel = win.document.createElement("div");
  panel.setAttribute("data-slot", "dialog-content");
  const sticky = win.document.createElement("nav");
  const body = win.document.createElement("div");
  const sections = IDS.map((id) => {
    const s = win.document.createElement("section");
    s.id = id;
    return s;
  });
  for (const s of sections) body.appendChild(s);
  panel.appendChild(sticky);
  panel.appendChild(body);
  main.appendChild(panel);
  win.document.body.appendChild(main);

  sticky.getBoundingClientRect = () => ({
    top: 0,
    left: 0,
    right: 800,
    bottom: layout.stickyHeight,
    width: 800,
    height: layout.stickyHeight,
  });
  stubLayout(main, sections);

  const api = {};
  // Both refs MUST be stable across renders, exactly as they are in the app
  // (`useRef`). The observer effect depends on `resolveContainer`, which is
  // derived from `containerRef`, so a fresh object literal per render makes
  // that effect tear down and re-run on every commit — and its cleanup calls
  // `stopAnimation()`, cancelling the scroll it was about to run. That looks
  // exactly like "the chips don't scroll".
  const containerRef = { current: options.containerRef ?? null };
  const stickyRef = { current: sticky };

  function Harness() {
    const nav = useSettingsNavigation({
      ids: IDS,
      containerRef,
      stickyRef,
      enabled: options.enabled ?? true,
    });
    api.nav = nav;
    return null;
  }

  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(React.createElement(Harness));
  });
  act(() => {
    for (const s of sections) nav_register(s);
  });

  function nav_register(section) {
    api.nav.register(section.id)(section);
  }

  return {
    api,
    main,
    sections,
    click(id) {
      act(() => {
        api.nav.goTo(id);
      });
      globalThis.__flushFrames();
    },
    destroy() {
      act(() => root.unmount());
    },
  };
}

describe("clicking a settings chip scrolls the reader to that section", () => {
  test("a mid-page chip moves the scroll container", () => {
    const m = mount();
    m.click("settings-appearance");
    // Appearance starts at 640; the sticky rail (96) + gap (12) is cleared.
    expect(m.main.scrollTop).toBe(640 - STICKY_HEIGHT - 12);
    m.destroy();
  });

  test("the App chip — the one the PWA work added — reaches the App section", () => {
    const m = mount();
    m.click("settings-app");
    expect(m.main.scrollTop).toBe(2400 - STICKY_HEIGHT - 12);
    m.destroy();
  });

  test("the last chip lands flush, clamped to the real scroll range", () => {
    const m = mount();
    m.click("settings-data");
    const max = layout.contentHeight - layout.viewport;
    expect(m.main.scrollTop).toBe(Math.min(2700 - STICKY_HEIGHT - 12, max));
    expect(m.main.scrollTop).toBeLessThanOrEqual(max);
    m.destroy();
  });

  test("every single chip lands on its own section", () => {
    // The regression was "chips don't scroll to the section I click", which a
    // test that only checks ONE chip could miss entirely.
    const m = mount();
    const max = layout.contentHeight - layout.viewport;
    for (const id of IDS) {
      m.main.scrollTop = 0;
      m.click(id);
      const expected = Math.max(
        0,
        Math.min(SECTION_TOP[id] - STICKY_HEIGHT - 12, max),
      );
      expect({ id, scrollTop: m.main.scrollTop, expected }).toEqual({
        id,
        scrollTop: expected,
        expected,
      });
    }
    m.destroy();
  });

  test("the chip the reader clicked is the one that lights up", () => {
    const m = mount();
    m.click("settings-app");
    expect(m.api.nav.activeId).toBe("settings-app");
    m.destroy();
  });

  test("clicking away then back lands on the second one, not a blend", () => {
    const m = mount();
    m.click("settings-data");
    m.main.scrollTop = 0;
    m.click("settings-playback");
    expect(m.main.scrollTop).toBe(0);
    expect(m.api.nav.activeId).toBe("settings-playback");
    m.destroy();
  });
});

describe("a chip for a section that is not laid out does nothing", () => {
  test("a hidden section is a no-op, not a jump to the top", () => {
    const m = mount();
    m.click("settings-appearance");
    const where = m.main.scrollTop;
    expect(where).toBeGreaterThan(0);

    // The keyboard panel is `hidden` below `lg`, so its chip is hidden too.
    // Reaching it must not scroll to 0 and throw the reader to the top.
    layout.hidden.add("settings-shortcuts");
    m.click("settings-shortcuts");
    expect(m.main.scrollTop).toBe(where);
    m.destroy();
  });
});

describe("a non-scrolling wrapper between the sections and the scroller", () => {
  // The failure mode this whole file exists for: resolving the NEAREST
  // MATCHING ancestor instead of the nearest SCROLLABLE one. The settings
  // panel is `overflow-y-visible` inside the shell's <main>, so a wrapper
  // that matches the selector sits between the chip and the element whose
  // scrollTop can actually move. Writing to that box is a silent no-op, and
  // the rail looks completely inert.
  function mountWithWrapper(wrapperScrolls) {
    const m = mount();
    const panel = m.main.firstElementChild;
    // The wrapper has to MATCH the container selector for this to be a real
    // test — `role="dialog"` is how the compact dialog's panel presents, and
    // it sits between the sections and whatever is further out.
    panel.setAttribute("role", "dialog");
    if (wrapperScrolls) {
      Object.defineProperty(panel, "scrollHeight", {
        get: () => layout.contentHeight,
        configurable: true,
      });
      Object.defineProperty(panel, "clientHeight", {
        get: () => layout.viewport,
        configurable: true,
      });
    } else {
      // A non-scrolling wrapper: both dimensions identical, exactly as an
      // `overflow-y-visible` box reports.
      Object.defineProperty(panel, "scrollHeight", {
        get: () => layout.viewport,
        configurable: true,
      });
      Object.defineProperty(panel, "clientHeight", {
        get: () => layout.viewport,
        configurable: true,
      });
    }
    let panelScrollTop = 0;
    Object.defineProperty(panel, "scrollTop", {
      get: () => panelScrollTop,
      set: (v) => {
        panelScrollTop = v;
      },
      configurable: true,
    });
    panel.getBoundingClientRect = () => ({
      top: 0,
      left: 0,
      right: 800,
      bottom: layout.viewport,
      width: 800,
      height: layout.viewport,
    });
    m.panel = panel;
    return m;
  }

  test("a chip still scrolls when a non-scrolling wrapper is in the chain", () => {
    const m = mountWithWrapper(false);
    m.click("settings-app");
    expect(m.main.scrollTop).toBe(2400 - STICKY_HEIGHT - 12);
    m.destroy();
  });

  test("the wrapper's own scrollTop is never written to", () => {
    const m = mountWithWrapper(false);
    const panel = m.main.firstElementChild;
    let writes = 0;
    Object.defineProperty(panel, "scrollTop", {
      get: () => 0,
      set: () => {
        writes += 1;
      },
      configurable: true,
    });
    m.click("settings-data");
    expect({ writes }).toEqual({ writes: 0 });
    expect(m.main.scrollTop).toBeGreaterThan(0);
    m.destroy();
  });

  test("a genuinely scrollable wrapper is used when it is the real scroller", () => {
    // The compact dialog's panel IS the scroller. The resolver must prefer a
    // scrollable NEAR match over a non-scrollable further one, or the dialog
    // form regresses.
    const m = mountWithWrapper(true);
    m.click("settings-app");
    expect(m.panel.scrollTop).toBe(2400 - STICKY_HEIGHT - 12);
    expect(m.main.scrollTop).toBe(0);
    m.destroy();
  });
});

describe("the hook resolves the element that actually scrolls", () => {
  test("with no containerRef it still finds the app's scroll container", () => {
    const m = mount({ containerRef: null });
    m.click("settings-app");
    // If it had picked the non-scrolling panel wrapper, this would be 0.
    expect(m.main.scrollTop).toBeGreaterThan(0);
    m.destroy();
  });

  test("an explicit containerRef wins over the closest ancestor", () => {
    const m = mount({ containerRef: null });
    m.click("settings-app");
    const viaMain = m.main.scrollTop;
    m.destroy();

    const m2 = mount();
    m2.click("settings-app");
    expect(m2.main.scrollTop).toBe(viaMain);
    m2.destroy();
  });
});
