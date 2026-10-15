const { contextBridge, ipcRenderer } = require("electron");

// ---------------------------------------------------------------------------
// SYNQ preload — minimal desktop bridge
// ---------------------------------------------------------------------------
// This is the ONLY surface between the renderer and the main process. It
// exposes what the app actually needs on the desktop side and nothing else, so
// the web app still works unchanged when packaged.
//
// The renderer is untrusted in the Electron sense: it is the packaged web app,
// which is trusted for the app's own features but is not given node, fs,
// child_process, or arbitrary IPC. Every channel is explicitly named.
//
// Note on shape: a contextBridge object is frozen, so the renderer cannot
// assign `window.synq.desktop.onAuthResult = fn`. Listener APIs are functions
// the renderer calls with a callback instead.
// ---------------------------------------------------------------------------

let trayMenuActions = null;
const authResultListeners = new Set();

contextBridge.exposeInMainWorld("synq", {
  desktop: {
    // Window behavior the app may want from the desktop side.
    minimizeToTray: (enable) => {
      ipcRenderer.send("desktop:minimize-to-tray", Boolean(enable));
    },

    // Ask the tray for a quick action. Responses come back through the same
    // listener registered below; truthy here means "the tray is in use".
    onTrayAction: (listener) => {
      if (typeof listener !== "function") return;
      trayMenuActions = listener;
      ipcRenderer.on("tray:action", (_event, action) => {
        try {
          listener(action);
        } catch (err) {
          console.error("[SYNQ] tray action handler threw", err);
        }
      });
    },

    // Open the settings page in the app (in-app navigation, not a shell open).
    openSettingsPage: () => {
      ipcRenderer.send("desktop:open-settings");
    },

    // --- Desktop OAuth -----------------------------------------------------
    // Declare the callback this sign-in attempt expects. The main process
    // records it and will only accept a synq://callback that matches.
    beginOAuth: (clientId, params) => {
      ipcRenderer.send("desktop:begin-oauth", String(clientId), params ?? {});
    },

    // Receive validated callback results. Returns nothing; the listener stays
    // registered for the life of the window.
    onAuthResult: (listener) => {
      if (typeof listener !== "function") return;
      authResultListeners.add(listener);
    },

    // Handy for diagnostics inside the app.
    appVersion: appVersion(),
  },
});

// Single IPC entry point for OAuth results, fanned out to registered listeners.
ipcRenderer.on("synq:auth-result", (_event, result) => {
  for (const listener of authResultListeners) {
    try {
      listener(result);
    } catch (err) {
      console.error("[SYNQ] auth result handler threw", err);
    }
  }
});

// Keep this thin. main reads "desktop:*" channels directly.
ipcRenderer.on("desktop:open-settings", () => {
  ipcRenderer.send("app:open-settings-page");
});

ipcRenderer.on("app:toggle-quick-action", (_event, action) => {
  if (trayMenuActions) trayMenuActions(action);
});

function appVersion() {
  try {
    const pkg = require("./package.json");
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}
