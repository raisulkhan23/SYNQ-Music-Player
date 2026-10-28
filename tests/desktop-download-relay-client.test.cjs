// ---------------------------------------------------------------------------
// Desktop download relay client tests (Electron main process).
// ---------------------------------------------------------------------------

const assert = require("node:assert");
const { describe, it } = require("node:test");
const { validateRelayResponse } = require("../electron/download-relay-client.cjs");

describe("desktop download relay client", () => {
  it("accepts a valid https audio url", () => {
    const url = validateRelayResponse({
      url: "https://storage.synq.demo/audio/licensed.mp3",
      size: 12345,
    });
    assert.ok(url.startsWith("https://"));
  });

  it("rejects http urls", () => {
    assert.throws(
      () => validateRelayResponse({ url: "http://storage.synq.demo/audio/licensed.mp3" }),
      { message: /not https/ },
    );
  });

  it("rejects non-audio urls", () => {
    assert.throws(
      () => validateRelayResponse({ url: "https://storage.synq.demo/file.txt" }),
      { message: /not a media file/ },
    );
  });

  it("rejects missing body", () => {
    assert.throws(
      () => validateRelayResponse(null),
      { message: /Invalid relay response/ },
    );
  });

  it("rejects missing url", () => {
    assert.throws(
      () => validateRelayResponse({}),
      { message: /missing url/ },
    );
  });
});
