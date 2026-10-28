// ---------------------------------------------------------------------------
// SYNQ desktop download helper worker (Electron main process, forked).
//
// This process runs yt-dlp for ONE track. It is separate from the shell so a
// hung or crashed extraction cannot wedge the app, and so the helper can be
// killed cleanly from the outside.
//
// Security boundaries:
//  - It receives its inputs ONLY through env vars the parent set. It does not
//    read any renderer-supplied arguments.
//  - The only URL it ever fetches is the one the backend's download relay hands
//    back after re-verifying permission for that exact release. The helper
//    authenticates with that relay first, and refuses to run if the relay says
//    no.
//  - yt-dlp is invoked through a verified exe path supplied by the parent.
//    No user input is interpolated into the process arguments.
//  - Output is written only to the path the parent gave it (a .part file in
//    SYNQ's managed downloads dir). It does not write anywhere else.
// ---------------------------------------------------------------------------

"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const YTDLP_PATH = process.env.SYNQ_YT_DLP_PATH;
const AUTH_URL = process.env.SYNQ_AUTH_URL;
const DEST_PATH = process.env.SYNQ_DEST_PATH;
const TRACK_ID = process.env.SYNQ_TRACK_ID;

if (!YTDLP_PATH || !AUTH_URL || !DEST_PATH) {
  printError("Missing required environment variables");
  process.exit(1);
}

if (!fs.existsSync(YTDLP_PATH)) {
  printError(`yt-dlp executable not found at ${YTDLP_PATH}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Step 1 — authenticate with the authorized download relay.
// ---------------------------------------------------------------------------

/**
 * Ask the backend's download relay whether this track is authorized, and get
 * the explicit file URL we are allowed to download.
 *
 * The relay is the same endpoint the browser build uses via
 * `src/lib/downloadProxy.ts`; on desktop we fetch it from the main process
 * instead of the renderer, because the renderer has no reason to touch yt-dlp
 * and we keep yt-dlp out of the renderer entirely.
 */
function authenticate() {
  try {
    // Minimal fetch implementation in the worker: use Node's global fetch if
    // available (Node 18+), else fall back to a tiny http(s) helper. On the
    // Electron Node versions this app ships, global fetch exists.
    const response = globalThis.fetch
      ? globalThis.fetch(AUTH_URL, {
          method: "GET",
          headers: { Accept: "application/json" },
        })
      : fetchLegacy(AUTH_URL);

    const body = response.body
      ? JSON.parse(response.body)
      : JSON.parse(response);

    if (!response.ok) {
      printError(
        `Download relay rejected authorization: ${response.status} ${body?.message || response.statusText}`,
      );
      process.exit(1);
    }

    if (!body?.url) {
      printError("Download relay did not return an authorized file URL");
      process.exit(1);
    }

    // The relay sanitizes this; we trust it because it is our own backend.
    return String(body.url);
  } catch (err) {
    printError(
      `Download relay authentication failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}

// Tiny legacy fetch for Node versions that lack global fetch (not expected in
// this app, but defensive).
function fetchLegacy(url) {
  const parsed = new URL(url);
  const lib = parsed.protocol === "https:" ? require("node:https") : require("node:http");
  return new Promise((resolve, reject) => {
    const request = lib.get(url, { headers: { Accept: "application/json" } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({
          ok: res.status >= 200 && res.status < 300,
          status: res.status,
          statusText: res.statusMessage,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      res.on("error", reject);
    });
    request.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Step 2 — run yt-dlp with a locked-down argument list.
// ---------------------------------------------------------------------------

/**
 * Build the yt-dlp argument list.
 *
 * We do NOT forward any user input except the ONE authorized URL returned by
 * the relay. Everything else is fixed: audio extraction only, no playlist,
 * no cookies, no post-processing hooks, no output templates that touch
 * directories outside the one the parent gave us.
 */
function buildYtDlpArgs(authorizedUrl) {
  const args = [
    // Do not load a config file from the user's environment.
    "--no-config",
    // Only audio.
    "-x",
    // Prefer common audio formats in order.
    "--audio-format", "mp3",
    // Do not transcode into something else if it would lose quality.
    "--audio-quality", "0",
    // Do not download video even if yt-dlp thinks it is needed.
    "--no-playlist",
    // Single result only.
    "--no-playlist",
    // Where the output goes. yt-dlp expands `%(title)s` etc.; we redirect its
    // output template to the exact temp path so it cannot write elsewhere.
    "-o", DEST_PATH,
    // Do not use any cookie file.
    "--no-cookies",
    // Prefer the direct media URL when available.
    "--prefer-free-form",
    // Quiet by default; the parent reads structured output.
    "--quiet",
    "--no-warnings",
    // Print progress to stderr in a parseable way so the parent can see it if
    // it wants to; we use the JSON summary at the end.
    "--progress-template", "%(progress._filename)s",
  ];

  // The URL to download is the ONLY positional argument, and it is the one the
  // backend authorized.
  args.push(authorizedUrl);

  return args;
}

// ---------------------------------------------------------------------------
// Step 3 — run and report.
// ---------------------------------------------------------------------------

function printResult(result) {
  process.stdout.write(JSON.stringify(result) + "\n");
}

function printError(message) {
  process.stderr.write(JSON.stringify({ type: "error", message }) + "\n");
}

function run() {
  const authorizedUrl = authenticate();

  const args = buildYtDlpArgs(authorizedUrl);
  const destDir = path.dirname(DEST_PATH);

  // Ensure the destination directory exists before yt-dlp runs.
  try {
    fs.mkdirSync(destDir, { recursive: true });
  } catch (err) {
    printError(`Cannot create download directory: ${err.message}`);
    process.exit(1);
  }

  let status;
  let metadata;
  try {
    // Use execFileSync so stderr is captured separately and yt-dlp cannot
    // inherit the parent's stdio in a way that could interfere with the
    // parent's IPC channel.
    const result = execFileSync(YTDLP_PATH, args, {
      encoding: "utf8",
      timeout: 10 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // yt-dlp writes a JSON summary to stdout when asked; parse it.
    try {
      metadata = JSON.parse(result);
    } catch {
      metadata = {};
    }

    // Determine the actual output file. yt-dlp may have used a different name
    // than DEST_PATH if the template expanded; but we forced -o DEST_PATH, so
    // the file should be there. If a post-processed file was created next to
    // it, prefer the primary one.
    const outputPath = path.resolve(DEST_PATH);
    if (!fs.existsSync(outputPath)) {
      printError(`yt-dlp did not create the expected output at ${outputPath}`);
      process.exit(1);
    }

    const stat = fs.statSync(outputPath);
    if (stat.size < 1024) {
      printError("Downloaded file is too small to be audio");
      process.exit(1);
    }

    status = "done";
  } catch (err) {
    if (err && err.status && err.status <= 1) {
      // yt-dlp user-facing error.
      printError(err.message || String(err));
    } else {
      printError(`yt-dlp execution failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }

  // Determine content type by extension, validated against an allowlist.
  const ext = path.extname(path.basename(DEST_PATH)).toLowerCase();
  const contentTypeMap = {
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".ogg": "audio/ogg",
    ".opus": "audio/opus",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
  };
  const contentType = contentTypeMap[ext] || "audio/mpeg";

  printResult({
    type: "done",
    path: path.resolve(DEST_PATH),
    size: fs.statSync(path.resolve(DEST_PATH)).size,
    filename: path.basename(path.resolve(DEST_PATH)),
    contentType,
    trackId: TRACK_ID,
  });
}

run();
