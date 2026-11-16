/**
 * Renderer half of the SYNQ ANDROID external-browser OAuth flow.
 *
 * ## Why this exists
 *
 * Signing in with Google or GitHub inside the packaged Android app used to fail
 * twice over:
 *
 *  1. `signIn()` assigns `window.location.href`, so the provider's consent page
 *     loaded INSIDE the app's WebView — where Google refuses to complete an
 *     OAuth flow (`disallowed_useragent`), and where the finished flow had to
 *     come back to `https://localhost`, the WebView's own origin.
 *  2. The server's redirect callback only trusted real web origins, so even a
 *     provider round-trip that did succeed was thrown out on the way back.
 *
 * Both are the same mistake: a native app is not a website, so it must hand the
 * consent screen to the user's real browser and be re-entered through a deep
 * link. That is exactly what the Electron build does (`desktop-auth.ts`), and
 * this module is the Android counterpart:
 *
 *   1. Build a `com.synq.music://callback` URL carrying this attempt's own
 *      client id, so a stale or unrelated deep link can never sign anybody in.
 *   2. Start the normal Convex sign-in with that URL as the redirect target.
 *      The SDK stores the OAuth verifier in localStorage at this point — which
 *      is what makes the code exchange work afterwards.
 *   3. MainActivity intercepts the resulting navigation (the Convex sign-in
 *      route and the provider's own pages) and opens it in the system browser,
 *      so the app's document is never replaced and React stays mounted.
 *   4. When the browser reaches the callback, Android re-enters the activity
 *      through the manifest's deep-link filter and MainActivity hands the URL
 *      to `window.synqNativeAuthDeliver` below.
 *   5. The caller exchanges the code with `signIn(undefined, { code })`.
 *
 * Every entry point answers `false`/`null` when the native shell is absent, so
 * the hosted web build and the desktop app keep their existing paths.
 */
import { isAndroidShell } from "@/lib/nativeShell";

/** The scheme MainActivity's manifest filter owns. */
export const NATIVE_CALLBACK_SCHEME = "com.synq.music";
const NATIVE_CALLBACK_HOST = "callback";

export interface NativeOAuthResult {
  /** The verification code to exchange for a session. */
  code: string | null;
  /** Set when the provider denied, or the callback carried no code. */
  error: string | null;
}

interface PendingAttempt {
  client: string;
  ts: number;
  resolve: (result: NativeOAuthResult | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Only one attempt can be in flight; a second replaces the first. */
let pending: PendingAttempt | null = null;

function settle(result: NativeOAuthResult | null): void {
  const attempt = pending;
  if (!attempt) return;
  pending = null;
  clearTimeout(attempt.timer);
  attempt.resolve(result);
}

/**
 * True inside the packaged Android app.
 *
 * Deliberately NOT gated on a function the native layer injects: the deep link
 * can arrive before any page has loaded (the OS may restart the activity while
 * the user is in the browser), so the JS side owns the receiver and registers
 * it at import time instead of waiting to be called.
 */
export function isNativeOAuthRuntime(): boolean {
  return isAndroidShell();
}

/**
 * Called by MainActivity with the full deep-link URL, through
 * `window.synqNativeAuthDeliver`.
 *
 * Querystring access is done through `URLSearchParams` rather than string
 * splitting because `@convex-dev/auth` rewrites the callback's query string
 * when it appends `code` — the URL that comes back is
 * `com.synq.music://callback/?client=…&ts=…&code=…`, with a slash the attempt
 * did not put there.
 */
function handleDeliveredUrl(rawUrl: string): void {
  if (typeof rawUrl !== "string" || !pending) return;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return;
  }
  if (
    url.protocol !== `${NATIVE_CALLBACK_SCHEME}:` ||
    url.host !== NATIVE_CALLBACK_HOST
  ) {
    return;
  }
  // Filter by THIS attempt's client id: a replayed deep link from an earlier
  // flow must not complete the one that is open now.
  const client = url.searchParams.get("client");
  if (client !== pending.client) return;

  const code = url.searchParams.get("code");
  const error =
    url.searchParams.get("error_description") ?? url.searchParams.get("error");

  if (error) settle({ code: null, error });
  else if (code) settle({ code, error: null });
  else settle(null);
}

// Registered at import time, so the receiver exists no matter how early the
// deep link arrives relative to the first render.
if (typeof window !== "undefined") {
  (window as unknown as { synqNativeAuthDeliver?: (url: string) => void })
    .synqNativeAuthDeliver = handleDeliveredUrl;
}

/**
 * Start the native OAuth flow and wait for the browser to come back.
 *
 * `startSignIn` is the existing Convex `signIn` from `useAuth`, passed in so
 * this stays a plain helper rather than a hook.
 *
 * Resolves with `null` when the user abandons the browser, or when the app is
 * re-entered with no usable code — the caller shows a retry, never a stuck
 * spinner.
 */
export async function startNativeOAuth(
  provider: "google" | "github",
  startSignIn: (redirectTo: string) => Promise<unknown>,
  options: { timeoutMs?: number } = {},
): Promise<NativeOAuthResult | null> {
  const client = `${provider}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const ts = Date.now();
  const redirectTo = `${NATIVE_CALLBACK_SCHEME}://${NATIVE_CALLBACK_HOST}?client=${encodeURIComponent(
    client,
  )}&ts=${ts}`;

  const result = new Promise<NativeOAuthResult | null>((resolve) => {
    const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    pending = {
      client,
      ts,
      resolve,
      timer: setTimeout(() => settle(null), timeoutMs),
    };
  });

  try {
    // The navigation this performs is intercepted by MainActivity and handed to
    // the system browser, so the app's document is NOT replaced and React keeps
    // its state (including the auth gate's parked intent).
    await startSignIn(redirectTo);
  } catch (error) {
    settle({
      code: null,
      error:
        error instanceof Error
          ? error.message
          : "Sign-in could not be started.",
    });
  }

  return result;
}
