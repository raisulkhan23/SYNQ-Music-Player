// ---------------------------------------------------------------------------
// Progressive Web App support.
//
// SYNQ was already a single-page app with a real manifest, so this module only
// adds the three things that were missing: a registered service worker, an
// install affordance, and a safe update path.
//
// Two rules shape everything here:
//
//   1. Never interrupt playback. A service worker that calls skipWaiting()
//      on its own swaps the running code out from under a listener who is
//      mid-song. The worker deliberately waits, and the page decides when it
//      is safe to reload (see `applyUpdate`).
//
//   2. Never fake a capability. iOS Safari has no install prompt event at
//      all, so there is nothing to trigger programmatically; instead the UI
//      explains the Share > Add to Home Screen steps rather than showing a
//      button that silently does nothing.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";

/** Path of the service worker, served from /public so it is root-scoped. */
export const SERVICE_WORKER_PATH = "/sw.js";

/**
 * Dismissal is stored under the same `ss.` localStorage convention every other
 * SYNQ preference uses, rather than introducing a second storage mechanism.
 */
export const INSTALL_DISMISSED_KEY = "ss.pwaInstallDismissed";

/** Storage key marking that an update has been applied and needs one reload. */
const UPDATE_RELOAD_KEY = "ss.pwaUpdateReload";

/** How long a worker can sit installed-but-waiting before we call it stale. */
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/** True when the app is running as an installed app rather than a browser tab. */
export function isStandalone(
  displayMode?: string,
  navStandalone?: boolean,
): boolean {
  const mode =
    displayMode ??
    (typeof window !== "undefined"
      ? window.matchMedia?.("(display-mode: standalone)")?.matches
        ? "standalone"
        : window.matchMedia?.("(display-mode: window-controls-overlay)")
              ?.matches
          ? "window-controls-overlay"
          : window.matchMedia?.("(display-mode: minimal-ui)")?.matches
            ? "minimal-ui"
            : ""
      : "");
  if (mode === "standalone" || mode === "minimal-ui") return true;
  if (mode === "window-controls-overlay") return true;
  return Boolean(navStandalone);
}

/**
 * iOS Safari never fires `beforeinstallprompt`, so there is no prompt to
 * capture and no API to trigger installation. The honest response is to show
 * the manual steps instead of a button that would do nothing.
 */
export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const iOS =
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ reports a desktop UA but is still a touch-first iOS device.
    (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
  return iOS;
}

export type InstallState =
  /** Already installed, or running in a browser that cannot install. */
  | "unavailable"
  /** The browser offered an install prompt we captured. */
  | "ready"
  /** iOS: no programmatic install, so we explain the manual steps. */
  | "manual"
  /** The listener dismissed the prompt. */
  | "dismissed"
  /** Installed and running standalone. */
  | "installed";

export function readDismissed(): boolean {
  try {
    return localStorage.getItem(INSTALL_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeDismissed(value: boolean): void {
  try {
    if (value) localStorage.setItem(INSTALL_DISMISSED_KEY, "1");
    else localStorage.removeItem(INSTALL_DISMISSED_KEY);
  } catch {
    /* storage unavailable — the prompt simply reappears later */
  }
}

/**
 * Decide what the install affordance should say.
 *
 * Kept separate from the hook so the precedence is testable: "already
 * installed" must ALWAYS win, or an installed app would keep being offered an
 * install button for itself.
 */
export function resolveInstallState(input: {
  installed: boolean;
  promptCaptured: boolean;
  dismissed: boolean;
  ios: boolean;
}): InstallState {
  if (input.installed) return "installed";
  if (input.dismissed) return "dismissed";
  if (input.promptCaptured) return "ready";
  if (input.ios) return "manual";
  return "unavailable";
}

/** Human-readable hint for platforms with no programmatic install. */
export function manualInstallHint(ios: boolean): string {
  return ios
    ? "Tap the Share button, then choose “Add to Home Screen”."
    : "Open your browser menu and choose “Install app” or “Add to Home Screen”.";
}

/**
 * Why this browser cannot install SYNQ right now, or null if it can.
 *
 * The important one is the DEV/PROD gate. `registerServiceWorker` refuses to
 * register unless `import.meta.env.PROD`, and that is deliberate: a service
 * worker in front of the Vite dev server caches module URLs that are
 * regenerated on every dependency re-optimisation, which produces precisely
 * the "stale bundle that never updates" failure a service worker exists to
 * prevent.
 *
 * The consequence, though, is that a local or preview build is NOT installable
 * — and Chrome will not even offer it, because a registered service worker is
 * part of the installability criteria. So `beforeinstallprompt` never fires,
 * the in-app card never appears, and Chrome's own omnibox install icon stays
 * hidden. Without an explanation that reads as "the PWA is broken", which is
 * exactly the wrong conclusion to reach.
 *
 * Returns null whenever nothing is actually blocking, so the caller can fall
 * back to "this browser hasn't offered it yet".
 */
export function installBlockedReason(): string | null {
  if (typeof window === "undefined") return null;
  return planInstallBlock({
    hasServiceWorker: "serviceWorker" in navigator,
    isProd: import.meta.env.PROD,
    isSecureContext: window.isSecureContext,
  });
}

/**
 * The decision behind {@link installBlockedReason}, kept pure so it can be
 * tested without a browser, a service worker or a build mode.
 *
 * Order matters and mirrors `registerServiceWorker`: a browser with no service
 * worker support can never install, then the build gate, then the context.
 */
export function planInstallBlock(input: {
  hasServiceWorker: boolean;
  isProd: boolean;
  isSecureContext: boolean;
}): string | null {
  if (!input.hasServiceWorker) {
    return "This browser doesn't support service workers, so SYNQ can't be installed here.";
  }
  if (!input.isProd) {
    return "Installing needs the published build. This preview runs a dev server, where a service worker would cache stale bundles.";
  }
  if (!input.isSecureContext) {
    return "Installing needs HTTPS (or localhost) — service workers won't register on plain http.";
  }
  return null;
}

// --- service worker ----------------------------------------------------------

interface PwaCallbacks {
  /** A new version is installed and waiting to take over. */
  onUpdateReady?: () => void;
}

let waitingWorker: ServiceWorker | null = null;
let registrationRef: ServiceWorkerRegistration | null = null;

// --- update availability, as an external store -------------------------------
//
// A waiting service worker is external state, not component state. Holding it
// in a `useState` inside a component makes the effect that observes it set
// state synchronously, which is exactly the cascading-render pattern React
// warns about. An external store keeps the worker lifecycle out of the render
// tree entirely and gives every surface one shared answer.

let updateReady = false;
/**
 * Monotonic id for each newly-arrived update. The UI stores "which update did
 * I dismiss?" rather than a boolean, so a LATER update re-opens the banner on
 * its own instead of staying hidden behind an old dismissal.
 */
let updateId = 0;
const updateListeners = new Set<() => void>();

function setUpdateReady(value: boolean): void {
  if (updateReady === value) return;
  if (value) updateId += 1;
  updateReady = value;
  for (const listener of updateListeners) listener();
}

/** Subscribe to "a new version is waiting". Returns an unsubscribe function. */
export function subscribePwaUpdate(listener: () => void): () => void {
  updateListeners.add(listener);
  return () => {
    updateListeners.delete(listener);
  };
}

/** Current update state. Stable primitive, so useSyncExternalStore is happy. */
export function getPwaUpdateSnapshot(): boolean {
  return updateReady;
}

/** Server/prerender snapshot; the worker never exists there. */
export function getPwaUpdateServerSnapshot(): boolean {
  return false;
}

/** Id of the currently-waiting update, for dismissal bookkeeping. */
export function getPwaUpdateId(): number {
  return updateId;
}

/** Server/prerender counterpart of {@link getPwaUpdateId}. */
export function getPwaUpdateIdServerSnapshot(): number {
  return 0;
}

/** Force a re-check of the deployed worker. Safe to call often. */
export function checkForUpdate(): void {
  void registrationRef?.update().catch(() => undefined);
}

/**
 * Register the service worker.
 *
 * Only in production. A service worker in front of the Vite dev server caches
 * module URLs that are re-generated on every dependency re-optimisation, which
 * produces exactly the "stale bundle that never updates" failure the SW is
 * meant to prevent. `import.meta.env.PROD` keeps dev honest.
 *
 * Never throws: a browser without service workers, an insecure context, or a
 * blocked registration must all leave the app working exactly as before.
 */
export async function registerServiceWorker(
  callbacks: PwaCallbacks = {},
): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined") return null;
  // Wrapped shells do not get a service worker:
  //
  //  - Packaged desktop app (`file://`): service workers are not available on
  //    the file scheme, `/sw.js` would resolve to the root of the drive, and a
  //    caching layer in front of an on-disk bundle has nothing to gain.
  //  - Capacitor Android: the WebView serves the bundle from its own origin, and
  //    a service worker there is what makes an updated APK keep running the
  //    previous build — the stale-bundle failure this module exists to avoid.
  if (window.location.protocol === "file:") return null;
  if ("Capacitor" in window) return null;
  if (!("serviceWorker" in navigator)) return null;
  if (!import.meta.env.PROD) return null;
  // A service worker needs a secure context. localhost counts; plain http on a
  // LAN does not, and registering there throws.
  if (!window.isSecureContext) return null;

  try {
    const registration = await navigator.serviceWorker.register(
      SERVICE_WORKER_PATH,
      { scope: "/" },
    );
    registrationRef = registration;

    if (registration.waiting && navigator.serviceWorker.controller) {
      waitingWorker = registration.waiting;
      setUpdateReady(true);
      callbacks.onUpdateReady?.();
    }

    registration.addEventListener("updatefound", () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener("statechange", () => {
        // "installed" while a controller already exists means this is an
        // UPDATE, not a first install. Activating it immediately would
        // replace the running code mid-song.
        if (
          installing.state === "installed" &&
          navigator.serviceWorker.controller
        ) {
          waitingWorker = installing;
          setUpdateReady(true);
          callbacks.onUpdateReady?.();
        }
      });
    });

    // A worker can be left waiting for hours if the tab is left open; without
    // this check a listener could sit on a stale version indefinitely.
    window.setInterval(() => {
      void registration.update().catch(() => undefined);
    }, UPDATE_CHECK_INTERVAL_MS);

    return registration;
  } catch {
    return null;
  }
}

/**
 * Activate the waiting worker and reload.
 *
 * `isPlaying` is passed in rather than read here so this module never imports
 * the player store: the caller decides when it is safe. Reloading during
 * playback would cut the song off mid-track, which is the single worst thing
 * an update can do to a music player.
 */
export async function applyUpdate(options: {
  isPlaying: boolean;
  onBlocked: () => void;
}): Promise<void> {
  const worker = waitingWorker ?? registrationRef?.waiting ?? null;
  if (!worker) {
    // Nothing waiting — the common case when the listener taps Update twice.
    setUpdateReady(false);
    window.location.reload();
    return;
  }
  if (options.isPlaying) {
    // Defer. The worker stays waiting; nothing is lost.
    options.onBlocked();
    return;
  }
  // The reload is committed to; the banner has nothing left to announce.
  setUpdateReady(false);
  try {
    // Remember that a reload is required. If the page dies before the
    // controller swap completes (a mobile browser killing a background tab),
    // the next launch still picks up the new version instead of pinning the
    // old one.
    sessionStorage.setItem(UPDATE_RELOAD_KEY, "1");
  } catch {
    /* storage unavailable */
  }
  const onControllerChange = () => {
    window.location.reload();
  };
  navigator.serviceWorker.addEventListener(
    "controllerchange",
    onControllerChange,
    { once: true },
  );
  worker.postMessage({ type: "SKIP_WAITING" });
  // If the controller never changes (some browsers defer it until the tab is
  // closed) reload anyway so the listener is not left on the old version.
  window.setTimeout(onControllerChange, 1500);
}

/** True when the app was reloaded to pick up a waiting worker. */
export function consumeUpdateReloadFlag(): boolean {
  try {
    const value = sessionStorage.getItem(UPDATE_RELOAD_KEY) === "1";
    if (value) sessionStorage.removeItem(UPDATE_RELOAD_KEY);
    return value;
  } catch {
    return false;
  }
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let deferredPrompt: BeforeInstallPromptEvent | null = null;

/**
 * Watch for the browser's install prompt and for the app becoming installed.
 * Returns everything the UI needs to offer installation.
 */
export function usePwaInstall() {
  const [installed, setInstalled] = useState(false);
  const [promptCaptured, setPromptCaptured] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const computeInstalled = () =>
      setInstalled(
        isStandalone(
          window.matchMedia?.("(display-mode: standalone)").matches
            ? "standalone"
            : undefined,
          (navigator as unknown as { standalone?: boolean }).standalone,
        ),
      );
    computeInstalled();

    const onBeforeInstall = (event: Event) => {
      // Chrome/Edge fire this when the app meets its install criteria. Holding
      // on to the event is the ONLY way to show a custom button later — it
      // cannot be re-requested once used.
      event.preventDefault();
      deferredPrompt = event as BeforeInstallPromptEvent;
      setPromptCaptured(true);
    };
    const onInstalled = () => {
      deferredPrompt = null;
      setPromptCaptured(false);
      setInstalled(true);
      setDismissed(false);
      writeDismissed(false);
    };
    const media = window.matchMedia?.("(display-mode: standalone)");

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    media?.addEventListener?.("change", computeInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
      media?.removeEventListener?.("change", computeInstalled);
    };
  }, []);

  const state = resolveInstallState({
    installed,
    promptCaptured,
    dismissed,
    ios: isIos(),
  });

  /** Ask the browser to install. Returns false when it cannot be done. */
  const install = useCallback(async (): Promise<boolean> => {
    const prompt = deferredPrompt;
    if (!prompt) return false;
    // Clear it FIRST: the event is single-use, and holding a spent reference
    // would let a second tap resolve a prompt that can never be shown again.
    deferredPrompt = null;
    setPromptCaptured(false);
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice.outcome === "dismissed") {
        setDismissed(true);
        writeDismissed(true);
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
    writeDismissed(true);
  }, []);

  const reset = useCallback(() => {
    setDismissed(false);
    writeDismissed(false);
  }, []);

  return { state, install, dismiss, reset, installed };
}
