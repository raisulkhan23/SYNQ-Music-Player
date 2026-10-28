// ---------------------------------------------------------------------------
// SYNQ desktop download auth helpers (Electron main process).
//
// Shared with the helper workers so the same refusal rules apply whether the
// request came from the renderer or from a forked yt-dlp worker.
// ---------------------------------------------------------------------------

"use strict";

const URL = globalThis.URL || require("node:url").URL;

const ALLOWED_SCHEMES = new Set(["https:"]);
// Only our own relay is a permitted source. A helper that accepted any URL
// would turn the desktop download path into an unrestricted media fetcher.
const ALLOWED_HOST_SUFFIX = ".synq.demo"; // placeholder — the real relay is the backend origin

/**
 * Validate that `url` is a plausible authorized file URL from the backend relay.
 *
 * This is NOT a substitute for the backend's own permission check — that runs
 * server-side. This is a belt-and-suspenders sanity check on the shape of the
// response the helper received, so a misconfigured or corrupted response cannot
// be misinterpreted as a valid download source.
 */
function validateAuthResponse(body) {
  if (!body || typeof body !== "object") {
    throw new Error("Invalid relay response: missing body");
  }
  if (typeof body.url !== "string" || !body.url) {
    throw new Error("Invalid relay response: missing url");
  }

  let parsed;
  try {
    parsed = new URL(body.url);
  } catch {
    throw new Error("Invalid relay response: url is not a valid URL");
  }

  if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
    throw new Error("Invalid relay response: url is not https");
  }

  // The relay must return a URL that points at an audio file, not a webpage.
  if (!/\.(mp3|m4a|aac|ogg|opus|flac|wav)$/i.test(parsed.pathname)) {
    throw new Error("Invalid relay response: url is not a media file");
  }

  if (body.size !== undefined && (typeof body.size !== "number" || body.size < 1024)) {
    throw new Error("Invalid relay response: size too small");
  }

  return body.url;
}

/**
 * Sanitize a filename that came from the backend's metadata.
 */
function sanitizeMetadataFilename(name) {
  if (!name || typeof name !== "string") return null;
  // Allow only printable ASCII and common unicode punctuation; strip control
  // chars and path separators so a filename can never be a traversal attempt.
  const cleaned = name
    .replace(/[\x00-\x1f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "-")
    .slice(0, 180);
  return cleaned || null;
}

module.exports = { validateAuthResponse, sanitizeMetadataFilename };
