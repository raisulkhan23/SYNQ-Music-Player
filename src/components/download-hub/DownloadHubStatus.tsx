// ---------------------------------------------------------------------------
// SYNQ DownloadHub — desktop download bridge status card.
//
// This is the desktop-only status surface for the optional download bridge in
// `electron/preload-download.cjs`. It reports what the shell has actually told
// the renderer and nothing more:
//
//   - whether the bridge is installed in this build,
//   - the progress / completion / failure it reported for named tracks.
//
// It deliberately makes no claim about `yt-dlp` availability: the shell's real
// probe is not exposed over IPC, and the previous version invented a verdict by
// sending a fake `__probe__` download through the channel. Owning no
// executable, the card must not pretend to know whether one exists.
//
// It also does NOT start downloads. The existing DownloadHub flow (authorized
// Jamendo release → download manager) remains the only place a transfer starts.
// ---------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Package, CheckCircle, Loader2 } from "lucide-react";
import {
  hasDesktopDownloadBridge,
  subscribeDesktopDownloads,
  type DesktopDownloadProgress,
} from "@/lib/desktopDownloadStatus";

export function DesktopDownloadStatusCard() {
  const isDesktop = typeof window !== "undefined" && window.synqDesktop?.isDesktop === true;
  const [bridgePresent] = useState(() => hasDesktopDownloadBridge());
  const [transfers, setTransfers] = useState<DesktopDownloadProgress[]>([]);

  useEffect(() => {
    if (!bridgePresent) return;

    const upsert = (
      trackId: string,
      patch: Partial<DesktopDownloadProgress>,
    ) =>
      setTransfers((prev) => {
        const index = prev.findIndex((item) => item.trackId === trackId);
        if (index === -1) {
          return [
            ...prev,
            { trackId, progress: 0, state: "starting", ...patch },
          ];
        }
        const next = [...prev];
        next[index] = { ...next[index], ...patch };
        return next;
      });

    return subscribeDesktopDownloads({
      onProgress: (event) => upsert(event.trackId, event),
      onDone: (event) => upsert(event.trackId, { state: "done", progress: 100 }),
      onError: (event) =>
        upsert(event.trackId, {
          state: "error",
          ...(event.message ? { error: event.message } : {}),
        }),
    });
  }, [bridgePresent]);

  // Web and Android have no shell at all; this card is not for them.
  if (!isDesktop) return null;

  if (!bridgePresent) {
    return (
      <div className="rounded-xl border border-dashed border-white/10 bg-white/[0.03] p-4">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Package className="size-4 shrink-0" />
          <span>
            This build has no desktop download bridge. Downloads use SYNQ&rsquo;s
            regular pipeline.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
        <CheckCircle className="size-4 shrink-0 text-emerald-400" />
        <div className="flex-1 text-sm">
          <p className="font-medium">Desktop download bridge connected</p>
          <p className="mt-0.5 text-muted-foreground">
            Transfers it starts are reported here.
          </p>
        </div>
      </div>

      {transfers.length > 0 ? (
        <div className="space-y-2">
          {transfers.map((item) => (
            <div
              key={item.trackId}
              className="flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2 text-sm"
            >
              <Loader2
                className={cn(
                  "size-4 shrink-0",
                  item.state === "done" && "text-emerald-400",
                  item.state === "error" && "text-red-400",
                  item.state === "starting" && "animate-spin text-muted-foreground",
                  item.state === "downloading" && "animate-pulse text-blue-400",
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-xs">{item.trackId}</p>
                <p className="text-muted-foreground">
                  {item.state === "done"
                    ? "Completed"
                    : item.state === "error"
                      ? item.error || "Failed"
                      : `${Math.round(item.progress)}%`}
                </p>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          No desktop downloads in progress.
        </p>
      )}
    </div>
  );
}
