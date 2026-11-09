import { describe, expect, test } from "bun:test";
import { readSource } from "./helpers/tailwind-css.js";

const auth = readSource("src/convex/auth.ts");
const authPage = readSource("src/pages/Auth.tsx");
const prompt = readSource("src/components/auth/AuthPromptDialog.tsx");

/**
 * The sign-in round-trip, end to end, is mostly the provider's; the part this
 * repo owns is the RETURN. Both entry points send an absolute URL
 * (`window.location.origin + path`), and the Convex Auth redirect callback
 * throws on an origin it does not trust — so an untrusted deployment origin
 * means a successful provider login that lands the user signed out.
 *
 * That was the Pages bug. These assertions pin the two things that have to
 * stay true for it not to come back.
 */

describe("OAuth return paths are absolute, so the origin list is load-bearing", () => {
  test("both sign-in entry points send an absolute return URL", () => {
    expect(authPage).toContain("window.location.origin");
    expect(prompt).toContain("window.location.origin");
  });

  test("the Pages production domains are trusted", () => {
    expect(auth).toContain("https://synqmusic.pages.dev");
    expect(auth).toContain("https://synq-music-player.pages.dev");
  });

  test("per-deployment preview URLs of those two projects are trusted", () => {
    expect(auth).toMatch(/synqmusic\|synq-music-player/);
    expect(auth).toMatch(/pages\\\.dev/);
  });

  test("trust is scoped to the SYNQ projects, not all of pages.dev", () => {
    // A blanket *.pages.dev rule would let any unrelated static site on the
    // platform receive the post-login redirect.
    expect(auth).not.toMatch(/\[\^\.\]\+\\\.pages\\\.dev/);
    expect(auth).not.toMatch(/\\\.pages\\\.dev\$\/i\.test\(normalized\)\s*\|\|\s*$/m);
  });

  test("an absolute redirect is still origin-checked before it is returned", () => {
    expect(auth).toContain("isTrustedOrigin(origin)");
    expect(auth).toContain("Untrusted redirect origin");
  });
});
