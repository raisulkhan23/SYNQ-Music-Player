// THIS FILE IS READ ONLY. Do not touch this file unless you are correctly adding a new auth provider in accordance to the vly auth documentation

import { convexAuth } from "@convex-dev/auth/server";
import { emailOtp } from "./auth/emailOtp";
import Google from "@auth/core/providers/google";
import GitHub from "@auth/core/providers/github";

const SITE_URL_ENV = (
  process.env.CONVEX_SITE_URL ?? process.env.SITE_URL ?? ""
).replace(/\/$/, "");

const TRUSTED_ORIGINS = [
  SITE_URL_ENV,
  "https://impartial-ptarmigan-116.convex.site",
  "https://synqmusic.freebuff.app",
  "https://synq-music.freebuff.app",
  "https://freebuff.com",
  "https://www.freebuff.com",
]
  .filter((x): x is string => !!x)
  .map((x) => x.replace(/\/$/, ""));

function isTrustedOrigin(origin: string): boolean {
  const normalized = origin.replace(/\/$/, "");
  return (
    TRUSTED_ORIGINS.includes(normalized) ||
    /^https:\/\/(?:[a-z0-9-]+\.)*freebuff\.(?:app|com)$/i.test(normalized) ||
    /^https:\/\/[a-z0-9-]+\.vly\.sh$/i.test(normalized) ||
    // The Capacitor Android shell serves the built web app from a localhost
    // origin inside its own WebView, so that origin is the app itself there.
    // Only localhost, and only the app's own callback path, is accepted.
    isLocalhostAppOrigin(normalized)
  );
}

/**
 * `https://localhost` / `capacitor://localhost` / `http://localhost:<port>`
 * exist only inside the Android WebView that loads the app's own bundle. They
 * are recognised so the OAuth round-trip can land back on the app there; a
 * public site can never hold one of these origins.
 */
function isLocalhostAppOrigin(origin: string): boolean {
  return (
    origin === "https://localhost" ||
    origin === "capacitor://localhost" ||
    /^http:\/\/localhost(?::\d+)?$/i.test(origin)
  );
}

/**
 * The desktop application's own URI scheme.
 *
 * Built apps register `synq://` as a protocol handler, so this is the origin
 * the Electron shell is reachable at. It is deliberately narrow: only the
 * callback target the desktop flow uses is allowed, never an arbitrary
 * `synq://` URL.
 */
function isDesktopAppCallback(url: string): boolean {
  if (!/^synq:\/\/callback(?:[/?#]|$)/i.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "synq:";
  } catch {
    return false;
  }
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
    // Desktop/electron builds plus external OAuth redirect targets (e.g. a
    // future desktop callback route). Relative paths already resolve against
    // the deployment's SITE_URL via the server-side redirect callback; this
    // gate only needs to accept absolute origins that belong to SYNQ or its
    // deployment host.
    redirect: async ({ redirectTo }) => {
      if (redirectTo.startsWith("/") || redirectTo.startsWith("?")) {
        return redirectTo;
      }

      // Desktop shell: `synq://callback?…`. Checked before the origin test
      // because a custom scheme has no origin (`new URL(...).origin` is
      // `"null"`), so it can never pass `isTrustedOrigin`. The redirect is
      // returned verbatim so the `code` parameter the server appends survives,
      // and the Electron main process validates it against the attempt it
      // recorded before anything is exchanged.
      if (isDesktopAppCallback(redirectTo)) {
        return redirectTo;
      }

      let origin: string;
      try {
        origin = new URL(redirectTo).origin.replace(/\/$/, "");
      } catch {
        // Not a URL we can reason about: fall back to the deployment's own
        // origin rather than passing an unknown value through.
        return SITE_URL_ENV || "/";
      }
      if (isTrustedOrigin(origin)) {
        return redirectTo;
      }
      return `${origin}${redirectTo}`;
    },
  },
});
