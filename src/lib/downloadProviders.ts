/**
 * Download provider registry.
 *
 * A provider is eligible only when the rights holder has explicitly granted a
 * download. Streaming availability is never used as evidence of permission.
 * Jamendo exposes `audiodownload_allowed`; SoundCloud exposes the artist's
 * `downloadable` flag. Both are re-checked by Convex for every request, so this
 * registry is a client-side capability description, not the authority.
 */

export type DownloadProviderId = "jamendo" | "soundcloud";

export interface DownloadProvider {
  id: DownloadProviderId;
  label: string;
  /** Prefix used by SYNQ's stable track ids for this provider. */
  trackIdPrefix: string;
  /** Field that must be true in the provider's own response. */
  grantField: string;
  /** Human-readable description shown in download details. */
  authorization: string;
  /** Formats this provider is known to serve. */
  formats: readonly AudioFormat[];
}

export type AudioFormat = "mp3" | "m4a" | "aac" | "flac" | "wav" | "ogg";

export const AUDIO_FORMATS: readonly AudioFormat[] = [
  "mp3",
  "m4a",
  "aac",
  "flac",
  "wav",
  "ogg",
];

export const DOWNLOAD_PROVIDERS: readonly DownloadProvider[] = [
  {
    id: "jamendo",
    label: "Jamendo",
    trackIdPrefix: "jamendo:",
    grantField: "audiodownload_allowed",
    authorization:
      "The artist explicitly enabled downloads for this Jamendo release.",
    formats: ["mp3"],
  },
  {
    id: "soundcloud",
    label: "SoundCloud",
    trackIdPrefix: "sc:",
    grantField: "downloadable",
    authorization:
      "The artist explicitly enabled downloads and the official SoundCloud API returned a download resource for this track.",
    formats: ["mp3", "m4a", "aac", "flac", "wav", "ogg"],
  },
];

export function getDownloadProvider(
  id: string | null | undefined,
): DownloadProvider | null {
  if (!id) return null;
  return DOWNLOAD_PROVIDERS.find((provider) => provider.id === id) ?? null;
}

export function providerForTrackId(
  trackId: string | null | undefined,
): DownloadProvider | null {
  if (!trackId) return null;
  return (
    DOWNLOAD_PROVIDERS.find((provider) =>
      trackId.trim().startsWith(provider.trackIdPrefix),
    ) ?? null
  );
}

/** Content types accepted from a provider's granted file URL. */
export function isAllowedAudioContentType(contentType: string): boolean {
  const value = contentType.split(";")[0].trim().toLowerCase();
  return (
    value.startsWith("audio/") ||
    value === "application/ogg" ||
    value === "application/octet-stream"
  );
}

/**
 * Browsers and native agents report many aliases. Normalize only values that
 * map unambiguously to a real container.
 */
export function formatFromContentType(
  contentType: string,
): AudioFormat | null {
  const value = contentType.split(";")[0].trim().toLowerCase();
  switch (value) {
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/mp4":
    case "audio/x-m4a":
    case "audio/m4a":
      return "m4a";
    case "audio/aac":
    case "audio/aacp":
      return "aac";
    case "audio/flac":
    case "audio/x-flac":
      return "flac";
    case "audio/wav":
    case "audio/wave":
    case "audio/x-wav":
      return "wav";
    case "audio/ogg":
    case "application/ogg":
    case "audio/opus":
      return "ogg";
    default:
      return null;
  }
}

/**
 * Strip a claimed extension without trusting it. Native storage inspects the
 * bytes and chooses the real extension after the transfer.
 */
export function safeDownloadStem(
  claimedFilename: string,
  artist: string,
  title: string,
  fallbackId: string,
): string {
  const clean = (value: string) =>
    value
      .replace(/[\\/:*?"<>|]/g, "-")
      .replace(/\p{C}/gu, "")
      .replace(/\.{2,}/g, "")
      .replace(/\s+/g, " ")
      .replace(/^[-. ]+|[-. ]+$/g, "")
      .trim();
  const withoutExtension = clean(
    claimedFilename.replace(/\.(mp3|m4a|aac|flac|wav|ogg|opus|mp4|webm)$/i, ""),
  );
  const generated = [artist, title].map(clean).filter(Boolean).join(" - ");
  const stem = withoutExtension || generated || `track-${fallbackId}`;
  return stem.slice(0, 140).replace(/[. ]+$/g, "") || `track-${fallbackId}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
