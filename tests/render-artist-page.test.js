/**
 * Renders the real Artist page with real route params.
 *
 * Every previous check on this page was a source-text or logic assertion. None
 * of them ever proved the component actually PRODUCES OUTPUT. This one does:
 * if the page throws during render, or renders an empty shell, it fails here
 * rather than in the browser where it looks like "the page does not load".
 */
import { describe, expect, test, vi } from 'vitest';
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { MemoryRouter, Routes, Route } from "react-router";

// The player store reads localStorage at module scope, and these pages pull it
// in. Provide the minimum browser surface it touches so the page can be
// rendered outside a browser at all.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
  clear: () => store.clear(),
};
globalThis.window = globalThis.window ?? globalThis;
// A very small document stand-in. The pages import sonner, which injects CSS
// at module load and calls getElementsByTagName / createElement on import.
if (!globalThis.document) {
  const makeEl = () => ({
    style: {},
    setAttribute() {},
    appendChild() {},
    removeChild() {},
    addEventListener() {},
    removeEventListener() {},
    classList: { add() {}, remove() {}, contains: () => false },
  });
  globalThis.document = {
    body: makeEl(),
    head: makeEl(),
    documentElement: makeEl(),
    getElementById: () => null,
    getElementsByTagName: () => [makeEl()],
    createElement: () => makeEl(),
    createTextNode: () => ({ data: "" }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
}
if (!globalThis.window.matchMedia) {
  globalThis.window.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  });
}
if (!globalThis.window.addEventListener) {
  globalThis.window.addEventListener = () => {};
  globalThis.window.removeEventListener = () => {};
}
// The store creates a real <audio> element at init for the shared playback
// path. It is never played in this test; it only has to construct.
if (typeof globalThis.Audio === "undefined") {
  globalThis.Audio = class {
    constructor() {
      this.playbackRate = 1;
      this.currentTime = 0;
      this.volume = 1;
      this.paused = true;
      this.readyState = 0;
      this.style = {};
    }
    addEventListener() {}
    removeEventListener() {}
    load() {}
    play() {
      return Promise.resolve();
    }
    pause() {}
    setAttribute() {}
    removeAttribute() {}
  };
}

// Convex hooks need a live client; stub them so the page renders offline.
const pendingAction = () => () => Promise.resolve({ items: [] });
const emptyQuery = () => undefined;

vi.mock("convex/react", () => ({
  useAction: () => pendingAction(),
  useQuery: emptyQuery,
  useMutation: () => () => Promise.resolve(),
}));

const { default: Artist } = await import("../src/pages/Artist.tsx");
const { default: Album } = await import("../src/pages/Album.tsx");

function renderAt(path, element) {
  return renderToString(
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(
        Routes,
        null,
        createElement(Route, {
          path: "/artist/:artist",
          element: createElement("div", null, element),
        }),
        createElement(Route, {
          path: "/album/:artist/:album",
          element: createElement("div", null, element),
        }),
      ),
    ),
  );
}

describe("the artist page actually renders", () => {
  test("it produces markup containing the artist name", () => {
    const html = renderAt("/artist/Charlie%20Puth", createElement(Artist));
    expect(html.length).toBeGreaterThan(500);
    expect(html).toContain("Charlie Puth");
    // A real header, not an empty shell.
    expect(html).toContain("Artist");
  });

  test("it renders a space-containing name that needs decoding", () => {
    // The URL is percent-encoded; react-router hands the page the DECODED
    // name. If the page decoded it a second time this would throw.
    const html = renderAt("/artist/Tate%20Mc%20Rae", createElement(Artist));
    expect(html).toContain("Tate Mc Rae");
  });

  test("it renders a name containing a percent sign without throwing", () => {
    // This is the URIError case: a second decodeURIComponent on an already
    // decoded param throws on "50% Hits" and takes the page down.
    const html = renderAt("/artist/50%25%20Hits", createElement(Artist));
    expect(html).toContain("50% Hits");
  });

  test("it renders an empty state rather than throwing on a bad param", () => {
    const html = renderAt("/artist/Unknown%20artist", createElement(Artist));
    expect(html.length).toBeGreaterThan(200);
  });

  test("the album page renders both halves of its route", () => {
    const html = renderAt(
      "/album/Charlie%20Puth/100%25%20Pure%20Love",
      createElement(Album),
    );
    expect(html.length).toBeGreaterThan(500);
    // The album page leads with the ALBUM name; the artist carries the route
    // and appears in the search link, so both are asserted separately.
    expect(html).toContain("100% Pure Love");
    expect(html).toContain("Charlie%20Puth");
  });
});
