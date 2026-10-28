/**
 * The OPFS sink, against a fake filesystem that behaves like the real one.
 *
 * The bug this file exists for is invisible in a memory sink: while a
 * `createWritable` stream is open, the browser stages data in a `.crswap` file
 * and the real entry keeps reporting its LAST CLOSED size. `bytesWritten()`
 * used to re-read the file, so a fresh download always reported 0 bytes, the
 * engine re-requested the first range forever, and the swap file grew without
 * bound. Browser-only behaviour, so the fake below reproduces exactly that
 * staging rule.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  listStoredDownloads,
  openStoredTrack,
  readDownloadedTracks,
  recordDownloadedTrack,
  removeDownloadedTrack,
} from "../src/lib/opfsSink";
import { createTrackAdapter } from "../src/lib/trackSource";
import { DownloadManager } from "../src/lib/downloadManager";

const SIZE = 200_000;
const SOURCE = new Uint8Array(SIZE);
for (let i = 0; i < SIZE; i += 1) SOURCE[i] = (i * 7) % 256;

/** A File-shaped view of a byte array, enough for `slice`/`arrayBuffer`. */
function fileOf(bytes) {
  return {
    size: bytes.length,
    lastModified: 1_700_000_000_000,
    slice(start, end) {
      const part = bytes.slice(start, end);
      return {
        size: part.length,
        async arrayBuffer() {
          return part.buffer.slice(
            part.byteOffset,
            part.byteOffset + part.byteLength,
          );
        },
      };
    },
    async text() {
      return new TextDecoder().decode(bytes);
    },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

function fakeOpfs() {
  const entries = new Map();

  const dir = {
    async getDirectoryHandle() {
      return dir;
    },
    async getFileHandle(name, opts = {}) {
      if (!entries.has(name)) {
        if (!opts.create) throw new Error(`NotFound: ${name}`);
        entries.set(name, new Uint8Array());
      }
      return {
        name,
        async getFile() {
          // The real entry: unchanged while a writer is staged, and gone once
          // the file has been promoted or removed.
          if (!entries.has(name)) throw new Error(`NotFound: ${name}`);
          return fileOf(entries.get(name));
        },
        async createWritable(options = {}) {
          let staged = options.keepExistingData
            ? new Uint8Array(entries.get(name))
            : new Uint8Array();
          let position = 0;
          return {
            async seek(next) {
              position = next;
            },
            async write(chunk) {
              // The real stream accepts strings too, which is how the manifest
              // is written.
              const data =
                typeof chunk === "string"
                  ? new TextEncoder().encode(chunk)
                  : chunk instanceof Uint8Array
                    ? chunk
                    : new Uint8Array(chunk);
              const needed = position + data.length;
              if (staged.length < needed) {
                const grown = new Uint8Array(needed);
                grown.set(staged);
                staged = grown;
              }
              staged.set(data, position);
              position += data.length;
            },
            async truncate(size) {
              staged = staged.slice(0, size);
            },
            async close() {
              entries.set(name, staged);
            },
            async abort() {},
          };
        },
      };
    },
    async removeEntry(name) {
      if (!entries.delete(name)) throw new Error(`NotFound: ${name}`);
    },
    async *entries() {
      for (const key of [...entries.keys()]) yield [key, { name: key }];
    },
  };

  return { dir, entries };
}

const realFetch = globalThis.fetch;
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const realWindow = globalThis.window;
let fs;
let rangeRequests = 0;

beforeAll(() => {
  fs = fakeOpfs();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { storage: { getDirectory: async () => fs.dir } },
  });
  // `createTrackAdapter` schedules its fetch timeouts on `window`.
  globalThis.window = { setTimeout, clearTimeout };
  globalThis.fetch = async (_url, init = {}) => {
    rangeRequests += 1;
    if (rangeRequests > 40) throw new Error("runaway range requests");
    const match = /^bytes=(\d+)-(\d*)$/.exec(init.headers?.Range ?? "");
    const start = Number(match?.[1] ?? 0);
    const end = match?.[2] ? Math.min(Number(match[2]), SIZE - 1) : SIZE - 1;
    const body = SOURCE.slice(start, end + 1);
    return new Response(body, {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${SIZE}`,
        "Content-Length": String(body.length),
        "Accept-Ranges": "bytes",
      },
    });
  };
});

afterAll(() => {
  globalThis.fetch = realFetch;
  globalThis.window = realWindow;
  if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
});

function managerFor(trackId, filename, meta) {
  return new DownloadManager({ chunkSize: 64 * 1024, timeoutMs: 5_000 }, () =>
    createTrackAdapter("https://relay.test/download-proxy?track=1", filename, trackId, meta),
  );
}

const META = {
  title: "Verified Song",
  artistName: "Test Artist",
  albumName: "Album",
  coverUrl: "",
  duration: 210,
  providerId: "1",
  licenseUrl: "http://creativecommons.org/licenses/by/4.0/",
  attribution: "Test Artist — Verified Song",
  contentType: "audio/mpeg",
};

describe("a real transfer through the OPFS sink", () => {
  test("finishes instead of re-requesting the first range forever", async () => {
    rangeRequests = 0;
    const m = managerFor("track-a", "Test Artist - Verified Song.mp3", META);
    const record = m.enqueue({
      trackId: "track-a",
      filename: "Test Artist - Verified Song.mp3",
    });
    await record.whenSettled();

    const after = m.get(record.id);
    expect(after.error ?? "").toBe("");
    expect(after.status).toBe("completed");
    expect(after.downloadedBytes).toBe(SIZE);
    // A sane number of ranged requests: one probe plus one per 64 KiB chunk.
    expect(rangeRequests).toBeLessThan(10);
  });

  test("the committed file is the audio, and no partial is left behind", async () => {
    const names = [...fs.entries.keys()];
    expect(names).toContain("track-a__Test Artist - Verified Song.mp3");
    for (const name of names) {
      expect(name.endsWith(".part")).toBe(false);
      expect(name.endsWith(".crswap")).toBe(false);
    }
    const file = await openStoredTrack("track-a");
    expect(file.size).toBe(SIZE);
    const bytes = new Uint8Array(await file.arrayBuffer());
    expect(bytes[0]).toBe(SOURCE[0]);
    expect(bytes[SIZE - 1]).toBe(SOURCE[SIZE - 1]);

    const listed = await listStoredDownloads();
    expect(listed.map((f) => f.name)).toContain(
      "track-a__Test Artist - Verified Song.mp3",
    );
  });

  test("the manifest describes the finished file", async () => {
    const library = await readDownloadedTracks();
    const entry = library.find((t) => t.id === "track-a");
    expect(entry).toBeDefined();
    expect(entry.size).toBe(SIZE);
    expect(entry.title).toBe("Verified Song");
    expect(entry.artistName).toBe("Test Artist");
    expect(entry.contentType).toBe("audio/mpeg");
    expect(entry.licenseUrl).toContain("creativecommons.org");
  });

  test("re-downloading replaces the previous copy", async () => {
    const m = managerFor("track-a", "Test Artist - Verified Song.mp3", META);
    const record = m.enqueue({
      trackId: "track-a",
      filename: "Test Artist - Verified Song.mp3",
      force: true,
    });
    await record.whenSettled();
    expect(m.get(record.id).status).toBe("completed");

    const library = await readDownloadedTracks();
    expect(library.filter((t) => t.id === "track-a")).toHaveLength(1);
    const file = await openStoredTrack("track-a");
    expect(file.size).toBe(SIZE);
  });

  test("removing deletes the audio and the library row together", async () => {
    expect(await removeDownloadedTrack("track-a")).toBe(true);
    expect(await openStoredTrack("track-a")).toBeNull();
    const library = await readDownloadedTracks();
    expect(library.find((t) => t.id === "track-a")).toBeUndefined();
  });

  test("a leftover swap file is never listed as saved music", async () => {
    fs.entries.set("track-b__Half Done.mp3.part.crswap", new Uint8Array(4096));
    const listed = await listStoredDownloads();
    expect(listed.map((f) => f.name)).not.toContain(
      "track-b__Half Done.mp3.part.crswap",
    );
    // ...and removing the track cleans the swap file too, not just the row.
    await removeDownloadedTrack("track-b");
    expect([...fs.entries.keys()]).not.toContain(
      "track-b__Half Done.mp3.part.crswap",
    );
  });

  test("a refused probe is a refusal, not a stream of the error page", async () => {
    const adapter = createTrackAdapter(
      "https://relay.test/download-proxy?track=2",
      "Denied.mp3",
      "track-denied",
      META,
    );
    const saved = globalThis.fetch;
    globalThis.fetch = async () => new Response("no", { status: 403 });
    try {
      const probe = await adapter.probe(1_000);
      // Masking a 403 as "206 with no window" made the engine stream the
      // error body and mark it complete.
      expect(probe.status).toBe(403);
      expect(probe.acceptRanges).toBe(false);
    } finally {
      globalThis.fetch = saved;
    }
  });

  test("a corrupt manifest is ignored rather than invented around", async () => {
    fs.entries.set("synq-downloads.json", new TextEncoder().encode("{not json"));
    expect(await readDownloadedTracks()).toEqual([]);
    // Writing a fresh row repairs it.
    await recordDownloadedTrack({
      id: "track-c",
      filename: "C.mp3",
      size: 3,
      completedAt: Date.now(),
      ...META,
    });
    const library = await readDownloadedTracks();
    expect(library.map((t) => t.id)).toEqual(["track-c"]);
  });
});
