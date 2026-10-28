/**
 * Ranged / segmented download engine + download manager.
 *
 * SCOPE, AND WHY. This module knows how to fetch a byte range, validate that
 * the server honoured it, resume after an interruption, and keep a queue of
 * those fetches in a coherent state machine. It is deliberately
 * provider-agnostic: it is handed a `MediaSource` and a `FileSink` and has no
 * idea what is on the other end.
 *
 * That is not a stylistic choice. §12 of the brief requires that SYNQ only
 * retrieve media it is authorised to retrieve, and that a source which cannot
 * legally provide downloadable media stays a metadata/playback integration.
 * YouTube is the latter: its terms do not license bulk media download, and
 * the formats needed to pull bytes out of it sit behind the same bot checks as
 * everything else. So this engine is wired to sources that grant download
 * rights, and YouTube stays on the streaming path in `youtube.ts`.
 *
 * The pure decision logic (`planSegments`, `validateContentRange`,
 * `nextChunk`) is separated from the I/O so it can be tested exhaustively
 * without a network, a filesystem, or a browser.
 */

export type DownloadStatus =
  | "queued"
  | "downloading"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface DownloadRecord {
  id: string;
  trackId: string;
  filename: string;
  /** Bytes, when the server tells us. `null` means unknown (no Range support). */
  totalSize: number | null;
  downloadedBytes: number;
  /** 0..100. Meaningless-but-still-shown when `totalSize` is null. */
  progress: number;
  /** Bytes per second, smoothed. */
  speed: number;
  /** Milliseconds remaining, or null when unknowable. */
  etaMs: number | null;
  status: DownloadStatus;
  error?: string;
  /** True when the server ignored our Range header and streamed the lot. */
  usedStreamingFallback: boolean;
}

export interface DownloadConfig {
  /** Bytes per ranged request. */
  chunkSize: number;
  /**
   * How many ranges may be in flight at once.
   *
   * Deliberately low. Ranged download is for resuming and for weak networks,
   * not for saturating a connection — hammering an origin with parallel ranges
   * is exactly the behaviour that gets a client rate limited or blocked.
   */
  maxConcurrentRanges: number;
  /** Per-request timeout, ms. */
  timeoutMs: number;
  /** Refuse anything larger than this, to bound disk use. */
  maxFileSize: number;
}

export const DEFAULT_DOWNLOAD_CONFIG: DownloadConfig = {
  chunkSize: 1_048_576, // 1 MiB
  maxConcurrentRanges: 2,
  timeoutMs: 30_000,
  maxFileSize: 512 * 1_048_576, // 512 MiB
};

/** One byte range, half-open `[start, end)`. */
export interface Segment {
  start: number;
  /** Exclusive. `start + length === end`. */
  end: number;
}

export type PlanResult =
  | { kind: "ranged"; segments: Segment[]; totalSize: number }
  | { kind: "streaming"; totalSize: number | null }
  | { kind: "unsupported"; reason: string };

/**
 * Decide how to fetch a resource.
 *
 * Three outcomes, and the distinction matters:
 *  - the server advertised a length and accepts ranges -> segment it;
 *  - it has a length but refuses ranges -> stream it whole;
 *  - it has no length at all -> stream, and report progress as unknown rather
 *    than inventing a total.
 */
export function planSegments(
  opts: {
    contentLength: number | null;
    acceptRanges: boolean;
    /** The PROBE's status. Used only to detect a failed/redirected probe. */
    status: number;
    chunkSize: number;
    maxFileSize: number;
  },
): PlanResult {
  const { contentLength, acceptRanges, status, chunkSize, maxFileSize } = opts;

  if (contentLength !== null && contentLength > maxFileSize) {
    return {
      kind: "unsupported",
      reason: `File is ${contentLength} bytes, over the ${maxFileSize} byte limit`,
    };
  }
  // A probe that did not succeed means the resource is not retrievable at all.
  if (status < 200 || status >= 300) {
    return { kind: "unsupported", reason: `Probe returned HTTP ${status}` };
  }
  // NOTE: a 200 here is NOT evidence that ranges are unsupported. A normal
  // probe answers 200 even when the origin happily serves ranges. The "origin
  // ignored my Range header" case is a property of an actual range RESPONSE,
  // and it is handled in `fetchSegments`, which can see the real status.
  if (!acceptRanges || contentLength === null) {
    return { kind: "streaming", totalSize: contentLength };
  }
  const size = Math.max(0, Math.floor(chunkSize));
  if (size <= 0) return { kind: "streaming", totalSize: contentLength };

  const segments: Segment[] = [];
  for (let start = 0; start < contentLength; start += size) {
    segments.push({ start, end: Math.min(start + size, contentLength) });
  }
  return { kind: "ranged", segments, totalSize: contentLength };
}

export type RangeCheck =
  | { ok: true; bytes: number }
  | { ok: false; reason: string };

/**
 * Verify a `Content-Range` actually covers the bytes we asked for.
 *
 * This is the guard against silent corruption. A proxy that answers a range
 * with the wrong window, or with `200 OK` and the whole file, would otherwise
 * be written into the output at the wrong offset and produce a file that is
 * the right length and the wrong content.
 */
export function validateContentRange(
  header: string | null,
  requested: Segment,
): RangeCheck {
  if (!header) return { ok: false, reason: "Missing Content-Range" };
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(header.trim());
  if (!match) return { ok: false, reason: `Unparseable Content-Range: ${header}` };
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start !== requested.start) {
    return { ok: false, reason: `Content-Range starts at ${start}, expected ${requested.start}` };
  }
  if (end < requested.start) {
    return { ok: false, reason: `Content-Range ends at ${end}, before it starts` };
  }
  const expected = requested.end - requested.start;
  const got = end - start + 1;
  if (got !== expected) {
    return {
      ok: false,
      reason: `Content-Range covers ${got} bytes, expected ${expected}`,
    };
  }
  return { ok: true, bytes: got };
}

/**
 * The next segment to request, given what is already on disk.
 *
 * Resume is derived from the sink's real byte count rather than from a
 * separate "progress" counter, so a crash or a reload cannot leave the two
 * disagreeing — which is the usual cause of a resumed download that is corrupt
 * in its middle rather than merely truncated.
 */
export function nextChunk(
  haveBytes: number,
  segments: Segment[],
  chunkSize: number,
): Segment | null {
  // The segment CONTAINING what we already have. Matching on `start >= have`
  // would skip forward past a partially-written segment and silently drop
  // those bytes on resume, which is how a "resumed" download ends up the right
  // length and the wrong content.
  const containing = segments.find(
    (s) => haveBytes >= s.start && haveBytes < s.end,
  );
  if (containing) return containing;
  const beyond = segments.find((s) => s.start >= haveBytes);
  if (beyond) return beyond;
  // Past the planned segments (chunk size changed between runs): issue one
  // more range of the current size so the download can still complete.
  const size = Math.max(1, Math.floor(chunkSize));
  return { start: haveBytes, end: haveBytes + size };
}

/** Exponential moving average — a raw per-second sample is far too jumpy. */
export function smoothSpeed(previous: number, sample: number, alpha = 0.3): number {
  if (!Number.isFinite(sample) || sample <= 0) return previous;
  return previous === 0 ? sample : previous * (1 - alpha) + sample * alpha;
}

export function progressOf(downloaded: number, total: number | null): number {
  if (!total || total <= 0) return 0;
  return Math.min(100, Math.max(0, (downloaded / total) * 100));
}

export function etaOf(
  downloaded: number,
  total: number | null,
  speed: number,
): number | null {
  if (!total || total <= 0 || speed <= 0) return null;
  const remaining = Math.max(0, total - downloaded);
  if (remaining === 0) return 0;
  return Math.round((remaining / speed) * 1000);
}

/**
 * A resumable, pausable, sequential download.
 *
 * Sequential rather than parallel on purpose. `maxConcurrentRanges` bounds how
 * many *sources* may run at once (the manager's job); within one download,
 * ranges are requested in order so that a failure resumes cleanly from the
 * first missing byte.
 */
export class ResumableDownload {
  readonly id: string;
  readonly trackId: string;
  readonly filename: string;
  readonly config: DownloadConfig;

  status: DownloadStatus = "queued";
  totalSize: number | null = null;
  downloadedBytes = 0;
  speed = 0;
  error: string | null = null;
  usedStreamingFallback = false;
  /** Resolves when the download settles (any terminal state). */
  private settled: Promise<void>;
  private markSettled!: () => void;
  /** Aborts the in-flight fetch on pause/cancel. */
  private controller: AbortController | null = null;
  /** Why the loop should stop, or null while it should keep going. */
  private stopReason: "paused" | "cancelled" | null = null;

  constructor(init: {
    id: string;
    trackId: string;
    filename: string;
    config?: Partial<DownloadConfig>;
  }) {
    this.id = init.id;
    this.trackId = init.trackId;
    this.filename = init.filename;
    this.config = { ...DEFAULT_DOWNLOAD_CONFIG, ...init.config };
    this.settled = new Promise<void>((resolve) => {
      this.markSettled = resolve;
    });
  }

  get progress(): number {
    return progressOf(this.downloadedBytes, this.totalSize);
  }

  get etaMs(): number | null {
    return etaOf(this.downloadedBytes, this.totalSize, this.speed);
  }

  toRecord(): DownloadRecord {
    return {
      id: this.id,
      trackId: this.trackId,
      filename: this.filename,
      totalSize: this.totalSize,
      downloadedBytes: this.downloadedBytes,
      progress: this.progress,
      speed: Math.round(this.speed),
      etaMs: this.etaMs,
      status: this.status,
      error: this.error ?? undefined,
      usedStreamingFallback: this.usedStreamingFallback,
    };
  }

  /**
   * Fetch the whole resource.
   *
   * `openRange` must resolve `{ status, headers, body }` for a byte range.
   * `openStream` is the no-Range fallback. `sink` is the only thing that
   * touches storage.
   */
  async run(adapterSpec: DownloadAdapter | Promise<DownloadAdapter>): Promise<void> {
    // Claim the slot BEFORE awaiting the adapter. Resolving a stream URL is a
    // network round trip, and a download left in `queued` across that await
    // would be picked up a second time by the manager's pump — two runs
    // writing to one sink.
    this.status = "downloading";
    // The adapter may be async, and it may REFUSE — `createTrackAdapter` throws
    // when the browser has no filesystem, and the app factory throws when a
    // record has no resolved stream. That await is therefore INSIDE the try:
    // when it sat outside, a rejecting factory escaped before `markSettled()`
    // was ever reached, so the record stayed "downloading" for the lifetime of
    // the page and `settled()` never resolved. A download that can never start
    // has to end as a failure with a readable reason, not hang.
    let adapter: DownloadAdapter | null = null;
    try {
      adapter = await adapterSpec;
      const resumeFrom = await adapter.sink.bytesWritten();
      this.downloadedBytes = resumeFrom;

      const probe = await adapter.probe(this.config.timeoutMs);
      this.totalSize = probe.contentLength;

      const plan = planSegments({
        contentLength: probe.contentLength,
        acceptRanges: probe.acceptRanges,
        status: probe.status,
        chunkSize: this.config.chunkSize,
        maxFileSize: this.config.maxFileSize,
      });

      if (plan.kind === "unsupported") {
        throw new DownloadError(plan.reason, "unsupported");
      }

      if (plan.kind === "streaming") {
        this.usedStreamingFallback = true;
        await this.streamWhole(adapter, plan.totalSize);
      } else {
        await this.fetchSegments(adapter, plan.segments);
      }

      const written = await adapter.sink.bytesWritten();
      if (this.totalSize !== null && written !== this.totalSize) {
        // A short file is worse than no file: it looks complete and plays as
        // a truncated track.
        throw new DownloadError(
          `Incomplete download: ${written} of ${this.totalSize} bytes`,
          "incomplete",
        );
      }
      await adapter.sink.commit();
      this.status = "completed";
      this.speed = 0;
    } catch (err) {
      if (this.stopReason === "cancelled") {
        this.markSettled();
        return;
      }
      // A pause is not a failure: the partial file is kept so resume can use it.
      if (this.stopReason === "paused") {
        this.markSettled();
        return;
      }
      this.status = "failed";
      this.error = err instanceof Error ? err.message : String(err);
      this.speed = 0;
      // An INTERRUPTED transfer is the one failure that is worth keeping: the
      // bytes already written are valid and whole segments, so the next run
      // resumes from them instead of starting over. Everything else
      // (unreachable, refused, a lying Content-Range, oversize) means what is
      // on disk cannot be trusted, so it is removed rather than left to be
      // mistaken for a resumable partial.
      const resumable =
        err instanceof DownloadError && err.kind === "interrupted";
      if (!resumable) {
        // No adapter means nothing was ever opened, so there is no partial to
        // clean up — and calling through a null adapter here is what turned a
        // refusal into a second, misleading crash.
        await adapter?.sink
          .discardIncomplete()
          .catch(() => undefined);
      }
    } finally {
      this.controller = null;
      this.markSettled();
    }
  }

  /** Fallback path: the origin does not do ranges. */
  private async streamWhole(
    adapter: DownloadAdapter,
    totalSize: number | null,
  ): Promise<void> {
    this.controller = new AbortController();
    const response = await adapter.openStream(this.config.timeoutMs, this.controller.signal);
    if (!response.body) throw new DownloadError("Empty response body", "invalid");

    let lastTick = Date.now();
    let lastBytes = this.downloadedBytes;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.length) continue;
        this.throwIfStopped();
        await adapter.sink.append(value);
        this.downloadedBytes += value.length;

        const now = Date.now();
        const elapsed = (now - lastTick) / 1000;
        if (elapsed >= 0.5) {
          this.speed = smoothSpeed(
            this.speed,
            (this.downloadedBytes - lastBytes) / elapsed,
          );
          lastTick = now;
          lastBytes = this.downloadedBytes;
        }
      }
    } finally {
      reader.releaseLock?.();
    }
    if (totalSize !== null) this.totalSize = totalSize;
  }

  private async fetchSegments(
    adapter: DownloadAdapter,
    segments: Segment[],
  ): Promise<void> {
    let lastTick = Date.now();
    let lastBytes = this.downloadedBytes;

    for (;;) {
      this.throwIfStopped();
      const have = await adapter.sink.bytesWritten();
      this.downloadedBytes = have;
      if (this.totalSize !== null && have >= this.totalSize) return;

      const segment = nextChunk(have, segments, this.config.chunkSize);
      if (!segment) return;
      if (
        this.totalSize !== null &&
        segment.end > this.totalSize
      ) {
        segment.end = this.totalSize;
      }

      this.controller = new AbortController();
      const response = await adapter.openRange(
        segment,
        this.config.timeoutMs,
        this.controller.signal,
      );

      if (response.status === 200) {
        // The origin ignored the Range header mid-download. Everything before
        // this point is still valid, so fall back to a whole-body stream
        // rather than appending a second full copy after the partial one.
        this.usedStreamingFallback = true;
        await adapter.sink.truncate(0);
        this.downloadedBytes = 0;
        await this.streamWhole(adapter, this.totalSize);
        return;
      }

      if (response.status !== 206) {
        // A refused or failed range is a transport problem, not a corrupt
        // Content-Range. Reporting it as the latter sent people looking at
        // the wrong thing entirely.
        throw new DownloadError(
          `The audio source answered HTTP ${response.status}`,
          "network",
        );
      }

      const check = validateContentRange(
        response.headers.get("content-range"),
        segment,
      );
      if (!check.ok) {
        throw new DownloadError(check.reason, "invalid-range");
      }
      if (!response.body) throw new DownloadError("Empty range body", "invalid");

      const reader = response.body.getReader();
      let writtenForSegment = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value?.length) continue;
          this.throwIfStopped();
          // Guard: never write past the end of this segment, so a server that
          // sends one byte too many cannot bleed into the next segment.
          const room = check.bytes - writtenForSegment;
          if (room <= 0) break;
          const slice = value.length > room ? value.subarray(0, room) : value;
          await adapter.sink.append(slice);
          writtenForSegment += slice.length;
          this.downloadedBytes += slice.length;

          const now = Date.now();
          const elapsed = (now - lastTick) / 1000;
          if (elapsed >= 0.5) {
            this.speed = smoothSpeed(
              this.speed,
              (this.downloadedBytes - lastBytes) / elapsed,
            );
            lastTick = now;
            lastBytes = this.downloadedBytes;
          }
        }
      } finally {
        reader.releaseLock?.();
      }

      if (writtenForSegment !== check.bytes) {
        // Partial segment. Roll the sink back to this segment's start so the
        // file never holds half a segment: `bytesWritten()` is then always a
        // segment boundary, and the next run re-requests this exact range.
        // Leaving the partial bytes in place would make resume skip them and
        // splice the file together out of order.
        await adapter.sink.truncate(segment.start).catch(() => undefined);
        this.downloadedBytes = segment.start;
        throw new DownloadError(
          `Range ${segment.start}-${segment.end - 1} returned ${writtenForSegment} of ${check.bytes} bytes`,
          "interrupted",
        );
      }
    }
  }

  private throwIfStopped(): void {
    // A dedicated stop signal rather than reading `status`. `pause`/`cancel`
    // are called from outside the run loop, so a status read here would be a
    // value the loop's own narrowing cannot see — and modelling the intent
    // separately removes that aliasing entirely.
    if (this.stopReason !== null) throw new PauseSignal();
  }

  /** Keep the partial file. The next run resumes from its real byte count. */
  pause(): void {
    if (this.status !== "downloading") return;
    this.stopReason = "paused";
    this.status = "paused";
    this.controller?.abort();
  }

  /** Drop the partial file. */
  cancel(): void {
    this.stopReason = "cancelled";
    this.status = "cancelled";
    this.controller?.abort();
  }

  /** Put a failed, cancelled or paused download back in the queue. */
  retry(): void {
    if (
      this.status !== "failed" &&
      this.status !== "cancelled" &&
      this.status !== "paused"
    ) {
      return;
    }
    this.status = "queued";
    this.error = null;
    this.speed = 0;
    this.stopReason = null;
  }

  whenSettled(): Promise<void> {
    return this.settled;
  }

  /**
   * Fail this download without having run it.
   *
   * Used by the manager when the ADAPTER FACTORY itself refuses, before `run()`
   * is ever invoked. Without this the record stayed `queued` for the lifetime of
   * the page and `settled` never resolved — an awaited download that hangs
   * forever instead of reporting the real reason. No sink was ever opened, so
   * there is no partial to clean up here.
   */
  failToStart(reason: string): void {
    if (this.status === "completed" || this.status === "cancelled") return;
    this.status = "failed";
    this.error = reason;
    this.speed = 0;
    this.markSettled();
  }
}

/** Thrown to unwind a paused/cancelled fetch without treating it as failure. */
class PauseSignal extends Error {
  constructor() {
    super("paused");
    this.name = "PauseSignal";
  }
}

export type DownloadErrorKind =
  | "unsupported"
  | "invalid"
  | "invalid-range"
  | "incomplete"
  | "interrupted"
  | "network";

export class DownloadError extends Error {
  readonly kind: DownloadErrorKind;
  constructor(message: string, kind: DownloadErrorKind) {
    super(message);
    this.name = "DownloadError";
    this.kind = kind;
  }
}

export interface DownloadAdapter {
  /** HEAD-ish probe for length and range support. */
  probe(timeoutMs: number): Promise<{
    status: number;
    contentLength: number | null;
    acceptRanges: boolean;
  }>;
  openRange(
    segment: Segment,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ status: number; headers: Headers; body: ReadableStream<Uint8Array> | null }>;
  openStream(
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<{ status: number; headers: Headers; body: ReadableStream<Uint8Array> | null }>;
  /** The only thing that touches storage. */
  sink: FileSink;
  /**
   * Delete this track's finished copy as well as any partial.
   *
   * Optional because the engine works with any sink, but a sink that keeps a
   * committed file MUST implement it: removing a completed download used to
   * discard only the `.part`, so the row disappeared while the audio stayed on
   * disk and kept playing offline.
   */
  removeStored?(): Promise<void>;
}

export interface FileSink {
  /** Real bytes already on disk — the basis for resume. */
  bytesWritten(): Promise<number>;
  append(chunk: Uint8Array): Promise<void>;
  /** Drop everything (used when an origin ignores Range mid-download). */
  truncate(to: number): Promise<void>;
  /** Promote the temp file to its final name. */
  commit(): Promise<void>;
  /** Remove an incomplete file after a hard failure. */
  discardIncomplete(): Promise<void>;
}

/**
 * Tracks many downloads and enforces the concurrency cap.
 *
 * Duplicate guard is keyed on `trackId`: asking for the same track twice
 * returns the existing download unless `force` is set, because two parallel
 * copies of one track is never what the user meant.
 */
export class DownloadManager {
  private readonly downloads = new Map<string, ResumableDownload>();
  private readonly byTrack = new Map<string, string>();
  private running = 0;
  /**
   * Downloads handed to `pump` but not yet started.
   *
   * A download's status only flips to `downloading` once `run()` is actually
   * invoked, which is now asynchronous (the adapter factory is resolved inside
   * the promise chain so a synchronous throw cannot leak a concurrency slot).
   * Without this set the `find(status === "queued")` scan below would see the
   * same still-queued record again on the next iteration and start it twice,
   * writing two runs into one file.
   */
  private readonly claimed = new Set<string>();
  private seq = 0;
  private readonly config: Partial<DownloadConfig>;
  private readonly adapterFor: (d: ResumableDownload) => DownloadAdapter | Promise<DownloadAdapter>;

  // Parameter properties are not used here: this project compiles with
  // `erasableSyntaxOnly`, which forbids them.
  constructor(
    config: Partial<DownloadConfig> = {},
    adapterFor: (
      d: ResumableDownload,
    ) => DownloadAdapter | Promise<DownloadAdapter>,
  ) {
    this.config = config;
    this.adapterFor = adapterFor;
  }

  list(): DownloadRecord[] {
    return [...this.downloads.values()].map((d) => d.toRecord());
  }

  get(id: string): DownloadRecord | null {
    return this.downloads.get(id)?.toRecord() ?? null;
  }

  /**
   * Queue a track. Returns the existing download for a track already queued,
   * unless `force` is set.
   */
  enqueue(
    init: { trackId: string; filename: string; force?: boolean },
  ): ResumableDownload {
    if (!init.force) {
      const existingId = this.byTrack.get(init.trackId);
      if (existingId) {
        const existing = this.downloads.get(existingId);
        // A finished download is still "this track, already downloaded".
        if (existing) return existing;
      }
    }
    const id = `dl_${Date.now().toString(36)}_${(this.seq++).toString(36)}`;
    const download = new ResumableDownload({
      id,
      trackId: init.trackId,
      filename: init.filename,
      config: this.config,
    });
    this.downloads.set(id, download);
    this.byTrack.set(init.trackId, id);
    void this.pump();
    return download;
  }

  pause(id: string): void {
    this.downloads.get(id)?.pause();
  }

  cancel(id: string): void {
    const d = this.downloads.get(id);
    if (!d) return;
    d.cancel();
    this.byTrack.delete(d.trackId);
  }

  retry(id: string): ResumableDownload | null {
    const d = this.downloads.get(id);
    if (!d) return null;
    d.retry();
    void this.pump();
    return d;
  }

  /** Forget a download and clean up its partial file. */
  async remove(id: string): Promise<boolean> {
    const d = this.downloads.get(id);
    if (!d) return false;
    d.cancel();
    try {
      const adapter = await this.adapterFor(d);
      if (adapter.removeStored) await adapter.removeStored();
      else await adapter.sink.discardIncomplete();
    } catch {
      // A file that is already gone is the outcome we wanted anyway.
    }
    this.byTrack.delete(d.trackId);
    return this.downloads.delete(id);
  }

  /** Start as many queued downloads as the concurrency budget allows. */
  private async pump(): Promise<void> {
    const cap = Math.max(1, this.config.maxConcurrentRanges ?? DEFAULT_DOWNLOAD_CONFIG.maxConcurrentRanges);
    while (this.running < cap) {
      const next = [...this.downloads.values()].find(
        (d) => d.status === "queued" && !this.claimed.has(d.id),
      );
      if (!next) return;
      this.running++;
      this.claimed.add(next.id);
      // The adapter factory is resolved INSIDE the promise chain, never as an
      // argument. It throws synchronously in real cases (`createTrackAdapter`
      // when the browser has no filesystem, the app factory when a record has
      // no resolved stream), and an eagerly-evaluated argument would throw
      // before `.finally()` was ever attached. `this.running` had already been
      // incremented, so the concurrency slot leaked permanently: after one such
      // failure the queue was wedged and no later download could ever start.
      void Promise.resolve()
        .then(() => this.adapterFor(next))
        .then((adapter) => next.run(adapter))
        .catch((err: unknown) => {
          // The factory refused, so `run` was never reached. The record has to
          // be failed HERE or it sits in `queued` forever with a `settled`
          // promise that never resolves.
          next.failToStart(
            err instanceof Error ? err.message : String(err),
          );
        })
        .finally(() => {
          this.running--;
          this.claimed.delete(next.id);
          void this.pump();
        });
    }
  }
}