import { describe, expect, test } from "bun:test";
import { readSource } from "./helpers/tailwind-css.js";

const main = readSource("src/main.tsx");

const PAGES = [
  // "Landing" was removed from this list when "/" became the app itself and
  // the marketing page was unrouted. Its file still exists and is still
  // referenced by nothing — the pages that belong here are the ones a route
  // actually renders.
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
 * It used to be enforced by forbidding dynamic imports outright — every page
 * was a static import, so there was no chunk to wait for. That worked, but it
 * cost a ~1 MB initial bundle on every load, because all ~20 pages shipped in
 * the entry chunk.
 *
 * The pages are lazy again, and the invariant is now enforced differently: every
 * route import goes through `lazyRoute`, which RACES the chunk fetch against
 * `ROUTE_CHUNK_TIMEOUT_MS`. A request that never settles (the original bug: a
 * dev-server restart invalidates Vite's `?v=` dep hash, and the stale tab asks
 * for a hash the server no longer serves) therefore REJECTS instead of pending
 * forever. The rejection surfaces through `PageBoundary`'s error boundary and
 * renders the retry card, which is exactly the state a manual refresh used to
 * be needed to reach.
 *
 * These tests assert THAT mechanism is present and actually wired to every
 * route. Weakening them (e.g. just checking `React.lazy` appears) would leave
 * the original bug reachable again, so each assertion pins a specific link in
 * the chain.
 */
describe("no route can hang waiting for a chunk that never arrives", () => {
  test("a bounded wait exists, so an unsettled chunk becomes a caught error", () => {
    // The bound itself…
    expect(codeOnly).toMatch(/const ROUTE_CHUNK_TIMEOUT_MS = [\d_]+;/);
    // …and it must actually be applied: a timeout constant that nothing races
    // against is precisely the "dead retry machinery" this file once guarded
    // against, just inverted.
    expect(codeOnly).toMatch(/Promise\.race\(\[/);
    expect(codeOnly).toMatch(/setTimeout\(/);
    expect(codeOnly).toMatch(/reject\(/);
    // The race must reference the bound rather than a magic number, or the
    // constant drifts away from the behaviour.
    expect(codeOnly).toMatch(/,\s*ROUTE_CHUNK_TIMEOUT_MS,?/);
  });

  test("every page is registered through the guarded loader", () => {
    // Assert on the import TARGET, not the binding name: the auth page binds
    // as `AuthPage` while everything else uses its own name, and neither
    // matters to the invariant. What matters is that every page's module is
    // reached via `lazyRoute`, so every route gets the bounded wait.
    for (const page of PAGES) {
      expect(main).toMatch(
        new RegExp(`lazyRoute\\(\\(\\) => import\\("\\./pages/${page}\\.tsx"\\)\\)`),
      );
    }
  });

  test("all twenty pages are accounted for (19 here + Discover)", () => {
    // Guards against a route quietly reverting to a bare static import and
    // silently re-inflating the entry chunk.
    expect(PAGES.length).toBe(19);
    for (const page of PAGES) {
      expect(codeOnly).not.toMatch(
        new RegExp(`^import \\w+ from "\\./pages/${page}\\.tsx";`, "m"),
      );
    }
    expect(main).toMatch(
      /const Discover = lazyRoute\(\(\) => import\("\.\/pages\/Discover\.tsx"\)\);/,
    );
  });

  test("AppShell is static too, so the player never tears down on navigation", () => {
    expect(main).toContain(
      'import AppShell from "./components/layout/AppShell.tsx";',
    );
    // Exactly one import — a duplicate would be a silent no-op shadowed by
    // whichever came last.
    expect((main.match(/import AppShell/g) ?? []).length).toBe(1);
    // It must NOT be lazy: tearing down the shell would stop audio.
    expect(codeOnly).not.toMatch(/AppShell = lazyRoute/);
  });

  test("the app shell is imported before the route loaders it wraps", () => {
    const shell = main.indexOf("import AppShell");
    const home = main.indexOf('const Home = lazyRoute');
    expect(shell).toBeGreaterThan(-1);
    expect(home).toBeGreaterThan(-1);
    expect(shell).toBeLessThan(home);
  });

  test("the recovery path is one coherent mechanism, not scattered dead code", () => {
    // The guard is bounded and the failure lands in a boundary the user can
    // act on. Half-removed recovery code is how this bug came back three times,
    // so the names that used to describe the old abandoned machinery must not
    // survive alongside the new one.
    expect(codeOnly).toContain("lazyRoute");
    expect(codeOnly).toContain("ROUTE_CHUNK_TIMEOUT_MS");
    expect(codeOnly).not.toContain("recoverFromDeadChunk");
    expect(codeOnly).not.toContain("CHUNK_RELOAD_COOLDOWN_MS");
  });

  test("every route renders inside the boundary that catches a rejected chunk", () => {
    // A rejection with no boundary above it unwinds to the ROOT boundary and
    // unmounts the player. Count the page-rendering routes: each must be
    // inside a <PageBoundary>.
    expect(main).toContain("<PageBoundary>");
    // The public pages and the 404 were not wrapped before they were lazy;
    // they must be now.
    for (const path of ["/auth", "/t/:trackId", "/support", "/privacy", "/terms", "*"]) {
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
