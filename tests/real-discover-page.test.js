/**
 * The Discover page, in a real DOM.
 *
 * Discover had never been rendered. Every check it had until now was a
 * source-text assertion — which passes just as happily against a component
 * that returns `null`, throws on mount, or renders an empty result list. This
 * file mounts the real page in a real document and clicks real buttons.
 *
 * The search is triggered by clicking one of the "Try one of these" chips
 * rather than by typing, which is not a convenience. React 19 and happy-dom
 * deliver clicks but not `change`/`input` on a controlled field (measured, not
 * assumed — see `real-import-note.test.js`), so a typed query is not reachable
 * from here. The chips call the exact same `runSearch` the form does, so the
 * path under test is the real one.
 *
 * FILE ORDERING IS LOAD-BEARING. The component is pulled in with a top-level
 * `await import`, because `mock.module` has to run first and static imports are
 * hoisted above it. That `await` suspends module evaluation, so every
 * `describe` and `beforeEach` is registered ABOVE it — anything registered
 * below lands after the runner has started the file and Bun rejects it with
 * "Cannot call describe() after the test run has completed". This file passes
 * in isolation and fails in a combined run, which is precisely the bug an
 * isolated run hides.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot } from "react-dom/client";

let win;
// These are initialised HERE, not only in `beforeEach`, and the reason is
// ordering. `mock.module` is process-global, so an unrelated page test that
// loads after this file gets this dispatcher too. If these were `undefined`
// until this file's first `beforeEach` ran, any such test would call a
// non-function and blow up — which is exactly what happened to four
// artist-page tests before this was fixed.
let discoverImpl = () => Promise.resolve({ results: [], needs_sync: false });
let syncImpl = () =>
  Promise.resolve({ indexed: 0, considered: 0, cursor: null });
let searchYtImpl = () => Promise.resolve({ items: [] });
let indexStatus = { indexed: 0, total: 0, pending: 0 };
/** Assigned at the very bottom, once the mocks above are in place. */
let Discover;

/**
 * The DOM has to exist at MODULE scope, not in `beforeAll`.
 *
 * `src/store/player.ts` reads `localStorage` while it is being evaluated, and
 * the page under test imports it. `beforeAll` runs after module evaluation, so
 * setting the globals there leaves the store crashing on load — which looks
 * exactly like a broken page.
 */
win = new Window({ url: "https://example.test/discover" });
globalThis.window = win;
globalThis.document = win.document;
globalThis.navigator = win.navigator;
globalThis.location = win.location;
globalThis.history = win.history;
globalThis.HTMLElement = win.HTMLElement;
globalThis.Element = win.Element;
globalThis.Node = win.Node;
globalThis.Event = win.Event;
globalThis.InputEvent = win.InputEvent;
globalThis.MouseEvent = win.MouseEvent;
globalThis.CustomEvent = win.CustomEvent;
globalThis.getComputedStyle = win.getComputedStyle.bind(win);
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.localStorage = win.localStorage;
globalThis.sessionStorage = win.sessionStorage;
// The player store appends a shared <audio> to document.body, which needs a
// genuine node rather than a stub.
globalThis.Audio = win.Audio;
win.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
});

/**
 * The Convex boundary, mocked at the seam the page actually uses.
 *
 * The generated `api` is a Proxy that throws on almost every property access —
 * `functionName`, `path` and even `toString` all blow up, and two reads of the
 * same function are not reference-equal. So it can neither be inspected nor
 * compared, and the refs it hands out are useless as mock keys. The api module
 * is therefore replaced with a Proxy that turns any path into a stable string.
 * The page still has to reach for the right path (`libraryVectors.discover`),
 * so its own wiring is genuinely exercised.
 *
 * Both mocks below are deliberately BENIGN for every other test file. Bun's
 * `mock.module` is process-global, not per-file, so a mock registered here
 * stays in effect for whatever loads next — an earlier version of this file
 * returned `undefined` for unrecognised refs and broke four unrelated page
 * tests in a combined run while passing perfectly in isolation. The fallback
 * is therefore the project's own harmless default, so a file that picks these
 * up by accident gets exactly what it would have got anyway.
 */
mock.module("@/convex/_generated/api", () => {
  const make = (prefix) =>
    new Proxy(
      {},
      {
        get: (_t, prop) =>
          typeof prop === "string" ? make(`${prefix}.${prop}`) : undefined,
      },
    );
  const api = make("");
  // Leaves are path strings; the same leaf is cached so identity is stable.
  const cache = new Map();
  const withLeaves = new Proxy(
    {},
    {
      get: (_t, moduleName) => {
        if (typeof moduleName !== "string") return undefined;
        if (!cache.has(moduleName)) {
          cache.set(
            moduleName,
            new Proxy(
              {},
              {
                get: (_t2, fnName) => {
                  const key = `${moduleName}.${fnName}`;
                  if (!cache.has(key)) cache.set(key, key);
                  return cache.get(key);
                },
              },
            ),
          );
        }
        return cache.get(moduleName);
      },
    },
  );
  void api;
  return { api: withLeaves };
});

mock.module("convex/react", () => ({
  useQuery: (ref) =>
    ref === "libraryVectors.indexStatus" ? indexStatus : undefined,
  useAction: (ref) => {
    if (ref === "libraryVectors.discover") return discoverImpl;
    if (ref === "libraryVectors.syncLibrary") return syncImpl;
    if (ref === "youtube.searchYoutube") return searchYtImpl;
    // The project's established harmless default, so an unrelated test file
    // that picks this mock up behaves as it would without it.
    return () => () => Promise.resolve({ items: [] });
  },
  useMutation: () => () => Promise.resolve(null),
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  usePaginatedQuery: () => ({
    results: [],
    status: "Success",
    loadMore: () => {},
  }),
  ConvexProvider: ({ children }) => children,
  ConvexReactClient: class {},
}));

const TRACK = {
  track_id: "t1",
  title: "Skinny Love",
  artist: "Bon Iver",
  album: "For Emma, Forever Ago",
  cover_url: "https://example.test/cover.jpg",
  duration: 232,
  youtube_id: "abc12345678",
  score: 0.87,
  match_reasons: ["low energy", "acoustic"],
};

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 80));
}

function renderDiscover() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  win.happyDOM.setURL("https://example.test/discover");
  root.render(React.createElement(Discover));
  return { container, root };
}

function fire(el) {
  el.dispatchEvent(
    new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
  );
}

/** Click the first "Try one of these" chip, which runs a real search. */
async function searchByExampleChip(container) {
  const heading = [...container.querySelectorAll("p")].find((p) =>
    (p.textContent || "").includes("Try one of these"),
  );
  if (!heading) throw new Error("the example chips are not rendered");
  const chip = heading.closest("section").querySelector("button");
  if (!chip) throw new Error("the example section has no chip");
  fire(chip);
  await settle();
  return chip;
}

function buttonWithText(container, text) {
  return [...container.querySelectorAll("button")].find((b) =>
    (b.textContent || "").includes(text),
  );
}

beforeEach(() => {
  indexStatus = { indexed: 12, total: 12, pending: 0 };
  discoverImpl = () => Promise.resolve({ results: [TRACK], needs_sync: false });
  syncImpl = () =>
    Promise.resolve({ indexed: 12, considered: 12, cursor: null });
  // Discover falls back to YouTube when a result has no known stream, so this
  // has to resolve to something or a streamless row would hang on "resolving".
  searchYtImpl = () => Promise.resolve({ items: [] });
});

describe("Discover renders and searches in a real DOM", () => {
  test("the page mounts and shows its prompt", async () => {
    const { container, root } = renderDiscover();
    await settle();

    const text = container.textContent || "";
    expect(text).toContain("Search your library by meaning");
    expect(text).toContain("Describe what you want to hear");
    // The prompt is the input's placeholder, so it is asserted on the element
    // rather than on textContent — a placeholder is not rendered text.
    const input = container.querySelector(
      'input[aria-label="Describe the music you want"]',
    );
    expect(input).toBeTruthy();
    expect(input.getAttribute("placeholder")).toBe(
      "sad songs for a rainy night",
    );
    root.unmount();
  });

  test("an indexed library offers example chips instead of the index button", async () => {
    const { container, root } = renderDiscover();
    await settle();

    const text = container.textContent || "";
    expect(text).toContain("Try one of these");
    // Already indexed, so the first-run panel must NOT be showing.
    expect(text).not.toContain("Your library isn't indexed yet");
    root.unmount();
  });

  test("clicking an example runs a search and renders the results", async () => {
    let received = null;
    discoverImpl = (args) => {
      received = args;
      return Promise.resolve({ results: [TRACK], needs_sync: false });
    };

    const { container, root } = renderDiscover();
    await settle();

    const chip = await searchByExampleChip(container);

    // The page really called the action, with the chip's own wording.
    expect(received).not.toBeNull();
    expect(received.query).toBe(chip.textContent);
    expect(received.query.length).toBeGreaterThan(3);
    expect(received.limit).toBe(25);

    // And the result is actually on screen, with its match reasons.
    const text = container.textContent || "";
    expect(text).toContain("Skinny Love");
    expect(text).toContain("Bon Iver");
    expect(text).toContain("1 track");
    // Match reasons are the whole point of a semantic search — if they do not
    // render, this is just a title list.
    expect(text).toContain("low energy");
    expect(text).toContain("87%");
    // A playable row, not a dead one.
    expect(
      container.querySelector('[aria-label="Play Skinny Love"]'),
    ).toBeTruthy();
    root.unmount();
  });

  test("a result with no match reasons still renders its row", async () => {
    discoverImpl = () =>
      Promise.resolve({
        results: [{ ...TRACK, match_reasons: [] }],
        needs_sync: false,
      });
    const { container, root } = renderDiscover();
    await settle();
    await searchByExampleChip(container);

    expect(container.textContent).toContain("Skinny Love");
    expect(
      container.querySelector('[aria-label="Play Skinny Love"]'),
    ).toBeTruthy();
    root.unmount();
  });

  test("an unindexed library invites indexing, and indexing reports back", async () => {
    indexStatus = { indexed: 0, total: 40, pending: 40 };
    const { container, root } = renderDiscover();
    await settle();

    expect(container.textContent).toContain("Your library isn't indexed yet");
    const button = buttonWithText(container, "Index my library");
    expect(button).toBeTruthy();

    fire(button);
    await settle();

    expect(container.textContent).toContain("Indexed 12 of 12 tracks");
    root.unmount();
  });

  test("a search with no matches explains itself instead of showing nothing", async () => {
    discoverImpl = () => Promise.resolve({ results: [], needs_sync: false });
    const { container, root } = renderDiscover();
    await settle();
    await searchByExampleChip(container);

    expect(container.textContent).toContain("Nothing in your library matched");
    root.unmount();
  });

  test("a failing search says so rather than hanging on a spinner", async () => {
    discoverImpl = () => Promise.reject(new Error("backend down"));
    const { container, root } = renderDiscover();
    await settle();
    await searchByExampleChip(container);

    expect(container.textContent).toContain("Search failed");
    root.unmount();
  });

  test("an unindexed library is told to index first", async () => {
    discoverImpl = () => Promise.resolve({ results: [], needs_sync: true });
    const { container, root } = renderDiscover();
    await settle();
    await searchByExampleChip(container);

    expect(container.textContent).toContain("Index your library first");
    root.unmount();
  });
});

// Last, because the `await` suspends module evaluation: nothing that registers
// tests may come after this line.
Discover = (await import("../src/pages/Discover.tsx")).default;
