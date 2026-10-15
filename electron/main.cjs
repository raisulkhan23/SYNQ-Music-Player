
// ---------------------------------------------------------------------------
// Why Electron: the existing project is React + Vite + TypeScript with a Convex
// music backend and Convex auth. Electron reuses that frontend verbatim and can
// load the production build from disk, so there is no rebuild of screens and no
// dependency on a dev server at runtime. Tauri would also work, but it wants a
// separate Rust build step and a non-trivial adapter around the existing Vite
// output; that is more moving parts for a first Windows deliverable.
//
// Security posture:
//  - nodeIntegration off
//  - contextIsolation on
//  - a minimal preload that exposes only the desktop things the renderer needs
//  - navigation limited to the app origin; external links handed to the system
//    browser
//  - no secrets shipped in the bundle; the Convex URL stays a build-time public
//    env as it already is in the web app
// ---------------------------------------------------------------------------

const tray = require("./tray.cjs");
const oauth = require("./oauth-deep-link.cjs");
const { app, BrowserWindow, Menu, ipcMain, shell } = require("electron");
const path = require("node:path");

// Remove the default Chromium/Electron menu bar so the desktop app presents
// only the SYNQ-provided UI (tray menu + in-app chrome). Without this the
// window shows the standard File/Edit/View/... menu that most users do not
// expect from a branded music player.
//
// True for the dev-server launch (`npm run desktop:dev`) as well as any
// unpackaged run, which is what decides between the Vite server, the packaged
// bundle, and whether devtools open.
const isDev =
  process.env.NODE_ENV === "development" ||
  !app.isPackaged ||
  !!process.env.ELECTRON_DEV;

// A synq:// URL in the launch arguments means the OS started us to deliver an
// OAuth callback (Windows passes the URL as an argv entry).
const startupDeepLink =
  process.argv.find(
    (arg) => typeof arg === "string" && arg.startsWith("synq://"),
  ) ?? null;

let mainWindow = null;

function resolveAssetFile(file) {
  if (isDev) {
    return file;
  }
  // Production: the renderer is packaged inside app.asar under dist/.
  // app.getAppPath() returns the asar root in packaged runs, and Node/Electron
  // resolve paths inside an asar transparently.
  return path.join(app.getAppPath(), file);
}

function resolveFrontendUrl() {
  if (isDev) {
    const url = new URL(
      process.env.VITE_DEV_URL ?? "http://localhost:5173",
    );
    return url.href;
  }
  // Packaged production build: load index.html from the app bundle (asar).
  const indexHtml = resolveAssetFile("dist/index.html");
  return require("node:url").pathToFileURL(indexHtml).href;
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 620,
    frame: true,
    title: "SYNQ",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
      // The renderer is the app itself; allow the packaged files only.
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
    show: false,
    backgroundColor: "#12141c",
  });

  mainWindow.once("ready-to-show", () => {
    if (!mainWindow) return;
    mainWindow.show();
  });

  // index.html carries its own <title>, which would otherwise take over the
  // native window caption once the document loads. The desktop window is SYNQ.
  mainWindow.webContents.on("page-title-updated", (event) => {
    event.preventDefault();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle("SYNQ");
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    // Drop any pending OAuth callback the user started before closing the
    // window, so a stray synq://callback cannot complete a flow on a future
    // launch.
    oauth.forgetPendingCallbackForWindow(mainWindow);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    // Keep the app inside SYNQ. Anything else is opened in the system browser.
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "deny" };
  });


  // Opt into minimize-to-tray from the renderer if it asks for it.
  ipcMain.on("desktop:minimize-to-tray", (_event, enable) => {
    tray.setMinimizeToTray(Boolean(enable));
  });

  // Surface load failures as a visible dialog instead of a blank window.
  mainWindow.webContents.on("did-fail-load", (_event, code, desc, url) => {
    console.error("[SYNQ] load failed", code, desc, url);
    const { dialog } = require("electron");
    dialog.showErrorBox(
      "SYNQ",
      `The app failed to load its interface.\n\n${code}: ${desc}\n${url}`,
    );
  });

  // In production, trap errors instead of surfacing a devtools-style overlay.
  if (!isDev) {
    mainWindow.webContents.on("render-process-gone", (_event, details) => {
      console.error("[SYNQ] renderer gone", details.reason);
    });
  }

  // Tray quick actions come from the renderer; the renderer listens for them
  // through the preload bridge and handles actual playback from there.
  ipcMain.on("tray:action", (_event, action) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("tray:action", action);
    }
  });

  mainWindow.on("close", tray.onWindowClose);

  // Apply the desktop-specific auth + deep-link configuration BEFORE any
  // renderer content loads. The OAuth guard must be in place for the moment
  // the user clicks Google/GitHub sign-in, and the deep-link handler must be
  // registered early enough to catch the synq://callback the browser produces
  // after authentication.
  oauth.registerDeepLink();
  // Desktop OAuth + external links. Any web navigation (the Google/GitHub
  // consent screen included) is handed to the default browser and the embedded
  // navigation is cancelled; the app's own pages keep working.
  oauth.onAuthNavigation(mainWindow, {
    openExternal: shell.openExternal.bind(shell),
    appOrigins: isDev
      ? [new URL(process.env.VITE_DEV_URL ?? "http://localhost:5173").origin]
      : [],
    appFileRoot: isDev ? null : path.join(app.getAppPath(), "dist"),
  });
  // Belt and braces: the menu is cleared on `ready`, and again here so a
  // window created later (macOS re-activate) cannot inherit the default bar.
  Menu.setApplicationMenu(null);

  oauth.onSecondInstance(mainWindow);

  // The renderer registers the callback id it expects for each attempt; the
  // deep link is only accepted if it matches a pending registration.
  oauth.onBeginOAuth();

  // A synq:// URL can also be the reason this process started (a cold launch
  // from a browser callback). Dispatch it once the window exists; an
  // unregistered callback is ignored by the validator rather than trusted.
  if (startupDeepLink) {
    mainWindow.webContents.once("did-finish-load", () => {
      oauth.handleDeepLink(mainWindow, startupDeepLink);
    });
  }

  // Start with the frontend. In dev this is the live Vite server; in prod it
  // is the packaged index.html.
  const url = resolveFrontendUrl();
  mainWindow.loadURL(url, {
    userAgent:
      "SYNQDesktop/1.0 (Windows; Music Player)",
  });

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: "right" });
  }

  tray.installTray();
}

// Quit cleanly on Windows session end / logout.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

// NOTE: the second-instance / open-url handlers are installed by
// oauth.onSecondInstance() together with the deep-link delivery, so the URL
// and the window activation stay in one place.

app.on("ready", () => {
  // There is no `app.setApplicationMenu`; the menu belongs to `Menu`. Getting
  // this wrong left the stock File/Edit/View bar on the packaged window.
  try {
    Menu.setApplicationMenu(null);
  } catch (err) {
    console.error("[SYNQ] failed to clear default menu", err?.message);
  }
  createMainWindow();
});
