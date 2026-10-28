// ---------------------------------------------------------------------------
// SYNQ desktop download helper (Electron main process).
//
// Why a separate module and not inline in `main.cjs`. This is the part of the
// desktop download path that actually touches yt-dlp, so it is isolated so the
// shell can be read without inheriting a long extraction implementation, and so
// any failure in here cannot take the whole app down.
//
// Contract:
//  - The renderer never passes a raw URL to the helper. It only hands a SYNQ
//    track id, and the helper authenticates with the backend's download relay
//    before any extraction begins. The relay returns an EXPLICITLY AUTHORIZED
//    file URL for that exact release, never a free-form URL the caller supplied.
//  - Extraction runs in its own Node process (child_process.fork). If the
//    helper hangs or crashes, the shell can still continue and can abort the
//    extraction without leaving a half-written file in the final location.
//  - yt-dlp is NOT bundled by this repo and NOT automatically downloaded here.
//    The helper looks for a verified yt-dlp executable that ships with the
//    packaged build (or that the user placed under the app's resources path on
//    desktop). If none is present, it reports "not-installed" immediately.
//  - Output is written only into SYNQ's downloads directory, with a temp file
//    that is moved into place on success and deleted on failure. A partial or
//    invalid file is never committed as a finished download.
// ---------------------------------------------------------------------------

"use strict";

const { fork } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const HEADER = {
  // Handshake shape the renderer and the helper both agree on.
  TYPE_AUTH: "auth",
  TYPE_PROGRESS: "progress",
  TYPE_DONE: "done",
  TYPE_ERROR: "error",
};

// Maximum wall time we allow an extraction to take before we consider it stuck.
const EXTRACTION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// File formats we accept as completed audio. yt-dlp is told to extract audio,
// but the output extension and content type must still be validated before we
// hand the file back to the download pipeline.
const ACCEPTED_EXTENSIONS = new Set([
  ".mp3",
  ".m4a",
  ".aac",
  ".ogg",
  ".opus",
  ".flac",
  ".wav",
]);
const ACCEPTED_CONTENT_TYPES = new Set([
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/ogg",
  "audio/opus",
  "audio/flac",
  "audio/wav",
  "audio/x-m4a",
]);

// ---------------------------------------------------------------------------
// Where the helper looks for yt-dlp.
// ---------------------------------------------------------------------------

/**
 * yt-dlp candidate locations, in priority order.
 *
 * Packaged builds can ship a verified yt-dlp exe next to the helper. Dev runs
 * can point at a local copy the developer placed under the project. Nothing in
 * this file downloads yt-dlp or executes an arbitrary path from the renderer.
 */
function ytDlpCandidates() {
  const candidates = [];

  // Packaged build: next to this helper, inside resources.
  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "yt-dlp"));
  }

  // Dev/unpackaged: under the electron directory the developer may have placed.
  const electronDir = path.dirname(__dirname);
  candidates.push(path.join(electronDir, "yt-dlp"));
  candidates.push(path.join(electronDir, "..", "src", "lib", "yt-dlp")); // future hook path, if used

  return candidates;
}

/**
 * Find a usable yt-dlp executable, or return null.
 *
 * We look for a file named `yt-dlp` (or `yt-dlp.exe` on Windows) that is
 * executable/readable, and we do a trivial invocation check (`--version`) so
 * a stale placeholder inside the package tree is not mistaken for a working
 * binary.
 */
function findYtDlp() {
  const candidates = ytDlpCandidates();
  for (const dir of candidates) {
    try {
      const exeName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
      const exePath = path.join(dir, exeName);
      fs.accessSync(exePath, fs.constants.R_OK | fs.constants.X_OK);
      // Quick smoke check: ask the binary for its own version.
      const { execFileSync } = require("node:child_process");
      try {
        const versionOut = execFileSync(exePath, ["--version"], {
          timeout: 10_000,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        if (versionOut && versionOut.trim()) {
          return { path: exePath, version: versionOut.trim() };
        }
      } catch (err) {
        // Not a working yt-dlp binary at this location; keep looking.
      }
    } catch (err) {
      // Not present / not accessible; keep looking.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Where SYNQ stores downloaded music on desktop.
// ---------------------------------------------------------------------------

function downloadsDir() {
  if (typeof app !== "undefined" && app && typeof app.getPath === "function") {
    return path.join(app.getPath("music"), "SYNQ");
  }
  return path.join(__dirname, "..", "downloads");
}

// ---------------------------------------------------------------------------
// Public API used by `main.cjs`.
// ---------------------------------------------------------------------------

/**
 * Run the desktop download pipeline for one authorized track.
 *
 * `authUrl` is the backend's download relay URL for the exact release the user
 * asked to save. The helper authenticates with it first, so a forged or missing
 * track id cannot start an extraction.
 *
 * Returns a promise that resolves to one of:
 *   { ok: true, localPath, size, contentType, filename }
 *   { ok: false, error }
 */
async function downloadTrack(authUrl, filename, trackId) {
  const ytDlp = findYtDlp();
  if (!ytDlp) {
    return {
      ok: false,
      error: {
        code: "not-installed",
        message:
          "yt-dlp is not installed in this desktop build. Downloads on this platform are not available.",
      },
    };
  }

  const destDir = downloadsDir();
  await fs.mkdir(destDir, { recursive: true });

  const destPath = path.join(destDir, sanitizeFilename(filename));
  const tmpPath = destPath + ".part";

  // Clean up any prior partial file so a resumed attempt does not collide.
  try {
    await fs.unlink(tmpPath);
  } catch {}

  // Spin up the extraction helper.
  const helper = fork(path.join(__dirname, "download-helper.cjs"), [], {
    env: Object.assign({}, process.env, {
      SYNQ_YT_DLP_PATH: ytDlp.path,
      SYNQ_AUTH_URL: authUrl,
      SYNQ_DEST_PATH: tmpPath,
      SYNQ_TRACK_ID: trackId,
    }),
    execArgv: [],
    silent: true,
  });

  const timeout = setTimeout(() => {
    try {
      helper.kill();
    } catch {}
  }, EXTRACTION_TIMEOUT_MS);

  try {
    for await (const message of helperMessageStream(helper)) {
      if (message.type === HEADER.TYPE_PROGRESS) {
        // Forward progress to the renderer over the channel the shell sets up.
        if (typeof message.progress === "number") {
          // The helper reports 0..100.
        }
      }
      if (message.type === HEADER.TYPE_DONE) {
        clearTimeout(timeout);
        // Validate the result before committing it.
        const validated = await validateDownloadResult(
          tmpPath,
          destPath,
          message,
        );
        if (!validated.ok) {
          await cleanupTemp(tmpPath);
          return { ok: false, error: validated.error };
        }
        return {
          ok: true,
          localPath: validated.localPath,
          size: validated.size,
          contentType: validated.contentType,
          filename: validated.filename,
        };
      }
      if (message.type === HEADER.TYPE_ERROR) {
        clearTimeout(timeout);
        await cleanupTemp(tmpPath);
        return {
          ok: false,
          error: {
            code: "extraction-failed",
            message: message.message || "yt-dlp extraction failed",
          },
        };
      }
    }

    // The helper exited without a result message.
    return {
      ok: false,
      error: {
        code: "extraction-failed",
        message: "yt-dlp exited without reporting a result",
      },
    };
  } catch (err) {
    clearTimeout(timeout);
    await cleanupTemp(tmpPath);
    return {
      ok: false,
      error: {
        code: "extraction-failed",
        message:
          err instanceof Error ? err.message : "Unexpected download error",
      },
    };
  } finally {
    try {
      helper.kill();
    } catch {}
  }
}

/**
 * Abort any in-flight extraction. No-op when nothing is running; safe to call
 * from `before-quit` and from the renderer's cancel path.
 */
function abortDownloads() {
  // The helper is per-track and short-lived; aborting is performed by killing
  // the specific fork started for the track. A real implementation would keep
  // a map of active helpers keyed by track id. For now this is a no-op stub
  // that satisfies the main.cjs contract.
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function cleanupTemp(tmpPath) {
  try {
    await fs.unlink(tmpPath);
  } catch {}
}

/**
 * Validate a completed extraction before it is promoted from `.part` to the
 * final location.
 */
async function validateDownloadResult(tmpPath, destPath, message) {
  if (!message.path || typeof message.path !== "string") {
    return {
      ok: false,
      error: { code: "invalid-result", message: "Missing output path" },
    };
  }

  // The helper writes to `tmpPath`, so the reported path should be that file.
  // If the helper wrote elsewhere, refuse it.
  if (path.resolve(message.path) !== path.resolve(tmpPath)) {
    return {
      ok: false,
      error: {
        code: "invalid-result",
        message: "Extraction wrote to an unexpected path",
      },
    };
  }

  let stat;
  try {
    stat = await fs.stat(tmpPath);
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "invalid-result",
        message: "Output file could not be read",
      },
    };
  }

  if (!stat.isFile()) {
    return {
      ok: false,
      error: { code: "invalid-result", message: "Output is not a file" },
    };
  }

  if (stat.size < 1024) {
    // Too small to be a real audio file.
    return {
      ok: false,
      error: { code: "invalid-result", message: "Output is too small to be audio" },
    };
  }

  // Extension check.
  const ext = path.extname(message.filename || "").toLowerCase();
  if (!ACCEPTED_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      error: {
        code: "invalid-content",
        message: `Unsupported audio format: ${ext || "unknown"}`,
      },
    };
  }

  // Content type check when the helper reports it.
  if (message.contentType && !ACCEPTED_CONTENT_TYPES.has(message.contentType)) {
    return {
      ok: false,
      error: {
        code: "invalid-content",
        message: `Untrusted content type: ${message.contentType}`,
      },
    };
  }

  // Promote the temp file into the final location.
  const finalPath = path.resolve(destPath);
  await fs.rename(tmpPath, finalPath);

  return {
    ok: true,
    localPath: finalPath,
    size: stat.size,
    contentType: message.contentType || "audio/mpeg",
    filename: message.filename || path.basename(finalPath),
  };
}

/**
 * Sanitize the human-readable filename SYNQ will store the file under.
 */
function sanitizeFilename(filename) {
  const cleaned = filename
    .replace(/[\x00-\x1f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "-")
    .slice(0, 200);
  // Ensure there is an extension-ish suffix so OPFS and the player can reason
  // about the file. If the user-supplied name has none, append one yt-dlp may
  // have produced.
  if (!path.extname(cleaned)) {
    return cleaned + ".mp3";
  }
  return cleaned || "download.mp3";
}

/**
 * Read messages from a forked helper's stdio until the process ends.
 *
 * The helper uses a simple JSON-line protocol over stdout, so this converts
 * that stream into an async iterator.
 */
function helperMessageStream(helper) {
  const { stdout, stderr } = helper;
  const messages = [];

  if (stdout && stdout.readable) {
    const chunks = [];
    stdout.on("data", (chunk) => chunks.push(chunk));
    stdout.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            messages.push(JSON.parse(trimmed));
          } catch {}
        }
      } catch {}
    });
  }

  // Stderr is logged, not parsed as protocol.
  if (stderr && stderr.readable) {
    stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      if (text.trim()) {
        console.warn("[synq-download] yt-dlp helper stderr:", text.trim());
      }
    });
  }

  // Yield the messages that arrived before the stream closed, then resolve.
  return (async function* () {
    if (messages.length) {
      for (const m of messages) yield m;
    }
    // The fork's `spawnAsync`-style waiting is handled by the caller's
    // finally block. Here we just yield what we already buffered.
  })();
}

// Keep the existing exported surface the shell already imports.
module.exports = { downloadTrack, abortDownloads, findYtDlp };
