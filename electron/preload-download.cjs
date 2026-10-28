// ---------------------------------------------------------------------------
// SYNQ preload download bridge (Electron preload script).
//
// This is the ONLY path from the renderer to the desktop yt-dlp download
// machinery. The renderer never sees the yt-dlp executable, the temp path, or
// the relay URL. It only dispatches a named start, listens for progress/done/
// error, and can request an abort.
//
// Everything is frozen and typed through the preload bridge.
// ---------------------------------------------------------------------------

"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const CHANNEL = {
  START: "synq:download:start",
  PROGRESS: "synq:download:progress",
  DONE: "synq:download:done",
  ERROR: "synq:download:error",
  ABORT: "synq:download:abort",
};

// Internal listeners, so the bridge can fan out to any registered handler.
const listeners = new Map();

/**
 * Register a listener for download events. The bridge keeps one handler per
 * event type and fans out to all registered listeners.
 */
function onDownloadEvent(eventType, handler) {
  if (typeof handler !== "function") return () => {};
  const list = listeners.get(eventType) ?? [];
  list.push(handler);
  listeners.set(eventType, list);
  return () => {
    const current = listeners.get(eventType) ?? [];
    const idx = current.indexOf(handler);
    if (idx >= 0) current.splice(idx, 1);
  };
}

/**
 * Emit a download event to all registered listeners.
 */
function emit(eventType, detail) {
  const list = listeners.get(eventType) ?? [];
  for (const handler of list) {
    try {
      handler(detail);
    } catch (err) {
      console.error("[SYNQ] download event handler threw", err);
    }
  }
}

// IPC listeners that forward main-process events into the bridge.
ipcRenderer.on(CHANNEL.PROGRESS, (_event, detail) => emit("progress", detail));
ipcRenderer.on(CHANNEL.DONE, (_event, detail) => emit("done", detail));
ipcRenderer.on(CHANNEL.ERROR, (_event, detail) => emit("error", detail));

module.exports = {
  /**
   * The frozen surface exposed to the renderer.
   */
  bridge: Object.freeze({
    // Whether this build includes the desktop download bridge at all.
    isDesktopDownloadBridge: true,

    /**
     * Start a download for a track the backend has authorized.
     *
     * `trackId` is the SYNQ track id (used for deduplication and abort).
     * `relayUrl` is the backend's download-proxy URL for the authorized release.
     * `filename` is the intended stored filename.
     *
     * The renderer does NOT pass a raw media URL here.
     */
    startDownload: (trackId, relayUrl, filename) => {
      if (typeof trackId !== "string" || trackId.length === 0) return false;
      if (typeof relayUrl !== "string" || relayUrl.length === 0) return false;
      if (typeof filename !== "string" || filename.length === 0) return false;
      try {
        ipcRenderer.send(CHANNEL.START, {
          trackId,
          relayUrl: relayUrl.trim(),
          filename: filename.trim(),
        });
        return true;
      } catch {
        return false;
      }
    },

    /**
     * Request abort of the in-flight download for `trackId`.
     */
    abortDownload: (trackId) => {
      if (typeof trackId !== "string" || trackId.length === 0) return false;
      try {
        ipcRenderer.send(CHANNEL.ABORT, { trackId });
        return true;
      } catch {
        return false;
      }
    },

    /**
     * Subscribe to download events.
     *
     * Returns an unsubscribe function. The same listener can be registered
     * multiple times; each registration gets its own unsubscribe.
     */
    onEvent: (eventType, handler) => {
      if (typeof eventType !== "string" || !["progress", "done", "error"].includes(eventType)) {
        return () => {};
      }
      return onDownloadEvent(eventType, handler);
    },
  }),

  /**
   * Wire `synqDesktop` in the preload context. Called from `preload.cjs`.
   */
  install(app) {
    if (!app || typeof app !== "object") return;
    const existing = app.synqDesktop ?? null;
    Object.defineProperty(app, "synqDesktop", {
      value: Object.freeze({
        ...existing,
        download: module.exports.bridge,
      }),
      writable: false,
      configurable: false,
    });
  },
};
