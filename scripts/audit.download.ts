/**
 * Download engine acceptance harness — spec §13 DOWNLOAD.
 *
 * Exercises the real `ResumableDownload` against a fake origin and an
 * in-memory sink, so every scenario in the brief is covered without a
 * network, a filesystem or a browser.
 *
 *   bun scripts/audit.download.ts
 *
 * Exit 0 when every case passes, 1 otherwise.
 */

import {
  ResumableDownload,
  DownloadManager,
  planSegments,
  validateContentRange,
  nextChunk,
  progressOf,
  etaOf,
  smoothSpeed,
  DEFAULT_DOWNLOAD_CONFIG,
  type DownloadAdapter,
  type FileSink,
  type Segment,
} from "../src/lib/downloadManager";

let pass = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) pass++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

// --------------------------------------------------------------- in-memory sink
class MemorySink implements FileSink {
  bytes: Uint8Array[] = [];
  committed = false;
  discarded = false;
  constructor(private readonly resumed: Uint8Array[] = []) {
    this.bytes = [...resumed];
  }
  async bytesWritten() {
    return this.bytes.reduce((n, b) => n + b.length, 0);
  }
  async append(chunk: Uint8Array) {
    this.bytes.push(chunk.slice());
  }
  async truncate(to: number) {
    // Correct implementation, not a stub: the engine relies on truncate
    // restoring a segment boundary, so a fake that only handled 0 would hide
    // exactly the corruption this suite exists to catch.
    let at = 0;
    const kept: Uint8Array[] = [];
    for (const b of this.bytes) {
      if (at + b.length <= to) {
        kept.push(b);
      } else if (at < to) {
        kept.push(b.subarray(0, to - at));
      }
      at += b.length;
    }
    this.bytes = kept;
  }
  async commit() {
    this.committed = true;
  }
  async discardIncomplete() {
    this.discarded = true;
    this.bytes = [];
  }
  flat(): Uint8Array {
    const total = this.bytes.reduce((n, b) => n + b.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const b of this.bytes) {
      out.set(b, at);
      at += b.length;
    }
    return out;
  }
}

// --------------------------------------------------------------- fake origin
interface OriginOptions {
  total: number;
  /** Serve 206 + Content-Range. False means the origin ignores Range entirely. */
  supportsRange: boolean;
  /** Truncate the Nth range's body to simulate an interrupted transfer. */
  breakSegment?: number;
  /** Answer every range with the whole entity (a lying proxy). */
  lieAboutRange?: boolean;
  /** Answer with a wrong-but-valid-looking Content-Range. */
  wrongRangeStart?: boolean;
  contentLengthHeader?: number | null;
}

function makeAdapter(
  origin: OriginOptions,
  sink: MemorySink,
  log: string[],
): DownloadAdapter {
  let rangeCount = 0;
  return {
    async probe() {
      return {
        status: 200,
        contentLength:
          origin.contentLengthHeader === undefined ? origin.total : origin.contentLengthHeader,
        acceptRanges: origin.supportsRange,
      };
    },
    async openRange(segment: Segment, _timeout, signal) {
      if (signal.aborted) throw new Error("aborted");
      const index = rangeCount++;
      log.push(`range ${segment.start}-${segment.end - 1}`);
      const full = new Uint8Array(origin.total).map((_, i) => i % 251);
      if (!origin.supportsRange || origin.lieAboutRange) {
        return { status: 200, headers: new Headers(), body: streamOf(full) };
      }
      const start = origin.wrongRangeStart ? segment.start + 1 : segment.start;
      const slice = full.subarray(start, segment.end);
      const body =
        origin.breakSegment === index ? slice.subarray(0, Math.max(0, slice.length - 3)) : slice;
      const headers = new Headers({
        "content-range": `bytes ${start}-${segment.end - 1}/${origin.total}`,
      });
      return { status: 206, headers, body: streamOf(body) };
    },
    async openStream(_timeout, signal) {
      if (signal.aborted) throw new Error("aborted");
      log.push("stream whole");
      const full = new Uint8Array(origin.total).map((_, i) => i % 251);
      return { status: 200, headers: new Headers(), body: streamOf(full) };
    },
    sink,
  };
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  // Chunked so the reader loop actually iterates.
  const size = 64;
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.subarray(at, Math.min(at + size, bytes.length)));
      at += size;
    },
  });
}

const cfg = { ...DEFAULT_DOWNLOAD_CONFIG, chunkSize: 256, maxConcurrentRanges: 2 };

// ===========================================================================
// Pure logic
// ===========================================================================
{
  const ranged = planSegments({
    contentLength: 1000,
    acceptRanges: true,
    status: 200,
    chunkSize: 256,
    maxFileSize: 10_000,
  });
  check(
    "planSegments splits into 4 chunks",
    ranged.kind === "ranged" && (ranged as { segments: Segment[] }).segments.length === 4,
    JSON.stringify(ranged),
  );
  const segs = (ranged as { segments: Segment[] }).segments;
  check("planSegments first chunk starts at 0", segs[0]?.start === 0);
  check("planSegments last chunk ends at total", segs[segs.length - 1]?.end === 1000);
  check(
    "planSegments chunks are contiguous",
    segs.every((s, i) => i === 0 || s.start === segs[i - 1]!.end),
  );

  check(
    "planSegments falls back when ranges refused",
    planSegments({ contentLength: 100, acceptRanges: false, status: 200, chunkSize: 50, maxFileSize: 1e6 })
      .kind === "streaming",
  );
  check(
    "planSegments falls back when length unknown",
    planSegments({ contentLength: null, acceptRanges: true, status: 200, chunkSize: 50, maxFileSize: 1e6 })
      .kind === "streaming",
  );
  check(
    "planSegments still segments on a 200 probe (ranges are independent of probe status)",
    planSegments({ contentLength: 100, acceptRanges: true, status: 200, chunkSize: 50, maxFileSize: 1e6 }).kind === "ranged",
  );
  check(
    "planSegments refuses a failed probe",
    planSegments({ contentLength: null, acceptRanges: false, status: 404, chunkSize: 50, maxFileSize: 1e6 }).kind === "unsupported",
  );
  const tooBig = planSegments({
    contentLength: 10_000,
    acceptRanges: true,
    status: 200,
    chunkSize: 50,
    maxFileSize: 1000,
  });
  check("planSegments rejects oversize", tooBig.kind === "unsupported", JSON.stringify(tooBig));
}
{
  const seg = { start: 100, end: 200 };
  check("validateContentRange accepts exact", validateContentRange("bytes 100-199/1000", seg).ok);
  check("validateContentRange rejects missing", !validateContentRange(null, seg).ok);
  check("validateContentRange rejects wrong start", !validateContentRange("bytes 99-198/1000", seg).ok);
  check("validateContentRange rejects short", !validateContentRange("bytes 100-150/1000", seg).ok);
  check("validateContentRange rejects garbage", !validateContentRange("nonsense", seg).ok);
  check(
    "validateContentRange rejects an over-long window",
    !validateContentRange("bytes 100-250/1000", seg).ok,
  );
}
{
  const segs: Segment[] = [
    { start: 0, end: 100 },
    { start: 100, end: 200 },
    { start: 200, end: 300 },
  ];
  check("nextChunk resumes from the sink", nextChunk(0, segs, 100)?.start === 0);
  check("nextChunk skips satisfied segments", nextChunk(100, segs, 100)?.start === 100);
  check("nextChunk extends past the plan", nextChunk(300, segs, 100)?.start === 300);
  check("nextChunk honours chunk size past the plan", nextChunk(300, segs, 50)?.end === 350);
}
check("progressOf is 0 for unknown total", progressOf(50, null) === 0);
check("progressOf is 50% at half", Math.round(progressOf(50, 100)) === 50);
check("progressOf caps at 100", progressOf(150, 100) === 100);
check("etaOf is null without a speed", etaOf(50, 100, 0) === null);
check("etaOf is null without a total", etaOf(50, null, 10) === null);
check("etaOf is 0 when complete", etaOf(100, 100, 10) === 0);
check("etaOf computes remaining", etaOf(50, 100, 10) === 5000);
check("smoothSpeed starts from the first sample", smoothSpeed(0, 10) === 10);
check("smoothSpeed stays finite", Number.isFinite(smoothSpeed(10, 1000)));

// ===========================================================================
// Small file
// ===========================================================================
{
  const sink = new MemorySink();
  const log: string[] = [];
  const d = new ResumableDownload({ id: "a", trackId: "t1", filename: "small.mp3", config: cfg });
  await d.run(makeAdapter({ total: 100, supportsRange: true }, sink, log));
  check("small ranged file completes", d.status === "completed", d.error ?? "");
  check("small ranged file has full length", sink.flat().length === 100);
  check("small ranged file is not corrupt", sink.flat()[57] === 57 % 251);
  check("small file commits", sink.committed);
  check("small file does not fall back to streaming", !d.usedStreamingFallback);
}

// ===========================================================================
// Large file
// ===========================================================================
{
  const sink = new MemorySink();
  const log: string[] = [];
  const d = new ResumableDownload({ id: "b", trackId: "t2", filename: "big.mp3", config: cfg });
  await d.run(makeAdapter({ total: 5000, supportsRange: true }, sink, log));
  check("large ranged file completes", d.status === "completed", d.error ?? "");
  check("large ranged file has full length", sink.flat().length === 5000);
  check("large file requested many ranges", log.length >= 19, `${log.length} requests`);
  check(
    "large file bytes are in order",
    sink.flat().every((byte, i) => byte === i % 251),
  );
}

// ===========================================================================
// Unsupported range -> streaming fallback
// ===========================================================================
{
  const sink = new MemorySink();
  const log: string[] = [];
  const d = new ResumableDownload({ id: "c", trackId: "t3", filename: "ns.mp3", config: cfg });
  await d.run(makeAdapter({ total: 700, supportsRange: false }, sink, log));
  check("no-range origin still completes", d.status === "completed", d.error ?? "");
  check("no-range origin uses streaming fallback", d.usedStreamingFallback);
  check("no-range origin writes the whole file", sink.flat().length === 700);
  check(
    "no-range origin does not double the file",
    sink.flat().every((byte, i) => byte === i % 251),
  );
}

// ===========================================================================
// Interrupted download -> failed, partial kept for resume
// ===========================================================================
{
  const sink = new MemorySink();
  const log: string[] = [];
  const d = new ResumableDownload({ id: "d", trackId: "t4", filename: "cut.mp3", config: cfg });
  await d.run(makeAdapter({ total: 1000, supportsRange: true, breakSegment: 2 }, sink, log));
  check("interrupted download fails", d.status === "failed", d.status);
  check("interrupted download explains why", /returned \d+ of \d+/.test(d.error ?? ""), d.error ?? "");
  check("interrupted download keeps a partial file for resume", !sink.discarded);
  check("interrupted download does not commit", !sink.committed);
  const partialBytes = sink.flat().length;
  check(
    "partial file is rolled back to a segment boundary",
    partialBytes % 256 === 0,
    `${partialBytes} bytes`,
  );
}

// ===========================================================================
// Resume
// ===========================================================================
{
  const sink = new MemorySink();
  const log: string[] = [];
  const d = new ResumableDownload({ id: "e", trackId: "t5", filename: "resume.mp3", config: cfg });
  await d.run(makeAdapter({ total: 1000, supportsRange: true, breakSegment: 2 }, sink, log));
  const after = sink.flat().length;
  check("interrupted run left whole segments behind", after > 0 && after < 1000, `${after}`);
  const d2 = new ResumableDownload({ id: "e2", trackId: "t5", filename: "resume.mp3", config: cfg });
  const requestsBefore = log.length;
  await d2.run(makeAdapter({ total: 1000, supportsRange: true }, sink, log));
  check("resumed download completes", d2.status === "completed", d2.error ?? "");
  check(
    "resumed download actually RESUMED rather than restarting",
    log.length - requestsBefore < 19,
    `re-requested ${log.length - requestsBefore} of ~19 segments`,
  );
  check(
    "resumed download's first request starts past the partial file",
    /range (\d+)-/.exec(log.slice(requestsBefore).join())?.[1] !== "0",
    log.slice(requestsBefore).join(),
  );
  check("resumed file is full length", sink.flat().length === 1000, `${sink.flat().length}`);
  check(
    "resumed file has no duplicated or missing bytes",
    sink.flat().every((byte, i) => byte === i % 251),
  );
}

// ===========================================================================
// Lying origin: 200 to a Range request mid-download must not corrupt
// ===========================================================================
{
  const sink = new MemorySink();
  const log: string[] = [];
  const d = new ResumableDownload({ id: "f", trackId: "t6", filename: "liar.mp3", config: cfg });
  await d.run(makeAdapter({ total: 800, supportsRange: true, lieAboutRange: true }, sink, log));
  check("lying origin does not produce a corrupt file", d.status === "completed", d.error ?? "");
  check("lying origin writes the file exactly once", sink.flat().length === 800, `${sink.flat().length}`);
  check(
    "lying origin content is correct",
    sink.flat().every((byte, i) => byte === i % 251),
  );
  check("lying origin is flagged as a fallback", d.usedStreamingFallback);
}

// ===========================================================================
// Bad Content-Range is rejected
// ===========================================================================
{
  const sink = new MemorySink();
  const log: string[] = [];
  const d = new ResumableDownload({ id: "g", trackId: "t7", filename: "bad.mp3", config: cfg });
  await d.run(makeAdapter({ total: 800, supportsRange: true, wrongRangeStart: true }, sink, log));
  check("wrong Content-Range fails the download", d.status === "failed", d.status);
  check("wrong Content-Range does not commit", !sink.committed);
  check("wrong Content-Range cleans up", sink.discarded);
}

// ===========================================================================
// Cancelled download
// ===========================================================================
{
  const sink = new MemorySink();
  const log: string[] = [];
  const d = new ResumableDownload({ id: "h", trackId: "t8", filename: "cancel.mp3", config: cfg });
  const adapter = makeAdapter({ total: 100_000, supportsRange: true }, sink, log);
  const running = d.run(adapter);
  d.cancel();
  await running;
  check("cancelled download is cancelled, not failed", d.status === "cancelled", d.status);
  check("cancelled download does not commit", !sink.committed);
}

// ===========================================================================
// Paused download, then retry
// ===========================================================================
{
  const sink = new MemorySink();
  const log: string[] = [];
  const d = new ResumableDownload({ id: "i", trackId: "t9", filename: "pause.mp3", config: cfg });
  const running = d.run(makeAdapter({ total: 100_000, supportsRange: true }, sink, log));
  d.pause();
  await running;
  check("paused download is paused, not failed", d.status === "paused", d.status);
  check("paused download keeps its partial file", !sink.discarded);
  d.retry();
  check("retry puts a paused download back in the queue", d.status === "queued", d.status);
}

// ===========================================================================
// Manager: duplicate guard, cancel, remove
// ===========================================================================
{
  const sinks = new Map<string, MemorySink>();
  const manager = new DownloadManager(cfg, (d) => {
    const sink = sinks.get(d.id) ?? new MemorySink();
    sinks.set(d.id, sink);
    return makeAdapter({ total: 400, supportsRange: true }, sink, []);
  });

  const first = manager.enqueue({ trackId: "same", filename: "a.mp3" });
  const second = manager.enqueue({ trackId: "same", filename: "a.mp3" });
  check("manager blocks a duplicate track", first.id === second.id, `${first.id} vs ${second.id}`);

  const forced = manager.enqueue({ trackId: "same", filename: "a.mp3", force: true });
  check("manager honours an explicit force", forced.id !== first.id);

  await first.whenSettled();
  check("manager download completes", first.status === "completed", first.error ?? "");
  check("manager reports progress", first.progress === 100, `${first.progress}`);

  const other = manager.enqueue({ trackId: "other", filename: "b.mp3" });
  check("manager tracks multiple downloads", manager.list().length >= 3);
  manager.cancel(other.id);
  check("manager cancels", other.status === "cancelled", other.status);
  check("manager exposes records", manager.list().every((r) => typeof r.id === "string"));
  check("manager get returns null for unknown ids", manager.get("nope") === null);

  const removed = await manager.remove(forced.id);
  check("manager removes", removed === true);
  check("manager get returns null after removal", manager.get(forced.id) === null);
}

// ===========================================================================
// Oversize refusal
// ===========================================================================
{
  const sink = new MemorySink();
  const d = new ResumableDownload({
    id: "j",
    trackId: "t10",
    filename: "huge.mp3",
    config: { ...cfg, maxFileSize: 100 },
  });
  await d.run(makeAdapter({ total: 10_000, supportsRange: true }, sink, []));
  check("oversize download is refused", d.status === "failed", d.status);
  check("oversize download says why", /over the/.test(d.error ?? ""), d.error ?? "");
  check("oversize download writes nothing", sink.flat().length === 0);
}

// --------------------------------------------------------------- report
console.log(`PASS ${pass}  FAIL ${failures.length}`);
if (failures.length) {
  for (const f of failures) console.log("  FAIL:", f);
  process.exit(1);
}