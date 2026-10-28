// ---------------------------------------------------------------------------
// SYNQ desktop download status — the renderer half of the status card.
//
// WHAT THIS IS
// ------------
// A thin, honest reader of the optional desktop download bridge installed by
// `electron/preload-download.cjs`. It answers exactly two questions:
//
//   1. Is that bridge present in this build?
//   2. What progress/done/error events has it emitted?
//
// WHAT THIS IS NOT
// ----------------
// It is not a probe of yt-dlp, and it does not start a download to find out
// whether downloads work. The earlier version sent `startDownload("__probe__",
// "__probe__", "__probe__")` through the real IPC channel and waited for an
// event that the main process never sends for a fake track id — so the card
// either spun forever or silently claimed the executable was available. A
// status surface must not perform a fake download to guess at a fact it was
// never told.
//
// The main process does own a real probe (`electron/yt-dlp-availability.cjs`),
// but it is not exposed over IPC yet. Until it is, the card reports the bridge
// connection truthfully and makes no claim about the executable.
// ---------------------------------------------------------------------------

export type DesktopDownloadState = "starting" | "downloading" | "done" | "error";

export interface DesktopDownloadProgress {
  trackId: string;
  progress: number;
  state: DesktopDownloadState;
  error?: string;
}

export interface DesktopDownloadHandlers {
  onProgress?: (event: DesktopDownloadProgress) => void;
  onDone?: (event: { trackId: string; localPath?: string }) => void;
  onError?: (event: { trackId: string; message?: string }) => void;
}

/** The preload download surface, when this build installs it. */
function downloadBridge() {
  if (typeof window === "undefined") return undefined;
  const bridge = window.synqDesktop?.download;
  return bridge && bridge.isDesktopDownloadBridge ? bridge : undefined;
}

/**
 * True only when the desktop download IPC surface really exists.
 *
 * `isDesktop` alone is not enough: the shell installs the OAuth and tray
 * surfaces in `preload.cjs`, while the download surface lives in a separate
 * optional preload. A build can legitimately have one and not the other.
 */
export function hasDesktopDownloadBridge(): boolean {
  return downloadBridge() !== undefined;
}

/** Coerce an unknown IPC payload into the renderer's progress shape. */
function toProgress(detail: unknown): DesktopDownloadProgress | null {
  if (!detail || typeof detail !== "object") return null;
  const data = detail as Record<string, unknown>;
  const trackId = data.trackId;
  if (typeof trackId !== "string" || trackId.length === 0) return null;
  // The probe id from older builds must never be shown as a real transfer.
  if (trackId === "__probe__") return null;
  const progress = typeof data.progress === "number" ? data.progress : 0;
  const state = data.state;
  const error = data.message ?? data.error;
  return {
    trackId,
    progress: Math.min(100, Math.max(0, progress)),
    state:
      state === "starting" || state === "downloading" || state === "done" || state === "error"
        ? state
        : "downloading",
    ...(typeof error === "string" ? { error } : {}),
  };
}

/**
 * Subscribe to the bridge's download events.
 *
 * Returns a no-op unsubscribe when the bridge is absent, so callers on web and
 * Android do not need their own guard.
 */
export function subscribeDesktopDownloads(
  handlers: DesktopDownloadHandlers,
): () => void {
  const bridge = downloadBridge();
  if (!bridge) return () => {};

  const offProgress = bridge.onEvent("progress", (detail) => {
    const event = toProgress(detail);
    if (event) handlers.onProgress?.(event);
  });
  const offDone = bridge.onEvent("done", (detail) => {
    const event = toProgress(detail);
    if (!event) return;
    handlers.onDone?.({ trackId: event.trackId });
  });
  const offError = bridge.onEvent("error", (detail) => {
    const event = toProgress(detail);
    if (!event) return;
    handlers.onError?.({ trackId: event.trackId, message: event.error });
  });

  return () => {
    offProgress();
    offDone();
    offError();
  };
}
