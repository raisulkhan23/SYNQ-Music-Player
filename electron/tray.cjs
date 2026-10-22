// ---------------------------------------------------------------------------
// SYNQ tray (Electron main process)
//
// Kept in a separate module so main.cjs wires it once and everything with a
// lifecycle decision stays testable without a desktop session (electron is
// required lazily, exactly like oauth-deep-link.cjs).
//
// Tray is a feature with real tradeoffs:
//  - It is useful for music apps and matches "close to tray" behavior many
//    desktop players expect: closing the window hides it and playback keeps
//    running instead of the app (and its audio) dying.
//  - It is powered by an icon asset that must actually ship. Rather than
//    quietly showing a default glyph when the asset is missing, the install
//    is cancelled and the app falls back to no-tray behavior; close-to-tray
//    is then disabled too, so closing still quits as before.
//
// The pure core (menu template, close decision, icon candidate resolution)
// is exportable and runs under Bun's test runner; the Electron-touching
// functions are thin wrappers around it.
// ---------------------------------------------------------------------------

const STATE = {
  tray: null,
  minimizeToTray: false,
  installed: false,
};

/** The actions the tray menu sends to the renderer. One contract with
 * `src/lib/trayBridge.ts`; the renderer maps them onto the player store. */
const TRAY_ACTIONS = ["play-pause", "next", "previous"];

/**
 * The icon candidates to try, in order, given how the app is running.
 *
 * The packaged app must load an asset actually shipped into
 * `process.resourcesPath` (logo.png, and ico only as the last resort — it is
 * the installer icon, not ideal as a small tray glyph). Unpackaged runs load
 * from `build/` and `public/`, next to the electron scripts, so dev behavior
 * on all three platforms includes SOME real icon rather than none.
 */
function iconCandidates({ isPackaged, resourcesDir, localDir }) {
  if (isPackaged) return ["logo.png", "logo.ico"].map((f) => `${resourcesDir}/${f}`);
  return [`${localDir}/icon.png`, `${localDir}/../public/logo.png`];
}

/**
 * Which action does closing the (only) window take?
 *
 *  - tray enabled  → "hide"  (window hides, audio keeps running)
 *  - tray disabled → "close" (the OS close proceeds; app quits as before)
 *
 * `isLastWindow` guards the multi-window case: the shell creates one window,
 * but if it ever creates more, closing a secondary window must not hijack
 * the OS close just because the tray is on.
 */
function decideCloseAction({ minimizeToTray, isLastWindow }) {
  return minimizeToTray && isLastWindow ? "hide" : "close";
}

/**
 * The tray menu, as a plain template array. Menus are serializable data;
 * clicking maps to the three handled verbs: an action pushed to the
 * renderer, showing the window, hiding it, or quitting. Every entry here is
 * wired — no decorative menu items that do nothing where unsupported.
 */
function buildMenuTemplate(verbs) {
  return [
    { label: "Play / Pause", click: () => verbs.action("play-pause") },
    { label: "Next", click: () => verbs.action("next") },
    { label: "Previous", click: () => verbs.action("previous") },
    { type: "separator" },
    { label: "Show SYNQ", click: () => verbs.showWindow() },
    { label: "Hide SYNQ", click: () => verbs.hideWindow() },
    { type: "separator" },
    { label: "Quit SYNQ", click: () => verbs.quit() },
  ];
}

/** Lazily required: lets the pure helpers run under Bun's test runner. */
function electron() {
  return require("electron");
}

function requiredApi() {
  const api = electron();
  // `Tray` does not exist on some Linux builds (no AppIndicator);
  // treat the platform as without tray rather than crashing.
  if (!api.Tray || !api.Menu || !api.nativeImage) return null;
  return api;
}

/** Resolve the first readable icon candidate; null when none is usable. */
function loadIconFile(candidates, exists, createFromPath) {
  for (const candidate of candidates) {
    if (exists(candidate)) {
      try {
        const image = createFromPath(candidate);
        if (image && !image.isEmpty()) return image;
      } catch {
        // unreadable — try the next candidate
      }
    }
  }
  return null;
}

/**
 * Send a tray quick action to the app's renderer via ONE explicit contract:
 * the "tray:action" channel over the visible window's webContents. A `Tray`
 * instance has no `send` of its own (that is a webContents API — the exact
 * bug this replaces from the recovered implementation), so the window to
 * deliver to is resolved here, first-visible-window first.
 */
function sendAction(action) {
  if (!TRAY_ACTIONS.includes(action)) return;
  const { BrowserWindow } = electron();
  const windows = BrowserWindow.getAllWindows();
  const target = windows.find((w) => w.isVisible()) ?? windows.shift();
  if (!target || target.isDestroyed()) return;
  try {
    target.webContents.send("tray:action", action);
  } catch {
    /* renderer gone between check and send — the click simply did nothing */
  }
}

/** Restore/show/focus the main window from the tray. */
function showMainWindow() {
  const { BrowserWindow } = electron();
  const windows = BrowserWindow.getAllWindows();
  const w = windows.find((x) => x.isVisible()) ?? windows[0];
  if (!w || w.isDestroyed()) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

/** Hide the visible window(s) (Hide SYNQ). */
function hideMainWindow() {
  const { BrowserWindow } = electron();
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && w.isVisible()) w.hide();
  }
}

/** Create the tray icon + menu. Idempotent: a second call is a no-op, so
 * re-created windows or re-driven ready handlers never stack tray icons. */
function installTray(options = {}) {
  if (STATE.installed) return true;

  const api = requiredApi();
  if (!api) return false;

  const { path } = require("node:path");
  const { app } = api;
  const localDir = __dirname;
  const resourcesDir =
    typeof process.resourcesPath === "string" && process.resourcesPath
      ? process.resourcesPath
      : path.join(path.dirname(app.getAppPath()), "resources");

  let image = null;
  try {
    const { existsSync } = require("node:fs");
    const { nativeImage } = api;
    const iconCandidatesResolved = options.iconCandidates ?? iconCandidates({
      isPackaged: app.isPackaged,
      resourcesDir,
      localDir,
    });
    image = loadIconFile(
      options.candidates ?? iconCandidatesResolved,
      existsSync,
      (file) => nativeImage.createFromPath(file),
    );
  } catch (err) {
    console.warn("[SYNQ] tray icon probe failed:", err?.message);
  }
  if (!image) {
    console.warn("[SYNQ] tray icon not found; tray not created");
    return false;
  }

  const verbs = {
    action: sendAction,
    showWindow: showMainWindow,
    hideWindow: hideMainWindow,
    quit: () => api.app.quit(),
  };
  const menu = api.Menu.buildFromTemplate(buildMenuTemplate(verbs));
  const tray = new api.Tray(image);
  tray.setToolTip("SYNQ");
  tray.setContextMenu(menu);
  tray.on("click", () => showMainWindow());
  tray.on("double-click", () => showMainWindow());
  STATE.tray = tray;
  STATE.installed = true;
  return true;
}

/** Renderer-driven preference: close-to-tray off by default. */
function setMinimizeToTray(enable) {
  STATE.minimizeToTray = Boolean(enable);
}

/**
 * The `close` handler the shell binds. Returning true asks the shell to
 * preventDefault and hide instead of closing. The shell passes its own
 * window's identity so the last-window check stays honest even if the
 * module-level reference is stale.
 */
function shouldHideOnClose(window, isMainWindow) {
  if (!STATE.minimizeToTray) return false;
  if (!isMainWindow) return false;
  const { BrowserWindow } = electron();
  const others = BrowserWindow.getAllWindows().filter(
    (w) => w !== window && !w.isDestroyed(),
  );
  return others.length === 0;
}

/** Destroy the tray icon and reset the state (used by the shell on quit). */
function unload() {
  if (STATE.tray) {
    try {
      STATE.tray.destroy();
    } catch {
      /* already gone */
    }
    STATE.tray = null;
  }
  STATE.installed = false;
}

function isInstalled() {
  return STATE.installed;
}

module.exports = {
  TRAY_ACTIONS,
  iconCandidates,
  decideCloseAction,
  buildMenuTemplate,
  installTray,
  setMinimizeToTray,
  shouldHideOnClose,
  unload,
  isInstalled,
};
