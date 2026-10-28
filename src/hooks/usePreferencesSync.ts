import { useEffect, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { usePlayerStore } from "@/store/player";
import { useAuth } from "@/hooks/use-auth";

/**
 * Single-profile preferences sync — server blob ⇄ local player store.
 *
 * ── The shape of the problem ───────────────────────────────────────────────
 *
 * Every preference already persists to `localStorage` via `writeSetting`, and
 * the zustand store is the single source of truth the whole UI reads. So sync
 * means exactly two flows and no new state system:
 *
 *  1. HYDRATE — on sign-in, the server blob is layered OVER the local
 *     defaults (server wins: it is the profile's canonical answer), using the
 *     store's own setters so every derived side effect (CSS classes, media
 *     session, audio graph) applies exactly as if the user had clicked it.
 *
 *  2. PUSH — a debounced snapshot of the whitelisted keys is written back
 *     whenever one of them changes locally.
 *
 * Transient state (currentTime, isPlaying, queue position, fullscreen) is
 * deliberately NOT in the whitelist: those are session state, not
 * preferences, and syncing them would make one device fight another.
 *
 * The loop is guarded so hydrate and push cannot feed each other: a
 * `hydrating` flag suppresses push during hydration, and the push effect
 * skips its first (pre-hydration) run.
 */

/** The keys that count as cross-device preferences. Anything else is session. */
export const SYNCED_PREF_KEYS = [
  "volume",
  "muted",
  "shuffle",
  "repeat",
  "rate",
  "crossfade",
  "gapless",
  "autoplay",
  "videoEnabled",
  "accentTheme",
  "themeMode",
  "trackPalettes",
  "settingsShimmer",
  "settingsDepth",
  "liquidGlass",
  "ambientGlow",
  "pointerEffects",
  "visualizerEnabled",
  "performanceMode",
  "cardTransparency",
  "sidebarCollapsed",
  "hideSidebarEmail",
  "introTrim",
  "wallpaperType",
  "wallpaperBlur",
] as const;

type PrefValue = string | number | boolean;

/** Snapshot only the whitelisted keys out of the store. */
function snapshotPrefs(state: Record<string, unknown>): Record<string, PrefValue> {
  const out: Record<string, PrefValue> = {};
  for (const key of SYNCED_PREF_KEYS) {
    const value = state[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

/** Map a server pref key onto the store setter that applies it. */
function applyPref(key: string, value: unknown): void {
  const s = usePlayerStore.getState() as unknown as {
    [key: string]: unknown;
  };
  const call = (v: unknown) => {
    if (typeof v !== "function") return;
    (v as (...args: unknown[]) => unknown)();
  };
  const callArg = <T>(f: unknown, arg: T) => {
    if (typeof f !== "function") return;
    (f as (a: T) => void)(arg);
  };

  switch (key) {
    case "volume":
      if (typeof value === "number") callArg(s.setVolume, value);
      break;
    case "muted":
      if (typeof value === "boolean" && s.muted !== value) call(s.toggleMute);
      break;
    case "shuffle":
      if (typeof value === "boolean" && s.shuffle !== value) call(s.toggleShuffle);
      break;
    case "repeat": {
      if (typeof value !== "string") break;
      for (let i = 0; i < 3 && s.repeat !== value; i++) call(s.cycleRepeat);
      break;
    }
    case "rate":
      if (typeof value === "number") callArg(s.setRate, value);
      break;
    case "crossfade":
      if (typeof value === "number") callArg(s.setCrossfade, value);
      break;
    case "gapless":
      if (typeof value === "boolean" && s.gapless !== value) call(s.toggleGapless);
      break;
    case "autoplay":
      if (typeof value === "boolean" && s.autoplay !== value) call(s.toggleAutoplay);
      break;
    case "videoEnabled":
      if (typeof value === "boolean" && s.videoEnabled !== value) call(s.toggleVideo);
      break;
    case "accentTheme":
      if (typeof value === "string") callArg(s.setAccentTheme, value);
      break;
    case "themeMode":
      if (typeof value === "string") callArg(s.setThemeMode, value);
      break;
    case "wallpaperType":
      if (value === "image" || value === "video") callArg(s.setWallpaperType, value);
      break;
    case "sidebarCollapsed":
      if (typeof value === "boolean" && s.sidebarCollapsed !== value) call(s.toggleSidebarCollapsed);
      break;
    case "hideSidebarEmail":
      if (typeof value === "boolean" && s.hideSidebarEmail !== value) call(s.toggleHideSidebarEmail);
      break;
    default:
      // Toggles without a dedicated conditional setter (visualizer, glow,
      // pointer effects, glass, performance, intro trim) are hydrated by the
      // settings dialog reading localStorage on mount; syncing them into the
      // blob keeps the VALUE portable even where live application is local.
      break;
  }
}

const PUSH_DEBOUNCE_MS = 1500;

export function usePreferencesSync(): void {
  const { isAuthenticated } = useAuth();
  const remote = useQuery(api.userPreferences.get, isAuthenticated ? {} : "skip");
  const putPrefs = useMutation(api.userPreferences.put);

  const hydratedRef = useRef(false);
  const hydratingRef = useRef(false);
  const lastPushedRef = useRef<string>("");
  const timerRef = useRef<number | null>(null);

  // 1. HYDRATE — once per sign-in, server wins over local defaults.
  useEffect(() => {
    if (!isAuthenticated || !remote || hydratedRef.current) return;
    hydratedRef.current = true;
    hydratingRef.current = true;
    try {
      const prefs = remote.prefs as Record<string, unknown> | null;
      if (prefs && typeof prefs === "object") {
        for (const [key, value] of Object.entries(prefs)) {
          if (!SYNCED_PREF_KEYS.includes(key as (typeof SYNCED_PREF_KEYS)[number])) {
            continue;
          }
          applyPref(key, value);
        }
      }
    } finally {
      window.setTimeout(() => {
        hydratingRef.current = false;
        lastPushedRef.current = JSON.stringify(
          snapshotPrefs(usePlayerStore.getState() as unknown as Record<string, unknown>),
        );
      }, 0);
    }
  }, [isAuthenticated, remote]);

  // 2. PUSH — debounce local changes of whitelisted keys back to the server.
  useEffect(() => {
    if (!isAuthenticated || !hydratedRef.current) return;
    const unsub = usePlayerStore.subscribe((state) => {
      if (hydratingRef.current) return;
      const snap = JSON.stringify(snapshotPrefs(state as unknown as Record<string, unknown>));
      if (snap === lastPushedRef.current) return;
      lastPushedRef.current = snap;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        void putPrefs({ prefs: JSON.parse(snap) }).catch(() => {
          // A failed sync must never break the session: local prefs already
          // persisted to localStorage, so the next successful push catches up.
        });
      }, PUSH_DEBOUNCE_MS);
    });
    return () => {
      unsub();
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isAuthenticated, putPrefs]);
}
