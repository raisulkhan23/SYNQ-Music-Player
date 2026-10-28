// ---------------------------------------------------------------------------
// SYNQ desktop yt-dlp availability probe.
//
// Called by the renderer (via the preload bridge) to populate the DownloadHub
// status display. Returns:
//  - available: true when a verified yt-dlp exe is present and runs,
//  - version: the yt-dlp --version string,
//  - exePath: the verified executable path (only the basename is exposed to the
//    renderer; the full path stays in the main process),
//  - reason: when not available, a human-readable reason.
// ---------------------------------------------------------------------------

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/**
 * Locate a verified yt-dlp executable.
 *
 * Candidates (in order):
//  1. The path the packaged build ships next to this probe,
//  2. The developer's local copy under electron/,
//  3. A system location the developer may have configured.
 */
function locateYtDlp() {
  const candidates = [
    // Packaged build: inside resources, next to this file.
    typeof process.resourcesPath === "string"
      ? path.join(process.resourcesPath, "yt-dlp")
      : null,
    // Developer build: under electron/.
    path.join(__dirname, "yt-dlp"),
    // Developer build: next to electron/ (legacy layout).
    path.join(__dirname, "..", "yt-dlp"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const exeName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
      const exePath = path.join(candidate, exeName);
      fs.accessSync(exePath, fs.constants.R_OK | fs.constants.X_OK);
      // Quick smoke check: ask for --version so a stale placeholder is not
      // mistaken for a working binary.
      const versionOut = execFileSync(exePath, ["--version"], {
        timeout: 10_000,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      if (versionOut && versionOut.trim()) {
        return { path: exePath, version: versionOut.trim() };
      }
    } catch (err) {
      // Not present / not accessible / not a working yt-dlp; keep looking.
    }
  }
  return null;
}

/**
 * Probe availability and return a structured result.
 */
function probeAvailability() {
  const found = locateYtDlp();
  if (!found) {
    return {
      available: false,
      reason: "yt-dlp not found",
      detail: "SYNQ cannot download audio on this desktop build because yt-dlp is not installed.",
    };
  }
  return {
    available: true,
    version: found.version,
    exePath: path.basename(found.path),
  };
}

module.exports = { probeAvailability, locateYtDlp };
