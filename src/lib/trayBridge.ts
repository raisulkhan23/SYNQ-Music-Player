import { useEffect } from "react";
import { usePlayerStore } from "@/store/player";

/**
 * Tray menu quick actions, renderer half.
 *
 * The main process forwards the tray's playback items over the
 * `tray:action` channel (one string per click). This module is the ONLY
 * renderer place that maps them onto the player store — the store itself
 * knows nothing about the Electron shell, so tray support cannot leak into
 * the web or Android runtimes: without the bridge this hook registers
 * nothing and unsubscribes cleanly.
 */
const PLAYER_ACTIONS: Record<
  "play-pause" | "next" | "previous",
  (store: ReturnType<typeof usePlayerStore.getState>) => void
> = {
  "play-pause": (store) => store.togglePlay(),
  next: (store) => store.next(),
  previous: (store) => store.prev(),
};

export function useTrayBridge(): void {
  useEffect(() => {
    const desktop = window.synqDesktop;
    if (
      !desktop ||
      typeof desktop.onTrayAction !== "function"
    )
      return;

    return desktop.onTrayAction((action: string) => {
      const handler = PLAYER_ACTIONS[action as keyof typeof PLAYER_ACTIONS];
      if (!handler) return;
      handler(usePlayerStore.getState());
    });
    // The bridge object is frozen and per-window; the listener lives as long
    // as the app's root effect does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
