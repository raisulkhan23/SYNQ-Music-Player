
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

const tray = require("./tray");
const { app, BrowserWindow, ipcMain, shell } = require("electron");
const path = require("node:path");

const isDev =
  process.env.NODE_ENV === "development" ||
  !app.isPackaged ||
  !!process.env.ELECTRON_DEV;

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

  mainWindow.on("closed", () => {
    mainWindow = null;
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

app.on("ready", () => {
  createMainWindow();
});
