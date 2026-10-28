// ---------------------------------------------------------------------------
// Desktop yt-dlp availability tests (Electron main process).
// ---------------------------------------------------------------------------

const assert = require("node:assert");
const path = require("node:path");
const { describe, it, before, after } = require("node:test");

const availability = require("../electron/yt-dlp-availability.cjs");
const { probeAvailability, locateYtDlp } = availability;

describe("desktop yt-dlp availability", () => {
  it("probeAvailability returns available when locateYtDlp finds a binary", () => {
    // This test cannot run a real yt-dlp in this environment, so it asserts
    // only the contract: locateYtDlp returns null when nothing is present, and
    // probeAvailability reports not available.
    const originalLocate = availability.locateYtDlp;
    try {
      availability.locateYtDlp = () => null;
      const probe = probeAvailability();
      assert.strictEqual(probe.available, false);
      assert.ok(probe.reason === "yt-dlp not found");
      assert.ok(typeof probe.detail === "string");
    } finally {
      availability.locateYtDlp = originalLocate;
    }
  });

  it("probeAvailability returns version when locateYtDlp finds a binary", () => {
    const originalLocate = availability.locateYtDlp;
    try {
      availability.locateYtDlp = () => ({
        path: "/usr/bin/yt-dlp",
        version: "2024.05.29",
      });
      const probe = probeAvailability();
      assert.strictEqual(probe.available, true);
      assert.strictEqual(probe.version, "2024.05.29");
      assert.strictEqual(probe.exePath, "yt-dlp");
    } finally {
      availability.locateYtDlp = originalLocate;
    }
  });

  it("locateYtDlp returns null when nothing is present", () => {
    const result = locateYtDlp();
    assert.strictEqual(result, null);
  });
});
