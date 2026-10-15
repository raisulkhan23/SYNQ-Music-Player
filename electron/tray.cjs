const { app, Menu, Tray, nativeImage, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

// ---------------------------------------------------------------------------
// SYNQ tray
// ---------------------------------------------------------------------------
// Kept in a separate module so the main process can optionally load it and so
// the renderer can decide whether close-to-quit or close-to-tray is preferred
// through the desktop.minimizeToTray IPC it already has.
//
// Tray is a feature with real tradeoffs:
//  - It is useful for music apps and matches the "minimize to tray" behavior
//    many desktop players expect.
//  - It is powered by a 16x16 / 24x24 icon that must be shipped; on some
//    Windows setups a missing icon path quietly shows a default, so we
//    validate the asset early and fall back cleanly.
// ---------------------------------------------------------------------------

const STATE = {
  tray: null,
  minimizeToTray: false,
};

function assetPath(file) {
  if (!app.isPackaged) {
    return path.join(__dirname, file);
  }
  return path.join(process.resourcesPath, file);
}

function loadIcon() {
  // In the packaged app the tray must load an asset we actually ship into
  // process.resourcesPath. electron-builder only puts logo.png and logo.ico there
  // (see electron-builder.yml files + extraResources), so logo.svg is not available
  // at runtime and is not a real candidate despite living in public/ at dev time.
  const candidates = ["logo.png", "logo.ico"];
  for (const c of candidates) {
    const p = assetPath(c);
    try {
      fs.accessSync(p, fs.constants.R_OK);
      return nativeImage.createFromPath(p).resize({ width: 24, height: 24 });
    } catch {
      continue;
    }
  }
  return null;
}

function buildMenu() {
  const cmds = [
    {
      label: "Play / Pause",
      click: () => sendAction("play-pause"),
    },
    {
      label: "Next",
      click: () => sendAction("next"),
    },
    {
      label: "Previous",
      click: () => sendAction("previous"),
    },
    { type: "separator" },
    {
      label: "Show SYNQ",
      click: () => showMainWindow(),
    },
    {
      label: "Hide SYNQ",
      click: () => {
        const w = BrowserWindow.getAllWindows().find((x) => x.isVisible());
        if (w) w.hide();
      },
    },
    { type: "separator" },
    {
      label: "Settings",
      click: () => {
        sendAction("open-settings");
        showMainWindow();
      },
    },
    { type: "separator" },
    {
      label: "Quit SYNQ",
      click: () => app.quit(),
    },
  ];
  return Menu.buildFromTemplate(cmds);
}

function sendAction(action) {
  if (!STATE.tray) return;
  STATE.tray.send("tray:action", action);
}

function showMainWindow() {
  const w = BrowserWindow.getAllWindows().find((x) => x.isVisible()) ?? BrowserWindow.getAllWindows()[0];
  if (!w) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

function installTray() {
  const icon = loadIcon();
  if (!icon) {
    console.warn("[SYNQ] tray icon not found; tray not created");
    return;
  }
  STATE.tray = new Tray(icon);
  STATE.tray.setToolTip("SYNQ");
  STATE.tray.setContextMenu(buildMenu());
  STATE.tray.on("click", () => showMainWindow());
  STATE.tray.on("double-click", () => showMainWindow());
}

function setMinimizeToTray(enable) {
  STATE.minimizeToTray = Boolean(enable);
}

function onWindowClose(event) {
  if (!STATE.minimizeToTray) return;
  const w = event.sender;
  if (BrowserWindow.getAllWindows().length === 1 && w) {
    event.preventDefault();
    w.hide();
  }
}

function unload() {
  if (STATE.tray) {
    try {
      STATE.tray.destroy();
    } catch {
      /* already gone */
    }
    STATE.tray = null;
  }
}

module.exports = {
  installTray,
  setMinimizeToTray,
  onWindowClose,
  unload,
};
