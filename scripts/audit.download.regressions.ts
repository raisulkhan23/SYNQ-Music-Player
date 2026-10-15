/**
 * Regression tests for the two download bugs found in review:
 *
 *  1. `pump()` resolved the adapter factory EAGERLY, as an argument. A factory
 *     that throws synchronously (real: no filesystem, or no resolved stream)
 *     threw before `.finally()` was attached, so `this.running` was never
 *     decremented. The concurrency slot leaked permanently and every later
 *     download silently sat in `queued` forever.
 *
 *  2. Fixing (1) by deferring the factory into the promise chain introduced a
 *     second race: `status` only becomes `downloading` once `run()` is invoked,
 *     so the `find(status === "queued")` scan could pick the SAME record twice
 *     and start two runs writing into one sink ("512 of 400 bytes").
 *
 * Run: bun scripts/audit.download.regressions.ts
 */

import {
  DownloadManager,
  type DownloadAdapter,
  type Segment,
} from "../src/lib/downloadManager";

let pass = 0;
let fail = 0;

function ok(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}`);
  }
}

function memorySink() {
  let bytes = 0;
  return {
    bytesWritten: async () => bytes,
    append: async (c: Uint8Array) => {
      bytes += c.length;
    },
    truncate: async (to: number) => {
      bytes = to;
    },
    commit: async () => {},
    discardIncomplete: async () => {
      bytes = 0;
    },
  };
}

function bodyOf(size: number): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(size));
      c.close();
    },
  });
}

function adapterFor(total: number, sinkBytes: { n: number }): DownloadAdapter {
  return {
    async probe() {
      return { status: 206, contentLength: total, acceptRanges: true };
    },
    async openRange(seg: Segment) {
      const headers = new Headers({
        "content-range": `bytes ${seg.start}-${seg.end - 1}/${total}`,
      });
      return { status: 206, headers, body: bodyOf(seg.end - seg.start) };
    },
    async openStream() {
      return { status: 200, headers: new Headers(), body: bodyOf(total) };
    },
    sink: {
      bytesWritten: async () => sinkBytes.n,
      append: async (c: Uint8Array) => {
        sinkBytes.n += c.length;
      },
      truncate: async (to: number) => {
        sinkBytes.n = to;
      },
      commit: async () => {},
      discardIncomplete: async () => {
        sinkBytes.n = 0;
      },
    },
  };
}

async function main() {
  // ---- BUG 1: a synchronously-throwing factory must not wedge the queue ----
  {
    const sinkBytes = { n: 0 };
    let calls = 0;
    const m = new DownloadManager({ chunkSize: 8, maxConcurrentRanges: 1 }, () => {
      calls++;
      // Real behaviour: createTrackAdapter throws when OPFS is missing, and the
      // app factory throws when a record has no resolved stream.
      throw new Error("no filesystem");
    });

    const bad = m.enqueue({ trackId: "t1", filename: "a.m4a" });
    await bad.settled;
    ok("bug1: failing download reports failed", bad.status === "failed");
    ok("bug1: error surfaced", (bad.error ?? "").length > 0);

    // The queue must still work afterwards. Before the fix `running` stayed at
    // 1 forever, so with a cap of 1 nothing else could ever start.
    const good = adapterFor(16, sinkBytes);
    const m2 = new DownloadManager(
      { chunkSize: 8, maxConcurrentRanges: 1 },
      (d) => (d.trackId === "bad" ? (() => {
        throw new Error("no filesystem");
      })() : good),
    );
    const d1 = m2.enqueue({ trackId: "bad", filename: "bad.m4a" });
    await d1.settled;
    const d2 = m2.enqueue({ trackId: "good", filename: "good.m4a" });
    await d2.settled;
    ok(
      "bug1: queue not wedged after a sync throw",
      d2.status === "completed",
    );
    ok("bug1: both downloads attempted", calls === 1 && m2.list().length === 2);
  }

  // ---- BUG 2: one download must never be started twice ----
  {
    let appends = 0;
    let opens = 0;
    const sink = memorySink();
    const m = new DownloadManager(
      { chunkSize: 8, maxConcurrentRanges: 4 },
      () => {
        opens++;
        return {
          async probe() {
            return { status: 206, contentLength: 16, acceptRanges: true };
          },
          async openRange(seg: Segment) {
            const length = seg.end - seg.start;
            return {
              status: 206,
              headers: new Headers({
                "content-range": `bytes ${seg.start}-${seg.end - 1}/16`,
              }),
              body: bodyOf(length),
            };
          },
          async openStream() {
            return {
              status: 200,
              headers: new Headers(),
              body: bodyOf(16),
            };
          },
          sink: {
            bytesWritten: async () => sink.bytesWritten(),
            append: async (c: Uint8Array) => {
              appends++;
              await sink.append(c);
            },
            truncate: sink.truncate,
            commit: sink.commit,
            discardIncomplete: sink.discardIncomplete,
          },
        } satisfies DownloadAdapter;
      },
    );

    const d = m.enqueue({ trackId: "solo", filename: "solo.m4a" });
    await d.settled;

    ok("bug2: opened the resource exactly once", opens === 1);
    // 16 bytes at an 8-byte chunk size is exactly 2 segments, so 2 appends is
    // the CORRECT count. Before the claimed-set fix this was 4 - the same
    // download run twice into one sink.
    ok("bug2: one append per segment, not double", appends === 2);
    ok("bug2: completed", d.status === "completed");
  }

  // ---- Many queued at once must each start exactly once ----
  {
    const perTrack = new Map<string, number>();
    const m = new DownloadManager(
      { chunkSize: 8, maxConcurrentRanges: 3 },
      (d) => {
        perTrack.set(d.trackId, (perTrack.get(d.trackId) ?? 0) + 1);
        const bytes = { n: 0 };
        return adapterFor(16, bytes);
      },
    );

    const all = Array.from({ length: 12 }, (_, i) =>
      m.enqueue({ trackId: `tr${i}`, filename: `f${i}.m4a` }),
    );
    await Promise.all(all.map((d) => d.settled));

    ok(
      "queue: every track started exactly once",
      [...perTrack.values()].every((n) => n === 1) && perTrack.size === 12,
    );
    ok(
      "queue: all completed",
      all.every((d) => d.status === "completed"),
    );
    ok(
      "queue: each wrote exactly its own 16 bytes",
      all.every((d) => d.downloadedBytes === 16),
    );
  }

  console.log(`\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();