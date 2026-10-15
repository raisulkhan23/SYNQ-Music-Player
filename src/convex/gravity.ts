// ---------------------------------------------------------------------------
// Gravity — contextual ad serving (server-side).
//
// Ads are requested from Gravity's API through Convex so the API key never
// reaches the browser. The client only receives the rendered ad payload.
//
//   GRAVITY_API_KEY  — from the Gravity dashboard (publisher/API settings)
//
// When the key is missing the action returns `skipped` and the UI renders
// nothing, so the app is completely unaffected until setup is done.
// ---------------------------------------------------------------------------

import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { action } from "./_generated/server";

const GRAVITY_AD_URL = "https://server.trygravity.ai/api/v1/ad";

/** Shape we actually use from the ad payload (kept loose but typed). */
export interface GravityAdPayload {
  adText: string;
  title?: string;
  cta?: string;
  brandName?: string;
  url?: string;
  favicon?: string;
  impUrl?: string;
  clickUrl?: string;
  campaignId?: string;
  variant?: string;
  renderer_key?: string;
}

export const requestAds = action({
  args: {
    /** Short context describing what the user is doing, e.g. "lofi search". */
    context: v.string(),
    /** Slot name, e.g. "search_results". */
    placement: v.optional(v.string()),
    /** Up to 2 recent turns of context, mirroring a chat-style product. */
    messages: v.optional(
      v.array(v.object({ role: v.string(), content: v.string() })),
    ),
    /** Durable, opaque browser identity for signed-out visitors. */
    visitorId: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { context, placement = "search_results", messages = [], visitorId },
  ): Promise<{
    ads: GravityAdPayload[];
    skipped?: boolean;
    error?: string;
  }> => {
    const apiKey = process.env.GRAVITY_API_KEY;
    if (!apiKey) return { ads: [], skipped: true };

    const trimmed = context.trim().slice(0, 200);
    if (!trimmed) return { ads: [], skipped: true, error: "empty context" };

    try {
      const res = await fetch(GRAVITY_AD_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          // Test mode by default; flip to true to serve real campaigns.
          production: process.env.GRAVITY_PRODUCTION === "1",
          messages: [{ role: "user", content: trimmed }, ...messages.slice(-2)],
          placements: [
            {
              placement,
              placement_id: placement,
            },
          ],
          user: {
            gruid:
              (await getAuthUserId(ctx).catch(() => null)) ??
              visitorId?.trim() ??
              `web-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`,
          },
        }),
      });
      if (!res.ok) return { ads: [], error: `Gravity ${res.status}` };

      const data = (await res.json()) as {
        ads?: GravityAdPayload[];
      };
      return { ads: (data.ads ?? []).slice(0, 2) };
    } catch (error) {
      // Never surface an ad failure to the user.
      return {
        ads: [],
        error: error instanceof Error ? error.message : "request failed",
      };
    }
  },
});
