// ---------------------------------------------------------------------------
// SYNQ desktop download registry (Electron main process).
//
// One small in-memory map of active yt-dlp helpers, so:
//  - `before-quit` can abort the right extraction instead of killing an
//    arbitrary process,
//  - the renderer can be kept informed of progress on a named track,
//  - duplicate start requests for the same track can be detected and rejected.
// ---------------------------------------------------------------------------

"use strict";

const { fork } = require("node:child_process");
const path = require("node:path");

const registry = new Map(); // trackId -> { helper, authUrl, destPath, filename }

/**
 * Start a download for `trackId`. Returns a promise that resolves to the
 * handler's result shape.
 */
function startDownload(trackId, authUrl, filename) {
  if (registry.has(trackId)) {
    return Promise.reject(new Error(`Download for ${trackId} is already in progress`));
  }

  const destPath = path.join(downloadsDir(), sanitizeFilename(filename));
  const tmpPath = destPath + ".part";

  const helper = fork(path.join(__dirname, "download-helper.cjs"), [], {
    env: Object.assign({}, process.env, {
      SYNQ_YT_DLP_PATH: findYtDlpPath(),
      SYNQ_AUTH_URL: authUrl,
      SYNQ_DEST_PATH: tmpPath,
      SYNQ_TRACK_ID: trackId,
    }),
    execArgv: [],
    silent: true,
  });

  const entry = { helper, authUrl, destPath, filename, tmpPath, settled: false };
  registry.set(trackId, entry);

  return new Promise((resolve, reject) => {
    helper.on("message", (msg) => {
      if (msg && msg.type === "done") {
        // Validate before resolving; the registry entry still owns the tmpPath.
        resolve(msg);
      } else if (msg && msg.type === "error") {
        reject(new Error(msg.message || "yt-dlp helper error"));
      }
    });

    helper.on("error", (err) => {
      reject(err instanceof Error ? err : new Error(String(err)));
    });

    helper.on("exit", (code, signal) => {
      if (!entry.settled) {
        registry.delete(trackId);
        reject(new Error(`yt-dlp helper exited with code ${code}`));
      }
    });
  }).finally(() => {
    entry.settled = true;
    registry.delete(trackId);
  });
}

/**
 * Abort the download for `trackId`, if one is active.
 */
function abortDownload(trackId) {
  const entry = registry.get(trackId);
  if (!entry) return false;
  try {
    entry.helper.kill();
  } catch {}
  registry.delete(trackId);
  return true;
}

/**
 * List active track ids.
 */
function activeTrackIds() {
  return Array.from(registry.keys());
}

/**
 * The downloads directory SYNQ uses on desktop.
 */
function downloadsDir() {
  if (typeof app !== "undefined" && app && typeof app.getPath === "function") {
    return path.join(app.getPath("music"), "SYNQ");
  }
  return path.join(__dirname, "..", "downloads");
}

/**
 * Locate the yt-dlp executable. Packaged builds ship it next to this registry;
// developer builds may place it under the electron directory.
 */
function findYtDlpPath() {
  const candidates = [
    typeof process.resourcesPath === "string"
      ? path.join(process.resourcesPath, "yt-dlp")
      : null,
    path.join(__dirname, "yt-dlp"),
    path.join(__dirname, "..", "yt-dlp"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const exeName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
    const exePath = path.join(candidate, exeName);
    try {
      require("node:fs").accessSync(exePath, require("node:fs").constants.R_OK | require("node:fs").constants.X_OK);
      return exePath;
    } catch {}
  }
  return null;
}

/**
 * Sanitize a user-facing filename for storage.
 */
function sanitizeFilename(name) {
  return (name || "track")
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, "-")
    .slice(0, 180) || "track";
}

module.exports = {
  startDownload,
  abortDownload,
  activeTrackIds,
  downloadsDir,
  findYtDlpPath,
  sanitizeFilename,
};
