// ---------------------------------------------------------------------------
// Renderer half of the SYNQ desktop external-browser OAuth flow.
//
// Why this exists
// ---------------
// On the desktop the browser must not be embedded. `@convex-dev/auth` starts an
// OAuth sign-in by assigning `window.location.href`, which in Electron
// navigates the app window itself — that is exactly how the Google consent page
// ended up inside a window titled "Sign in - Google Accounts".
//
// The main process intercepts that navigation (electron/oauth-deep-link.cjs),
// opens the default browser instead, and the flow comes back through the
// `synq://callback` deep link. This module owns the renderer side of that
// contract:
//
//   1. Generate a client id + nonce for this one attempt.
//   2. Tell the main process to expect a callback under that id (so an
//      unrelated or replayed `synq://` URL can never complete sign-in) and
//      subscribe to results BEFORE starting, so a fast return cannot be missed.
//   3. Start the normal Convex sign-in with `synq://callback` as the redirect
//      target. The verifier is stored in localStorage by the SDK at this point,
//      which is what lets the code exchange succeed after the browser returns.
//   4. Resolve with the validated result the main process forwards back — after
//      filtering by this attempt's own client id, so a stray URL from another
//      attempt (or the rejected `error` field of this one) is surfaced honestly.
//
// The exchange itself (`signIn(undefined, { code })`) is left to the caller so
// that this module never touches tokens beyond handing the code straight to
// the SDK. Nothing here is logged.
//
// The bridge is `window.synqDesktop` (electron/preload.cjs). Every entry point
// answers `false`/`null` when it is absent — the hosted web build and the
// Android shell take their existing path unchanged.
// ---------------------------------------------------------------------------

export interface DesktopOAuthBeginParams {
  /** The page the app should be on when sign-in completes. */
  redirectTo: string;
  /** Must match the `nonce` sent back in the deep link. */
  nonce: string;
  /** Epoch ms of the attempt; the main process rejects stale callbacks. */
  ts: number;
}

export interface DesktopOAuthResult {
  client: string;
  ts: number;
  nonce: string | null;
  /** Set when the provider denied, or the callback failed validation. */
  error: string | null;
  /** The verification code the app exchanges for a session. */
  code: string | null;
  state: string | null;
}

/** True when the app is running inside the Electron shell AND the OAuth
 * surface of the bridge is available. */
export function isDesktopRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.synqDesktop?.beginOAuth &&
    !!window.synqDesktop?.onAuthResult
  );
}

/**
 * Build the callback the browser is redirected to after consent.
 *
 * Shape matters: `@convex-dev/auth` appends the `code` query parameter with its
 * own `setURLSearchParam` helper, which rewrites `synq://callback?…` into
 * `synq://callback/?…`. Keeping a query string here means both the pre-redirect
 * and post-redirect URLs are the same form, so the main-process parser only has
 * one shape to handle.
 */
export function buildDesktopCallbackUrl(input: {
  client: string;
  ts: number;
  nonce: string;
}): string {
  return `synq://callback?client=${encodeURIComponent(
    input.client,
  )}&ts=${input.ts}&nonce=${encodeURIComponent(input.nonce)}`;
}

/**
 * Start the desktop OAuth flow and wait for the browser to come back.
 *
 * `startSignIn` is the existing Convex `signIn` from `useAuth`. It is passed in
 * rather than imported so this module stays a plain helper and does not need
 * to be a hook.
 *
 * Resolves with `null` if the runtime is not desktop or the flow timed out
 * (for example the user closed the browser tab without finishing).
 */
export async function startDesktopOAuth(
  provider: "google" | "github",
  startSignIn: (redirectTo: string) => Promise<unknown>,
  options: { timeoutMs?: number } = {},
): Promise<DesktopOAuthResult | null> {
  const desktop =
    typeof window !== "undefined" ? window.synqDesktop : undefined;
  if (!desktop?.beginOAuth || !desktop.onAuthResult) return null;

  const client = `${provider}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2)}`;
  const nonce = Math.random().toString(36).slice(2);
  const ts = Date.now();

  // Listen BEFORE starting, so a fast return cannot be missed. Only this
  // attempt's callback may settle this attempt: a stray result from an
  // earlier or unrelated flow is ignored rather than completing a sign-in
  // the listener did not start, and a rejected/no-code result still settles
  // (as an error the caller can show) instead of hanging to the timeout.
  const result = new Promise<DesktopOAuthResult | null>((resolve) => {
    const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    let settled = false;
    const finish = (value: DesktopOAuthResult | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe?.();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const unsubscribe = desktop.onAuthResult!((incoming) => {
      if (incoming && incoming.client === client) finish(incoming);
    });
  });

  // Record the expected callback, then start the sign-in. The SDK stores the
  // OAuth verifier and assigns `window.location.href`; the main process turns
  // that into "open the default browser" and the app stays where it is.
  desktop.beginOAuth(client, { redirectTo: window.location.href, nonce, ts });
  await startSignIn(buildDesktopCallbackUrl({ client, ts, nonce }));

  return await result;
}
