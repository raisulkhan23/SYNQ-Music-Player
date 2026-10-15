/**
 * The Shelf render loop.
 *
 * `Shelf` re-measures its rail after EVERY render (an effect with no
 * dependency array, on purpose, so cards arriving are noticed). It then called
 * `setEdges` with a fresh object literal every time. A new object is never
 * `Object.is`-equal to the previous state, so React never bailed out: render →
 * effect → setState → render, forever. React stopped at 50 nested updates with
 * "Maximum update depth exceeded" and UNWOUND the commit — which is why
 * clicking a link changed the URL while the page on screen stayed exactly as
 * it was, and why every page looked broken at once.
 *
 * The loop is detected by COUNTING LAYOUT READS, not by watching the console.
 * React's error reporting turned out to depend on which test file ran first, so
 * a console-based assertion could silently pass. Counting is deterministic: a
 * healthy Shelf measures a handful of times and stops, a looping one measures
 * thousands of times.
 *
 * Each test builds its own Window and installs its own globals, so this file
 * cannot pass by inheriting another test's environment.
 */
import { expect, test } from 'vitest';
import { Window } from "happy-dom";
import React from "react";
import { createRoot } from "react-dom/client";

/** A healthy Shelf re-measures a few times. A looping one never stops. */
const MEASURE_BUDGET = 40;

function installDom() {
  const win = new Window({ url: "https://example.test/home" });
  globalThis.window = win;
  globalThis.document = win.document;
  try { Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true, writable: true }); } catch (e) { Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true }); }
  globalThis.location = win.location;
  globalThis.history = win.history;
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.Element = win.Element;
  globalThis.Node = win.Node;
  globalThis.Event = win.Event;
  globalThis.MouseEvent = win.MouseEvent;
  globalThis.CustomEvent = win.CustomEvent;
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.localStorage = win.localStorage;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  return win;
}

/**
 * Counts reads of `scrollWidth` and returns a DIFFERENT value every time.
 *
 * The changing value matters: it guarantees the computed edge state differs
 * between measurements, so a Shelf that calls setState unconditionally cannot
 * get lucky and have React bail out. That is exactly the condition the real
 * bug lived on.
 */
function instrumentScrollWidth(win) {
  const counter = { reads: 0 };
  Object.defineProperty(win.Element.prototype, "scrollWidth", {
    configurable: true,
    get() {
      counter.reads += 1;
      return 1000 + (counter.reads % 2) * 500;
    },
  });
  Object.defineProperty(win.Element.prototype, "clientWidth", {
    configurable: true,
    get() {
      return 400;
    },
  });
  Object.defineProperty(win.Element.prototype, "scrollLeft", {
    configurable: true,
    get() {
      return 0;
    },
  });
  return counter;
}

async function mountShelf() {
  const win = installDom();
  const counter = instrumentScrollWidth(win);
  const { Shelf } = await import("@/components/core/shelf");

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  let renders = 0;
  function Counting() {
    renders += 1;
    return React.createElement(
      Shelf,
      { title: "Recently played", id: "shelf-test" },
      React.createElement("div", { className: "w-32 shrink-0" }, "card"),
    );
  }

  root.render(React.createElement(Counting));
  await new Promise((resolve) => setTimeout(resolve, 300));

  return { container, renders, counter, win };
}

test("a mounted Shelf measures a bounded number of times", async () => {
  const { container, renders, counter } = await mountShelf();

  expect(container.textContent).toContain("Recently played");
  // The loop reads scrollWidth forever. A healthy Shelf measures once on
  // mount, once more for the state change it causes, and then stops.
  expect(counter.reads).toBeLessThanOrEqual(MEASURE_BUDGET);
  expect(renders).toBeLessThanOrEqual(4);
}, 15000);

test("scrolling the rail re-measures once and settles", async () => {
  const { container, counter, win } = await mountShelf();
  const readsBefore = counter.reads;

  const rail = container.querySelector(".slider-rail");
  expect(rail).not.toBeNull();
  rail.dispatchEvent(new win.Event("scroll"));
  await new Promise((resolve) => setTimeout(resolve, 150));

  // A scroll re-measures, and re-measuring is allowed to be expensive. What
  // it must not do is keep going.
  expect(counter.reads - readsBefore).toBeLessThanOrEqual(MEASURE_BUDGET);
}, 15000);
