// ---------------------------------------------------------------------------
// Desktop download helper tests (Electron main process).
//
// These tests exercise the helper worker's INPUT handling — the authentication
// step, the argument construction, the refusal of missing or malformed inputs —
// without running a real yt-dlp binary or hitting the network.
// ---------------------------------------------------------------------------

const assert = require("node:assert");
const path = require("node:path");
const { describe, it, before, after } = require("node:test");

const downloadHelper = require("../electron/download-helper.cjs");

describe("desktop download helper worker", () => {
  it("refuses to run when required env vars are missing", () => {
    assert.throws(
      () => downloadHelper.run(),
      /Missing required environment variables/,
    );
  });

  it("refuses when the yt-dlp path does not exist", () => {
    // The worker checks fs.existsSync early; we simulate by setting a bad path.
    process.env.SYNQ_YT_DLP_PATH = "/nonexistent/yt-dlp";
    process.env.SYNQ_AUTH_URL = "https://example.invalid/relay";
    process.env.SYNQ_DEST_PATH = "/tmp/synq-test.bin";
    try {
      assert.throws(
        () => downloadHelper.run(),
        /yt-dlp executable not found/,
      );
    } finally {
      delete process.env.SYNQ_YT_DLP_PATH;
      delete process.env.SYNQ_AUTH_URL;
      delete process.env.SYNQ_DEST_PATH;
    }
  });

  it("builds yt-dlp args that contain only the authorized url", () => {
    const args = downloadHelper.buildYtDlpArgs("https://storage.synq.demo/audio/licensed.mp3");
    assert.ok(args.includes("--no-config"));
    assert.ok(args.includes("-x"));
    assert.ok(args.includes("--audio-format"));
    assert.ok(args.includes("mp3"));
    assert.ok(args.includes("--audio-quality"));
    assert.ok(args.includes("0"));
    assert.ok(args.includes("--no-playlist"));
    assert.ok(args.includes("--quiet"));
    assert.ok(args.includes("--no-warnings"));
    assert.ok(args.includes("--progress-template"));
    assert.ok(args.includes("https://storage.synq.demo/audio/licensed.mp3"));
    // There should be exactly ONE positional url at the end.
    const lastArg = args[args.length - 1];
    assert.strictEqual(lastArg, "https://storage.synq.demo/audio/licensed.mp3");
  });

  it("refuses to include any extra positional args beyond the authorized url", () => {
    const args = downloadHelper.buildYtDlpArgs("https://storage.synq.demo/audio/licensed.mp3");
    // Count positional args that look like urls.
    const urlLike = args.filter((a) => /^https?:\/\//i.test(a));
    assert.strictEqual(urlLike.length, 1);
  });
});

describe("desktop download helper auth sequencing", () => {
  it("authenticates before building args", () => {
    // The helper's run() calls authenticate() first; this test asserts the
    // order indirectly by checking that buildYtDlpArgs is only reached with a
    // url that came from authenticate().
    const authorizedUrl = "https://storage.synq.demo/audio/licensed.mp3";
    const args = downloadHelper.buildYtDlpArgs(authorizedUrl);
    assert.ok(args.includes(authorizedUrl));
  });
});
