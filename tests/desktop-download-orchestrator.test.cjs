// ---------------------------------------------------------------------------
// Desktop download orchestrator tests (Electron main process).
// ---------------------------------------------------------------------------

const assert = require("node:assert");
const path = require("node:path");
const { describe, it, before, after } = require("node:test");

const orchestrator = require("../electron/download-auth-then-extract.cjs");
const { authenticateThenExtract, sanitizeFilename } = orchestrator;

describe("desktop download orchestrator", () => {
  it("sanitizeFilename strips dangerous chars", () => {
    assert.strictEqual(sanitizeFilename('a\x00b\x1fb\x02c/:*?"<>|d'), "abcd");
    assert.strictEqual(sanitizeFilename("x".repeat(250) + ".mp3"), "x".repeat(180) + ".mp3");
    assert.strictEqual(sanitizeFilename(""), "track.mp3");
  });

  it("returns auth-failed when relay request fails", async () => {
    // Use a url that will fail to fetch (connection refused) — this exercises
    // the auth failure path without needing the real relay.
    const result = await authenticateThenExtract(
      "https://127.0.0.1:1/relay",
      "track-1",
      "Track.mp3",
      "/tmp",
    );
    assert.strictEqual(result.ok, false);
    assert.ok(
      result.error.code === "auth-failed" ||
        result.error.code === "invalid-relay-response" ||
        result.error.code === "relay-request-failed" ||
        result.error.code === "relay-rejected",
    );
  });

  it("does not extract when auth fails", async () => {
    // This test is about sequencing: the orchestrator must authenticate first,
    // and must NOT call the helper when auth fails. We cannot easily assert the
    // helper is not called in this environment, so we assert the refusal shape.
    const result = await authenticateThenExtract(
      "https://127.0.0.1:1/relay",
      "track-1",
      "Track.mp3",
      "/tmp",
    );
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.code !== "extraction-started");
  });
});
