import { describe, expect, test } from "bun:test";
import { isDesktopCallbackUrl } from "../src/lib/oauthRedirect.ts";
import { readSource } from "./helpers/tailwind-css.js";

/**
 * Google sign-in failed with `Untrusted redirect origin: null`.
 *
 * Root cause: the desktop build returns through its own `synq://callback` deep
 * link, and a custom scheme is not a "special" URL — `new URL(url).origin` is
 * the literal string `"null"`. The redirect callback compared that against a
 * list of https origins, so EVERY desktop sign-in was rejected before the
 * browser could be handed back to the app. The error page was served by the
 * Convex deployment, which is why it appeared at the callback URL.
 *
 * The fix is an explicit scheme+host allowlist for that one return path, not a
 * relaxation of the origin check: an http(s) redirect still has to be on a
 * trusted SYNQ origin, and no other custom scheme is accepted.
 */

describe("the desktop return path", () => {
  test("accepts both spellings the auth server produces", () => {
    expect(
      isDesktopCallbackUrl(
        "synq://callback?client=google-abc&ts=1700000000000&nonce=n",
      ),
    ).toBe(true);
    // @convex-dev/auth's URL helper rewrites `?` into `/?`.
    expect(
      isDesktopCallbackUrl(
        "synq://callback/?client=google-abc&ts=1700000000000&nonce=n&code=C",
      ),
    ).toBe(true);
  });

  test("rejects every other custom-scheme destination", () => {
    for (const value of [
      "synq://evil",
      "synq://callback/extra",
      "synq://callback/deep/path",
      "synq://other?client=x",
      "synq:/callback?client=x", // opaque form of the scheme
      "file:///C:/Windows/System32/drivers/etc/hosts",
      "javascript:alert(1)",
      "data:text/html,hi",
      "about:blank",
      "null",
      "",
    ]) {
      expect(isDesktopCallbackUrl(value)).toBe(false);
    }
  });

  test("never treats a web URL as the desktop callback", () => {
    expect(isDesktopCallbackUrl("https://synqmusic.com/auth")).toBe(false);
    expect(isDesktopCallbackUrl("http://localhost:5173/auth")).toBe(false);
  });

  test("non-strings are rejected rather than coerced", () => {
    expect(isDesktopCallbackUrl(null)).toBe(false);
    expect(isDesktopCallbackUrl(undefined)).toBe(false);
    expect(isDesktopCallbackUrl(42)).toBe(false);
    expect(isDesktopCallbackUrl({ href: "synq://callback" })).toBe(false);
  });
});

describe("the auth callback keeps validating everything else", () => {
  const authSrc = readSource("src/convex/auth.ts");

  test("the desktop allowlist is consulted", () => {
    expect(authSrc).toContain("isDesktopCallbackUrl");
    expect(authSrc).toMatch(/if \(isDesktopCallbackUrl\(redirectTo\)\) return redirectTo;/);
  });

  test("an http(s) redirect still has to be on a trusted origin", () => {
    // The allowlist is for the custom scheme only. A web redirect must still
    // pass `isTrustedOrigin`, otherwise the fix would be an open redirect.
    expect(authSrc).toMatch(/if \(!isTrustedOrigin\(origin\)\) \{/);
    expect(authSrc).toContain("Untrusted redirect origin");
  });

  test("a non-http scheme is refused by name, not as a null origin", () => {
    // `new URL("foo://bar").origin` is "null", which produced the
    // undiagnosable `Untrusted redirect origin: null`.
    expect(authSrc).toMatch(/parsed\.protocol !== "https:" && parsed\.protocol !== "http:"/);
    expect(authSrc).toMatch(/Untrusted redirect scheme/);
  });
});
