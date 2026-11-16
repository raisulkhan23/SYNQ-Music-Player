// THIS FILE IS READ ONLY. Do not touch this file unless you are correctly adding a new auth provider in accordance to the vly auth documentation

import { convexAuth } from "@convex-dev/auth/server";
import { emailOtp } from "./auth/emailOtp";
import Google from "@auth/core/providers/google";
import GitHub from "@auth/core/providers/github";

const SITE_URL_ENV = (
  process.env.CONVEX_SITE_URL ??
  process.env.SITE_URL ??
  ""
).replace(/\/$/, "");

const TRUSTED_ORIGINS = [
  SITE_URL_ENV,
  "https://synqmusic.com",
  "https://synq-music.com",
  "https://frugal-lobster-91.convex.site",
  "https://frugal-lobster-91.convex.cloud",
  "https://freebuff.com",
  "https://www.freebuff.com",
  // The Pages deployments. Sign-in sends an ABSOLUTE return URL
  // (`window.location.origin + path` — see Auth.tsx and AuthPromptDialog), and
  // the redirect callback below refuses any origin it does not trust. That is
  // exactly how OAuth appeared to work on freebuff.app and failed on Pages:
  // the provider round-trip succeeded, then the callback threw on the return
  // origin and the user landed signed out. Both project domains are listed,
  // not a wildcard, so an unrelated *.pages.dev site cannot receive a token.
  "https://synqmusic.pages.dev",
  "https://synq-music-player.pages.dev",
  // The packaged Android app. Capacitor's default `androidScheme: "https"`
  // makes the WebView report `https://localhost`, which is a real web origin
  // the OAuth redirect has to be allowed back into. Without it, an Android
  // sign-in completed with the provider and then the callback threw
  // "Untrusted redirect origin: https://localhost" — the user landed back on a
  // signed-out app, which is exactly how the phone build "lost" the session.
  "https://localhost",
  "capacitor://localhost",
]
  .filter((x): x is string => !!x)
  .map((x) => x.replace(/\/$/, ""));

/**
 * Custom URL schemes the app owns.
 *
 * Neither the Android shell nor the Electron desktop app is a website, so
 * their OAuth return leg is a deep link (`com.synq.music://callback`, and the
 * older `synq://callback`). Those URLs have NO origin — `new URL()` reports the
 * literal string "null" for `url.origin` — so every one of them used to be
 * rejected here as untrusted, and the browser was left on an error page after
 * a perfectly successful provider sign-in.
 *
 * Only these two schemes are accepted. A scheme is a much narrower thing than
 * an origin: it cannot be pointed at somebody else's host, because the handler
 * for it is this app and nothing else.
 */
const TRUSTED_APP_SCHEMES = ["synq:", "com.synq.music:"];

function isTrustedOrigin(origin: string): boolean {
  const normalized = origin.replace(/\/$/, "");
  return (
    TRUSTED_ORIGINS.includes(normalized) ||
    /^https:\/\/(?:[a-z0-9-]+\.)*freebuff\.(?:app|com|dev)$/i.test(normalized) ||
    /^https:\/\/[a-z0-9-]+\.vly\.sh$/i.test(normalized) ||
    // Per-deployment preview URLs of the two SYNQ Pages projects, e.g.
    // `https://6a86aaa5.synq-music-player.pages.dev`.
    /^https:\/\/[a-z0-9-]+\.(?:synqmusic|synq-music-player)\.pages\.dev$/i.test(
      normalized,
    )
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
      const base =
        TRUSTED_ORIGINS.find((o) => o.includes("freebuff.app")) ?? SITE_URL_ENV;
      if (redirectTo.startsWith("/") || redirectTo.startsWith("?")) {
        return `${base}${redirectTo}`;
      }
      // Absolute URL — only allow trusted origins, or the app's own deep-link
      // scheme (which has no origin at all and must be matched before the
      // origin check below turns it into the string "null").
      let parsed: URL;
      try {
        parsed = new URL(redirectTo);
      } catch {
        throw new Error(`Unparseable redirect: ${redirectTo}`);
      }
      if (!TRUSTED_APP_SCHEMES.includes(parsed.protocol)) {
        const origin = parsed.origin.replace(/\/$/, "");
        if (!isTrustedOrigin(origin)) {
          throw new Error(`Untrusted redirect origin: ${origin}`);
        }
      }
      return redirectTo;
    },
  },
});
