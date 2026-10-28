import {
  getDownloadManager,
  forgetResolved,
  rememberResolved,
} from "@/lib/downloads";
import { downloadProxyUrl } from "@/lib/convexSite";
import { authorizedFilename, refuse, type DownloadRefusal } from "@/lib/downloadAuth";

/**
 * The authorized-download bridge: authorization -> bytes -> OPFS.
 *
 * ── Why this is a separate pipeline from playback ──────────────────────────
 *
 * Playback resolves its own source inside `store/player.ts` and never imports
 * anything from here. Downloading goes the other way: it asks the backend
 * whether a track may be saved, and only then hands a URL to the download
 * engine. Neither direction depends on the other, so a download can never stall
 * playback and a playback resolver can never be dragged into an offline path.
 *
 * ── Why the engine is reused rather than replaced ───────────────────────────
 *
 * `DownloadManager` already does the hard parts correctly: ranged reads,
 * resume from a real on-disk length, integrity validation, bounded concurrency,
 * and a duplicate guard. It is not the thing that was wrong — the thing that was
 * wrong was what it was pointed at. So this module keeps the engine untouched
 * and replaces only the source decision.
 *
 * ── Why the bytes come from SYNQ ────────────────────────────────────────────
 *
 * The provider's storage sends no CORS headers, so the browser cannot read a
 * licensed file directly. The transfer therefore targets `/download-proxy`,
 * which re-verifies the release server-side for every ranged request. The URL
 * is built from the release id the SERVER authorized, never from anything the
 * caller supplied, so a forged request still lands on a permission check.
 */

/** What the backend said about a track. */
export interface AuthorizationResult {
  /** The licensed release this permission is for. */
  providerId: string;
  filename: string;
  contentType: string;
  licenseUrl: string;
  attribution: string;
}

/** The metadata a download carries into the local library. */
export interface DownloadTrackInfo {
  title: string;
  artistName: string;
  albumName?: string;
  coverUrl?: string;
  duration?: number;
}

/** The outcome of asking to download, with copy the UI can show verbatim. */
export type AuthorizedDownloadResult =
  | { started: true }
  | { started: false; refusal: DownloadRefusal };

/**
 * Ask the backend to authorize `trackId`, then start the transfer.
 *
 * The source URL never comes from the caller: this function only forwards the
 * SYNQ track id to the server, which decides. A client that forges its way to
 * the manager directly still cannot obtain an unauthorized file, because the
 * relay it would have to fetch from re-checks the artist's permission itself.
 */
export async function requestAuthorizedDownload(
  authorize: (args: { trackId: string }) => Promise<
    | ({ authorized: true } & AuthorizationResult)
    | { authorized: false; decision: DownloadRefusal }
  >,
  trackId: string,
  opts: {
    force?: boolean;
    /**
     * The id the copy is STORED under, when it differs from the authorized
     * release id. A discovery-resolved track plays through its YouTube upload
     * and looks its local copy up by THAT id, while authorization is granted
     * for the Jamendo release. Default: same as `trackId`.
     */
    storageKey?: string;
    /** Title/artist/artwork, so the saved file can describe itself offline. */
    meta?: DownloadTrackInfo;
  } = {},
): Promise<AuthorizedDownloadResult> {
  const storageKey = opts.storageKey ?? trackId;
  const existing = getDownloadManager()
    .list()
    .find((record) => record.trackId === storageKey && record.status !== "failed");
  if (existing && !opts.force) {
    // Already queued or in flight: the manager's own guard makes this
    // idempotent, so a second press must not resolve or transfer anything.
    return { started: true };
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

  const proxyUrl = downloadProxyUrl(decision.providerId);
  if (!proxyUrl || !/^https:\/\//i.test(proxyUrl)) {
    // Without a known deployment origin there is no relay to fetch. Guessing
    // one would send a transfer to an unrelated host.
    return { started: false, refusal: refuse("not-configured") };
  }

  const filename =
    decision.filename?.trim() ||
    authorizedFilename(decision.providerId, "", "");

  const meta = opts.meta;

  try {
    // The authorized source is recorded first, so the adapter factory can never
    // start a transfer without one. Recorded under the STORAGE key, because
    // that is the id the manager and offline playback both use.
    rememberResolved(storageKey, {
      url: proxyUrl,
      filename,
      meta: {
        title: meta?.title ?? "",
        artistName: meta?.artistName ?? "",
        albumName: meta?.albumName ?? "",
        coverUrl: meta?.coverUrl ?? "",
        duration: meta?.duration ?? 0,
        providerId: decision.providerId,
        licenseUrl: decision.licenseUrl,
        attribution: decision.attribution,
        contentType: decision.contentType,
      },
    });
    getDownloadManager().enqueue({
      trackId: storageKey,
      filename,
      ...(opts.force !== undefined ? { force: opts.force } : {}),
    });
    return { started: true };
  } catch (error) {
    forgetResolved(storageKey);
    return {
      started: false,
      refusal: refuse(
        "invalid-request",
        error instanceof Error ? error.message : undefined,
      ),
    };
  }
}
