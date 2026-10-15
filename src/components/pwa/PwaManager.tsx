import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Download, RefreshCw, X } from "lucide-react";
import { toast } from "sonner";
import {
  applyUpdate,
  getPwaUpdateId,
  getPwaUpdateIdServerSnapshot,
  getPwaUpdateServerSnapshot,
  getPwaUpdateSnapshot,
  manualInstallHint,
  registerServiceWorker,
  subscribePwaUpdate,
  usePwaInstall,
} from "@/lib/pwa";
import { usePlayerStore } from "@/store/player";
import { cn } from "@/lib/utils";
import { publicAsset } from "@/lib/publicAsset";

/**
 * Progressive Web App plumbing for the signed-in shell.
 *
 * Two jobs, both deliberately quiet:
 *
 *  - Register the service worker and surface a new version when one is ready.
 *    The reload is NEVER automatic: this is a music player, and swapping the
 *    running code mid-song would cut the track off. An update offered while
 *    something is playing says so and waits for the track to finish.
 *
 *  - Offer "Install SYNQ" once, and remember a dismissal. Re-prompting someone
 *    who already said no is the fastest way to make an install banner feel
 *    like an ad.
 */
export function PwaManager() {
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const current = usePlayerStore((s) => s.current);
  // The waiting-worker state lives in the PWA module, not here: it is external
  // state owned by the browser, and mirroring it into a useState would make
  // the registering effect set state synchronously.
  const updateReady = useSyncExternalStore(
    subscribePwaUpdate,
    getPwaUpdateSnapshot,
    getPwaUpdateServerSnapshot,
  );
  const [deferredWhilePlaying, setDeferredWhilePlaying] = useState(false);
  // Which update was dismissed, rather than a boolean. A later update arrives
  // with a new id and re-opens the banner by itself, which avoids an effect
  // that would have to reset state after every update.
  const [dismissedUpdateId, setDismissedUpdateId] = useState<number | null>(
    null,
  );
  const updateId = useSyncExternalStore(
    subscribePwaUpdate,
    getPwaUpdateId,
    getPwaUpdateIdServerSnapshot,
  );
  const { state, install, dismiss } = usePwaInstall();

  useEffect(() => {
    void registerServiceWorker();
  }, []);

  // The listener kept playing and declined the reload. Re-offer once the track
  // is over rather than leaving the update stranded in the background. There is
  // deliberately no setState here: `waitingForTrackEnd` is derived, and the
  // reload this triggers ends the page anyway.
  const waitingForTrackEnd = deferredWhilePlaying && !isPlaying;
  useEffect(() => {
    if (!waitingForTrackEnd) return;
    void applyUpdate({ isPlaying: false, onBlocked: () => undefined });
  }, [waitingForTrackEnd]);

  const onUpdate = useCallback(() => {
    void applyUpdate({
      isPlaying,
      onBlocked: () => {
        setDeferredWhilePlaying(true);
        toast("Update ready", {
          id: "pwa-update-deferred",
          description: "It'll load when this song finishes.",
        });
      },
    });
  }, [isPlaying]);

  const dismissUpdate = useCallback(() => {
    setDismissedUpdateId(updateId);
  }, [updateId]);

  const showUpdate = updateReady && dismissedUpdateId !== updateId;
  const showInstall = state === "ready" || state === "manual";
  if (!showUpdate && !showInstall) return null;

  return (
    <>
      {showUpdate && (
        <div
          role="status"
          className="z-50 flex items-center justify-between gap-3 bg-[rgb(var(--tint))] px-4 py-1.5 text-xs font-semibold text-black"
        >
          <span className="min-w-0 truncate">
            {deferredWhilePlaying
              ? `Update ready — loads after “${current?.title ?? "this track"}”`
              : "A new version of SYNQ is available"}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={onUpdate}
              disabled={deferredWhilePlaying}
              className={cn(
                "flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors",
                deferredWhilePlaying
                  ? "cursor-not-allowed bg-black/10 text-black/50"
                  : "bg-black/85 text-white hover:bg-black",
              )}
            >
              <RefreshCw className="size-3" />
              Update
            </button>
            <button
              type="button"
              onClick={dismissUpdate}
              aria-label="Dismiss update notice"
              className="rounded-full p-1 transition-colors hover:bg-black/10"
            >
              <X className="size-3.5" />
            </button>
          </span>
        </div>
      )}

      {showInstall && (
        // In the normal flow, NOT fixed.
        //
        // This used to be a `fixed right-4 bottom-... z-40` card, which is the
        // one place in the app it must never occupy: it sat permanently over
        // the bottom-right of the content, directly under the Queue panel —
        // the right-hand surface that slides in over exactly those pixels.
        // A floating promo over the right side of a music player is both a
        // layout collision and an interruption on every single launch.
        //
        // As an in-flow strip below the offline banner it cannot overlap
        // anything: the Queue sheet and the Settings dialog are both `z-[75]`
        // and `z-50` overlays that render above the whole column, and this
        // strip simply occupies its own line in the layout when it is shown.
        <div className="flex items-center justify-between gap-3 border-b border-white/[0.06] bg-white/[0.03] px-4 py-2">
          <span className="flex min-w-0 items-center gap-2">
            <img
              src={publicAsset("icons/icon-192.png")}
              alt=""
              width={22}
              height={22}
              className="size-[22px] shrink-0 rounded-md"
            />
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              <span className="font-semibold text-foreground">
                Install SYNQ
              </span>{" "}
              {state === "ready"
                ? "— run it in its own window, with the player intact."
                : manualInstallHint(true)}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5">
            {state === "ready" && (
              <button
                type="button"
                onClick={() => {
                  void install();
                }}
                // `inline-flex items-center` is load-bearing, not decoration.
                // Tailwind's preflight sets `svg { display: block }`, so in a
                // plain inline button the Download icon became a BLOCK and
                // forced a line break of its own — the icon sat on top of the
                // word "Install" and the pill grew into a tall two-line
                // lozenge. `whitespace-nowrap` stops the label breaking on a
                // narrow strip, and the slightly roomier padding gives it a
                // comfortable one-line hit target.
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-[rgb(var(--tint))] px-3 py-1.5 text-[11px] font-semibold whitespace-nowrap text-black transition-transform hover:scale-[1.03]"
              >
                <Download className="size-3" />
                Install
              </button>
            )}
            <button
              type="button"
              onClick={dismiss}
              aria-label="Dismiss install notice"
              className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          </span>
        </div>
      )}
    </>
  );
}
