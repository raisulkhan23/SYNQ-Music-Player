import { registerDownloadAdapter, takeResolved } from "@/lib/downloads";
import { createTrackAdapter } from "@/lib/trackSource";
import { prependToStoredDownload } from "@/lib/opfsSink";
import type { DownloadAdapter } from "@/lib/downloadManager";

/**
 * Installs the download adapter once, at app level.
 *
 * WHY THIS IS CALLED FROM THE APP SHELL AND NOT FROM THE DOWNLOAD HUB.
 *
 * The adapter used to be registered by `DownloadHub` on mount. That is one
 * navigation too late: the track menu enqueues a download and *then*
 * navigates to `/downloads`, so at the moment the download started there was
 * no adapter registered at all. Two things went wrong from that single
 * ordering mistake:
 *
 *  - the download failed immediately, because the manager's factory refused;
 *  - and when the hub finally mounted, registering a new adapter used to
 *    discard the manager, so even a record that had survived was wiped.
 *
 * `AppShell` is mounted for the whole session, so registering here means the
 * adapter exists before the user can possibly press Download.
 *
 * There is no cleanup. The manager and its adapter deliberately outlive any
 * single page — tearing them down on unmount is what broke it in the first
 * place.
 */
let installed = false;

export function installDownloadAdapter(): void {
  if (installed) return;
  installed = true;
  registerDownloadAdapter((download) => {
    const stream = takeResolved(download.trackId);
    if (!stream) {
      // A record with no resolved stream was never queued through
      // `requestTrackDownload`. Refusing is correct: it stops a queued row
      // from quietly producing an empty file reported as a finished download.
      throw new Error("This download has no resolved stream");
    }
    // Keyed by TRACK id, not `download.id`. `download.id` is unique per
    // transfer (`dl_<time>_<seq>`), so a file stored under it could never be
    // found again by anything looking up "the copy of this track" — which is
    // exactly what offline playback does. Keying by track id also means
    // re-downloading overwrites its own copy instead of piling up duplicates.
    const base = createTrackAdapter(stream.url, stream.filename, download.trackId);
    if (!stream.tag || stream.tag.length === 0) return base;
    return withTaggingCommit(base, download.trackId, stream.tag);
  });
}

/**
 * Wrap an adapter so a finished download gets its ID3 tag prepended.
 *
 * The hook runs on `commit` — after the engine has verified the full length —
 * so the transfer's resume math and integrity checks never see the tag. A
 * tagging failure must not fail the download: the file is already on disk and
 * playable, the tag is decoration.
 */
function withTaggingCommit(
  base: DownloadAdapter,
  trackId: string,
  tag: Uint8Array,
): DownloadAdapter {
  return {
    ...base,
    sink: {
      ...base.sink,
      commit: async () => {
        await base.sink.commit();
        try {
          await prependToStoredDownload(trackId, tag);
        } catch {
          /* the file is complete and playable without the tag */
        }
      },
    },
  };
}