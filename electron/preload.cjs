/**
 * The only bridge between the shell and the app.
 *
 * `contextIsolation` is on and `nodeIntegration` is off, so the renderer gets a
 * frozen object and nothing else: no `require`, no fs, no ipc surface to misuse.
 *
 * The renderer needs exactly one fact — "am I inside the desktop shell?" — so it
 * can skip the service worker (there is nothing to cache in a shell that already
 * ships its files) and skip the install prompt.
 */
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld(
  "synqDesktop",
  Object.freeze({
    isDesktop: true,
    platform: process.platform,
    // The shell serves `app://synq`; the renderer uses it to build share links
    // that are meaningful outside the app.
    shell: "electron",
  }),
);
