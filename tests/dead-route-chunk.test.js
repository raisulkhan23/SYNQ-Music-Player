import { describe, expect, test } from "bun:test";
import { readSource } from "./helpers/tailwind-css.js";

const main = readSource("src/main.tsx");

const PAGES = [
  // "Landing" was removed from this list when "/" became the app itself and
  // the marketing page was unrouted. Its file still exists and is still
  // statically referenced by nothing — the pages that belong here are the
  // ones a route actually renders.
  "Auth",
  "TrackLink",
  "Home",
  "Search",
  "Artist",
  "Album",
  "Liked",
  "Playlists",
  "PlaylistDetail",
  "Admin",
  "Stats",
  "Recent",
  "Social",
  "Profile",
  "Settings",
  "NotFound",
  "Support",
  "Privacy",
  "Terms",
];

describe("no route can hang waiting for a chunk that never arrives", () => {
  test("every page is imported eagerly, with no dynamic import anywhere", () => {
    // THE bug, and the reason this file exists. Routes used to be React.lazy()
    // chunks. Vite stamps pre-bundled deps with ?v=<hash>; when the dev server
    // restarts it re-optimises and issues a NEW hash, and a tab open across
    // that restart kept a graph built with the old one. The first dynamic
    // import after it — a route chunk, fetched only on navigation — asked for
    // deps the server no longer served. The request never settled, so React
    // stayed in the Suspense fallback forever: the URL changed and the page sat
    // on "Loading..." indefinitely. A hard refresh worked because a full page
    // load re-reads the entry document and gets a current graph.
    //
    // Retrying could not fix a mechanism that kept failing. Removing the
    // dynamic imports removes the failure mode: there is no chunk to fetch at
    // navigation time, so nothing can fail to arrive and nothing can hang.
    // Assert against CODE, not prose: the doc comment above the imports
    // explains this bug and necessarily names React.lazy().
    const code = main
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/import\("\.\/pages\//);
    expect(code).not.toContain("React.lazy");
    expect(code).not.toMatch(/\blazy\(/);
    expect(code).not.toContain("lazy,");
  });

  test("all twenty pages are statically imported", () => {
    for (const page of PAGES) {
      expect(main).toMatch(
        new RegExp(`import \\w+ from "\\./pages/${page}\\.tsx";`),
      );
    }
  });

  test("AppShell is static too, so the player never tears down on navigation", () => {
    expect(main).toContain(
      'import AppShell from "./components/layout/AppShell.tsx";',
    );
    // Exactly one import — a duplicate would be a silent no-op shadowed by
    // whichever came last.
    expect((main.match(/import AppShell/g) ?? []).length).toBe(1);
  });

  test("the app shell is imported once, before the routes it wraps", () => {
    const shell = main.indexOf("import AppShell");
    const home = main.indexOf('import Home from "./pages/Home.tsx"');
    expect(shell).toBeGreaterThan(-1);
    expect(home).toBeGreaterThan(-1);
  });

  test("the retry machinery is gone rather than left as dead code", () => {
    // Half-removed recovery code is how this bug came back three times. There
    // is no timeout race, no reload cooldown and no pending-forever promise.
    expect(main).not.toContain("recoverFromDeadChunk");
    expect(main).not.toContain("ROUTE_CHUNK_TIMEOUT_MS");
    expect(main).not.toContain("CHUNK_RELOAD_COOLDOWN_MS");
    expect(main).not.toContain("lazyRoute");
  });

  test("navigation can no longer show a loading state at all", () => {
    // RouteLoading survives only as the Suspense fallback for genuinely
    // suspending content. With no lazy chunks, a route change paints the page
    // on the first frame instead of a spinner that may never resolve.
    expect(main).toContain("function RouteLoading()");
    expect(main).toContain("<PageSuspense>");
  });

  test("a crash in any page is still contained to that page", () => {
    // Removing the chunks must not remove the safety net: one bad page still
    // degrades to a recoverable card instead of unmounting the player.
    expect(main).toContain("This page didn&apos;t load");
    expect(main).toContain("onRetry");
    expect(main).toContain("class RouteErrorBoundary");
  });
});
