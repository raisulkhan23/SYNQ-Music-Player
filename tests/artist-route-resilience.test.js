import { describe, expect, test } from "bun:test";
import { readSource } from "./helpers/tailwind-css.js";
import {
  artistPath,
  albumPath,
  parseAlbumRoute,
  routeParam,
} from "../src/lib/artistLinks.ts";

const main = readSource("src/main.tsx");
const artist = readSource("src/pages/Artist.tsx");
const vite = readSource("vite.config.ts");

describe("artist/album route params are not double-decoded", () => {
  test("react-router already decodes, so nothing decodes again", () => {
    // react-router v7 percent-decodes each path segment while matching, so
    // `params.artist` is the DISPLAY name. Running `decodeURIComponent` over
    // it a second time is the bug this test exists to prevent.
    expect(artist).not.toContain("decodeURIComponent(params.artist)");
  });

  test("routeParam returns the value react-router already decoded", () => {
    // A real artist name with a percent sign round-trips intact. Before the
    // fix this THREW a URIError, which unwound the whole app into the root
    // error boundary — a dead screen with no way out but a manual reload.
    expect(routeParam("50% Hits")).toBe("50% Hits");
    expect(routeParam("100% Pure Love")).toBe("100% Pure Love");
    expect(routeParam("Rosalía")).toBe("Rosalía");
    expect(routeParam("Simon & Garfunkel")).toBe("Simon & Garfunkel");
  });

  test("a percent in an artist name cannot crash the page", () => {
    const names = ["50% Hits", "100% Pure Love", "99.9% Fiction"];
    for (const name of names) {
      const path = artistPath(name);
      expect(path).not.toBeNull();
      // Simulate react-router: it decodes the segment once when matching.
      const param = decodeURIComponent(path.replace("/artist/", ""));
      expect(() => routeParam(param)).not.toThrow();
      expect(routeParam(param)).toBe(name);
    }
  });

  test("parseAlbumRoute survives percent signs in either half", () => {
    const path = albumPath("50% Hits", "100% Pure Love");
    // `/album/<artist>/<album>` — the first segment is the literal "album".
    const [, , artistPart, albumPart] = path.split("/");
    const parsed = parseAlbumRoute(
      decodeURIComponent(artistPart),
      decodeURIComponent(albumPart),
    );
    expect(parsed).toEqual({
      artist: "50% Hits",
      album: "100% Pure Love",
    });
  });

  test("parseAlbumRoute still rejects unusable pairs", () => {
    // The fix must not turn the null guard into a pass-everything.
    expect(parseAlbumRoute("", "")).toBeNull();
    expect(parseAlbumRoute("Katy Perry", "")).toBeNull();
    expect(parseAlbumRoute(undefined, undefined)).toBeNull();
    expect(parseAlbumRoute("Unknown artist", "Teenage Dream")).toBeNull();
  });
});

describe("one bad page can no longer kill the whole app", () => {
  test("every route is wrapped in the error boundary, not just Suspense", () => {
    // A throw inside a page used to unwind AppShell, the player and the nav.
    const opens = (main.match(/<PageBoundary>/g) ?? []).length;
    const closes = (main.match(/<\/PageBoundary>/g) ?? []).length;
    expect(opens).toBeGreaterThanOrEqual(13);
    expect(opens).toBe(closes);
  });

  test("the boundary is composed around the existing Suspense boundary", () => {
    // The player must never unmount while a lazy page chunk loads, so the
    // error boundary wraps the Suspense boundary rather than replacing it.
    expect(main).toMatch(
      /function PageBoundary\([\s\S]*?<RouteErrorBoundary>[\s\S]*?<PageSuspense>/,
    );
  });

  test("a crashed route offers a way out instead of a dead screen", () => {
    expect(main).toContain("This page didn&apos;t load");
    expect(main).toContain("onRetry");
    expect(main).toContain('to="/home"');
    // And it says the rest of the app still works, because it does.
    expect(main).toContain("your queue and playback are fine");
  });

  test("the root boundary is no longer a dead end", () => {
    // The last-resort boundary also needs a visible escape hatch.
    expect(main).toContain("Reload SYNQ");
    expect(main).toContain("window.location.reload()");
  });

  test("the dev error overlay is off, so boundaries are the only signal", () => {
    // Documents WHY the boundaries matter here: with no overlay, a runtime
    // error is otherwise completely silent to the listener.
    expect(vite).toContain("overlay: false");
  });
});
