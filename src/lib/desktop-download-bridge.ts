// ---------------------------------------------------------------------------
// SYNQ desktop download bridge (renderer).
//
// This is the renderer half of the desktop download path.
// It does NOT run yt-dlp and does not know what yt-dlp is. It only:
//  - sends the already-authorized relay URL to the main process,
//  - listens for progress / done / error over a narrow IPC channel.
//
// The main process owns the helper process, the executable, the temp file and
// the validation. The renderer owns UI state only.
//
// The surface lives at `window.synqDesktop.download` (installed by
// `electron/preload-download.cjs`), NOT directly on `window.synqDesktop` — the
// OAuth and tray surfaces share that object.
// ---------------------------------------------------------------------------

import type { DownloadMeta } from "@/lib/trackSource";

export interface DesktopDownloadResult {
  ok: boolean;
  localPath?: string;
  size?: number;
  contentType?: string;
  filename?: string;
  error?: { code: string; message: string };
}

export interface DesktopDownloadProgress {
  trackId: string;
  progress: number;
}

function desktopApi() {
  if (typeof window === "undefined") return null;
  return window.synqDesktop ?? null;
}

function isDesktop() {
  return !!desktopApi()?.isDesktop;
}

/** The download surface, or null when this build does not install it. */
function downloadBridge() {
  const bridge = desktopApi()?.download;
  return bridge && bridge.isDesktopDownloadBridge ? bridge : null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start a desktop download for a track the backend has authorized.
 *
 * `relayUrl` is the backend's download-proxy URL for the exact release.
 * `filename` and `meta` describe the saved file.
 *
 * Resolves once the helper reports done or error. Every listener registered
 * here is removed on settle, and the watchdog is cleared, so a finished (or
 * timed-out) transfer leaves nothing subscribed to later IPC traffic.
 */
export async function startDesktopDownload(
  relayUrl: string,
  trackId: string,
  filename: string,
  meta: DownloadMeta | undefined,
): Promise<DesktopDownloadResult> {
  const bridge = downloadBridge();
  if (!isDesktop() || !bridge) {
    return {
      ok: false,
      error: {
        code: "not-available",
        message: "Desktop downloads are not available on this platform.",
      },
    };
  }
  void meta;

  return new Promise<DesktopDownloadResult>((resolve) => {
    const offs: Array<() => void> = [];
    // Held on one object rather than a `let` binding so `finish` can release
    // it even when a bridge replays an event synchronously from
    // `onEvent`/`startDownload`. The timers are the globals, not `window.*`,
    // so this module also works in a test/worker context.
    const control: {
      settled: boolean;
      timer?: ReturnType<typeof setTimeout>;
    } = { settled: false };

    const finish = (result: DesktopDownloadResult) => {
      if (control.settled) return;
      control.settled = true;
      if (control.timer !== undefined) clearTimeout(control.timer);
      for (const off of offs) {
        try {
          off();
        } catch {
          /* unsubscribe must not throw into the caller */
        }
      }
      resolve(result);
    };

    const onDone = (detail: unknown) => {
      if (!detail || typeof detail !== "object") return;
      const data = detail as Record<string, unknown>;
      if (data.trackId !== trackId) return;
      finish({
        ok: true,
        ...(typeof data.localPath === "string" ? { localPath: data.localPath } : {}),
        ...(typeof data.size === "number" ? { size: data.size } : {}),
        ...(typeof data.contentType === "string"
          ? { contentType: data.contentType }
          : {}),
        ...(typeof data.filename === "string" ? { filename: data.filename } : {}),
      });
    };

    const onError = (detail: unknown) => {
      if (!detail || typeof detail !== "object") return;
      const data = detail as Record<string, unknown>;
      if (data.trackId !== trackId) return;
      finish({
        ok: false,
        error: {
          code: "extraction-failed",
          message:
            typeof data.message === "string" && data.message
              ? data.message
              : "The desktop download failed.",
        },
      });
    };

    offs.push(bridge.onEvent("done", onDone));
    offs.push(bridge.onEvent("error", onError));

    // The helper must not hang forever.
    control.timer = setTimeout(
      () =>
        finish({
          ok: false,
          error: {
            code: "timeout",
            message: "The download helper did not respond in time.",
          },
        }),
      15 * 60 * 1000,
    );

    bridge.startDownload(trackId, relayUrl, filename);
  });
}

/**
 * Ask the main process to abort the in-flight download for `trackId`.
 */
export function abortDesktopDownload(trackId: string): boolean {
  const bridge = downloadBridge();
  if (!isDesktop() || !bridge) return false;
  return bridge.abortDownload(trackId);
}

// ---------------------------------------------------------------------------
// Adapter factory hook
//
// The adapter shape the existing download manager expects. On desktop the bytes
// are fetched by the main process, so this adapter only forwards aborts; it is
// not yet wired into `installDownloadAdapter` (which still uses the browser
// sink). See the note at the end of the file.
// ---------------------------------------------------------------------------

export function createDesktopAdapter(
  relayUrl: string,
  filename: string,
  trackId: string,
  meta?: DownloadMeta,
) {
  void relayUrl;
  void filename;
  void meta;
  return {
    async probe() {
      return { status: 200, contentLength: null, acceptRanges: false };
    },
    async readRange() {
      throw new Error("Desktop downloads do not use ranged fetches in the renderer.");
    },
    async openStream() {
      throw new Error("Desktop downloads do not use streaming fetches in the renderer.");
    },
    async sink() {
      throw new Error("Desktop downloads do not expose a renderer sink.");
    },
    async abort() {
      abortDesktopDownload(trackId);
    },
  };
}

// NOTE: `installDownloadAdapter` still installs the browser adapter on every
// platform. Wiring the desktop adapter in requires the main process to surface
// the completed file back to the library; that is a feature, not a repair, and
// is intentionally out of scope for this reliability pass.

export { desktopApi, isDesktop, downloadBridge };
