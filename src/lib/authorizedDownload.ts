import {
  isAllowedAudioContentType,
  providerForTrackId,
  safeDownloadStem,
  type DownloadProviderId,
} from "@/lib/downloadProviders";
import {
  nativeDownloadsSupported,
  startNativeDownload,
} from "@/lib/nativeDownloads";
import {
  DOWNLOAD_MESSAGES,
  refuse,
  type DownloadRefusal,
} from "@/lib/downloadAuth";

/**
 * Authorization -> validated native transfer.
 *
 * The Convex action is the authority on whether a track may be saved. This
 * module never fetches media itself and never constructs a URL from metadata:
 * it forwards the SYNQ track id, validates the server's grant shape, and hands
 * the granted URL to the platform's native queue. A web/PWA caller is refused
 * before any request is sent.
 */

export interface AuthorizationResult {
  downloadUrl: string;
  filename: string;
  contentType: string;
  licenseUrl: string;
  attribution: string;
  artworkUrl?: string;
  durationMs?: number;
  title?: string;
  artist?: string;
  provider?: DownloadProviderId;
}

export type AuthorizedDownloadResult =
  | { started: true }
  | { started: false; refusal: DownloadRefusal };

export async function requestAuthorizedDownload(
  authorize: (args: { trackId: string }) => Promise<
    | ({ authorized: true } & AuthorizationResult)
    | { authorized: false; decision: DownloadRefusal }
  >,
  trackId: string,
  opts: {
    force?: boolean;
    /**
     * The id the local copy is stored under when it differs from the licensed
     * release id. A Jamendo-discovered track plays through its YouTube upload
     * and offline playback looks it up by that playable id.
     */
    storageKey?: string;
  } = {},
): Promise<AuthorizedDownloadResult> {
  if (!nativeDownloadsSupported()) {
    return { started: false, refusal: refuse("unsupported-platform") };
  }

  const storageKey = opts.storageKey ?? trackId;
  if (!storageKey || !trackId) {
    return { started: false, refusal: refuse("invalid-request") };
  }

  let decision;
  try {
    decision = await authorize({ trackId });
  } catch {
    return { started: false, refusal: refuse("network") };
  }

  if (!decision.authorized) {
    return { started: false, refusal: decision.decision };
  }
  if (
    !decision.downloadUrl ||
    !/^https:\/\//i.test(decision.downloadUrl) ||
    !isAllowedAudioContentType(decision.contentType ?? "")
  ) {
    return { started: false, refusal: refuse("not-found") };
  }

  const provider =
    decision.provider ?? providerForTrackId(trackId)?.id ?? "jamendo";
  if (!providerForTrackId(trackId) && provider !== "jamendo") {
    return { started: false, refusal: refuse("not-authorized") };
  }

  const title = decision.title?.trim() ?? "";
  const artist = decision.artist?.trim() ?? "";
  const filename = safeDownloadStem(
    decision.filename?.trim() ?? "",
    artist,
    title,
    storageKey,
  );
  const licenseUrl = /^https:\/\//i.test(decision.licenseUrl ?? "")
    ? decision.licenseUrl
    : provider === "soundcloud"
      ? `https://soundcloud.com/`
      : `https://www.jamendo.com/track/${encodeURIComponent(
          trackId.replace(/^jamendo:/, ""),
        )}`;

  const result = await startNativeDownload({
    trackId: storageKey,
    downloadUrl: decision.downloadUrl,
    filename,
    contentType: decision.contentType,
    provider,
    title,
    artist,
    ...(decision.artworkUrl ? { artworkUrl: decision.artworkUrl } : {}),
    ...(Number.isFinite(decision.durationMs)
      ? { durationMs: decision.durationMs }
      : {}),
    licenseUrl,
    attribution: decision.attribution?.trim() ?? "",
  });

  if (!result.started) {
    return {
      started: false,
      refusal: refuse(
        result.reason === "unsupported-platform"
          ? "unsupported-platform"
          : "invalid-request",
        result.message || DOWNLOAD_MESSAGES["invalid-request"],
      ),
    };
  }
  return { started: true };
}
