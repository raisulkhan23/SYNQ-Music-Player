import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";

/**
 * Client-side analytics helper.
 *
 * Every event goes through the Convex action so the Amplitude API key stays on
 * the server. Everything here is fire-and-forget and NEVER throws or blocks:
 * analytics must not be able to break playback or a click.
 */

type Props = Record<string, string | number | boolean | null>;

let client: ConvexHttpClient | null = null;
function getClient(): ConvexHttpClient {
  client ??= new ConvexHttpClient(import.meta.env.VITE_CONVEX_URL as string);
  return client;
}

const DEVICE_KEY = "ss.analyticsDeviceId";

/** Stable per-browser id (Amplitude uses it to stitch sessions). */
function getDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing) return existing;
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    return "anonymous";
  }
}

/** Stop after repeated hard failures; transient offline errors are ignored. */
let disabled = false;
let consecutiveFailures = 0;

function recordAnalyticsSuccess(): void {
  consecutiveFailures = 0;
}

function recordAnalyticsFailure(): void {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return;
  consecutiveFailures += 1;
  if (consecutiveFailures >= 3) disabled = true;
}

export function isAnalyticsEnabled(): boolean {
  return !disabled;
}

/** Send one event. Silently no-ops (and disables itself) if it can't be sent. */
export function track(event: string, properties: Props = {}): void {
  if (disabled) return;
  try {
    void getClient()
      .action(api.amplitude.track, {
        event,
        properties,
        deviceId: getDeviceId(),
      })
      .then((res) => {
        // `skipped` means the key isn't configured yet — stay quiet but keep
        // the integration ready for when it is added.
        if (res && "skipped" in res && res.skipped) return;
        recordAnalyticsSuccess();
      })
      .catch(() => {
        // A single failure shouldn't disable tracking; repeated hard failures
        // indicate a misconfigured deployment and should stop the hot path.
        recordAnalyticsFailure();
      });
  } catch {
    disabled = true;
  }
}

/** Send a batch (used sparingly, e.g. session start). */
export function trackBatch(
  events: { event: string; properties?: Props }[],
): void {
  if (disabled || events.length === 0) return;
  try {
    void getClient()
      .action(api.amplitude.trackBatch, { events, deviceId: getDeviceId() })
      .then(() => recordAnalyticsSuccess())
      .catch(() => recordAnalyticsFailure());
  } catch {
    disabled = true;
  }
}

/** Re-enable after the user adds their API key mid-session. */
export function resetAnalytics(): void {
  disabled = false;
  consecutiveFailures = 0;
}
