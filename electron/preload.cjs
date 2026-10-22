// The only bridge between the shell and the app.
//
// `contextIsolation` is on and `nodeIntegration` is off, so the renderer gets a
// frozen object and nothing else: no `require`, no fs, no ipc surface to misuse.
//
// The renderer needs exactly one fact — "am I inside the desktop shell?" — so it
// can skip the service worker (there is nothing to cache in a shell that already
// ships its files) and skip the install prompt. On top of that, one narrow,
// explicitly-named surface per feature:
//
//   OAuth (`src/lib/desktop-auth.ts`):
//     beginOAuth   — register the callback id/timestamp/nonce this attempt
//                    expects. The main process rejects any synq://callback
//                    that does not match.
//     onAuthResult — receive the validated callback result. Additive: every
//                    registered listener receives every result and filters by
//                    its own client id.
//
//   Tray (`src/lib/trayBridge.ts`):
//     minimizeToTray — the renderer's close-to-tray preference (off by
//                      default, so desktop close/quit behavior is unchanged
//                      until the user opts in).
//     onTrayAction   — "play-pause"/"next"/"previous" clicks from the tray
//                      menu, mapped onto the player store in the renderer.
//
// Everything is frozen, so the renderer cannot assign
// `window.synqDesktop.beginOAuth = fn` and steal a channel.
const { contextBridge, ipcRenderer } = require("electron");

const authResultListeners = new Set();
const trayActionListeners = new Set();

contextBridge.exposeInMainWorld(
  "synqDesktop",
  Object.freeze({
    isDesktop: true,
    platform: process.platform,
    // The shell serves `app://synq`; the renderer uses it to build share links
    // that are meaningful outside the app.
    shell: "electron",

    // --- Desktop OAuth -----------------------------------------------------
    beginOAuth: (clientId, params) => {
      if (typeof clientId !== "string" || clientId.length === 0) return;
      // Only the fields the main process validates are forwarded — nothing
      // else the renderer may attach can ride along.
      ipcRenderer.send("desktop:begin-oauth", clientId, {
        nonce: typeof params?.nonce === "string" ? params.nonce : null,
        ts: typeof params?.ts === "number" ? params.ts : null,
        redirectTo:
          typeof params?.redirectTo === "string" ? params.redirectTo : null,
      });
    },
    onAuthResult: (listener) => {
      if (typeof listener !== "function") return () => {};
      authResultListeners.add(listener);
      return () => {
        authResultListeners.delete(listener);
      };
    },

    // --- Tray ---------------------------------------------------------------
    minimizeToTray: (enable) => {
      ipcRenderer.send("desktop:minimize-to-tray", Boolean(enable));
    },
    onTrayAction: (listener) => {
      if (typeof listener !== "function") return () => {};
      trayActionListeners.add(listener);
      return () => {
        trayActionListeners.delete(listener);
      };
    },
  }),
);

// A single push channel per feature, fanned out to the listeners above. One
// throw in one listener can never break the others or the channel itself.
ipcRenderer.on("synq:auth-result", (_event, result) => {
  for (const listener of authResultListeners) {
    try {
      listener(result);
    } catch (err) {
      console.error("[SYNQ] auth result handler threw", err);
    }
  }
});

ipcRenderer.on("tray:action", (_event, action) => {
  if (typeof action !== "string") return;
  for (const listener of trayActionListeners) {
    try {
      listener(action);
    } catch (err) {
      console.error("[SYNQ] tray action handler threw", err);
    }
  }
});
