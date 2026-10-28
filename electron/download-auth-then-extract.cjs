// ---------------------------------------------------------------------------
// SYNQ desktop download orchestrator: authenticate, then extract.
//
// This is the middle layer between the registry (which owns start/abort/lifecycle)
// and the helper worker (which runs yt-dlp). Its job is to make sure that:
//  - authentication with the backend relay happens first,
//  - the relay response is validated before any yt-dlp invocation,
//  - only the single authorized URL is ever forwarded to yt-dlp,
//  - yt-dlp receives no user input except that URL.
// ---------------------------------------------------------------------------

"use strict";

const { fork } = require("node:child_process");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const relayClient = require("./download-relay-client.cjs");
const helper = require("./download-helper.cjs");

const HEADER = {
  TYPE_AUTH: "auth",
  TYPE_PROGRESS: "progress",
  TYPE_DONE: "done",
  TYPE_ERROR: "error",
};

const EXTRACTION_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Run the full desktop download pipeline for one track.
 *
 * `relayUrl` is the backend's download-proxy URL for the authorized release.
 * The orchestrator authenticates with it, validates the response, and if
 * successful starts the helper worker to extract audio with yt-dlp.
 */
async function authenticateThenExtract(relayUrl, trackId, filename, destDir) {
  // Step 1 — authenticate.
  let authorizedUrl;
  try {
    authorizedUrl = await relayClient.getAuthorizedUrl(relayUrl);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "auth-failed",
        message: err instanceof Error ? err.message : "Authentication failed",
      },
    };
  }

  // Step 2 — validate again (belt-and-suspenders).
  let validatedUrl;
  try {
    validatedUrl = relayClient.validateRelayResponse({ url: authorizedUrl });
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "invalid-relay-response",
        message: err instanceof Error ? err.message : "Invalid relay response",
      },
    };
  }

  // Step 3 — start the helper with ONLY the validated url.
  const destPath = path.join(destDir, sanitizeFilename(filename));
  const tmpPath = destPath + ".part";

  const helperProcess = fork(path.join(__dirname, "download-helper.cjs"), [], {
    env: Object.assign({}, process.env, {
      SYNQ_YT_DLP_PATH: process.env.SYNQ_YT_DLP_PATH || findYtDlpPath(),
      SYNQ_AUTH_URL: validatedUrl,
      SYNQ_DEST_PATH: tmpPath,
      SYNQ_TRACK_ID: trackId,
    }),
    execArgv: [],
    silent: true,
  });

  const timeout = setTimeout(() => {
    try {
      helperProcess.kill();
    } catch {}
  }, EXTRACTION_TIMEOUT_MS);

  return new Promise((resolve, reject) => {
    helperProcess.on("message", (msg) => {
      if (msg && msg.type === "done") {
        clearTimeout(timeout);
        helperProcess.kill();
        resolve({
          ok: true,
          path: msg.path,
          size: msg.size,
          filename: msg.filename,
          contentType: msg.contentType,
        });
      } else if (msg && msg.type === "error") {
        clearTimeout(timeout);
        helperProcess.kill();
        reject(new Error(msg.message || "yt-dlp helper error"));
      }
    });

    helperProcess.on("error", (err) => {
      clearTimeout(timeout);
      reject(err instanceof Error ? err : new Error(String(err)));
    });

    helperProcess.on("exit", (code, signal) => {
      if (code !== 0 && signal !== "SIGTERM") {
        reject(new Error(`yt-dlp helper exited with code ${code}`));
      }
    });

    // Start the helper.
    helperProcess.send("start");
  });
}

/**
 * Find the yt-dlp executable path from env or known locations.
 */
function findYtDlpPath() {
  const candidates = [
    process.env.SYNQ_YT_DLP_PATH,
    typeof process.resourcesPath === "string"
      ? path.join(process.resourcesPath, "yt-dlp")
      : null,
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
 * Sanitize a filename for storage.
 */
function sanitizeFilename(name) {
  return (name || "track")
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, "-")
    .slice(0, 180) || "track";
}

module.exports = { authenticateThenExtract, findYtDlpPath, sanitizeFilename };
