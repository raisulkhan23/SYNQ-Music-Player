// ---------------------------------------------------------------------------
// OAuth redirect validation shared by the Convex auth callback.
//
// The callback in `src/convex/auth.ts` has to accept two kinds of destination:
//
//   1. an absolute http(s) URL on a SYNQ origin (the web build), and
//   2. the desktop shell's own `synq://callback?...` deep link.
//
// Case 2 is what produced the error `Untrusted redirect origin: null`: a custom
// scheme is not a "special" URL, so `new URL("synq://callback?...").origin` is
// the literal string "null". Comparing that against an origin allowlist can
// never succeed, and "allow origin null" would also allow `file:` documents and
// an OAuth callback redirected into an opaque origin.
//
// So the custom scheme is matched explicitly instead — exact scheme, exact
// host, no path beyond the callback itself. Everything else still goes through
// the http(s) origin allowlist in `auth.ts`, which is unchanged and remains the
// only thing that can approve a web redirect.
// ---------------------------------------------------------------------------

/**
 * True only for the desktop shell's own callback URL.
 *
 * Accepted shapes (the auth server's URL helper rewrites `?` to `/?`):
 *
 *   synq://callback?client=…&ts=…&nonce=…
 *   synq://callback/?client=…&ts=…&nonce=…
 *
 * Rejected: any other scheme, any other host, any deeper path, and the opaque
 * `synq:/callback` form a WHATWG parser can produce from a malformed string.
 * Query parameters are not inspected here — `electron/oauth-deep-link.cjs`
 * validates `client`, `ts`, `nonce` and freshness against the attempt it
 * recorded before the browser left, and drops anything that does not match.
 */
export function isDesktopCallbackUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "synq:") return false;
  if (parsed.hostname !== "callback") return false;
  const path = parsed.pathname.replace(/\/+$/, "");
  return path === "";
}
