/**
 * Discover — route wiring and blast radius.
 *
 * The value of a vector search page is only real if it cannot break the rest
 * of the app. Two things are checked here:
 *
 * 1. The route exists, sits inside the authenticated group, and is wrapped in
 *    the same error/suspense boundary as every other page — so a failure on it
 *    degrades to a card instead of unmounting the shell, the queue and the
 *    player.
 * 2. The vector database is NOT imported by the player, the recommendation
 *    path or the layout. That is what makes this additive: the existing
 *    recommendation engine keeps working from live provider data, untouched,
 *    and the heaviest new code cannot end up on a click-to-play path.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { readSource } from "./helpers/tailwind-css.js";

const root = join(import.meta.dir, "..");
const read = (relative) => readFileSync(join(root, relative), "utf8");

describe("discover route", () => {
  const main = read("src/main.tsx");

  test("is registered as a static import, not a lazy chunk", () => {
    expect(main).toMatch(/import Discover from "\.\/pages\/Discover\.tsx"/);
    expect(main).not.toMatch(/import\([^)]*Discover/);
  });

  test("sits inside the authenticated group with the page boundary", () => {
    // The route must be wrapped in PageBoundary, exactly like every other
    // authenticated page, so a failure here degrades to a card instead of
    // unmounting the shell, the queue and the player.
    const block = main.slice(main.indexOf('path="/discover"'));
    const segment = block.slice(0, block.indexOf("/>") + 2);
    expect(segment).toContain("<PageBoundary>");
    expect(segment).toContain("<Discover />");
  });

  test("the route is declared between other authenticated routes", () => {
    const discoverIndex = main.indexOf('path="/discover"');
    const searchIndex = main.indexOf('path="/search"');
    const artistIndex = main.indexOf('path="/artist/:artist"');
    expect(discoverIndex).toBeGreaterThan(-1);
    expect(searchIndex).toBeGreaterThan(-1);
    expect(artistIndex).toBeGreaterThan(-1);
    // It must not have been appended after the authenticated group's closing
    // brace, which would put it outside RequireAuth/AppShell.
    const groupEnd = main.lastIndexOf(
      '</Route>\n                <Route path="/support"',
    );
    expect(discoverIndex).toBeLessThan(groupEnd);
  });
});

describe("blast radius", () => {
  const CRITICAL = [
    "src/components/layout/AppShell.tsx",
    "src/components/layout/Sidebar.tsx",
    "src/components/player/PlayerBar.tsx",
    "src/components/player/QueuePanel.tsx",
    "src/store/player.ts",
    "src/lib/recommend.ts",
    "src/pages/Home.tsx",
    "src/pages/Search.tsx",
    "src/pages/Artist.tsx",
    "src/pages/Album.tsx",
    "src/pages/Liked.tsx",
  ];

  test("no existing playback or recommendation path imports the vector db", () => {
    const offenders = CRITICAL.filter((file) =>
      /from ["'][^"']*musicdb/.test(readSource(file)),
    );
    expect(offenders).toEqual([]);
  });

  test("the page reaches vectors through the API, not by importing them", () => {
    const page = readSource("src/pages/Discover.tsx");
    // The embedder must never reach the browser bundle: Discover talks to
    // Convex actions, which run the vector code server-side.
    expect(page).not.toMatch(/from ["'][^"']*musicdb/);
    expect(page).toMatch(/api\.libraryVectors\./);
  });

  test("the server-side vector surfaces own the engine", () => {
    for (const file of [
      "src/convex/libraryVectors.ts",
      "src/convex/musicVectorDb.ts",
      "src/convex/convexVectorStore.ts",
    ]) {
      expect(readSource(file)).toMatch(/musicdb|convexVectorStore/);
    }
  });
});
