import { OpfsSink, opfsSupported } from "@/lib/opfsSink";
import type { DownloadAdapter, Segment } from "@/lib/downloadManager";

/**
 * The download SOURCE adapter.
 *
 * ── What was removed from this file, and why ──────────────────────────────
 *
 * This used to also contain `resolveStreamUrl()`, a helper whose whole job was
 * to turn a YouTube video id into a direct media URL: it called the server's
 * InnerTube extraction action and, when that was bot-blocked, fell through to
 * public Piped mirrors. `DownloadHub` then handed the result to the download
 * engine, which wrote the bytes to disk.
 *
 * That is saving a copy of audio SYNQ only ever had permission to STREAM, so
 * it was not a bug to be repaired but the wrong source, and it is gone. Its
 * last production caller was removed in the same change, and its dedicated test
 * (`scripts/audit.resolve.ts`) was deleted with it rather than left asserting
 * behaviour nothing uses.
 *
 * Downloads now get their URL from `convex/downloads.ts`, which re-verifies
 * the artist's `audiodownload_allowed` grant server-side. `lib/downloadAuth.ts`
 * owns the rules; `lib/authorizedDownload.ts` calls the backend; this file owns
 * only the mechanics of pulling authorized bytes to disk.
 *
 * NOTE — `lib/customResolver.ts` and `lib/pipedResolve.ts` were NOT removed.
 * They look related (they were built for this same path) but they are also the
 * PLAYBACK resolver's fallback, which is a different system and is still in
 * use by `store/player.ts`. Deleting them here would have broken playback.
 *
 * ── Mechanics (unchanged) ────────────────────────────────────────────────
 *
 * Ranged GETs so a dropped connection resumes instead of restarting, and the
 * `googlevideo.com`-shaped CORS problem is irrelevant here because an
 * authorized download URL is served with CORS headers of its own.
 */

/** Build the adapter the manager uses, for one authorized transfer. */
export function createTrackAdapter(
  url: string,
  filename: string,
  id: string,
): DownloadAdapter {
  if (!opfsSupported()) {
    throw new Error(
      "This browser has no filesystem for downloads (Origin Private File System)",
    );
  }
  let sink: OpfsSink | null = null;
  const getSink = async (): Promise<OpfsSink> => {
    sink ??= await OpfsSink.open(filename, id);
    return sink;
  };

  const timedFetch = async (
    input: string,
    init: RequestInit & { timeoutMs: number },
  ): Promise<Response> => {
    const { timeoutMs, ...rest } = init;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    init.signal?.addEventListener("abort", onAbort);
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(input, { ...rest, signal: controller.signal });
    } finally {
      window.clearTimeout(timer);
      init.signal?.removeEventListener("abort", onAbort);
    }
  };

  return {
    async probe(timeoutMs) {
      // A ranged GET is the only reliable probe: many origins do not answer
      // HEAD with an accurate length or an Accept-Ranges header. Asking for
      // the first byte tells us both, and the body is discarded.
      const res = await timedFetch(url, {
        headers: { Range: "bytes=0-0" },
        timeoutMs,
      });
      // A 200 here means the origin ignored the range and is streaming the
      // whole entity — record that rather than assuming ranges work.
      if (res.status === 200) {
        return {
          status: 200,
          contentLength: numberHeader(res, "content-length"),
          acceptRanges: false,
        };
      }
      const contentRange = res.headers.get("content-range");
      const total = contentRange?.split("/")[1];
      return {
        status: 206,
        contentLength: total && total !== "*" ? Number(total) : null,
        acceptRanges: true,
      };
    },

    async openRange(segment: Segment, timeoutMs, signal) {
      const res = await timedFetch(url, {
        headers: { Range: `bytes=${segment.start}-${segment.end - 1}` },
        timeoutMs,
        signal,
      });
      return {
        status: res.status,
        headers: res.headers,
        body: res.body,
      };
    },

    async openStream(timeoutMs, signal) {
      const res = await timedFetch(url, { timeoutMs, signal });
      return { status: res.status, headers: res.headers, body: res.body };
    },

    // `FileSink` is a structural interface, so forwarding every method is
    // enough — no getter, no cast. Opening happens on the first call, which
    // is also what makes a resume pick up an existing `.part` file.
    sink: {
      bytesWritten: () => getSink().then((s) => s.bytesWritten()),
      append: (chunk: Uint8Array) => getSink().then((s) => s.append(chunk)),
      truncate: (to: number) => getSink().then((s) => s.truncate(to)),
      commit: () => getSink().then((s) => s.commit()),
      discardIncomplete: () => getSink().then((s) => s.discardIncomplete()),
    },
  };
}

function numberHeader(res: Response, name: string): number | null {
  const raw = res.headers.get(name);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}