// ---------------------------------------------------------------------------
// Amplitude analytics (server-side proxy).
//
// Events are sent from the browser through this action so the Amplitude API
// key never ships to the client. Read from the Convex environment:
//   AMPLITUDE_API_KEY
//
// The action is intentionally forgiving: if the key is missing (or Amplitude
// is down) it reports `skipped` instead of throwing, so analytics can never
// break playback or a user action.
// ---------------------------------------------------------------------------

import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { action } from "./_generated/server";

const AMPLITUDE_URL = "https://api2.amplitude.com/2/httpapi";
/** Fallback only for callers that cannot provide a durable client id. */
function makeAnonymousId(): string {
  return `web-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Properties must be primitives; anything else is dropped. */
function sanitize(value: unknown): string | number | boolean | null {
  if (value === null) return null;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean")
    return value as string | number | boolean;
  if (Array.isArray(value))
    return value
      .slice(0, 20)
      .map((v) => String(v).slice(0, 200))
      .join(", ");
  if (t === "object") return JSON.stringify(value).slice(0, 500);
  return String(value).slice(0, 200);
}

export const track = action({
  args: {
    event: v.string(),
    properties: v.optional(
      v.record(
        v.string(),
        v.union(v.string(), v.number(), v.boolean(), v.null()),
      ),
    ),
    deviceId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { event, properties, deviceId },
  ): Promise<{ ok: boolean; skipped?: boolean; error?: string }> => {
    const apiKey = process.env.AMPLITUDE_API_KEY;
    if (!apiKey) {
      // Not configured yet — stay silent so the UI keeps working.
      return {
        ok: false,
        skipped: true,
        error: "AMPLITUDE_API_KEY not configured",
      };
    }

    // Prefer the signed-in user as the identity so events stitch together
    // across devices; fall back to the caller's durable device id. Never use
    // a shared literal for anonymous traffic: that collapses every visitor
    // into one analytics user.
    const userId = await getAuthUserId(ctx).catch(() => null);
    const identity = userId ?? deviceId ?? makeAnonymousId();

    const eventPayload: Record<string, unknown> = {
      event_type: event.slice(0, 100),
      user_id: identity,
      device_id: deviceId ?? identity,
      // Amplitude HTTP v2 timestamps are microseconds, not milliseconds.
      time: Date.now() * 1000,
      event_properties: properties ?? {},
    };
    if (userId) eventPayload.user_properties = { signedIn: true };

    try {
      const res = await fetch(AMPLITUDE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey, events: [eventPayload] }),
      });
      if (!res.ok) {
        // Never throw: analytics must not surface as an app error.
        return { ok: false, error: `Amplitude ${res.status}` };
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : "request failed",
      };
    }
  },
});

/**
 * Fire-and-forget multi-event batch (used for startup/session signals).
 * Silently skips when unconfigured.
 */
export const trackBatch = action({
  args: {
    events: v.array(
      v.object({
        event: v.string(),
        properties: v.optional(
          v.record(
            v.string(),
            v.union(v.string(), v.number(), v.boolean(), v.null()),
          ),
        ),
      }),
    ),
    deviceId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { events, deviceId },
  ): Promise<{ ok: boolean; skipped?: boolean; sent: number }> => {
    const apiKey = process.env.AMPLITUDE_API_KEY;
    if (!apiKey) return { ok: false, skipped: true, sent: 0 };

    const userId = await getAuthUserId(ctx).catch(() => null);
    const identity = userId ?? deviceId ?? makeAnonymousId();
    const payload = events.slice(0, 20).map((e) => ({
      event_type: e.event.slice(0, 100),
      user_id: identity,
      device_id: deviceId ?? identity,
      time: Date.now() * 1000,
      event_properties: e.properties ?? {},
    }));

    try {
      const res = await fetch(AMPLITUDE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey, events: payload }),
      });
      return { ok: res.ok, sent: res.ok ? payload.length : 0 };
    } catch {
      return { ok: false, sent: 0 };
    }
  },
});

export { sanitize };
