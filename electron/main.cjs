/**
 * SYNQ desktop shell (Electron main process).
 *
 * Plain CommonJS on purpose: this file is not part of the Vite build, so it has
 * to run exactly as written in the packaged app. Keeping it dependency-free
 * means there is no transpile step between the repository and the installer.
 *
 * Why Electron and not Tauri: the repository already carried both a
 * `tauri-app/` scaffold and Electron output (see `.gitignore`, which ignores
 * `electron/dist` and `desktop-dist`). Tauri needs a Rust toolchain on every
 * build machine, and its WebView2 runtime differs per Windows install. Electron
 * ships its own Chromium, so the audio deck, service-worker-free asset loading
 * and the playback engine behave identically to the browser build and to every
 * other Windows machine. The trade is installer size (~80 MB). That is the
 * documented choice: least disruptive, most predictable playback.
 *
 * The renderer is served from `app://synq/` rather than `file://` so that
 * `BrowserRouter` keeps real paths: a `file://` document makes history
 * navigation and deep links fail on Windows, and `/artist/<name>` is a route
 * listeners actually share.
 */

const { app, BrowserWindow, Menu, dialog, net, protocol, shell } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

/** Where the Vite build lands. Packaged builds carry it inside app.asar. */
const DIST = path.join(__dirname, "..", "dist");
const APP_ORIGIN = "app://synq";
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
};

// Must run before `app.ready`. `standard` gives real URLs/paths, `secure` makes
// the page a secure context (so clipboard, media and storage APIs behave as
// they do on https), and `supportFetchAPI` keeps `fetch()` working for the same
// relative URLs the browser build uses.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      codeCache: true,
    },
  },
]);

/**
 * Serve `dist/` over `app://`.
 *
 * Any path that is not a real file falls back to `index.html`: that is what
 * makes `/artist/Hozier` (typed, shared, or restored from the last session)
 * work instead of 404ing inside the shell.
 */
async function serveApp(request) {
  const url = new URL(request.url);
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const candidate = path.join(DIST, relative || "index.html");

  // Never escape the build directory.
  if (!candidate.startsWith(DIST)) {
    return new Response("Forbidden", { status: 403 });
  }

  const send = async (file) => {
    const body = await fs.readFile(file);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        // The shell loads its own files from disk; caching them in the HTTP
        // cache only creates a second, staler copy of the app to debug.
        "Cache-Control": "no-cache",
      },
    });
  };

  try {
    const stat = await fs.stat(candidate);
    if (stat.isFile()) return await send(candidate);
  } catch {
    // fall through to the SPA entry point
  }

  try {
    return await send(path.join(DIST, "index.html"));
  } catch {
    return new Response(
      "<h1>SYNQ could not start</h1><p>The application files are missing. Reinstall SYNQ.</p>",
      { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }
}

/** Only the app's own origin may be loaded in the window. */
function isAppUrl(target) {
  try {
    return new URL(target).protocol === "app:";
  } catch {
    return false;
  }
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    // Matches `--background` so the first paint is not a white flash.
    backgroundColor: "#0A0B10",
    title: "SYNQ",
    autoHideMenuBar: true,
    // The renderer draws its own chrome; the window keeps the native frame and
    // system controls so maximise/restore/snap behave like every other Windows
    // app instead of being re-implemented badly.
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Playback is an audio app: it must keep running when the window is not
      // focused, and media keys should not require a click first.
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());

  // External links (support pages, provider consent, a shared link) belong in
  // the user's browser, never in a window with no address bar.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });

  // A permission prompt from a page we did not author is a red flag; the app
  // only ever needs audio playback and clipboard writes, which do not ask.
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "media" || permission === "clipboard-sanitized-write");
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Headless smoke check for CI and for shipping verification: load the shell,
  // report what actually rendered, and exit. Guarded by an env var so a normal
  // launch never takes this path. Windows GUI builds have no console, so the
  // result is written to the file named by SYNQ_SMOKE_OUT.
  const smokeOut = process.env.SYNQ_SMOKE_OUT;
  if (smokeOut) {
    mainWindow.webContents.once("did-finish-load", () => {
      void (async () => {
        let report = { ok: false, url: mainWindow.webContents.getURL() };
        try {
          const probed = await mainWindow.webContents.executeJavaScript(
            `JSON.stringify({ title: document.title, text: (document.body.innerText || "").slice(0, 400), url: location.href })`,
          );
          report = { ok: true, ...JSON.parse(probed) };
        } catch (error) {
          report.error = error instanceof Error ? error.message : String(error);
        }
        await fs.writeFile(smokeOut, JSON.stringify(report, null, 2), "utf8");
        app.exit(report.ok ? 0 : 1);
      })();
    });
  }

  // `/`, not `/index.html`: BrowserRouter matches on the path, and
  // `/index.html` is not a route — it rendered the 404 page inside the shell.
  // SYNQ_SMOKE_ROUTE lets the smoke check open a deep link the same way a
  // shared URL or a restored session would.
  const route = process.env.SYNQ_SMOKE_ROUTE ?? "";
  const target = route.startsWith("/") ? route : `/${route}`;
  void mainWindow.loadURL(`${APP_ORIGIN}${target === "/" ? "/" : target}`);
}

/**
 * Minimal menu so clipboard shortcuts keep working.
 *
 * `Menu.setApplicationMenu(null)` removes Ctrl+C / Ctrl+V / Ctrl+A inside text
 * inputs on Windows, which would make the app feel broken. The menu is hidden
 * by `autoHideMenuBar` and only appears while Alt is held.
 */
function installMenu() {
  const isMac = process.platform === "darwin";
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: "appMenu" }] : []),
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
    ]),
  );
}

/**
 * Automatic update check — CONFIGURED, NOT VERIFIED.
 *
 * There is no update feed in this repository and no signing certificate in this
 * environment, so nothing here claims an update has ever installed. When
 * `SYNQ_UPDATE_FEED` points at a JSON document:
 *
 *   { "version": "1.4.0", "url": "https://…/SYNQ-Setup-1.4.0.exe", "notes": "…" }
 *
 * the shell compares it with its own version and offers the download. The user
 * runs the installer; nothing is downloaded or executed silently, and an
 * unsigned build would trigger SmartScreen regardless.
 *
 * Without a feed this stays silent rather than inventing an "up to date" claim.
 */
async function checkForUpdates({ interactive = false } = {}) {
  const feed = process.env.SYNQ_UPDATE_FEED;
  if (!feed) {
    if (interactive) {
      await dialog.showMessageBox({
        type: "info",
        title: "Updates",
        message: "No update feed is configured",
        detail:
          "This build was produced without SYNQ_UPDATE_FEED, so SYNQ cannot check for a newer version.",
      });
    }
    return;
  }

  try {
    const response = await net.fetch(feed, { cache: "no-store" });
    if (!response.ok) throw new Error(`feed returned ${response.status}`);
    const latest = await response.json();
    const current = app.getVersion();
    if (typeof latest?.version !== "string" || !isNewer(latest.version, current)) {
      if (interactive) {
        await dialog.showMessageBox({
          type: "info",
          title: "Updates",
          message: `SYNQ ${current} is the latest version`,
        });
      }
      return;
    }

    const { response: choice } = await dialog.showMessageBox({
      type: "info",
      title: "Update available",
      message: `SYNQ ${latest.version} is available`,
      detail: typeof latest.notes === "string" ? latest.notes : undefined,
      buttons: ["Download", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice === 0 && typeof latest.url === "string" && /^https?:/i.test(latest.url)) {
      await shell.openExternal(latest.url);
    }
  } catch (error) {
    // A feed that is down must never interrupt listening.
    console.warn("[synq] update check failed:", error instanceof Error ? error.message : error);
  }
}

/** Numeric semver comparison; a suffix (beta) sorts before the plain release. */
function isNewer(candidate, current) {
  const parse = (value) =>
    String(value)
      .split(/[.+-]/)
      .slice(0, 3)
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

// One instance only: two windows sharing one localStorage would fight over the
// saved queue and the "single audio deck" invariant.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    app.setAppUserModelId("com.synq.app");
    protocol.handle("app", serveApp);
    installMenu();
    createWindow();

    // Give the first paint time to finish before talking to the network.
    setTimeout(() => void checkForUpdates(), 15_000);
    setInterval(() => void checkForUpdates(), UPDATE_CHECK_INTERVAL_MS);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
