/**
 * Do the real artist/album hrefs actually MATCH the route table?
 *
 * The reported symptom is "the URL updates but the page does not". The pages
 * themselves are proven to render (render-artist-page.test.js), so the question
 * left is whether the href the app produces resolves to the artist route at
 * all. `matchRoutes` is react-router's own matcher — the same code the runtime
 * uses — so this answers that without needing a DOM.
 *
 * A client-side swap cannot be exercised here: there is no DOM library in this
 * project, and `renderToString` never runs effects, so a navigation cannot be
 * driven through it.
 */
import { describe, expect, test, mock } from "bun:test";
import { matchRoutes } from "react-router";
import { artistPath, albumPath } from "../src/lib/artistLinks.ts";

mock.module("convex/react", () => ({
  useAction: () => () => Promise.resolve({ items: [] }),
  useQuery: () => undefined,
  useMutation: () => () => Promise.resolve(),
}));

// Mirrors the shape declared in src/main.tsx: a public group, then the
// authenticated group whose children are the app pages.
const ROUTES = [
  { path: "/", element: "Landing" },
  { path: "/auth", element: "Auth" },
  { path: "/home", element: "Home" },
  { path: "/search", element: "Search" },
  { path: "/artist/:artist", element: "Artist" },
  { path: "/album/:artist/:album", element: "Album" },
  { path: "/liked", element: "Liked" },
  { path: "/playlists", element: "Playlists" },
  { path: "/playlist/:id", element: "PlaylistDetail" },
  { path: "/stats", element: "Stats" },
  { path: "/recent", element: "Recent" },
  { path: "/social", element: "Social" },
  { path: "/profile", element: "Profile" },
  { path: "/settings", element: "Settings" },
  { path: "/admin", element: "Admin" },
  { path: "/support", element: "Support" },
  { path: "/privacy", element: "Privacy" },
  { path: "/terms", element: "Terms" },
  { path: "*", element: "NotFound" },
];

const resolve = (href) => {
  const matches = matchRoutes(ROUTES, href);
  return {
    matched: matches !== null,
    leaf: matches?.[matches.length - 1]?.route?.element ?? null,
    param: matches?.[matches.length - 1]?.params ?? null,
  };
};

describe("every href the app produces resolves to its route", () => {
  test("an artist link resolves to the Artist route, not NotFound", () => {
    const r = resolve(artistPath("Charlie Puth"));
    expect(r.matched).toBe(true);
    expect(r.leaf).toBe("Artist");
    expect(r.param.artist).toBe("Charlie Puth");
  });

  test("an artist name with a percent sign still resolves", () => {
    // The href is percent-ENCODED; the router decodes it for the param. A
    // mismatch here is exactly what would produce a URL that changes but
    // renders the wrong thing.
    const r = resolve(artistPath("50% Hits"));
    expect(r.matched).toBe(true);
    expect(r.leaf).toBe("Artist");
    expect(r.param.artist).toBe("50% Hits");
  });

  test("non-ASCII and punctuation-heavy names resolve", () => {
    for (const name of [
      "Beyoncé",
      "Simon & Garfunkel",
      "Tate Mc Rae",
      "A$AP Rocky",
      "AC/DC",
    ]) {
      const r = resolve(artistPath(name));
      expect(r.leaf, name).toBe("Artist");
      expect(r.param.artist, name).toBe(name);
    }
  });

  test("an album link resolves with both params intact", () => {
    const r = resolve(albumPath("Charlie Puth", "100% Pure Love"));
    expect(r.leaf).toBe("Album");
    expect(r.param).toEqual({
      artist: "Charlie Puth",
      album: "100% Pure Love",
    });
  });

  test("every other top-level destination still resolves", () => {
    for (const [href, leaf] of [
      ["/home", "Home"],
      ["/search", "Search"],
      ["/liked", "Liked"],
      ["/playlists", "Playlists"],
      ["/recent", "Recent"],
      ["/stats", "Stats"],
      ["/social", "Social"],
      ["/profile", "Profile"],
    ]) {
      expect(resolve(href).leaf, href).toBe(leaf);
    }
  });

  test("a genuinely unknown path still lands on NotFound", () => {
    // Guards against over-matching: the catch-all must keep working, or a
    // typo would render an arbitrary page instead of the 404.
    expect(resolve("/definitely-not-a-page").leaf).toBe("NotFound");
  });
});
