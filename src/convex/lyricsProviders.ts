"use node";

/**
 * Optional, key-gated lyrics providers.
 *
 * These live in their own Node-runtime module because reading a deployment
 * env var needs `process.env`, and Convex only allows a `"use node"` module to
 * contain actions. Keeping them separate lets `lyrics.ts` stay a normal
 * module and keeps the key-gated provider private to the backend.
 */

import { v } from "convex/values";
import { internalAction } from "./_generated/server";

const UA = { "User-Agent": "SYNQ/1.0 (web player)" };
const REQUEST_TIMEOUT_MS = 3500;

function apiKey(): string {
  const key = process.env.MUSIXMATCH_API_KEY;
  return typeof key === "string" ? key.trim() : "";
}

/**
 * Musixmatch — by far the widest catalogue available without scraping, and
 * unlike the plain-text providers it also serves synced LRC.
 *
 * Strictly optional: with `MUSIXMATCH_API_KEY` unset this returns null
 * immediately and the rest of the ladder is unaffected. Set the variable on
 * the deployment to switch it on; no code change is needed.
 */
export const musixmatch = internalAction({
  args: {
    title: v.string(),
    artist: v.string(),
    /** Ask for the synced LRC first — real timings beat plain text. */
    synced: v.boolean(),
  },
  handler: async (
    _ctx,
    { title, artist, synced },
  ): Promise<{
    lrc: string | null;
    plain: string | null;
  } | null> => {
    const key = apiKey();
    if (!key || !artist.trim()) return null;
    try {
      const res = await fetch(
        `https://api.musixmatch.com/ws/1.1/macro.subtitles.get?${new URLSearchParams(
          {
            format: "json",
            apikey: key,
            q_track: title,
            q_artist: artist,
            ...(synced
              ? { namespace: "lyrics_richsynched", subtitle_format: "lrc" }
              : {}),
          },
        )}`,
        { headers: UA, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      );
      if (!res.ok) return null;
      const data = (await res.json()) as {
        message?: {
          header?: { status_code?: number };
          body?: {
            macro_calls?: Record<
              string,
              {
                subtitle_list?: {
                  subtitle?: { subtitle_body?: string; lyrics_body?: string };
                }[];
              }
            >;
          };
        };
      };
      if (data.message?.header?.status_code !== 200) return null;
      const call = Object.values(data.message?.body?.macro_calls ?? {})[0];
      const best = call?.subtitle_list?.[0]?.subtitle;
      if (!best) return null;
      const lrc = best.subtitle_body?.trim() || null;
      const plain = best.lyrics_body?.trim() || null;
      return lrc || plain ? { lrc, plain } : null;
    } catch {
      return null;
    }
  },
});
