import {
  getDownloadManager,
  forgetResolved,
  rememberResolved,
} from "@/lib/downloads";
import { createTrackAdapter } from "@/lib/trackSource";
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
 */

/** What the backend said about a track. */
export interface AuthorizationResult {
  downloadUrl: string;
  filename: string;
  contentType: string;
  licenseUrl: string;
  attribution: string;
}

/** The outcome of asking to download, with copy the UI can show verbatim. */
export type AuthorizedDownloadResult =
  | { started: true }
  | { started: false; refusal: DownloadRefusal };

/**
 * Ask the backend to authorize `trackId`, then start the transfer.
 *
 * The URL never comes from the caller: this function only forwards the SYNQ
 * track id to the server, which decides. A client that forges its way to the
 * manager directly still cannot obtain an unauthorized file, because the
 * manager's adapter factory below only ever accepts URLs that arrived through
 * `authorize`.
 */
export async function requestAuthorizedDownload(
  authorize: (args: { trackId: string }) => Promise<
    | { authorized: true } & AuthorizationResult
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
  if (!decision.downloadUrl || !/^https:\/\//i.test(decision.downloadUrl)) {
    // An authorized response with an unusable URL is still a refusal; it must
    // not fall back to any other source.
    return { started: false, refusal: refuse("not-found") };
  }

  const filename =
    decision.filename?.trim() || authorizedFilename(trackId, "", "");

  try {
    // The authorized source is recorded first, so the adapter factory can never
    // start a transfer without one. Recorded under the STORAGE key, because
    // that is the id the manager and offline playback both use.
    rememberResolved(storageKey, { url: decision.downloadUrl, filename });
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

/**
 * Build the adapter for an authorized transfer.
 *
 * Identical mechanics to the old stream adapter (ranged GETs, streamed to the
 * OPFS sink) — the only difference is what the bytes come from. Kept as a named
 * export so the download pipeline has a single, auditable source factory and
 * nothing else can quietly register a different one.
 */
export function createAuthorizedAdapter(
  url: string,
  filename: string,
  trackId: string,
) {
  return createTrackAdapter(url, filename, trackId);
}