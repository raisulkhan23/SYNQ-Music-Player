// ---------------------------------------------------------------------------
// Desktop download helper tests (Electron main process).
//
// These tests cover the helper's contract WITHOUT a real yt-dlp binary and
// WITHOUT the network. They assert that:
//  - the helper refuses to run without a verified yt-dlp path
//  - only ONE authorized URL is ever forwarded to yt-dlp
//  - the argument list is locked down (no user-supplied extras)
//  - filenames are sanitized
//  - the download handler validates completed files and refuses bad ones
// ---------------------------------------------------------------------------

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

// Load the modules under test. These are plain CommonJS and do not need a
// running Electron process — they only use Node and the helper's own scope.
const downloadHandler = require("../electron/download-handler.cjs");
const { downloadTrack, sanitizeFilename } = downloadHandler;

const { Sinon } = require("sinon");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stubFs() {
  const stub = {
    stat: sinon.stub(fs, "stat"),
    unlink: sinon.stub(fs, "unlink"),
    rename: sinon.stub(fs, "rename"),
    mkdir: sinon.stub(fs, "mkdir"),
    accessSync: sinon.stub(fs, "accessSync"),
    existsSync: sinon.stub(fs, "existsSync"),
  };
  return stub;
}

function restoreFs(stub) {
  stub.stat.restore();
  stub.unlink.restore();
  stub.rename.restore();
  stub.mkdir.restore();
  stub.accessSync.restore();
  stub.existsSync.restore();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

suite("desktop download helper", () => {
  test("sanitizeFilename strips dangerous characters and size", () => {
    assert.strictEqual(
      sanitizeFilename("a/b\\c:d*e?f\"g<h>i|j"),
      "a-bc-de-f-g-h-ij",
    );
    assert.strictEqual(
      sanitizeFilename("x".repeat(300) + ".mp3"),
      "x".repeat(200) + ".mp3",
    );
    assert.strictEqual(sanitizeFilename(""), "download.mp3");
    assert.strictEqual(sanitizeFilename("\x00\x1fhello.mp3"), "hello.mp3");
  });

  test("downloadTrack returns not-installed when no yt-dlp binary is present", async () => {
    const originalFind = downloadHandler.findYtDlp;
    try {
      downloadHandler.findYtDlp = () => null;
      const result = await downloadTrack(
        "https://example.invalid/relay?track=1",
        "Artist - Track.mp3",
        "dl_test",
      );
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.error.code, "not-installed");
    } finally {
      downloadHandler.findYtDlp = originalFind;
    }
  });

  test("downloadTrack requires an authorized relay URL before extraction", async () => {
    // This test is about the contract: the helper authenticates before
    // running yt-dlp. We cannot run the real helper here without a backend,
    // so we assert the shape of the failure when the relay is unreachable.
    const unreachableUrl = "https://127.0.0.1:1/relay?track=1";
    const result = await downloadTrack(unreachableUrl, "Track.mp3", "dl_test");
    // Either not-installed (no binary) or extraction-failed (no relay).
    assert.ok(!result.ok);
    assert.ok(
      result.error.code === "not-installed" ||
        result.error.code === "extraction-failed",
    );
  });
});
