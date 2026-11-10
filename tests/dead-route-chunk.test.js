import { describe, expect, test } from "bun:test";
import { readSource } from "./helpers/tailwind-css.js";

const main = readSource("src/main.tsx");

// Every page a route renders. Landing is here because "/" renders it for web
// visitors: the packaged shells redirect to /home, but the browser gets the
// marketing page, so it must be a static import like every other route.
const PAGES = [
  "Auth",
  "Landing",
  "TrackLink",
  "Home",
  "Search",
  "Discover",
  "DownloadHub",
  "ImportHub",
  "Artist",
  "Album",
  "Liked",
  "Playlists",
  "PlaylistDetail",
  "Admin",
  "Stats",
  "Recap",
  "Recent",
  "Social",
  "Profile",
  "Settings",
  "NotFound",
  "Support",
  "Privacy",
  "Terms",
];

// Comments carry a lot of prose naming React.lazy(), so assertions about the
// MECHANISM run against code only. Assertions about which pages are wired up
// run against the raw source, because the import lines must be visible there.
const codeOnly = main
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/**
 * The invariant this file exists to protect:
 *
 *   **No route may sit on a spinner forever waiting for code that never
 *   arrives.**
 *
 * The route layer cycled through designs before settling:
 *
 *   1. Dynamic `React.lazy` imports — the original bug. A dev-server restart
 *      re-optimises deps under a NEW `?v=` hash; a tab open across the restart
 *      asks for a route chunk under the old hash, the request never settles,
 *      and React sits in the Suspense fallback forever.
 *   2. A guarded loader (`lazyRoute` + `ROUTE_CHUNK_TIMEOUT_MS`) that raced
 *      each chunk fetch against a timeout so it REJECTED instead of pending.
 *   3. The current design: NO route chunks at all. Every page is a static
 *      import, so there is nothing to fetch at navigation time and nothing
 *      that can fail to arrive. Navigation is instant; the cost is a larger
 *      entry bundle, a deliberate trade for reliability (the comment above the
 *      imports in `src/main.tsx` records that reasoning).
 *
 * These tests assert the CURRENT mechanism. The strongest form of "a hung
 * chunk cannot happen" is structural: if there is no dynamic route import,
 * there is nothing to hang. A regression to a lazy route fails test 1 and 2
 * immediately, and the boundary assertions below keep a page crash contained
 * either way.
 */
describe("no route can hang waiting for a chunk that never arrives", () => {
  test("every page is statically imported", () => {
    for (const page of PAGES) {
      expect(main).toMatch(
        new RegExp(`^import \\w+ from "\\./pages/${page}\\.tsx";`, "m"),
      );
    }
  });

  test("all twenty-four pages are accounted for", () => {
    expect(PAGES.length).toBe(24);
  });

  test("no page is loaded through a dynamic import, so there is no chunk to wait for", () => {
    // The structural invariant. A dynamic import of a page module — however
    // it is wrapped (React.lazy, lazyRoute, Promise.race, anything) — is
    // forbidden: navigation must not fetch.
    expect(codeOnly).not.toMatch(/import\(["'`]\.\/pages\//);
    expect(codeOnly).not.toMatch(/import\(["'`]@\/pages\//);
    // And no route-level lazy machinery survives from the previous designs.
    expect(codeOnly).not.toMatch(/lazyRoute|React\.lazy\(|ROUTE_CHUNK_TIMEOUT_MS/);
  });

  test("AppShell is static, so the player never tears down on navigation", () => {
    expect(main).toContain(
      'import AppShell from "./components/layout/AppShell.tsx";',
    );
    // Exactly one import — a duplicate would be a silent no-op shadowed by
    // whichever came last.
    expect((main.match(/import AppShell/g) ?? []).length).toBe(1);
    expect(codeOnly).not.toMatch(/AppShell = lazyRoute/);
    expect(codeOnly).not.toMatch(/import\(["'`]\.\/components\/layout\/AppShell/);
  });

  test("the app shell is imported before the pages it wraps", () => {
    const shell = main.indexOf("import AppShell");
    const firstPage = Math.min(
      ...PAGES.map((page) => main.indexOf(`from "./pages/${page}.tsx"`)),
    );
    expect(shell).toBeGreaterThan(-1);
    expect(firstPage).toBeGreaterThan(-1);
    expect(shell).toBeLessThan(firstPage);
  });

  test("every shell route renders inside the boundary that catches a crashing page", () => {
    // A throw inside any page unwinds to THIS boundary, not to the root one —
    // the player, queue and nav survive a bad page.
    expect(main).toContain("<PageBoundary>");
    // Every route the AppShell renders (signed-out and RequireAuth alike).
    for (const path of [
      "/",
      "/home",
      "/search",
      "/discover",
      "/downloads",
      "/import",
      "/artist/:artist",
      "/album/:artist/:album",
      "/liked",
      "/playlists",
      "/playlist/:id",
      "/stats",
      "/recent",
      "/recap",
      "/social",
      "/profile",
      "/settings",
      "/admin",
    ]) {
      const idx = main.indexOf(`path="${path}"`);
      expect(idx).toBeGreaterThan(-1);
      const segment = main.slice(idx, main.indexOf("/>", idx) + 2);
      expect(segment).toContain("<PageBoundary>");
    }
  });

  test("a loading state exists and a crash in any page is still contained", () => {
    expect(main).toContain("function RouteLoading()");
    expect(main).toContain("<PageSuspense>");
    expect(main).toContain("This page didn&apos;t load");
    expect(main).toContain("onRetry");
    expect(main).toContain("class RouteErrorBoundary");
  });
});
