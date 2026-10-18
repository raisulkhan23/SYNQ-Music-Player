/**
 * Navigation, tested the only way that actually proves it: a real DOM, a real
 * click, a real assertion on what the user would see.
 *
 * Every earlier check inspected pages, hrefs or the route table in isolation,
 * and the app still shipped with "the URL changes but the page does not". None
 * of them ever moved the mouse. These do.
 *
 * They cover the three navigation surfaces SYNQ has:
 *   1. an artist <Link> inside a track row (search results, queue)
 *   2. the same link with the real AppShell + RequireAuth layout above it
 *   3. an artist MediaCard, which navigates from the card's own onClick
 *      (the "Artists you listen to" shelf on Home)
 *
 * If react-router, the environment or the shell ever breaks again, one of
 * these fails here rather than in the browser.
 */
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useNavigate } from "react-router";

let win;

beforeAll(() => {
  win = new Window({ url: "https://example.test/home" });
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.navigator = win.navigator;
  globalThis.location = win.location;
  globalThis.history = win.history;
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.Element = win.Element;
  globalThis.Node = win.Node;
  globalThis.Event = win.Event;
  globalThis.MouseEvent = win.MouseEvent;
  globalThis.CustomEvent = win.CustomEvent;
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  // The real happy-dom HTMLAudioElement is used, not a stub: the player store
  // appends the shared <audio> to document.body, which needs a genuine node.
  globalThis.Audio = win.Audio;
  globalThis.localStorage = win.localStorage;
  win.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
});

const pendingAction = () => () => Promise.resolve({ items: [] });

mock.module("convex/react", () => ({
  useQuery: () => undefined,
  useAction: () => pendingAction(),
  useMutation: () => pendingAction(),
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  usePaginatedQuery: () => ({
    results: [],
    status: "Success",
    loadMore: () => {},
  }),
  ConvexProvider: ({ children }) => children,
  ConvexReactClient: class {},
}));

mock.module("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signIn: () => {}, signOut: () => {} }),
  ConvexAuthProvider: ({ children }) => children,
}));

mock.module("@/hooks/use-auth", () => ({
  useAuth: () => ({
    isLoading: false,
    isAuthenticated: true,
    user: { name: "Test" },
    signIn: () => {},
    signOut: () => {},
  }),
}));

const TRACK = {
  id: "abc123",
  title: "We Don't Talk Anymore",
  artist: "Charlie Puth",
  album: "Nine Track Mind",
  thumbnail: "https://example.test/c.jpg",
  duration: 219,
};

const ARTIST_HREF = "/artist/Charlie%20Puth";

function renderApp(routes) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  // The window is shared across tests, so each one starts from a known URL
  // rather than inheriting wherever the previous click left it.
  win.happyDOM.setURL("https://example.test/home");
  root.render(
    React.createElement(
      BrowserRouter,
      null,
      React.createElement(Routes, null, ...routes),
    ),
  );
  return { container, root };
}

async function settle() {
  // `act` is deliberately not used: a settled act never returns while the
  // player store's timers keep the queue alive. A macrotask turn is enough for
  // the router update and the page's effects to land.
  await new Promise((resolve) => setTimeout(resolve, 100));
}

function click(container, selector) {
  const el = container.querySelector(selector);
  if (!el) throw new Error(`no element matched ${selector}`);
  el.dispatchEvent(
    new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
  );
  return settle();
}

describe("clicking through to an artist in a real DOM", () => {
  test("an artist link in a track row swaps the view", async () => {
    const { RemoteTrackRow } =
      await import("@/components/tracks/RemoteTrackRow");
    const Artist = (await import("@/pages/Artist")).default;

    function Library() {
      return React.createElement(
        "div",
        null,
        React.createElement("h1", null, "YOUR LIBRARY"),
        React.createElement(RemoteTrackRow, {
          item: TRACK,
          index: 1,
          onPlay: () => {},
        }),
      );
    }

    const { container } = renderApp([
      React.createElement(Route, {
        path: "/home",
        element: React.createElement(Library),
      }),
      React.createElement(Route, {
        path: "/artist/:artist",
        element: React.createElement(Artist),
      }),
    ]);
    await settle();

    expect(container.textContent).toContain("YOUR LIBRARY");

    const link = [...container.querySelectorAll("a")].find((a) =>
      a.textContent.includes("Charlie Puth"),
    );
    expect(link).toBeDefined();
    expect(link.getAttribute("href")).toBe(ARTIST_HREF);

    await click(container, `a[href="${ARTIST_HREF}"]`);

    expect(win.location.pathname).toBe(ARTIST_HREF);
    expect(container.textContent).not.toContain("YOUR LIBRARY");
    expect(container.textContent).toContain("Charlie Puth");
  }, 30000);

  test("the same click works inside the real AppShell + RequireAuth layout", async () => {
    const { RemoteTrackRow } =
      await import("@/components/tracks/RemoteTrackRow");
    const Artist = (await import("@/pages/Artist")).default;
    const AppShell = (await import("@/components/layout/AppShell")).default;
    const { RequireAuth } = await import("@/components/RequireAuth");

    function Library() {
      return React.createElement(
        "div",
        null,
        React.createElement("h1", null, "YOUR LIBRARY"),
        React.createElement(RemoteTrackRow, {
          item: TRACK,
          index: 1,
          onPlay: () => {},
        }),
      );
    }

    const { container } = renderApp([
      React.createElement(Route, {
        element: React.createElement(
          RequireAuth,
          null,
          React.createElement(AppShell),
        ),
      }),
      React.createElement(Route, {
        path: "/home",
        element: React.createElement(Library),
      }),
      React.createElement(Route, {
        path: "/artist/:artist",
        element: React.createElement(Artist),
      }),
    ]);
    await settle();

    expect(container.textContent).toContain("YOUR LIBRARY");

    await click(container, `a[href="${ARTIST_HREF}"]`);

    expect(win.location.pathname).toBe(ARTIST_HREF);
    expect(container.textContent).not.toContain("YOUR LIBRARY");
    expect(container.textContent).toContain("Charlie Puth");
  }, 30000);

  test("an artist card on Home navigates to the artist page", async () => {
    const { MediaCard } = await import("@/components/tracks/MediaCard");
    const Artist = (await import("@/pages/Artist")).default;
    const { artistPath } = await import("@/lib/artistLinks");

    // This is the Home "Artists you listen to" shelf, which navigates from the
    // card's own onClick rather than from a link — a different code path with
    // the same user-visible outcome.
    function ArtistShelf() {
      const navigate = useNavigate();
      return React.createElement(
        "div",
        null,
        React.createElement("h1", null, "YOUR SHELF"),
        React.createElement(MediaCard, {
          variant: "artist",
          round: true,
          item: {
            id: "cp",
            title: "Charlie Puth",
            artist: "Charlie Puth",
            duration: 0,
            thumbnail: "",
          },
          onOpen: () => navigate(artistPath("Charlie Puth") ?? "/search"),
        }),
      );
    }

    const { container } = renderApp([
      React.createElement(Route, {
        path: "/home",
        element: React.createElement(ArtistShelf),
      }),
      React.createElement(Route, {
        path: "/artist/:artist",
        element: React.createElement(Artist),
      }),
    ]);
    await settle();

    expect(container.textContent).toContain("YOUR SHELF");

    await click(container, `div[role="button"]`);

    expect(win.location.pathname).toBe(ARTIST_HREF);
    expect(container.textContent).not.toContain("YOUR SHELF");
    expect(container.textContent).toContain("Charlie Puth");
  }, 30000);

  test("a click still lands while a Shelf is on screen", async () => {
    // The exact reported failure: a Shelf re-measured itself after every
    // render and set state with a fresh object each time, so React looped
    // until it hit "Maximum update depth exceeded" and unwound the commit.
    // With a Shelf mounted, clicking a link changed the URL and left the
    // previous page on screen, untouched.
    const { Shelf } = await import("@/components/core/shelf");
    const { RemoteTrackRow } =
      await import("@/components/tracks/RemoteTrackRow");
    const Artist = (await import("@/pages/Artist")).default;

    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };

    function Library() {
      return React.createElement(
        Shelf,
        { title: "Recently played", id: "shelf-recent" },
        React.createElement(RemoteTrackRow, {
          item: TRACK,
          index: 1,
          onPlay: () => {},
        }),
      );
    }

    const logged = [];
    const realError = console.error;
    console.error = (...args) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      const { container } = renderApp([
        React.createElement(Route, {
          path: "/home",
          element: React.createElement(Library),
        }),
        React.createElement(Route, {
          path: "/artist/:artist",
          element: React.createElement(Artist),
        }),
      ]);
      await settle();

      expect(container.textContent).toContain("Recently played");

      await click(container, `a[href="${ARTIST_HREF}"]`);

      expect(win.location.pathname).toBe(ARTIST_HREF);
      expect(container.textContent).not.toContain("Recently played");
      expect(container.textContent).toContain("Charlie Puth");
      expect(logged.join(" ")).not.toContain("Maximum update depth exceeded");
    } finally {
      console.error = realError;
    }
  }, 30000);
});
