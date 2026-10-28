// THIS FILE IS READ ONLY. Do not touch this file unless you are correctly adding a new auth provider in accordance to the vly auth documentation

import { convexAuth } from "@convex-dev/auth/server";
import { emailOtp } from "./auth/emailOtp";
import Google from "@auth/core/providers/google";
import GitHub from "@auth/core/providers/github";
// Relative, not `@/`: the Convex bundler does not resolve the alias.
import { isDesktopCallbackUrl } from "../lib/oauthRedirect";

const SITE_URL_ENV = (
  process.env.CONVEX_SITE_URL ??
  process.env.SITE_URL ??
  ""
).replace(/\/$/, "");

const TRUSTED_ORIGINS = [
  SITE_URL_ENV,
  "https://synqmusic.com",
  "https://synq-music.com",
  // Add your own deployment hosts here, e.g.
  //   "https://<your-deployment>.convex.site",
  //   "https://<your-deployment>.convex.cloud",
  // `SITE_URL_ENV` above covers the normal case: Convex sets CONVEX_SITE_URL /
  // SITE_URL on the deployment, so only additional frontend origins belong in
  // this list.
  "https://freebuff.com",
  "https://www.freebuff.com",
]
  .filter((x): x is string => !!x)
  .map((x) => x.replace(/\/$/, ""));

function isTrustedOrigin(origin: string): boolean {
  const normalized = origin.replace(/\/$/, "");
  return (
    TRUSTED_ORIGINS.includes(normalized) ||
    /^https:\/\/(?:[a-z0-9-]+\.)*freebuff\.(?:app|com|dev)$/i.test(normalized) ||
    /^https:\/\/[a-z0-9-]+\.vly\.sh$/i.test(normalized)
  );
}

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    emailOtp,
    // OAuth providers — credentials come from the deployment's env vars:
    //   AUTH_GOOGLE_ID, AUTH_GOOGLE_SECRET
    //   AUTH_GITHUB_ID, AUTH_GITHUB_SECRET
    Google,
    GitHub,
  ],
  callbacks: {
    // The deployment's SITE_URL points at the convex.site host, so
    // absolute redirects to the real frontend domain get rejected by the
    // default callback. The client sends a RELATIVE path; we resolve it
    // against the trusted frontend origin here.
    redirect: async ({ redirectTo }) => {
      // ── Desktop shell ──────────────────────────────────────────────────
      // The Electron build returns through its own `synq://callback` deep
      // link (see `src/lib/desktop-auth.ts`). A custom scheme is not a
      // special URL, so its `origin` is the literal string "null" — the
      // old absolute-origin check therefore rejected every desktop sign-in
      // with `Untrusted redirect origin: null`, before the browser could be
      // handed back to the app. It is accepted here only in its exact
      // scheme/host shape; the deep-link handler then re-validates the
      // attempt id, timestamp, nonce and freshness.
      if (isDesktopCallbackUrl(redirectTo)) return redirectTo;

      // The frontend origin, never the Convex deployment host: SITE_URL is
      // the `*.convex.site` origin, so falling back to it would send a
      // relative redirect to the backend instead of the app.
      const base =
        TRUSTED_ORIGINS.find(
          (o) =>
            o.startsWith("https://") &&
            !o.includes(".convex.site") &&
            !o.includes(".convex.cloud"),
        ) ?? SITE_URL_ENV;
      if (redirectTo.startsWith("/") || redirectTo.startsWith("?")) {
        return `${base}${redirectTo}`;
      }

      // Absolute URL — only an http(s) URL on a trusted origin may pass.
      let parsed: URL;
      try {
        parsed = new URL(redirectTo);
      } catch {
        throw new Error("Untrusted redirect: not a valid URL");
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        // Name the scheme rather than the opaque "null" origin, so the
        // remaining failure is diagnosable instead of mysterious.
        throw new Error(`Untrusted redirect scheme: ${parsed.protocol}`);
      }
      const origin = parsed.origin.replace(/\/$/, "");
      if (!isTrustedOrigin(origin)) {
        throw new Error(`Untrusted redirect origin: ${origin}`);
      }
      return redirectTo;
    },
  },
});
