// ---------------------------------------------------------------------------
// SYNQ desktop download relay client (Electron main process).
//
// Used by the download helper to authenticate with the backend's download relay
// and obtain the explicitly authorized file URL for one release. This client
// does not download the audio itself — yt-dlp does that. This module only
// obtains and validates the URL yt-dlp is allowed to fetch.
// ---------------------------------------------------------------------------

"use strict";

const URL = globalThis.URL || require("node:url").URL;

const ALLOWED_SCHEMES = new Set(["https:"]);
const ALLOWED_EXTENSIONS = new Set([
  ".mp3",
  ".m4a",
  ".aac",
  ".ogg",
  ".opus",
  ".flac",
  ".wav",
]);

/**
 * Validate the shape of a relay response before it is used.
 */
function validateRelayResponse(body) {
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

  const ext = "." + (parsed.pathname.split(".").pop() || "").toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error("Invalid relay response: url is not a media file");
  }

  return body.url;
}

/**
 * Fetch the authorized file URL from the relay.
 *
 * This is deliberately minimal: it uses the global fetch available in the
// Electron Node version, and validates the response shape before returning.
 */
async function getAuthorizedUrl(relayUrl) {
  if (typeof relayUrl !== "string" || !relayUrl) {
    throw new Error("Missing relay URL");
  }

  let response;
  try {
    response = await globalThis.fetch(relayUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new Error(
      `Relay request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("Relay response is not JSON");
  }

  if (!response.ok) {
    throw new Error(
      `Relay rejected authorization: ${response.status} ${body?.message || response.statusText}`,
    );
  }

  const url = validateRelayResponse(body);
  return url;
}

module.exports = { getAuthorizedUrl, validateRelayResponse };
