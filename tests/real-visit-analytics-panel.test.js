/**
 * The admin Visits panel, in a real DOM.
 *
 * The lesson this file exists to enforce: `tsc` passing and eslint passing say
 * nothing about whether a component renders. A panel can typecheck perfectly
 * and throw on first render, or render `null`, and the build stays green. So
 * this mounts the REAL component with the output of the REAL `summariseVisits`
 * and asserts on the text an admin would actually read.
 *
 * It covers the chain that can break: rollup rows -> summary -> DOM. That
 * includes the "no data yet" state, which is the very first thing a real
 * admin sees on a fresh deployment and the easiest one to get wrong.
 */
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Window } from "happy-dom";
import { setGlobal } from "./helpers/globals.js";
import React from "react";
import { createRoot } from "react-dom/client";
import { VisitAnalytics } from "../src/components/admin/VisitAnalytics.tsx";
import { summariseVisits } from "../src/lib/visitAnalytics.ts";

let win;

/**
 * Install this file's window as the process-wide DOM.
 *
 * Called before EVERY test, not just once. `bun test` runs all files in a
 * single process, and another DOM test file (`real-navigation-click`) installs
 * its own happy-dom Window over these same globals in its own `beforeAll`.
 * Whichever ran last owned `globalThis.document` for both files.
 *
 * The failure that produced was silent and looked like a component bug: the
 * host element below is created from THIS file's `win.document`, while
 * react-dom creates its elements using `globalThis.document`. Once the other
 * file's Window won, the component rendered cross-document nodes into a
 * container that stayed empty — every assertion on the panel's text failed,
 * 0 bars, no headline numbers, in a suite that passed in isolation. Re-asserting
 * the globals per test makes the file order-independent.
 */
function installGlobals() {
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
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.localStorage = win.localStorage;
  globalThis.URL.createObjectURL = () => "blob:stub";
  globalThis.URL.revokeObjectURL = () => {};
  win.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
  globalThis.matchMedia = win.matchMedia;
}

beforeAll(() => {
  win = new Window({ url: "https://example.test/admin" });
});

beforeEach(() => {
  installGlobals();
});

/** Mount and return the rendered text plus a query helper. */
async function render(props) {
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  const root = createRoot(host);
  await root.render(React.createElement(VisitAnalytics, props));
  // One turn of the microtask queue is enough for a synchronous render; the
  // panel has no effects that fetch.
  await new Promise((r) => setTimeout(r, 0));
  const text = host.textContent ?? "";
  return {
    host,
    text,
    unmount: () => root.unmount(),
    has: (needle) => text.includes(needle),
  };
}

const NOW = Date.UTC(2026, 0, 15, 12);
const today = "2026-01-15";
const yesterday = "2026-01-14";

describe("the Visits tab shows an admin real numbers", () => {
  test("it renders totals, a trend and a ranked page list", async () => {
    const summary = summariseVisits(
      [
        {
          day: today,
          path: "/home",
          views: 30,
          visitors: ["a", "b"],
          members: ["a"],
        },
        { day: today, path: "/search", views: 12, visitors: ["a", "c"] },
        { day: yesterday, path: "/home", views: 8, visitors: ["a", "d"] },
      ],
      14,
      NOW,
    );
    const view = await render({ summary });

    // The headline numbers.
    expect(view.has("50")).toBe(true); // 30 + 12 + 8 page views
    expect(view.has("Unique visitors")).toBe(true);

    // The ranked list, with the busiest page on top and the routes collapsed.
    expect(view.has("Most visited pages")).toBe(true);
    expect(view.has("/home")).toBe(true);
    expect(view.has("/search")).toBe(true);
    // 38 views on /home across both days, so it must outrank /search.
    expect(view.text.indexOf("/home")).toBeLessThan(
      view.text.indexOf("/search"),
    );

    view.unmount();
  });

  test("it names a private, first-party measurement, not a third-party tracker", async () => {
    const view = await render({ summary: summariseVisits([], 14, NOW) });
    // The panel has to state the privacy position, because the numbers on it
    // are only trustworthy if the listener knows what was and was not kept.
    expect(view.has("No IP")).toBe(true);
    expect(view.has("fingerprint")).toBe(true);
    view.unmount();
  });

  test("every bar in the trend is labelled for a screen reader", async () => {
    const summary = summariseVisits(
      [{ day: today, path: "/home", views: 5, visitors: ["a"] }],
      14,
      NOW,
    );
    const view = await render({ summary });
    const labels = [...view.host.querySelectorAll("[aria-label]")].map((n) =>
      n.getAttribute("aria-label"),
    );
    const bars = labels.filter((l) => l && l.includes("views"));
    // 14 days, each with a readable label including the date and both numbers.
    expect(bars).toHaveLength(14);
    expect(bars[13]).toContain(today);
    expect(bars[13]).toContain("5 views");
    expect(bars[13]).toContain("1 visitors");
    view.unmount();
  });
});

describe("a fresh deployment is not an error state", () => {
  test("with no visits it explains itself instead of showing zeroes", async () => {
    const view = await render({ summary: summariseVisits([], 14, NOW) });
    expect(view.has("No visits recorded yet")).toBe(true);
    // Retention is a promise about what happens to the data; an admin should
    // be able to see it without reading the source.
    expect(view.has("30 days")).toBe(true);
    view.unmount();
  });

  test("with no visits the ranking says so rather than rendering an empty box", async () => {
    const view = await render({ summary: summariseVisits([], 14, NOW) });
    expect(view.has("Nothing to rank yet")).toBe(true);
    view.unmount();
  });

  test("light traffic is flagged instead of averaging two data points", async () => {
    const thin = summariseVisits(
      [{ day: today, path: "/home", views: 1, visitors: ["a"] }],
      14,
      NOW,
    );
    const view = await render({ summary: thin });
    expect(view.has("still light")).toBe(true);
    view.unmount();
  });

  test("the loading state renders a placeholder, not an empty panel", async () => {
    const view = await render({ summary: undefined, loading: true });
    expect(view.has("Page views")).toBe(false);
    expect(view.host.querySelector('[aria-busy="true"]')).not.toBeNull();
    view.unmount();
  });
});

describe("the range buttons ask for a real refetch", () => {
  test("they are hidden when there is no handler, so nothing can be mislabelled", async () => {
    // The bug this guards: a range switcher that only relabels the cards,
    // showing 14 days of numbers under a "30 days" heading.
    const view = await render({ summary: summariseVisits([], 14, NOW) });
    const labels = [...view.host.querySelectorAll("button")].map((b) =>
      (b.textContent ?? "").trim(),
    );
    expect(labels.some((l) => l === "7d")).toBe(false);
    expect(labels.some((l) => l === "30d")).toBe(false);
    view.unmount();
  });

  test("with a handler they appear and report the window that is displayed", async () => {
    const view = await render({
      summary: summariseVisits([], 7, NOW),
      days: 7,
      onDaysChange: () => {},
    });
    const labels = [...view.host.querySelectorAll("button")].map((b) =>
      (b.textContent ?? "").trim(),
    );
    expect(labels).toContain("7d");
    expect(labels).toContain("14d");
    expect(labels).toContain("30d");
    // The heading must state the FETCHED window, not a remembered one.
    expect(view.has("Page views · 7 days")).toBe(true);
    view.unmount();
  });

  test("exactly one range is marked selected, and it is the fetched one", async () => {
    // Weakly asserted at first: a mutation that set every button's
    // aria-pressed to false passed the suite, because the buttons were only
    // ever checked for existing. The selected state IS the feature — it is
    // what stops an admin believing they are looking at 30 days.
    const view = await render({
      summary: summariseVisits([], 7, NOW),
      days: 7,
      onDaysChange: () => {},
    });
    const pressed = [...view.host.querySelectorAll("[aria-pressed]")]
      .filter((b) => (b.textContent ?? "").trim().endsWith("d"))
      .map((b) => [b.textContent.trim(), b.getAttribute("aria-pressed")]);
    expect(pressed).toHaveLength(3);
    expect(pressed.filter(([, v]) => v === "true")).toHaveLength(1);
    expect(pressed.find(([label]) => label === "7d")?.[1]).toBe("true");
    expect(pressed.find(([label]) => label === "30d")?.[1]).toBe("false");
    view.unmount();
  });

  test("clicking a range asks the parent to refetch that window", async () => {
    const asked = [];
    const view = await render({
      summary: summariseVisits([], 14, NOW),
      days: 14,
      onDaysChange: (d) => asked.push(d),
    });
    const thirty = [...view.host.querySelectorAll("button")].find(
      (b) => (b.textContent ?? "").trim() === "30d",
    );
    expect(thirty).toBeDefined();
    thirty.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    // Without this the switcher would relabel the cards and fetch nothing —
    // a 14-day chart captioned "30 days".
    expect(asked).toEqual([30]);
    view.unmount();
  });
});
