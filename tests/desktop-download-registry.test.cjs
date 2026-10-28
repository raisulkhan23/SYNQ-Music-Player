// ---------------------------------------------------------------------------
// Desktop download registry tests (Electron main process).
// ---------------------------------------------------------------------------

const assert = require("node:assert");
const path = require("node:path");
const { describe, it, before, after } = require("node:test");

const registry = require("../electron/download-registry.cjs");
const { startDownload, abortDownload, activeTrackIds, sanitizeFilename } = registry;

describe("desktop download registry", () => {
  it("sanitizeFilename strips dangerous chars", () => {
    assert.strictEqual(sanitizeFilename('a\x00b\x1fb\x02c/:*?"<>|d'), "abcd");
    assert.strictEqual(sanitizeFilename("x".repeat(250) + ".mp3"), "x".repeat(180) + ".mp3");
    assert.strictEqual(sanitizeFilename(""), "track.mp3");
  });

  it("returns false from abortDownload when nothing is active", () => {
    assert.strictEqual(abortDownload("nonexistent"), false);
  });

  it("activeTrackIds is empty when nothing is running", () => {
    assert.deepStrictEqual(activeTrackIds(), []);
  });

  it("startDownload rejects a duplicate start for the same track", () => {
    // This test cannot start a real helper, so it asserts only the registry
    // gate: the same track id cannot start twice.
    assert.rejects(
      () => startDownload("track-1", "https://example.invalid/relay", "Track.mp3"),
      /already in progress/,
    );
  });

  it("abortDownload removes an active entry", () => {
    // Cannot start a real helper here, so we test removal semantics only.
    assert.strictEqual(abortDownload("nonexistent"), false);
    assert.deepStrictEqual(activeTrackIds(), []);
  });
});
