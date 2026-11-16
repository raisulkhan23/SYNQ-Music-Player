import { afterEach, describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const {
  NativeDownloadStore,
  detectAudioFormat,
  validateDownloadRequest,
  parseRange,
  handleMediaRequest,
} = require("../electron/downloads.cjs");

const MP3_BYTES = Buffer.concat([
  Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
  Buffer.alloc(2048, 0x55),
]);
const FLAC_BYTES = Buffer.concat([
  Buffer.from("fLaC", "latin1"),
  Buffer.alloc(1024, 0x33),
]);

const temporary = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synq-dl-test-"));
  temporary.push(dir);
  return dir;
}

function request(overrides = {}) {
  return {
    trackId: "jamendo:1234",
    downloadUrl: "https://example.test/granted/audio",
    filename: "Artist - Song.mp3",
    contentType: "audio/mpeg",
    provider: "jamendo",
    title: "Song",
    artist: "Artist",
    album: "Album",
    durationMs: 210_000,
    licenseUrl: "https://example.test/license",
    attribution: "Artist — Song",
    ...overrides,
  };
}

function fakeFetch(bytes, headers = {}) {
  return async () =>
    new Response(bytes, {
      status: 200,
      headers: {
        "content-type": "audio/mpeg",
        "content-length": String(bytes.length),
        ...headers,
      },
    });
}

async function waitFor(store, predicate, timeout = 4000) {
  const started = Date.now();
  for (;;) {
    const record = store.list()[0];
    if (record && predicate(record)) return record;
    if (Date.now() - started > timeout) {
      throw new Error(`Timed out; last state: ${JSON.stringify(record)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("Electron native download store", () => {
  test("downloads actual bytes, validates the container, and survives restart", async () => {
    const root = await tempDir();
    const store = new NativeDownloadStore({
      root,
      fetch: fakeFetch(MP3_BYTES),
      appVersion: "test",
    });
    await store.init();
    const started = await store.start(request());
    expect(started.record.trackId).toBe("jamendo:1234");
    const done = await waitFor(store, (record) => record.status === "completed");
    expect(done.format).toBe("mp3");
    expect(done.fileSize).toBe(MP3_BYTES.length);
    expect(done.filename).toEndWith(".mp3");
    const files = await fs.readdir(root);
    const audio = files.find((name) => name.endsWith(".mp3"));
    expect(audio).toBeTruthy();
    const onDisk = await fs.readFile(path.join(root, audio));
    expect(onDisk.subarray(0, 3).toString("latin1")).toBe("ID3");

    const playback = await store.getPlaybackUrl("jamendo:1234");
    expect(playback.url).toStartWith("synq-media://track/");

    const reopened = new NativeDownloadStore({
      root,
      fetch: fakeFetch(MP3_BYTES),
      appVersion: "test",
    });
    await reopened.init();
    const restored = reopened.list()[0];
    expect(restored.status).toBe("completed");
    expect(restored.trackId).toBe("jamendo:1234");
    expect(restored.fileSize).toBe(MP3_BYTES.length);

    const media = await handleMediaRequest(
      reopened,
      new Request("synq-media://track/jamendo%3A1234", {
        headers: { Range: "bytes=0-2" },
      }),
    );
    expect(media.status).toBe(206);
    expect(media.headers.get("content-range")).toBe(
      `bytes 0-2/${MP3_BYTES.length}`,
    );
    const first = Buffer.from(await media.arrayBuffer());
    expect(first.subarray(0, 3).toString("latin1")).toBe("ID3");

    expect(await reopened.remove(restored.id)).toEqual({ removed: true });
    expect(reopened.list()).toHaveLength(0);
    await expect(fs.stat(path.join(root, audio))).rejects.toThrow();
  });

  test("cancelling stops the transfer and leaves no partial file", async () => {
    const root = await tempDir();
    let pulls = 0;
    const store = new NativeDownloadStore({
      root,
      fetch: async (_url, init) => {
        const signal = init?.signal;
        return new Response(
          new ReadableStream({
            start(controller) {
              const timer = setInterval(() => {
                if (signal?.aborted) {
                  clearInterval(timer);
                  controller.error(new Error("aborted"));
                  return;
                }
                pulls += 1;
                controller.enqueue(Buffer.alloc(1024, 0x55));
              }, 10);
              signal?.addEventListener("abort", () => {
                clearInterval(timer);
                try {
                  controller.error(new Error("aborted"));
                } catch {
                  // already closed
                }
              });
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "audio/mpeg",
              "content-length": String(1024 * 1024 * 512),
            },
          },
        );
      },
      appVersion: "test",
    });
    await store.init();
    const { record } = await store.start(request());
    const moving = await waitFor(store, (row) => row.bytes > 0);
    expect(moving.status).toBe("downloading");
    await store.cancel(record.id);
    const stopped = await waitFor(store, (row) => row.status === "cancelled");
    expect(stopped.bytes).toBe(0);
    expect(pulls).toBeGreaterThan(0);
    const files = await fs.readdir(root);
    expect(files.filter((name) => name.endsWith(".part"))).toHaveLength(0);
  });

  test("extension follows real bytes, not the provider's filename", async () => {
    const root = await tempDir();
    const store = new NativeDownloadStore({
      root,
      fetch: fakeFetch(FLAC_BYTES, { "content-type": "audio/flac" }),
      appVersion: "test",
    });
    await store.init();
    await store.start(request({ filename: "Mislabelled.mp3" }));
    const done = await waitFor(store, (record) => record.status === "completed");
    expect(done.format).toBe("flac");
    expect(done.filename).toEndWith(".flac");
    expect(done.filename).not.toEndWith(".mp3");
  });

  test("an empty or non-audio response never becomes a completed download", async () => {
    const root = await tempDir();
    const store = new NativeDownloadStore({
      root,
      fetch: async () =>
        new Response("<html>not audio</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      appVersion: "test",
    });
    await store.init();
    await store.start(request());
    const failed = await waitFor(store, (record) => record.status === "failed");
    expect(failed.error).toContain("audio");
    expect(store.list()[0].status).toBe("failed");
    const files = await fs.readdir(root);
    expect(files.filter((name) => name.endsWith(".mp3"))).toHaveLength(0);
  });

  test("IPC validation rejects file paths, HTTP, bad providers and bad metadata", () => {
    expect(() =>
      validateDownloadRequest(request({ downloadUrl: "file:///etc/passwd" })),
    ).toThrow("HTTPS");
    expect(() =>
      validateDownloadRequest(request({ downloadUrl: "http://example.test/x" })),
    ).toThrow("HTTPS");
    expect(() =>
      validateDownloadRequest(request({ provider: "youtube" })),
    ).toThrow("provider");
    expect(() => validateDownloadRequest(request({ trackId: "../escape" }))).toThrow(
      "track id",
    );
    expect(() =>
      validateDownloadRequest(request({ contentType: "text/html" })),
    ).toThrow("audio");
    expect(() =>
      validateDownloadRequest(request({ attribution: "x".repeat(501) })),
    ).toThrow("attribution");
  });

  test("range parsing is bounded to the file", () => {
    expect(parseRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=100-", 100)).toEqual({ invalid: true });
    expect(parseRange("nonsense", 100)).toBeNull();
  });

  test("container detection handles MP3 frame sync as well as ID3", () => {
    expect(
      detectAudioFormat(
        Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0, 0, 0, 0, 0]),
      ),
    ).toBe("mp3");
    expect(
      detectAudioFormat(
        Buffer.from([0xff, 0xf1, 0x50, 0x80, 0, 0, 0, 0, 0, 0, 0, 0]),
      ),
    ).toBe("aac");
  });
});
