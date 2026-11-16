import { Capacitor, registerPlugin } from "@capacitor/core";
import type { AudioFormat, DownloadProviderId } from "@/lib/downloadProviders";

/**
 * The ONLY frontend entry point to offline storage.
 *
 * Android is backed by the SynqDownloads Capacitor plugin, which owns a
 * persistent native queue and writes into app-private storage. Electron is
 * backed by the main-process download manager over validated IPC. A website
 * has neither bridge, so every mutating call here returns an explicit
 * unsupported-platform result instead of falling back to OPFS or a browser
 * download.
 */

export type NativeDownloadStatus =
  | "queued"
  | "downloading"
  | "validating"
  | "completed"
  | "failed"
  | "cancelled";

export interface NativeDownloadMetadata {
  title: string;
  artist: string;
  album?: string;
  artworkUrl?: string;
  durationMs?: number;
  licenseUrl: string;
  attribution: string;
  provider: DownloadProviderId;
}

export interface NativeDownloadRecord {
  id: string;
  trackId: string;
  filename: string;
  status: NativeDownloadStatus;
  bytes: number;
  totalBytes: number | null;
  progress: number;
  speed: number;
  etaMs: number | null;
  error?: string;
  format?: AudioFormat;
  fileSize?: number;
  downloadedAt?: number;
  metadata: NativeDownloadMetadata;
  /** Native-only locator. Never rendered or accepted back as an input path. */
  uri?: string;
}

export interface NativeDownloadRequest extends NativeDownloadMetadata {
  trackId: string;
  downloadUrl: string;
  filename: string;
  contentType: string;
}

export interface NativeStorageInfo {
  usedBytes: number;
  fileCount: number;
  availableBytes: number | null;
  directory: string;
}

interface SynqDownloadsPlugin {
  list(): Promise<{ records: NativeDownloadRecord[] }>;
  start(options: { request: NativeDownloadRequest }): Promise<{
    record: NativeDownloadRecord;
  }>;
  cancel(options: { id: string }): Promise<void>;
  retry(options: { id: string }): Promise<void>;
  remove(options: { id: string }): Promise<{ removed: boolean }>;
  getPlaybackPath(options: { trackId: string }): Promise<{ path: string | null }>;
  getArtworkPath(options: { trackId: string }): Promise<{ path: string | null }>;
  getStorage(): Promise<NativeStorageInfo>;
  addListener(
    eventName: "downloadsChanged",
    listener: () => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

const androidPlugin = registerPlugin<SynqDownloadsPlugin>("SynqDownloads");

export type DownloadsPlatform = "android" | "electron" | "web";

interface ElectronDownloadsBridge {
  isSupported: true;
  list: () => Promise<{ records: NativeDownloadRecord[] }>;
  start: (request: NativeDownloadRequest) => Promise<{
    record: NativeDownloadRecord;
  }>;
  cancel: (id: string) => Promise<void>;
  retry: (id: string) => Promise<void>;
  remove: (id: string) => Promise<{ removed: boolean }>;
  getPlaybackUrl: (trackId: string) => Promise<{ url: string | null }>;
  getArtworkUrl: (trackId: string) => Promise<{ url: string | null }>;
  getStorage: () => Promise<NativeStorageInfo>;
  onChanged: (listener: () => void) => () => void;
}

function electronBridge(): ElectronDownloadsBridge | null {
  if (typeof window === "undefined") return null;
  const desktop = (
    window as Window & {
      synqDesktop?: { isDesktop?: boolean; downloads?: ElectronDownloadsBridge };
    }
  ).synqDesktop;
  if (
    desktop?.isDesktop !== true ||
    desktop.downloads?.isSupported !== true ||
    typeof desktop.downloads.start !== "function"
  ) {
    return null;
  }
  return desktop.downloads;
}

/**
 * Capacitor's native runtime is the platform fact. `isPluginAvailable` asks
 * the registered native bridge, not the viewport and not the user agent.
 */
export function downloadsPlatform(): DownloadsPlatform {
  if (electronBridge()) return "electron";
  if (
    typeof window !== "undefined" &&
    Capacitor.isNativePlatform() &&
    Capacitor.getPlatform() === "android" &&
    Capacitor.isPluginAvailable("SynqDownloads")
  ) {
    return "android";
  }
  return "web";
}

export function nativeDownloadsSupported(): boolean {
  return downloadsPlatform() !== "web";
}

export function nativeDownloadsPlatformLabel(): string {
  const platform = downloadsPlatform();
  if (platform === "android") return "Android app";
  if (platform === "electron") return "Desktop app";
  return "Web";
}

export async function listNativeDownloads(): Promise<NativeDownloadRecord[]> {
  const platform = downloadsPlatform();
  if (platform === "web") return [];
  try {
    const result =
      platform === "electron"
        ? await electronBridge()!.list()
        : await androidPlugin.list();
    return Array.isArray(result.records) ? result.records : [];
  } catch {
    return [];
  }
}

export async function startNativeDownload(
  request: NativeDownloadRequest,
): Promise<
  | { started: true; record: NativeDownloadRecord }
  | { started: false; reason: "unsupported-platform" | "storage"; message: string }
> {
  const platform = downloadsPlatform();
  if (platform === "web") {
    return {
      started: false,
      reason: "unsupported-platform",
      message: "Downloads are available only in the SYNQ Android and desktop apps.",
    };
  }
  try {
    const result =
      platform === "electron"
        ? await electronBridge()!.start(request)
        : await androidPlugin.start({ request });
    return { started: true, record: result.record };
  } catch (error) {
    return {
      started: false,
      reason: "storage",
      message:
        error instanceof Error
          ? error.message
          : "The native download could not be started.",
    };
  }
}

export async function cancelNativeDownload(id: string): Promise<void> {
  const platform = downloadsPlatform();
  if (platform === "electron") return electronBridge()!.cancel(id);
  if (platform === "android") return androidPlugin.cancel({ id });
}

export async function retryNativeDownload(id: string): Promise<void> {
  const platform = downloadsPlatform();
  if (platform === "electron") return electronBridge()!.retry(id);
  if (platform === "android") return androidPlugin.retry({ id });
}

export async function removeNativeDownload(id: string): Promise<boolean> {
  const platform = downloadsPlatform();
  if (platform === "electron") {
    return (await electronBridge()!.remove(id)).removed;
  }
  if (platform === "android") {
    return (await androidPlugin.remove({ id })).removed;
  }
  return false;
}

export async function nativeStorageInfo(): Promise<NativeStorageInfo | null> {
  const platform = downloadsPlatform();
  if (platform === "web") return null;
  try {
    return platform === "electron"
      ? await electronBridge()!.getStorage()
      : await androidPlugin.getStorage();
  } catch {
    return null;
  }
}

/**
 * A local URL for playback, or null when there is no validated completed file.
 * Native code resolves the path by track id; the renderer never supplies one.
 */
export async function localAudioUrl(trackId: string): Promise<string | null> {
  if (!trackId) return null;
  const platform = downloadsPlatform();
  try {
    if (platform === "electron") {
      return (await electronBridge()!.getPlaybackUrl(trackId)).url;
    }
    if (platform === "android") {
      const { path } = await androidPlugin.getPlaybackPath({ trackId });
      return path ? Capacitor.convertFileSrc(path) : null;
    }
    return null;
  } catch {
    return null;
  }
}

export async function localArtworkUrl(trackId: string): Promise<string | null> {
  if (!trackId) return null;
  const platform = downloadsPlatform();
  try {
    if (platform === "electron") {
      return (await electronBridge()!.getArtworkUrl(trackId)).url;
    }
    if (platform === "android") {
      const { path } = await androidPlugin.getArtworkPath({ trackId });
      return path ? Capacitor.convertFileSrc(path) : null;
    }
    return null;
  } catch {
    return null;
  }
}

/** Subscribe to native queue changes. Returns an unsubscribe function. */
export function subscribeNativeDownloads(listener: () => void): () => void {
  const platform = downloadsPlatform();
  if (platform === "electron") {
    return electronBridge()!.onChanged(listener);
  }
  if (platform === "android") {
    let disposed = false;
    let remove: (() => Promise<void>) | null = null;
    void androidPlugin
      .addListener("downloadsChanged", () => {
        if (!disposed) listener();
      })
      .then((handle) => {
        remove = handle.remove;
        if (disposed) void remove();
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      void remove?.();
    };
  }
  return () => undefined;
}

/** Never allow a download action on a browser/PWA installation. */
export function assertNativeDownloadPlatform(): void {
  if (!nativeDownloadsSupported()) {
    throw new Error(
      "Downloads are available only in the SYNQ Android and desktop apps.",
    );
  }
}
