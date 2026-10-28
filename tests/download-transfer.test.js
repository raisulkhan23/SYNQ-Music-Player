/**
 * The download ENGINE against a real HTTP server.
 *
 * The engine is provider-agnostic: it is handed an adapter and a sink. Testing
 * it here with a controlled origin (real sockets, real Range handling, real
 * interruptions) and an in-memory sink proves the parts that matter without
 * pretending OPFS exists in Bun: bytes land exactly once, in order, and a
 * transfer that did not finish is never reported as finished.
 *
 * The adapter below mirrors `createTrackAdapter`'s mechanics (ranged GETs, a
 * range probe, a whole-body fallback) without the OPFS dependency.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  DownloadManager,
  DownloadError,
  nextChunk,
  validateContentRange,
} from "../src/lib/downloadManager";

const SIZE = 256 * 1024;
const SOURCE = new Uint8Array(SIZE);
for (let i = 0; i < SIZE; i += 1) SOURCE[i] = i % 251;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/ignore-range") {
      return new Response(SOURCE, {
        status: 200,
        headers: { "Content-Length": String(SIZE) },
      });
    }
    if (url.pathname === "/abort") {
      // A correct 206 window that dies part-way through the requested bytes.
      const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.get("range") ?? "");
      const start = Number(match?.[1] ?? 0);
      const end = Number(match?.[2] ?? SIZE - 1);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(SOURCE.slice(start, start + 512));
          controller.error(new Error("connection reset"));
        },
      });
      return new Response(stream, {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end}/${SIZE}`,
          "Content-Length": String(end - start + 1),
          "Accept-Ranges": "bytes",
        },
      });
    }
    if (url.pathname === "/refused-range") {
      return new Response("no", { status: 403 });
    }
    if (url.pathname === "/wrong-range") {
      return new Response(SOURCE.slice(0, 512), {
        status: 206,
        headers: {
          "Content-Range": `bytes 0-511/${SIZE}`,
          "Content-Length": "512",
        },
      });
    }
    if (url.pathname === "/slow") {
      const stream = new ReadableStream({
        async start(controller) {
          for (let at = 0; at < SIZE; at += 4096) {
            await Bun.sleep(15);
            controller.enqueue(SOURCE.slice(at, at + 4096));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Length": String(SIZE) },
      });
    }

    const range = req.headers.get("range");
    if (!range) {
      return new Response(SOURCE, {
        status: 200,
        headers: { "Content-Length": String(SIZE), "Accept-Ranges": "bytes" },
      });
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    const start = Number(match[1]);
    const end = match[2] ? Math.min(Number(match[2]), SIZE - 1) : SIZE - 1;
    const body = SOURCE.slice(start, end + 1);
    return new Response(body, {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${SIZE}`,
        "Content-Length": String(body.length),
        "Accept-Ranges": "bytes",
      },
    });
  },
});

afterAll(() => {
  server.stop(true);
});

const url = (path) => `${server.url}${path.replace(/^\//, "")}`;

function memorySink(initial = new Uint8Array()) {
  let data = initial;
  const state = { committed: false, discarded: false, removed: false };
  const sink = {
    bytesWritten: async () => data.length,
    append: async (chunk) => {
      const next = new Uint8Array(data.length + chunk.length);
      next.set(data, 0);
      next.set(chunk, data.length);
      data = next;
    },
    truncate: async (to) => {
      data = data.slice(0, to);
    },
    commit: async () => {
      state.committed = true;
    },
    discardIncomplete: async () => {
      state.discarded = true;
    },
  };
  return { sink, state, bytes: () => data };
}

function adapterFor(endpoint, sink, state) {
  return {
    probe: async () => {
      const res = await fetch(endpoint, { headers: { Range: "bytes=0-0" } });
      if (res.status !== 206) {
        // Mirrors the production adapter: a refused probe is a REFUSAL, not a
        // 206 with no window.
        return {
          status: res.status,
          contentLength: Number(res.headers.get("content-length")) || null,
          acceptRanges: false,
        };
      }
      const total = res.headers.get("content-range")?.split("/")[1];
      return {
        status: 206,
        contentLength: total && total !== "*" ? Number(total) : null,
        acceptRanges: true,
      };
    },
    openRange: async (segment, _timeoutMs, signal) => {
      const res = await fetch(endpoint, {
        headers: { Range: `bytes=${segment.start}-${segment.end - 1}` },
        signal,
      });
      return { status: res.status, headers: res.headers, body: res.body };
    },
    openStream: async (_timeoutMs, signal) => {
      const res = await fetch(endpoint, { signal });
      return { status: res.status, headers: res.headers, body: res.body };
    },
    sink,
    removeStored: async () => {
      state.removed = true;
    },
  };
}

async function waitFor(fn, predicate, timeoutMs = 8_000) {
  const started = Date.now();
  for (;;) {
    const value = fn();
    if (predicate(value)) return value;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out; last value ${JSON.stringify(fn())}`);
    }
    await Bun.sleep(10);
  }
}

const manager = (endpoint, sink, state, config = {}) =>
  new DownloadManager(
    { chunkSize: 64 * 1024, timeoutMs: 10_000, maxConcurrentRanges: 2, ...config },
    () => adapterFor(endpoint, sink, state),
  );

describe("a complete transfer", () => {
  test("writes every byte once and commits", async () => {
    const memory = memorySink();
    const m = manager(url("/audio"), memory.sink, memory.state);
    const record = m.enqueue({ trackId: "t1", filename: "one.mp3" });
    await record.whenSettled();

    const after = m.get(record.id);
    expect(after.status).toBe("completed");
    expect(after.downloadedBytes).toBe(SIZE);
    expect(after.totalSize).toBe(SIZE);
    expect(after.progress).toBe(100);
    expect(memory.state.committed).toBe(true);
    expect(memory.state.discarded).toBe(false);
    expect(memory.bytes()).toEqual(SOURCE);
  });

  test("resumes from the bytes already on disk", async () => {
    const memory = memorySink(SOURCE.slice(0, 64 * 1024));
    const m = manager(url("/audio"), memory.sink, memory.state);
    const record = m.enqueue({ trackId: "t2", filename: "two.mp3" });
    await record.whenSettled();

    expect(m.get(record.id).status).toBe("completed");
    expect(memory.bytes()).toEqual(SOURCE);
  });

  test("ignores ranges without duplicating the file", async () => {
    const memory = memorySink();
    const m = manager(url("/ignore-range"), memory.sink, memory.state);
    const record = m.enqueue({ trackId: "t3", filename: "three.mp3" });
    await record.whenSettled();

    const after = m.get(record.id);
    expect(after.status).toBe("completed");
    expect(after.usedStreamingFallback).toBe(true);
    expect(memory.bytes()).toEqual(SOURCE);
  });

  test("a duplicate request is the same transfer", async () => {
    const memory = memorySink();
    const m = manager(url("/audio"), memory.sink, memory.state);
    const first = m.enqueue({ trackId: "t4", filename: "four.mp3" });
    const second = m.enqueue({ trackId: "t4", filename: "four.mp3" });
    expect(second.id).toBe(first.id);
    await first.whenSettled();
    expect(m.list().filter((r) => r.trackId === "t4")).toHaveLength(1);
    expect(memory.bytes()).toEqual(SOURCE);
  });
});

describe("a transfer that cannot be trusted", () => {
  test("a lying Content-Range fails and discards the partial", async () => {
    const memory = memorySink();
    const m = manager(url("/wrong-range"), memory.sink, memory.state);
    const record = m.enqueue({ trackId: "b1", filename: "bad.mp3" });
    await record.whenSettled();

    const after = m.get(record.id);
    expect(after.status).toBe("failed");
    expect(after.error).toContain("Content-Range");
    expect(memory.state.committed).toBe(false);
    expect(memory.state.discarded).toBe(true);
  });

  test("a refused range names the HTTP status instead of blaming the range", async () => {
    const memory = memorySink();
    const m = manager(url("/refused-range"), memory.sink, memory.state);
    const record = m.enqueue({ trackId: "b5", filename: "refused.mp3" });
    await record.whenSettled();
    const after = m.get(record.id);
    expect(after.status).toBe("failed");
    expect(after.error).toContain("403");
    expect(after.error).not.toContain("Content-Range");
    expect(memory.state.committed).toBe(false);
  });

  test("a dropped connection fails honestly and is not marked done", async () => {
    const memory = memorySink();
    const m = manager(url("/abort"), memory.sink, memory.state);
    const record = m.enqueue({ trackId: "b2", filename: "dropped.mp3" });
    await record.whenSettled();

    expect(m.get(record.id).status).toBe("failed");
    expect(memory.state.committed).toBe(false);
    expect(m.get(record.id).progress).toBeLessThan(100);
  });

  test("an oversize file is refused before it is written", async () => {
    const memory = memorySink();
    const m = manager(url("/audio"), memory.sink, memory.state, {
      maxFileSize: 1024,
    });
    const record = m.enqueue({ trackId: "b3", filename: "big.mp3" });
    await record.whenSettled();

    const after = m.get(record.id);
    expect(after.status).toBe("failed");
    expect(after.error).toContain("over");
    expect(memory.state.committed).toBe(false);
  });

  test("a factory that refuses fails the record instead of hanging", async () => {
    const m = new DownloadManager({}, () => {
      throw new Error("This browser has no filesystem");
    });
    const record = m.enqueue({ trackId: "b4", filename: "x.mp3" });
    await record.whenSettled();
    const after = m.get(record.id);
    expect(after.status).toBe("failed");
    expect(after.error).toContain("filesystem");
  });
});

describe("pausing, cancelling and removing", () => {
  test("a paused transfer keeps its partial and completes on retry", async () => {
    const memory = memorySink();
    const m = manager(url("/slow"), memory.sink, memory.state);
    const record = m.enqueue({ trackId: "c1", filename: "slow.mp3" });
    await waitFor(
      () => m.get(record.id).status,
      (status) => status === "downloading",
    );
    m.pause(record.id);
    await record.whenSettled();
    expect(m.get(record.id).status).toBe("paused");
    expect(memory.state.committed).toBe(false);

    m.retry(record.id);
    await waitFor(
      () => m.get(record.id).status,
      (status) => status === "completed" || status === "failed",
    );
    expect(m.get(record.id).status).toBe("completed");
    expect(memory.bytes()).toEqual(SOURCE);
  });

  test("a cancelled transfer is not committed", async () => {
    const memory = memorySink();
    const m = manager(url("/slow"), memory.sink, memory.state);
    const record = m.enqueue({ trackId: "c2", filename: "cancel.mp3" });
    await waitFor(
      () => m.get(record.id).status,
      (status) => status === "downloading",
    );
    m.cancel(record.id);
    await record.whenSettled();
    expect(m.get(record.id).status).toBe("cancelled");
    expect(memory.state.committed).toBe(false);
  });

  test("removing deletes the stored file, not just the row", async () => {
    const memory = memorySink();
    const m = manager(url("/audio"), memory.sink, memory.state);
    const record = m.enqueue({ trackId: "c3", filename: "gone.mp3" });
    await record.whenSettled();
    expect(m.get(record.id).status).toBe("completed");

    expect(await m.remove(record.id)).toBe(true);
    expect(memory.state.removed).toBe(true);
    expect(m.get(record.id)).toBeNull();
    // The track can be downloaded again afterwards.
    const again = m.enqueue({ trackId: "c3", filename: "gone.mp3" });
    expect(again.id).not.toBe(record.id);
    await again.whenSettled();
    expect(m.get(again.id).status).toBe("completed");
  });
});

describe("the pure range helpers", () => {
  test("nextChunk resumes inside a partially written segment", () => {
    const segments = [
      { start: 0, end: 10 },
      { start: 10, end: 20 },
    ];
    expect(nextChunk(4, segments, 10)).toEqual({ start: 0, end: 10 });
    expect(nextChunk(10, segments, 10)).toEqual({ start: 10, end: 20 });
    expect(nextChunk(20, segments, 10)).toEqual({ start: 20, end: 30 });
  });

  test("a wrong window is rejected with a reason", () => {
    expect(validateContentRange("bytes 0-9/10", { start: 0, end: 10 }).ok).toBe(
      true,
    );
    const wrong = validateContentRange("bytes 5-14/20", { start: 0, end: 10 });
    expect(wrong.ok).toBe(false);
    expect(validateContentRange(null, { start: 0, end: 10 }).ok).toBe(false);
  });

  test("DownloadError carries its kind", () => {
    const error = new DownloadError("short", "interrupted");
    expect(error.kind).toBe("interrupted");
  });
});
