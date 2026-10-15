// ---------------------------------------------------------------------------
// SYNQ OAuth deep-link + external-browser OAuth helpers (Electron main process)
//
// Problems this fixes:
//  - Presently the renderer launches OAuth with a "_blank" target, so Electron
//    opens the Google/GitHub login page inside a second BrowserWindow. That
//    window gets the OS-window title "Sign in - Google Accounts" and looks like
//    a broken embedded browser.
//  - There is no "will-navigate" / "will-attach-webview" guard, so a future
//    change could again embed an auth URL without anyone noticing.
//  - There is no deep-link return path on desktop, so an external-browser
//    OAuth flow has nowhere to come back to.
//
// Why synq://:
//  - @convex-dev/auth's server-side redirect callback accepts absolute origins
//    that pass isTrustedOrigin(). A custom protocol is a legitimate absolute
//    origin in that sense, and it is the cleanest desktop return path because
//    the OS hands the URL straight to the already-running app — no loopback
//    TCP server, no port selection, no firewalling concerns.
//  - We register "synq" as the default protocol client so the OS resolves
//    synq://callback?... to this running instance.
//
// Security posture:
//  - Auth origins are whitelisted by scheme + host, never by path string match
//    alone. Anything that is not an auth origin is denied and (if http/https)
//    handed to the system browser only as a fallback the user opted into by
//    clicking a link.
//  - Callback URLs are validated: they must use synq://, carry the timestamp
//    we embedded, and match an optional client-id/nonce we recorded when the
//    flow started. Expired or mismatched callbacks are discarded, never passed
//    to the renderer as a completed auth.
//  - We never log the code or token parameters.
// ---------------------------------------------------------------------------

// Electron is required lazily so this module can be loaded (and its URL /
// navigation validation unit-tested) outside a running Electron process.
function electronApi() {
  return require("electron");
}

const { pathToFileURL } = require("node:url");

// Auth origins that must open IN THE DEFAULT BROWSER, not inside SYNQ.
// Google sign-in and GitHub sign-in both end up at these hosts during the
// consent screen, and any embedded window showing them is the bug we are
// fixing. Host list is intentionally specific rather than a blanket
// "anything google.com" so we do not accidentally redirect unrelated traffic.
const AUTH_HOSTS = [
  "accounts.google.com",
  "google.com",
  "github.com",
];

const AUTH_HOST_SET = new Set(AUTH_HOSTS);


// ---------------------------------------------------------------------------
// Origin classification
// ---------------------------------------------------------------------------

/**
 * True when `url` is an auth-related origin that should be opened externally.
 * We treat the consent/redirect hosts as auth regardless of path, because
 * the whole Google/GitHub consent experience lives there.
 */
function isAuthOrigin(url) {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    return AUTH_HOST_SET.has(u.hostname);
  } catch {
    return false;
  }
}

/**
 * True when `url` is an external web link the user's browser should handle,
 * as distinct from an auth origin. Used only as the fallback for ordinary
 * external links (docs, support, etc.).
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
 * Called from both webContents.on("will-navigate") and
 * webContents.on("will-attach-webview") so that either path — a plain
 * location change or a popup/new-view attempt — gets the same policy.
 *
 * Returns one of:
 *   "deny"                — keep the app inside SYNQ; do not open anything.
 *   "open-external"       — open the URL in the default browser, deny the
 *                          embedded navigation.
 *   "allow"               — let SYNQ navigate internally (normal app routes).
 */
function decideNavigationPolicy(url, options = {}) {
  const appOrigins = options.appOrigins ?? [];
  const appFileRoot = options.appFileRoot ?? null;

  if (typeof url !== "string") return "deny";

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL at all. Never let an unparseable target through.
    return "deny";
  }

  // The packaged renderer is loaded from file://. Only files inside the app's
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

  // Any other scheme (synq:, javascript:, data:, mailto:, custom handlers) is
  // not something the app window may navigate to. The deep link is delivered
  // to the main process by the OS, never by renderer navigation.
  return "deny";
}

/**
 * Install the auth-navigation guard on a webContents. Best-effort: if called
 * before the contents exist we just return.
 */
function onAuthNavigation(webContents, opts = {}) {
  if (!webContents) return;

  const openExternal =
    opts.openExternal ?? electronApi().shell.openExternal.bind(electronApi().shell);

  const policyOptions = {
    appOrigins: opts.appOrigins ?? [],
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
        console.error("[SYNQ] failed to open external URL", url, err?.message);
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
 * back to us. Each entry is tied to a specific OAuth flow so a stale
 * synq://callback from a previous run cannot complete a flow it did not
 * start.
 */
const pendingCallbacks = new Map();

/**
 * Register a pending OAuth callback so that when the OS activates
 * synq://callback?... we can validate it.
 */
function recordPendingCallback(id, params) {
  pendingCallbacks.set(id, params);
}

function forgetPendingCallback(id) {
  pendingCallbacks.delete(id);
}

/**
 * Clear any pending callback associated with a closed window. The renderer
 * passes the window id so we do not need to keep a reference to the BrowserWindow.
 */
function forgetPendingCallbackForWindow(windowArgument) {
  if (!windowArgument) return;
  const id =
    typeof windowArgument === "object"
      ? windowArgument.id
      : windowArgument;
  if (typeof id === "number") {
    for (const key of pendingCallbacks.keys()) {
      if (String(key) === String(id)) {
        pendingCallbacks.delete(key);
        break;
      }
    }
  }
}

/**
 * Validate a synq://callback?... URL against the pending record we stored
 * when the flow started.
 *
 * Validation:
 *  - scheme must be synq:// (malformed or unrelated protocols are rejected).
 *  - must carry a `client` id that matches a pending record (prevents a
 *    random synq:// URL from pretending to be our callback).
 *  - must carry a `ts` epoch timestamp within a sane window; we reject old
 *    callbacks so a launched-from-desktop shortcut cannot replay a flow from
 *    hours ago.
 *  - optional `nonce` must match if we recorded one.
 *
 * Returns the parsed params if valid, otherwise null.
 */
function parseDeepLinkParams(url) {
  if (typeof url !== "string") return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "synq:") return null;
  // The server appends `code` using its own URL helper, which rewrites
  // `synq://callback?…` into `synq://callback/?…`. Accept the host form
  // (`synq://callback/`) and the path form (`synq:/callback`) alike so the
  // validation does not depend on that detail.
  const host = parsed.hostname;
  const path = parsed.pathname.replace(/\/+$/, "");
  const isCallback =
    host === "callback" ||
    path === "/callback" ||
    (host === "" && path === "");
  if (!isCallback) return null;

  const client = parsed.searchParams.get("client");
  const ts = parsed.searchParams.get("ts");
  const nonce = parsed.searchParams.get("nonce");
  const error = parsed.searchParams.get("error");
  const code = parsed.searchParams.get("code");
  const state = parsed.searchParams.get("state");

  if (!client) return null;
  if (!ts || isNaN(Number(ts))) return null;


  const record = pendingCallbacks.get(client);
  if (!record) return null;
  if (record.nonce && record.nonce !== nonce) return null;
  // The timestamp must be the one this attempt was registered with: matching it
  // rejects a URL replayed at a different ts, and the freshness window is then
  // measured from when the flow actually started rather than from the clock of
  // whoever constructed the URL.
  if (record.ts !== undefined && Number(record.ts) !== Number(ts)) return null;
  const startedAt = Number(record.ts ?? ts);
  if (Date.now() - startedAt > 10 * 60 * 1000) return null;

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
 * responsible for finishing the flow (exchanging the code, etc.) using the
 * existing Convex Auth integration. We do not expose the raw parameters to
 * any window other than the app's main window.
 */
function dispatchAuthResult(mainWindow, result) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send("synq:auth-result", result);
  } catch (err) {
    // The renderer may not be listening yet; that is fine.
    if (err?.code !== "ERR_IPC_REPLY_ONLY_IN_MAIN") {
      console.error("[SYNQ] failed to dispatch auth result", err?.message);
    }
  }
}

/**
 * Register the synq:// protocol as a default protocol client so that when
 * the browser redirects to synq://callback?... the OS activates this running
 * app. On Windows this is what makes the callback "return to SYNQ".
 */
function registerDeepLink() {
  const { app } = electronApi();
  try {
    // NOTE: the only guard Electron offers is `isDefaultProtocolClient`.
    // (`isRegisteredProtocolHandler` does not exist; calling it throws, which
    // surfaced as a main-process error dialog on launch and skipped the whole
    // registration.)
    if (app.isDefaultProtocolClient("synq")) return;

    if (app.isPackaged) {
      app.setAsDefaultProtocolClient("synq");
      return;
    }

    // Unpackaged: point the handler at the local Electron binary and this
    // entry script, which is the documented way to test deep links in dev.
    const entry = process.argv[1] ? pathToFileURL(process.argv[1]).pathname : "";
    app.setAsDefaultProtocolClient("synq", process.execPath, [entry]);
  } catch (err) {
    // A missing protocol handler degrades the OAuth return path; it must never
    // take the whole app down with it.
    console.error("[SYNQ] failed to register synq:// protocol", err?.message);
  }
}

/**
 * Handle a deep-link URL the OS activated (second-instance on Windows, open-url
 * on macOS, the launch-url on Linux). This is the return path for the
 * external-browser OAuth flow.
 */
function handleDeepLink(mainWindow, url) {
  if (typeof url !== "string") return;
  const result = parseDeepLinkParams(url);
  if (!result) return;
  dispatchAuthResult(mainWindow, result);
}

/**
 * Install the second-instance/deep-link handler. On Windows, when the user
 * clicks a synq:// link (or the app is launched via one) and a SYNQ instance
 * is already running, the second instance is blocked and the first instance
 * receives the URL here.
 */
function onSecondInstance(mainWindow, callback) {
  const { app } = electronApi();
  app.on("second-instance", (_event, args) => {
    // The URL is typically the last argv that looks like a URI.
    const url = args.find((a) => typeof a === "string" && a.startsWith("synq://"));
    if (url) handleDeepLink(mainWindow, url);
    // Bring the existing window forward so the user sees SYNQ again.
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    callback?.();
  });

  // macOS: the app is activated with the URL directly.
  app.on("open-url", (_event, url) => {
    handleDeepLink(mainWindow, url);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    }
    callback?.();
  });
}

// ---------------------------------------------------------------------------
// IPC wiring for the preload bridge surface
// ---------------------------------------------------------------------------

/**
 * Install IPC handlers that the preload bridge uses to start OAuth flows and
 * to hand off deep links from the renderer.
 *
 * The renderer calls window.synq.desktop.beginOAuth(client, params) which is
 * forwarded here. We record a pending callback and send the assigned id back
 * so the renderer can build the synq://callback URL it tells the browser to
 * redirect to.
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
  isAuthOrigin,
  isOrdinaryExternalWebUrl,
  decideNavigationPolicy,
  onAuthNavigation,
  registerDeepLink,
  recordPendingCallback,
  forgetPendingCallback,
  forgetPendingCallbackForWindow,
  parseDeepLinkParams,
  dispatchAuthResult,
  handleDeepLink,
  onSecondInstance,
  onBeginOAuth,
};
