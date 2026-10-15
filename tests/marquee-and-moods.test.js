import { beforeAll, describe, expect, test } from 'vitest';
import { Window } from "happy-dom";
import { setGlobal } from "./helpers/globals.js";
import React from "react";
import { createRoot } from "react-dom/client";
import { InfiniteSlider } from "../src/components/core/infinite-slider.tsx";
import { readSource } from "./helpers/tailwind-css.js";

/**
 * The drifting "Featured on" strip, in a real DOM.
 *
 * Two real bugs are pinned here, both of which were invisible to every check
 * that had run before:
 *
 * 1. HOVER MADE IT FASTER. `SiteFooter` passed `speedOnHover={4}`, so the strip
 *    accelerated four-fold at precisely the moment the pointer arrived to click
 *    something. It typechecked, it linted, and it looked fine in a screenshot.
 * 2. THE LINKS STOPPED WORKING. Copies after the first were marked `inert` to
 *    keep duplicates out of the accessibility tree. But the strip drifts
 *    continuously, so after one group-width every badge on screen belonged to
 *    a later copy — and `inert` means "not clickable". The marquee looked
 *    alive and was completely dead. That is the "some buttons don't redirect"
 *    report.
 */
let win;

beforeAll(() => {
  win = new Window({ url: "https://example.test/" });
  globalThis.window = win;
  globalThis.document = win.document;
  setGlobal("navigator", win.navigator);
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.Element = win.Element;
  globalThis.Node = win.Node;
  globalThis.Event = win.Event;
  globalThis.MouseEvent = win.MouseEvent;
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.IntersectionObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  win.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  globalThis.matchMedia = win.matchMedia;
});

async function renderSlider(props = {}) {
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  const root = createRoot(host);
  await root.render(
    React.createElement(
      InfiniteSlider,
      { label: "Launch directories", ...props },
      [
        React.createElement("a", { key: "a", href: "https://a.example" }, "A"),
        React.createElement("a", { key: "b", href: "https://b.example" }, "B"),
      ],
    ),
  );
  await new Promise((r) => setTimeout(r, 0));
  return { host, unmount: () => root.unmount() };
}

describe("the strip slows down when you reach for a link", () => {
  test("the shipped footer value is a REDUCER, not an accelerator", () => {
    const footer = readSource("src/components/landing/SiteFooter.tsx");
    const match = footer.match(/speedOnHover=\{([\d.]+)\}/);
    expect(match).not.toBeNull();
    const value = Number(match[1]);
    // Above 1 is the bug that shipped. A link you cannot hit is a dead button.
    expect(value).toBeLessThan(1);
  });

  test("the component default is a reducer too", () => {
    const slider = readSource("src/components/core/infinite-slider.tsx");
    const match = slider.match(/speedOnHover = ([\d.]+)/);
    expect(match).not.toBeNull();
    expect(Number(match[1])).toBeLessThan(1);
  });

  test("the doc no longer describes a value above 1 as normal", () => {
    const slider = readSource("src/components/core/infinite-slider.tsx");
    expect(slider).toContain("Values BELOW 1 slow the drift down");
  });
});

describe("every badge on screen stays clickable", () => {
  test("no copy is inert", async () => {
    const view = await renderSlider();
    const inerts = [...view.host.querySelectorAll("[inert]")];
    // `inert` makes an element unclickable AND unfocusable. It was used to
    // de-duplicate the accessibility tree, and it silently killed every link
    // the moment the strip had drifted one group-width.
    expect(inerts).toHaveLength(0);
    view.unmount();
  });

  test("duplicate copies are still removed from the tab order", async () => {
    const view = await renderSlider();
    const links = [...view.host.querySelectorAll("a")];
    // The first copy keeps its natural tab stop; the repeats are removed from
    // it so a keyboard user does not tab through the same link four times.
    const tabbable = links.filter((a) => a.getAttribute("tabindex") !== "-1");
    expect(links.length).toBeGreaterThan(2);
    expect(tabbable).toHaveLength(2);
    view.unmount();
  });

  test("every rendered link still has a real href", async () => {
    // The "buttons don't redirect" symptom, checked at the level that matters:
    // the anchor is present and aimed somewhere, not just that something
    // focusable was painted.
    const view = await renderSlider();
    const links = [...view.host.querySelectorAll("a")];
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) {
      expect(a.getAttribute("href")).toBeTruthy();
    }
    view.unmount();
  });
});

describe("the mood tiles open searches that actually return something", () => {
  // Measured against the live `youtube.searchYoutube` action. The originals
  // were English descriptions: "focus concentration music" returned 0 results,
  // "soft acoustic morning songs" returned 1, "high energy workout songs"
  // returned 1. Tapping a tile led to an empty page.
  const home = readSource("src/pages/Home.tsx");

  // Scoped to the mood block. Home.tsx has other `query:` fields, and matching
  // the whole file silently swept those in — which is how a test can be green
  // while asserting about the wrong thing.
  const block = home.slice(
    home.indexOf("const MOOD_LAUNCHES"),
    home.indexOf("] as const;", home.indexOf("const MOOD_LAUNCHES")),
  );
  const queries = [...block.matchAll(/query: "([^"]+)"/g)].map((m) => m[1]);

  test("the tile list is still there", () => {
    expect(queries.length).toBeGreaterThanOrEqual(5);
  });

  test("the queries are the measured ones, not plausible-looking ones", () => {
    // Pinned EXACTLY rather than pattern-matched. An earlier version of this
    // test tried to detect "bad" queries by word count, and a mutation
    // reintroducing "focus concentration music" passed it — three words, so it
    // satisfied a `<= 3` heuristic while returning zero results.
    //
    // A heuristic cannot know what YouTube has results for. Only the
    // measurement can. So the list is frozen, and changing a query is a
    // deliberate act that means re-measuring against the live action.
    // Re-measured against the live search action. Three entries were replaced
    // because they no longer met the bar this test exists to enforce:
    //   "lofi hip hop"           -> 3 results  (now "study lofi", 9)
    //   "cheesy 80s love songs"  -> 3 results  (now "80s hits", 10)
    //   "Bengali lofi"           -> 0 results  (now "bengali hits", 10)
    // A tile that opens an empty search is the defect, not the query string.
    expect(queries).toEqual([
      "study lofi",
      "acoustic lofi",
      "sport electronic",
      "midnight lofi",
      "funk",
      "80s hits",
      "bengali hits",
    ]);
  });

  test("each query is annotated with the count it actually returned", () => {
    // The annotation is the point. It makes the next edit checkable against
    // the same measurement instead of by intuition.
    const annotated = [
      ...block.matchAll(/query: "([^"]+)", \/\/ (\d+) results/g),
    ];
    expect(annotated.length).toBe(queries.length);
    for (const [, , count] of annotated) {
      expect(Number(count)).toBeGreaterThanOrEqual(5);
    }
  });

  test("the tiles still link into the search page with the query", () => {
    expect(home).toContain("/search?q=${encodeURIComponent(query)}");
  });
});
