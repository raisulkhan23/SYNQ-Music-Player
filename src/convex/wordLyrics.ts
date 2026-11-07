import { v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { TTL, cacheKey, dedupeRequest, takeRateSlot } from "./providerCache";
import { parseYrc, type WordLyricLine } from "../lib/yrcParse";

/**
 * Word-by-word lyrics from NetEase — the karaoke layer, ported from melo.
 *
 * LRCLIB's per-LINE timings are already good, but they cannot tell you which
 * WORD is being sung. NetEase's YRC format carries real per-word timings, and
 * melo's engine reads it as the word-by-word source of record. The flow is
 * melo's, verbatim:
 *
 *   1. search  — GET music.163.com/api/search/get/web?s={title artist}&type=1
 *   2. pick    — the song whose duration matches the track within ±3 s, title
 *                matched after normalization
 *   3. fetch   — GET music.163.com/api/song/lyric?id={id}&yv=1 → yrc.lrc
 *   4. parse   — src/lib/yrcParse.ts (pure, shared with tests)
 *
 * A result of null is a HONEST null: NetEase has no YRC for this track. The
 * per-line lyrics from `lyrics.ts` remain on screen; karaoke simply does not
 * light up. Timings are never invented.
 */

const SEARCH_URL = "https://music.163.com/api/search/get/web";
const LYRIC_URL = "https://music.163.com/api/song/lyric";
const REQUEST_TIMEOUT_MS = 12_000;
/** Duration agreement window for "this search row is this track". */
const DURATION_WINDOW_MS = 3_000;

/** NetEase requires a browser-ish UA and a same-site referer. */
function headers(): Record<string, string> {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Referer: "https://music.163.com/",
    Accept: "application/json, text/plain, */*",
  };
}

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      headers: headers(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Strip the noise that keeps titles from matching ("(Live)", "MV", …). */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\([^)]*\)|\[[^\]]*\]|【[^】]*】/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Find the search row that is genuinely this track, or null. */
function pickSongId(
  body: Record<string, unknown>,
  title: string,
  durationMs: number | undefined,
): { id: string; title: string } | null {
  const result = isRecord(body.result) ? body.result : undefined;
  const songs = Array.isArray(result?.songs) ? result.songs : [];
  const wanted = normalize(title);
  for (const raw of songs) {
    if (!isRecord(raw)) continue;
    const id = typeof raw.id === "number" ? String(raw.id) : undefined;
    const name = typeof raw.name === "string" ? raw.name : "";
    if (!id || !name) continue;
    // Duration first when the track knows its length: ±3 s is the same
    // recording, and it is the only signal that cannot be fuzzed by a
    // similarly-titled cover.
    if (durationMs && typeof raw.duration === "number") {
      if (Math.abs(raw.duration - durationMs) > DURATION_WINDOW_MS) continue;
      return { id, title: name };
    }
    if (wanted && normalize(name) !== wanted) continue;
    return { id, title: name };
  }
  return null;
}

export const fetchWordLyrics = action({
  args: {
    title: v.string(),
    artist: v.string(),
    duration: v.optional(v.number()),
  },
  handler: async (ctx, { title, artist, duration }): Promise<{
    words: WordLyricLine[];
  } | null> => {
    const cleanTitle = title.trim();
    if (!cleanTitle) return null;

    const key = cacheKey("netease", "track", {
      t: cleanTitle.toLowerCase(),
      a: artist.trim().toLowerCase(),
      d: duration ?? 0,
    });
    const cached = (await ctx.runQuery(api.providerCache.cacheGet, { key })) as {
      value: { words: WordLyricLine[] } | null;
    } | null;
    if (cached) return cached.value;

    const result = await dedupeRequest(key, async () => {
      const slot = takeRateSlot("netease:lyrics");
      if (!slot.allowed) return null;

      const query = encodeURIComponent(
        [cleanTitle, artist.trim()].filter(Boolean).join(" "),
      );
      const search = await getJson(`${SEARCH_URL}?s=${query}&type=1&limit=5`);
      if (!search) return null;
      const song = pickSongId(search, cleanTitle, duration);
      if (!song) return null;

      const lyricBody = await getJson(
        `${LYRIC_URL}?id=${song.id}&lv=1&kv=1&tv=-1&yv=1`,
      );
      if (!lyricBody) return null;
      const yrc = isRecord(lyricBody.yrc) ? lyricBody.yrc : undefined;
      const payload = typeof yrc?.lyric === "string" ? yrc.lyric : null;
      const words = parseYrc(payload);
      return words.length > 0 ? { words } : null;
    });

    await ctx.runMutation(internal.providerCache.cachePut, {
      key,
      value: result,
      provider: "netease",
      // Word timings are facts about a recording, not about a CDN session.
      ttlSeconds: TTL.track,
    });
    return result;
  },
});
