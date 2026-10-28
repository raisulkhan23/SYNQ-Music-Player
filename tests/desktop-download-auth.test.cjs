// ---------------------------------------------------------------------------
// Desktop download auth tests (Electron main process).
// ---------------------------------------------------------------------------

const assert = require("node:assert");
const { describe, it } = require("node:test");
const downloadAuth = require("../electron/download-auth.cjs");

describe("desktop download auth", () => {
  it("returns the url when the relay response is valid", () => {
    const url = downloadAuth.validateAuthResponse({
      url: "https://storage.synq.demo/audio/licensed.mp3",
      size: 12345,
    });
    assert.strictEqual(url, "https://storage.synq.demo/audio/licensed.mp3");
  });

  it("rejects non-https urls", () => {
    assert.throws(
      () => downloadAuth.validateAuthResponse({ url: "http://storage.synq.demo/audio/licensed.mp3" }),
      { message: /not https/ },
    );
  });

  it("rejects non-media urls", () => {
    assert.throws(
      () => downloadAuth.validateAuthResponse({ url: "https://storage.synq.demo/file.txt" }),
      { message: /not a media file/ },
    );
  });

  it("rejects a missing body", () => {
    assert.throws(
      () => downloadAuth.validateAuthResponse(null),
      { message: /Invalid relay response/ },
    );
  });

  it("sanitizeMetadataFilename returns null for bad input", () => {
    assert.strictEqual(downloadAuth.sanitizeMetadataFilename(null), null);
    assert.strictEqual(downloadAuth.sanitizeMetadataFilename(undefined), null);
    assert.strictEqual(downloadAuth.sanitizeMetadataFilename(""), null);
    assert.strictEqual(downloadAuth.sanitizeMetadataFilename(" \t\n\r"), null);
  });

  it("sanitizeMetadataFilename strips traversal chars", () => {
    const cleaned = downloadAuth.sanitizeMetadataFilename('a/b\\c:"<>%?*d');
    assert.strictEqual(cleaned, "a-bc-d");
  });

  it("sanitizeMetadataFilename caps length", () => {
    const cleaned = downloadAuth.sanitizeMetadataFilename("x".repeat(300));
    assert.strictEqual(cleaned.length, 180);
  });
});
