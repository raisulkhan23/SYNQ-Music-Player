// ---------------------------------------------------------------------------
// SYNQ OAuth deep-link + external-browser OAuth helpers (Electron main process)
//
// Problems this fixes:
//  - The renderer launches OAuth with `signIn(provider, { redirectTo })`, and
//    `@convex-dev/auth` starts it by assigning `window.location.href` — which
//    in Electron navigates the app window itself. The Google/GitHub consent
//    page would end up inside a window titled "Sign in - Google Accounts".
//  - There is no "will-attach-webview" guard in the shell, so a future change
//    could embed an auth URL without anyone noticing.
//  - Without a deep-link return path on desktop, an external-browser OAuth
//    flow has nowhere to come back to.
//
// Why synq://:
//  - @convex-dev/auth's server-side redirect callback accepts absolute origins
//    that pass its trusted-origin check. A custom protocol is a legitimate
//    absolute origin in that sense, and it is the cleanest desktop return path
//    because the OS hands the URL straight to the already-running app — no
//    loopback TCP server, no port selection, no firewalling concerns.
//  - We register "synq" as the default protocol client so the OS resolves
//    synq://callback?... to this running instance (packaged) or to
//    `electron.exe <entry>` (dev), matching the convention used to test deep
//    links in development.
//
// Security posture:
//  - Navigation policy is scheme/origin based, never a path string match:
//    the app's own scheme(s) and configured origins stay inside the window,
//    every web origin (the consent screens included) goes to the browser,
//    and everything else is denied outright.
//  - Callback URLs are validated: they must use synq:// at the path the OS
//    produces, carry the client id and timestamp we recorded when the flow
//    started, match the optional nonce, and still be inside the freshness
//    window. Each recorded callback is consumed on first use, so a duplicate
//    delivery cannot complete a flow twice, and a stale synq:// URL from an
//    older attempt is discarded rather than passed to the renderer.
//  - The `code` parameter is forwarded to the renderer over one narrow IPC
//    channel and never logged; nothing here touches tokens.
// ---------------------------------------------------------------------------

// Electron is required lazily so this module can be loaded (and its URL /
// navigation validation unit-tested) outside a running Electron process.
function electronApi() {
  return require("electron");
}

const { pathToFileURL } = require("node:url");

// ---------------------------------------------------------------------------
// Origin classification
// ---------------------------------------------------------------------------

/** How long a recorded callback stays acceptable, measured from flow start. */
const CALLBACK_VALIDITY_MS = 10 * 60 * 1000;

/**
 * True when `url` is an external web link the user's browser should handle —
 * docs, provider consent screens, a shared link. Used by the navigation
 * policy so the renderer can never pull an arbitrary site into a
// privileged window.
 */
function isOrdinaryExternalWebUrl(url) {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Navigation guard
// ---------------------------------------------------------------------------

/**
 * Decide what to do with a navigation the renderer is about to perform.
 * Called from both webContents "will-navigate" and "will-attach-webview" so
 * that either path — a plain location change or an embedded-frame attempt —
 * gets the same policy.
 *
 * Options:
 *   appOrigins  — http(s) origins that ARE the app (the dev server).
 *   appSchemes  — custom schemes that ARE the app (the packaged shell uses
 *                 `app://synq`, so `["app:"]` keeps internal navigation
 *                 working — BrowserRouter reloads, the smoke route, etc.).
 *   appFileRoot — filesystem root the file:// renderer is confined to (only
 *                 meaningful if the shell ever loads a file:// document).
 *
 * Returns one of:
 *   "deny"          — keep the app inside SYNQ; do not open anything.
 *   "open-external" — open the URL in the default browser, deny the
 *                     embedded navigation.
 *   "allow"         — let SYNQ navigate internally (normal app routes).
 */
function decideNavigationPolicy(url, options = {}) {
  const appOrigins = options.appOrigins ?? [];
  const appSchemes = options.appSchemes ?? [];
  const appFileRoot = options.appFileRoot ?? null;

  if (typeof url !== "string") return "deny";

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL at all. Never let an unparseable target through.
    return "deny";
  }

  // A custom app scheme (e.g. the shell's `app://synq`) is the app itself.
  if (appSchemes.includes(parsed.protocol)) return "allow";

  // If the shell ever loads a file:// document, only files inside the app's
  // own directory may be navigated to — anything else on disk is off limits,
  // so a compromised page cannot turn the window into a local file reader.
  if (parsed.protocol === "file:") {
    if (!appFileRoot) return "deny";
    // Windows file URLs are `/D:/…` while a filesystem path is `D:\…`; macOS
    // and Linux paths both start with `/`. Normalising both sides (separators,
    // leading slashes, case on Windows) keeps the comparison honest.
    const normalize = (value) =>
      decodeURIComponent(value)
        .replace(/\\/g, "/")
        .replace(/^\/+/, "")
        .replace(/\/+$/, "")
        .toLowerCase();
    const target = normalize(parsed.pathname);
    const root = normalize(appFileRoot);
    return target === root || target.startsWith(`${root}/`) ? "allow" : "deny";
  }

  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    // A known app origin (the dev server) is the app itself, not the web.
    const origin = parsed.origin.replace(/\/$/, "");
    if (appOrigins.some((allowed) => allowed.replace(/\/$/, "") === origin)) {
      return "allow";
    }
    // Everything else on the web — Google/GitHub consent screens included —
    // belongs in the user's browser. This is what stops the sign-in page from
    // being embedded in the app window.
    return "open-external";
  }

  // Any other scheme (synq:, javascript:, data:, mailto:, unknown handlers)
  // is not something the app window may navigate to. The deep link is
  // delivered to the main process by the OS, never by renderer navigation.
  return "deny";
}

/**
 * Install the navigation guard on webContents. `opts.openExternal` is
 * injectable so the handler itself can be exercised outside Electron.
 */
function onAuthNavigation(webContents, opts = {}) {
  if (!webContents) return;

  const openExternal =
    opts.openExternal ?? electronApi().shell.openExternal.bind(electronApi().shell);

  const policyOptions = {
    appOrigins: opts.appOrigins ?? [],
    appSchemes: opts.appSchemes ?? [],
    appFileRoot: opts.appFileRoot ?? null,
  };

  const handler = (event, url) => {
    const policy = decideNavigationPolicy(url, policyOptions);
    if (policy === "open-external") {
      // Open the browser and prevent the embedded navigation.
      try {
        openExternal(url);
      } catch (err) {
        // If openExternal itself fails (missing default browser, etc.) we
        // still deny the embedded navigation so we do not silently embed an
        // auth page.
        console.error("[SYNQ] failed to open external URL", err?.message);
      }
      event.preventDefault();
      return;
    }
    if (policy === "deny") {
      event.preventDefault();
      return;
    }
    // "allow" — do nothing; the navigation proceeds inside SYNQ.
  };

  webContents.on("will-navigate", handler);
  webContents.on("will-attach-webview", handler);

  // Expose a teardown so the caller can clean up if it re-creates windows.
  return () => {
    webContents.removeListener("will-navigate", handler);
    webContents.removeListener("will-attach-webview", handler);
  };
}

// ---------------------------------------------------------------------------
// Deep-link registration + parsing
// ---------------------------------------------------------------------------

/**
 * Things we have started and want to recognise when the OS hands the URL
 * back to us. Each entry is tied to a specific OAuth attempt so a stale
 * synq://callback from a previous run cannot complete a flow it did not
 * start.
 */
const pendingCallbacks = new Map();

/** Register a pending OAuth callback so that when the OS activates
 * synq://callback?... we can validate it. */
function recordPendingCallback(id, params) {
  pendingCallbacks.set(id, params);
}

function forgetPendingCallback(id) {
  pendingCallbacks.delete(id);
}

/**
 * Clear any pending callback records when a window goes away. Passing a
 * BrowserWindow cleans up everything that was registered from any window —
 * the shell has exactly one window, so a closed window makes every outstanding
 * flow invalid for future launches.
 */
function forgetAllPendingCallbacks() {
  pendingCallbacks.clear();
}

/**
 * The synq:// URL in a launch-argument list, if any.
 *
 * Windows passes the callback URL as an argv entry of a NEW process when the
 * app is cold-launched from a browser redirect; a second launch while an
 * instance is running delivers the same argv through the `second-instance`
 * event instead. Exported and pure so both paths (and the tests) share it.
 */
function findDeepLinkArg(args) {
  if (!Array.isArray(args)) return null;
  return args.find((a) => typeof a === "string" && a.startsWith("synq://")) ?? null;
}

/**
 * Validate a synq://callback?... URL against the pending record we stored
 * when the flow started.
 *
 * Validation:
 *  - scheme must be synq:// (malformed or unrelated protocols are rejected).
 *  - must be the `/callback` path (the server's URL rewrite produces
 *    `synq://callback/?...`; the slash forms collapse to the same thing).
 *  - must carry a `client` id that matches a pending record (prevents a
 *    random synq:// URL from pretending to be our callback).
 *  - must carry a `ts` epoch timestamp EQUAL to the one recorded for that
 *    attempt, so a replayed URL with a rewritten timestamp fails.
 *  - optional `nonce` must match if we recorded one.
 *  - the attempt must still be inside CALLBACK_VALIDITY_MS.
 *
 * Returns the parsed params if valid (and consumes the record — a duplicate
 * callback cannot complete the flow twice), otherwise null.
 */
function parseDeepLinkParams(url, now = Date.now()) {
  if (typeof url !== "string") return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "synq:") return null;
  // The server appends `code` using its own URL helper, which rewrites
  // `synq://callback?…` into `synq://callback/?…`. Accept both spellings (and
  // the exotic `synq:/callback` the WHATWG parser can produce for certain
  // protocol strings) so the validation does not depend on that detail.
  const host = parsed.hostname;
  const path = parsed.pathname.replace(/\/+$/, "");
  const isCallback =
    host === "callback" || path === "/callback" || (host === "" && path === "");
  if (!isCallback) return null;

  const client = parsed.searchParams.get("client");
  const ts = parsed.searchParams.get("ts");
  const nonce = parsed.searchParams.get("nonce");
  const error = parsed.searchParams.get("error");
  const code = parsed.searchParams.get("code");
  const state = parsed.searchParams.get("state");

  if (!client || !ts || Number.isNaN(Number(ts))) return null;

  const record = pendingCallbacks.get(client);
  if (!record) return null;
  if (record.nonce && record.nonce !== nonce) return null;
  // The timestamp must be the one this attempt was registered with: matching it
  // rejects a URL replayed at a different ts, and the freshness window is then
  // measured from when the flow actually started rather than from the clock of
  // whoever constructed the URL.
  if (record.ts !== undefined && Number(record.ts) !== Number(ts)) return null;
  const startedAt = Number(record.ts ?? ts);
  if (now - startedAt > CALLBACK_VALIDITY_MS) return null;

  // Consume the pending record so a duplicate callback cannot complete the
  // flow twice.
  forgetPendingCallback(client);

  return {
    client,
    ts: Number(ts),
    nonce: nonce ?? null,
    error: error ?? null,
    code: code ?? null,
    state: state ?? null,
  };
}

/**
 * Dispatch a validated auth result to the renderer. The renderer is
 * responsible for finishing the flow (exchanging the code) via the existing
 * Convex Auth integration. We do not expose the raw parameters to any window
 * other than the app's main window, and we never log the code/state.
 */
function dispatchAuthResult(mainWindow, result) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send("synq:auth-result", result);
  } catch (err) {
    // The renderer may not be listening yet; that is fine and must not take
    // the main process down.
    console.error("[SYNQ] failed to dispatch auth result", err?.message);
  }
}

/**
 * Register the synq:// protocol as the default protocol client so that when
 * the browser redirects to synq://callback?... the OS activates this app.
 *
 * Dev mode still registers — pointing at the local Electron binary and this
 * entry script, the documented way to exercise deep links unpackaged — so the
 * behavior is testable in development rather than silently just web-like.
 * The registration attempt is honest in both modes; only the target differs.
 */
function registerDeepLink() {
  const { app } = electronApi();
  try {
    // NOTE: the only guard Electron offers is `isDefaultProtocolClient`.
    // (`isRegisteredProtocolHandler` does not exist; calling it throws.)
    if (app.isDefaultProtocolClient("synq")) return;

    if (app.isPackaged) {
      app.setAsDefaultProtocolClient("synq");
      return;
    }

    // Unpackaged: point the handler at the local Electron binary and this
    // entry script.
    const entry = process.argv[1] ? pathToFileURL(process.argv[1]).pathname : "";
    app.setAsDefaultProtocolClient("synq", process.execPath, [entry]);
  } catch (err) {
    // A missing protocol handler degrades the OAuth return path (the flow
    // simply never calls back); it must never take the whole app down.
    console.error("[SYNQ] failed to register synq:// protocol", err?.message);
  }
}

/**
 * Handle a deep-link URL the OS activated (second-instance argv on Windows,
 * open-url on macOS). This is the return path for the external-browser OAuth
 * flow: invalid URLs are rejected by the validator, valid ones are forwarded
 * to the renderer exactly once.
 */
function handleDeepLink(mainWindow, url) {
  if (typeof url !== "string") return;
  const result = parseDeepLinkParams(url);
  if (!result) return;
  dispatchAuthResult(mainWindow, result);
}

/**
 * Show/restore/focus the main window. Shared by second-instance and open-url
 * so the user always sees SYNQ again after clicking a link; guarded for a
 * destroyed window and safe as a no-op when there is none (tray-only mode).
 */
function focusMainWindow(mainWindow) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * Install the second-instance/deep-link handlers. On Windows, when the user
 * clicks a synq:// link (or the app is launched via one) and a SYNQ instance
 * is already running, the second instance is blocked and the first instance
 * receives the URL here.
 *
 * `getWindow` is resolved at event time, not registration time, so the
 * handlers stay correct even when they are installed before the window exists
 * (as the shell does, before `app.ready`). Returns a cleanup function.
 */
function onSecondInstance(getWindow, callback) {
  const { app } = electronApi();
  const onSecond = (_event, args) => {
    const url = findDeepLinkArg(args);
    if (url) handleDeepLink(getWindow(), url);
    focusMainWindow(getWindow());
    callback?.();
  };
  // macOS: the app is activated with the URL directly.
  const onOpenUrl = (_event, url) => {
    handleDeepLink(getWindow(), url);
    focusMainWindow(getWindow());
    callback?.();
  };
  app.on("second-instance", onSecond);
  app.on("open-url", onOpenUrl);
  return () => {
    app.removeListener("second-instance", onSecond);
    app.removeListener("open-url", onOpenUrl);
  };
}

// ---------------------------------------------------------------------------
// IPC wiring for the preload bridge surface
// ---------------------------------------------------------------------------

/**
 * Install the renderer→main half of the OAuth contract. The preload bridge
 * forwards `synqDesktop.beginOAuth(clientId, params)` here; the main process
 * records the expected callback so a later synq://callback is only accepted
 * if client, timestamp and nonce all match. Malformed client ids are ignored.
 */
function onBeginOAuth() {
  const { ipcMain } = electronApi();
  ipcMain.on("desktop:begin-oauth", (_event, clientId, params) => {
    if (typeof clientId !== "string" || clientId.length === 0) return;
    recordPendingCallback(clientId, {
      nonce: typeof params?.nonce === "string" ? params.nonce : null,
      ts: typeof params?.ts === "number" ? params.ts : Date.now(),
    });
  });
}

module.exports = {
  CALLBACK_VALIDITY_MS,
  isOrdinaryExternalWebUrl,
  decideNavigationPolicy,
  onAuthNavigation,
  recordPendingCallback,
  forgetPendingCallback,
  forgetAllPendingCallbacks,
  findDeepLinkArg,
  parseDeepLinkParams,
  dispatchAuthResult,
  registerDeepLink,
  handleDeepLink,
  focusMainWindow,
  onSecondInstance,
  onBeginOAuth,
};
