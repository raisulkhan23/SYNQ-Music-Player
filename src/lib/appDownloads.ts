/**
 * Where the SYNQ installers actually live.
 *
 * The Android build (a release APK, ~4 MB) is small enough to ship with the
 * site, so it is copied into `public/downloads/` and served from the same
 * origin as everything else — one place, no third party, works on the hosted
 * site and in the packaged desktop app via `publicAsset`.
 *
 * The Windows installers are ~128 MB each. Bundling them into `public/` would
 * add that weight to every deploy and to every `dist/` the Android build
 * copies, so they are hosted instead of bundled. Set
 * `VITE_WINDOWS_DOWNLOAD_URL` to wherever they are published (a GitHub Release,
 * an object store, the site's own `/downloads`). Without it the button falls
 * back to the GitHub Releases "latest" URL for the artifact this repo produces,
 * which is the conventional home for them.
 */
import { isNativeShell } from "@/lib/nativeShell";
import { isFileProtocol, publicAsset } from "@/lib/publicAsset";

/** Must match the version in package.json / the built artifacts. */
export const APP_VERSION = "1.0.0";

/** Artifact names as produced by `npm run desktop:win` and `android:release`. */
export const WINDOWS_INSTALLER_NAME = `SYNQ-${APP_VERSION}-x64.exe`;
export const ANDROID_APK_NAME = `SYNQ-${APP_VERSION}.apk`;

export type AppPlatform = "windows" | "android";

export type AppDownload = {
  id: AppPlatform;
  /** Shown on the button. */
  label: string;
  /** One-line requirement, so nobody downloads a file their machine can't run. */
  requirement: string;
  /** What the download actually is, for the settings row description. */
  detail: string;
  href: string;
  fileName: string;
  /** Bytes, when known. Used only for the label; never blocks the download. */
  sizeLabel: string;
};

function resolveWindowsUrl(): string {
  const configured = (
    import.meta.env.VITE_WINDOWS_DOWNLOAD_URL as string | undefined
  )?.trim();
  if (configured) return configured;
  return `https://github.com/raisulkhan23/synqmusic/releases/latest/download/${WINDOWS_INSTALLER_NAME}`;
}

/** All platforms, in the order they should be offered. */
export const APP_DOWNLOADS: readonly AppDownload[] = [
  {
    id: "windows",
    label: "Download for Windows",
    requirement: "Windows 10 or 11 · 64-bit",
    detail: "Installer for Windows 10 and 11 (64-bit).",
    href: resolveWindowsUrl(),
    fileName: WINDOWS_INSTALLER_NAME,
    sizeLabel: "≈128 MB",
  },
  {
    id: "android",
    label: "Download for Android",
    requirement: "Android 8 or newer",
    detail: "Release APK. Allow installs from your browser when prompted.",
    // Served from this origin, so it works on the site and in the app bundle.
    href: publicAsset(`downloads/${ANDROID_APK_NAME}`),
    fileName: ANDROID_APK_NAME,
    sizeLabel: "≈4 MB",
  },
] as const;

/**
 * The downloads this runtime can actually deliver.
 *
 * The Android installer is hidden where it makes no sense:
 * - packaged desktop app (`file://`): the APK is deliberately not shipped
 *   inside the desktop bundle (see `electron-builder.yml`), so the link would
 *   not resolve.
 * - native Android shell: the app is already installed, and the build strips
 *   the APK out of the web assets (`scripts/strip-downloads-from-dist.cjs`).
 *
 * The hosted site is the one place both are offered, which is the point of it.
 */
export function appDownloads(): AppDownload[] {
  if (isFileProtocol() || isNativeShell()) {
    return APP_DOWNLOADS.filter((item) => item.id !== "android");
  }
  return [...APP_DOWNLOADS];
}
