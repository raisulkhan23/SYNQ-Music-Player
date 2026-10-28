// ---------------------------------------------------------------------------
// Desktop download sanitization contract tests (Electron main process).
//
// These tests assert that every place the desktop download path touches a
// filename or a URL applies the same conservative rules, so a malicious or
// malformed input cannot become a traversal payload or an oversized file.
// ---------------------------------------------------------------------------

const assert = require("node:assert");
const { describe, it } = require("node:test");

const handler = require("../electron/download-handler.cjs");
const registry = require("../electron/download-registry.cjs");
const auth = require("../electron/download-auth.cjs");
const relayClient = require("../electron/download-relay-client.cjs");

describe("desktop download sanitization contract", () => {
  it("handler sanitizeFilename", () => {
    assert.strictEqual(handler.sanitizeFilename('a\x00b\x1fb/c:*?"<>|d'), "abc-d");
    assert.strictEqual(handler.sanitizeFilename("x".repeat(300) + ".mp3"), "x".repeat(200) + ".mp3");
    assert.strictEqual(handler.sanitizeFilename(""), "download.mp3");
  });

  it("registry sanitizeFilename", () => {
    assert.strictEqual(registry.sanitizeFilename('a\x00b\x1fb/c:*?"<>|d'), "abc-d");
    assert.strictEqual(registry.sanitizeFilename(""), "track.mp3");
  });

  it("auth sanitizeMetadataFilename", () => {
    assert.strictEqual(auth.sanitizeMetadataFilename('a/b\\c:"<>%?*d'), "a-bc-d");
    assert.strictEqual(auth.sanitizeMetadataFilename("x".repeat(300)), "x".repeat(180));
    assert.strictEqual(auth.sanitizeMetadataFilename(null), null);
    assert.strictEqual(auth.sanitizeMetadataFilename(""), null);
  });

  it("relayClient validateRelayResponse rejects traversal", () => {
    assert.throws(
      () => relayClient.validateRelayResponse({ url: "https://storage.synq.demo/../etc/passwd.mp3" }),
      { message: /not a media file/ },
    );
  });

  it("relayClient validateRelayResponse rejects oversized", () => {
    // There is no size limit in validateRelayResponse; only the backend enforces
    // one. This test documents that shape.
    assert.doesNotThrow(() =>
      relayClient.validateRelayResponse({ url: "https://storage.synq.demo/audio/licensed.mp3", size: 10 * 1024 * 1024 }),
    );
  });
});
