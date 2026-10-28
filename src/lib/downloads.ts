import {
  DownloadManager,
  type DownloadAdapter,
  type DownloadConfig,
} from "@/lib/downloadManager";
import type { Playable } from "@/lib/playable";
import type { DownloadMeta } from "@/lib/trackSource";

/**
 * The single, app-level download manager, and the bridge between "something
 * wants to download this track" and the queue that performs transfers.
 *
 * WHY THIS IS A SINGLETON, NOT A COMPONENT'S STATE. The manager owns the
 * in-flight transfers, the concurrency budget and the duplicate guard, so two
 * instances would be two competing queues. An earlier version had the Download
 * Hub own it and register it on mount — which was wrong: a track's context
 * menu is used on search, liked songs, recently played and the queue, where
 * the hub is NOT mounted. Every menu press therefore found no manager, so the
 * Download action could never start a transfer even once a source adapter was
 * wired in. The manager has to outlive any single page.
 *
 * It is created lazily on first use, so nothing is constructed on pages that
 * never download anything.
 */

export const DOWNLOAD_CONFIG: Partial<DownloadConfig> = {
  chunkSize: 1_048_576,
  maxConcurrentRanges: 2,
  timeoutMs: 30_000,
  maxFileSize: 512 * 1_048_576,
};

export type AdapterFactory = (download: {
  id: string;
  filename: string;
  trackId: string;
}) => DownloadAdapter | Promise<DownloadAdapter>;

let manager: DownloadManager | null = null;
let adapterFactory: AdapterFactory | null = null;

/**
 * Supply the adapter that actually fetches bytes.
 *
 * Called once at app start. Until this is called with a working source,
 * `requestTrackDownload` reports that nothing is downloadable — which is the
 * honest answer today, because every provider SYNQ streams from licenses
 * streaming rather than download.
 */
export function registerDownloadAdapter(factory: AdapterFactory | null): void {
  adapterFactory = factory;
  // The manager is deliberately NOT recreated here. Its factory closure reads
  // `adapterFactory` at CALL time, so a newly registered adapter is picked up
  // without a rebuild. Resetting `manager` used to throw away every download
  // already in flight — and because the track menu enqueues a download and
  // then navigates to /downloads, where this registration happens, every
  // single menu-started download was wiped the instant its own hub opened.
}

/** The one manager, created on first use. */
export function getDownloadManager(): DownloadManager {
  if (!manager) {
    manager = new DownloadManager(DOWNLOAD_CONFIG, (d) => {
      if (!adapterFactory) {
        // Refusing is deliberate. An adapter that quietly succeeded would
        // produce an empty file reported as a finished download.
        throw new Error("No download source is configured");
      }
      return adapterFactory(d);
    });
  }
  return manager;
}

/** True when a source that can actually fetch media has been configured. */
export function downloadsAvailable(): boolean {
  return adapterFactory !== null;
}

export interface DownloadRequestResult {
  started: boolean;
  /** Why not, when `started` is false. Safe to show to a user. */
  reason?: "no-source" | "not-downloadable" | "unresolved";
  /** The provider's own reason, when it gave one. */
  detail?: string;
}

/**
 * Resolved streams, keyed by track id.
 *
 * The manager holds ONE adapter factory for the whole app, but each download
 * needs its own stream URL. Resolving up front and storing it here is what
 * lets the shared factory hand each download the right one — and it means a
 * provider refusal surfaces to the user immediately, at press time, instead of
 * buried in a background transfer failure.
 */
/** One authorized source, remembered between `enqueue` and the transfer. */
export interface ResolvedDownload {
  /** The URL the engine fetches. For downloads this is SYNQ's own relay. */
  url: string;
  filename: string;
  /** Metadata written into the local library when the transfer completes. */
  meta?: DownloadMeta;
}

const resolved = new Map<string, ResolvedDownload>();

/** Called by the registered factory to claim a download's resolved stream. */
export function takeResolved(trackId: string): ResolvedDownload | null {
  return resolved.get(trackId) ?? null;
}

/** Forget a resolved stream so a signed URL is not kept around. */
export function forgetResolved(trackId: string): void {
  resolved.delete(trackId);
}

/** A desktop-only relay URL resolved for one track, if the shell has started to resolve it. */
export interface DesktopResolvedDownload extends ResolvedDownload {
  relayUrl: string;
}

const desktopResolved = new Map<string, DesktopResolvedDownload>();

/** Called by the desktop path before handing control to the shell. */
export function rememberDesktopResolved(
  trackId: string,
  source: DesktopResolvedDownload,
): void {
  desktopResolved.set(trackId, source);
}

/** Read a desktop-resolved relay URL, if one was remembered. */
export function takeDesktopResolved(
  trackId: string,
): DesktopResolvedDownload | null {
  return desktopResolved.get(trackId) ?? null;
}

/**
 * Record the authorized source for a download BEFORE enqueuing it.
 *
 * The adapter factory reads this map at transfer time, so the URL a download
 * pulls from is the one the backend just authorized for that exact track — it
 * cannot be supplied by the caller, and a download whose entry is missing is
 * refused by the factory rather than silently producing an empty file.
 */
export function rememberResolved(
  trackId: string,
  source: ResolvedDownload,
): void {
  resolved.set(trackId, source);
}

/**
 * Ask for `track` to be downloaded.
 *
 * `resolve` performs the provider lookup and returns the stream URL. It is
 * required because there is no other way to know whether a transfer can
 * actually start — and returning `started: false` on refusal is the whole
 * point of this function being honest.
 */
export async function requestTrackDownload(
  track: Pick<Playable, "id" | "title" | "artistName">,
  resolve: () => Promise<{ url: string; filename?: string }>,
  opts: { force?: boolean } = {},
): Promise<DownloadRequestResult> {
  const existing = getDownloadManager()
    .list()
    .find((r) => r.trackId === track.id && r.status !== "failed");
  if (existing && !opts.force) {
    // Already queued or downloading: the manager's own guard makes a repeat
    // press idempotent, so there is nothing to resolve again.
    return { started: true };
  }

  let stream: { url: string; filename?: string };
  try {
    stream = await resolve();
  } catch (err) {
    return {
      started: false,
      reason: "unresolved",
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const filename = (stream.filename ?? `${track.artistName} - ${track.title}`)
    .replace(/[\\/:*?"<>|]/g, "-")
    .slice(0, 120);
  resolved.set(track.id, { url: stream.url, filename });

  try {
    getDownloadManager().enqueue({
      trackId: track.id,
      filename,
      force: opts.force,
    });
    return { started: true };
  } catch (err) {
    resolved.delete(track.id);
    return {
      started: false,
      reason: "not-downloadable",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}