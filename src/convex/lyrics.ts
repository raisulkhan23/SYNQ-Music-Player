import { v } from "convex/values";
import { action, internalMutation, query } from "./_generated/server";
import { api, internal } from "./_generated/api";

export interface LyricLine {
  /** seconds from track start */
  t: number;
  text: string;
  /**
   * A section break, not a real line.
   *
   * Both parsers used to drop empty lines, which flattened every song into one
   * undifferentiated wall of text with no verse structure — the single biggest
   * reason the panel read as a list instead of as lyrics. Blanks are kept as
   * zero-height-content markers purely so the UI can render the gap.
   */
  blank?: boolean;
}

const UA = { "User-Agent": "SYNQ/1.0 (web player)" };
/** Upstream providers are free and rate limited; a miss is cached too so a
 *  song with genuinely no lyrics anywhere is only looked up once. */
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30;
/**
 * Wall-clock budget for ONE provider pass.
 *
 * This used to be a single budget shared by every provider, which is why so
 * many songs came back empty. Five candidates at up to 4s each could burn the
 * whole 6s inside the LRCLIB exact pass alone, so the deadline check tripped
 * before the LRCLIB *search* pass and before lyrics.ovh ever ran — the plain
 * text provider was, in practice, dead code. Each pass now gets its own budget
 * and its candidates run concurrently, so every provider is genuinely tried.
 */
/** Wall-clock ceiling for a single provider pass, across all its candidates. */
const STAGE_BUDGET_MS = 4000;
/** Per-request ceiling, comfortably under the stage budget. */
const REQUEST_TIMEOUT_MS = 3500;

/** Parse LRC-format text into timed lines. */
function parseLrc(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const raw of lrc.split("\n")) {
    const m = raw.match(/^\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\](.*)$/);
    if (!m) continue;
    const t =
      Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(`0.${m[3]}`) : 0);
    const text = m[4].trim();
    // A timestamp with no words is a section break in an LRC file. Keeping it
    // as a blank marker is what gives the panel its verse rhythm.
    if (!text) {
      // Leading padding is dropped, and a RUN of blanks collapses to one, or
      // a sloppy provider's stack of empty timestamps opens a hole in the
      // middle of a verse. `distributePlain` applies the same two rules.
      const prev = lines[lines.length - 1];
      if (lines.length === 0 || prev?.blank) continue;
      lines.push({ t, text: "", blank: true });
      continue;
    }
    lines.push({ t, text });
  }
  // Trailing breaks carry no information and just add dead space.
  while (lines.length > 0 && lines[lines.length - 1].blank) lines.pop();
  return lines;
}

/**
 * Distribute unsynced plain-text lyrics evenly across the track duration so
 * they can be shown in the synced-style view (approximate, but far better
 * than "no lyrics found" when only plain text exists).
 */
function distributePlain(text: string, duration: number): LyricLine[] {
  const kept: string[] = [];
  for (const raw of text.split("\n")) {
    const l = raw.trim();
    // skip [Chorus] style tags
    if (/^\[.*\]$/.test(l)) continue;
    // Blank lines survive as section breaks, but a run of them collapses to
    // one so a sloppy provider can't open a hole in the middle of a verse.
    if (l.length === 0) {
      if (kept.length > 0 && kept[kept.length - 1] !== "") kept.push("");
      continue;
    }
    kept.push(l);
  }
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  const rawLines = kept;
  if (rawLines.length === 0) return [];
  // Reserve 8% at the end for the outro; spread lines over the rest.
  const usable = duration > 60 ? duration * 0.92 : duration * 0.8;
  const step = usable / rawLines.length;
  return rawLines.map((text, i) =>
    text === ""
      ? { t: Number((i * step).toFixed(2)), text: "", blank: true }
      : { t: Number((i * step).toFixed(2)), text },
  );
}

// ---------------------------------------------------------------------------
// Matching
//
// The single biggest cause of a miss is a title that carries the decoration
// YouTube/catalogue titles come with. LRCLIB answers 404 for
// "Show Me Love (Radio Edit)" and 200 for "Show Me Love" — same song. So the
// raw title is never the only thing we try.
// ---------------------------------------------------------------------------

/** Words that mark a version/edition rather than part of the song title. */
const VERSION_WORDS =
  /\b(radio edit|single version|album version|extended mix|extended edit|remaster(?:ed)?(?: \d{4})?|deluxe|bonus track|explicit|clean version|edit|remix|version|live|acoustic|instrumental|demo|mono|stereo|album edit|full album video|official (?:music )?video|official audio|lyric video|lyrics|visualizer|audio|hd|hq|4k|mv|visualiser)\b/gi;

const FEATURED =
  /\s*[([]?\s*\b(?:feat|ft|featuring|with)\b\.?\s[^)\]]*[)\]]?/gi;

/** `test` against a /g regex is stateful, so the flag is cleared first. */
function isVersionWord(value: string): boolean {
  VERSION_WORDS.lastIndex = 0;
  return VERSION_WORDS.test(value);
}

const ARTIST_NOISE =
  /\s*[-–—]\s*(?:topic|official|video|audio|lyrics?|hd|hq|mv|visualizer)\s*$/i;

/** Strip quotes, collapse whitespace, tidy punctuation. */
function tidy(value: string): string {
  return value
    .replace(/["'“”‘’`]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*,\s*/g, ", ")
    .trim();
}

/** Remove bracketed suffixes, then any trailing version/edition wording. */
export function cleanTitle(title: string): string {
  let out = title;
  // Leading "Artist - Title" is a very common catalogue shape.
  const dash = out.match(/^(.{2,60}?)\s+[-–]\s+(.+)$/);
  // `VERSION_WORDS` is /g, and `RegExp.test` on a global regex advances
  // `lastIndex` instead of starting from 0. The flag is only reset by the
  // `replace` further down, so the test was reading leftover state from
  // whichever call ran before and could decide to keep "Artist - " glued onto
  // the title (or strip a real title) on a whim.
  if (dash && !isVersionWord(dash[1])) out = dash[2];
  out = out.replace(/\((?:[^()]*)\)/g, " ");
  out = out.replace(/\[(?:[^\][]*)\]/g, " ");
  out = out.replace(FEATURED, " ");
  out = out.replace(VERSION_WORDS, " ");
  out = tidy(out);
  // A title that was *only* decoration ("(Live)") leaves nothing behind; fall
  // back to the original so we never search for an empty string.
  return out.length >= 2 ? out : tidy(title);
}

/** The head artist, without featured guests or channel suffixes. */
export function cleanArtist(artist: string): string {
  let out = artist.replace(ARTIST_NOISE, "");
  out = out.replace(FEATURED, " ");
  out = out.split(/\s+(?:&|x|and|\/|,)\s+/)[0] ?? out;
  out = tidy(out);
  return out.length >= 2 ? out : tidy(artist);
}

type Candidate = { title: string; artist: string };

/** Ordered, de-duplicated lookup pairs. Raw first, then progressively cleaner. */
export function buildCandidates(title: string, artist: string): Candidate[] {
  const cleanT = cleanTitle(title);
  const cleanA = cleanArtist(artist);
  const ordered: Candidate[] = [
    { title: tidy(title), artist: tidy(artist) },
    { title: cleanT, artist: cleanA },
    { title: cleanT, artist: tidy(artist) },
    { title: tidy(title), artist: cleanA },
  ];
  // Some providers match on the title alone better than on a half-wrong artist.
  ordered.push({ title: cleanT, artist: "" });
  const seen = new Set<string>();
  return ordered.filter((candidate) => {
    if (!candidate.title) return false;
    const key = `${candidate.title.toLowerCase()}|${candidate.artist.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Cheap similarity in [0,1] used to rank search results. */
function similarity(a: string, b: string): number {
  const left = a
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
  const right = b
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.8;
  const leftWords = new Set(left.split(/\s+/));
  const rightWords = right.split(/\s+/);
  const shared = rightWords.filter((word) => leftWords.has(word)).length;
  return shared / Math.max(leftWords.size, rightWords.length);
}

type LrcRecord = {
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number | null;
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
  instrumental?: boolean;
};

/** One `/api/get` call returns BOTH forms, so this is a single request. */
async function lrclibGet(
  candidate: Candidate,
  album: string | undefined,
  duration: number | undefined,
): Promise<LrcRecord | null> {
  const params = new URLSearchParams({ track_name: candidate.title });
  if (candidate.artist) params.set("artist_name", candidate.artist);
  if (album) params.set("album_name", album);
  // Only send a duration when we trust it: `/api/get` matches on duration to
  // the second, and a live/radio cut differs from the studio one, which turns
  // a would-be hit into a 404.
  if (duration && duration > 0)
    params.set("duration", String(Math.round(duration)));
  try {
    const res = await fetch(`https://lrclib.net/api/get?${params.toString()}`, {
      headers: UA,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as LrcRecord;
  } catch {
    return null;
  }
}

/**
 * Rank search results instead of taking the first hit. A result that matches
 * the title/artist and the duration is worth far more than the first row of a
 * loose search, and a live version is worth less when we did not ask for one.
 */
function rank(
  results: LrcRecord[],
  candidate: Candidate,
  duration?: number,
): LrcRecord | null {
  let best: LrcRecord | null = null;
  let bestScore = -Infinity;
  let bestTitleMatch = 0;
  for (const result of results) {
    if (!result.syncedLyrics && !result.plainLyrics) continue;
    let score = 0;
    // The title has to match at all. Without this floor the flat +18 for
    // carrying synced lyrics was enough on its own, so a search that returned
    // a blank or unrelated `trackName` won and the user was shown the wrong
    // song's lyrics — strictly worse than being told there are none.
    const titleMatch = similarity(candidate.title, result.trackName ?? "");
    if (titleMatch === 0) continue;
    score += titleMatch * 40;
    if (candidate.artist)
      score += similarity(candidate.artist, result.artistName ?? "") * 30;
    if (result.syncedLyrics) score += 18;
    if (duration && result.duration) {
      const delta = Math.abs(result.duration - duration);
      if (delta <= 2) score += 14;
      else if (delta <= 6) score += 6;
      else if (delta > 20) score -= 10;
    }
    // A live/acoustic cut is a worse match than the studio recording.
    const name =
      `${result.trackName ?? ""} ${result.albumName ?? ""}`.toLowerCase();
    if (/\b(live|acoustic|remaster|cover|karaoke|instrumental)\b/.test(name))
      score -= 12;
    if (score > bestScore) {
      bestScore = score;
      bestTitleMatch = titleMatch;
      best = result;
    }
  }
  // A single shared word is a weak match for a multi-word title: prefer any
  // candidate that matches the title properly over a one-word collision.
  return best !== null && bestTitleMatch >= 0.3 && bestScore > 0 ? best : null;
}

async function lrclibSearch(
  candidate: Candidate,
  duration: number | undefined,
): Promise<LrcRecord | null> {
  try {
    const res = await fetch(
      `https://lrclib.net/api/search?${new URLSearchParams({
        track_name: candidate.title,
        ...(candidate.artist ? { artist_name: candidate.artist } : {}),
      }).toString()}`,
      { headers: UA, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    if (!res.ok) return null;
    return rank((await res.json()) as LrcRecord[], candidate, duration);
  } catch {
    return null;
  }
}

/** lyrics.ovh — free plain-text lyrics API, no key required. */
async function lyricsOvh(candidate: Candidate): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.lyrics.ovh/v1/${encodeURIComponent(candidate.artist)}/${encodeURIComponent(candidate.title)}`,
      { headers: UA, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { lyrics?: string };
    return data.lyrics?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Run every candidate for one provider at the same time and take the first
 * hit, in candidate order so the most faithful match still wins a tie.
 *
 * Sequential awaits meant five candidates cost five round trips. That is both
 * slow and the reason the shared budget ran out before the later providers
 * were reached.
 */
async function firstHit<T>(
  candidates: Candidate[],
  run: (candidate: Candidate) => Promise<T | null>,
): Promise<{ candidate: Candidate; value: NonNullable<T> } | null> {
  const settled: Promise<({ candidate: Candidate; value: T | null } | null)[]> =
    Promise.all(
      candidates.map(
        async (
          candidate,
        ): Promise<{ candidate: Candidate; value: T | null } | null> => {
          try {
            return { candidate, value: await run(candidate) };
          } catch {
            return null;
          }
        },
      ),
    );
  // The pass gets its own wall-clock budget. A provider that stalls (a slow
  // Musixmatch action, say) must not hold up the passes after it.
  const results = await Promise.race([
    settled,
    new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), STAGE_BUDGET_MS),
    ),
  ]);
  if (!results) return null;
  for (const result of results) {
    if (result && result.value) {
      return { candidate: result.candidate, value: result.value };
    }
  }
  return null;
}

export type FetchLyricsResult = {
  lines: LyricLine[];
  /** False when the lines are time-distributed guesses over plain text. */
  synced: boolean;
  source: string;
  /** Set when the lookup hit a cached "no lyrics anywhere" entry. */
  missing?: boolean;
};

function toResult(
  record: LrcRecord,
  source: string,
  duration: number,
): FetchLyricsResult | null {
  const syncedLines = record.syncedLyrics ? parseLrc(record.syncedLyrics) : [];
  if (syncedLines.length > 0) {
    return { lines: syncedLines, synced: true, source };
  }
  if (record.plainLyrics) {
    const lines = distributePlain(record.plainLyrics, duration);
    if (lines.length > 0) return { lines, synced: false, source };
  }
  return null;
}

/**
 * Fetch lyrics, widening the match rather than the provider list.
 *
 * LRCLIB is the only source with frame-accurate lyrics, so it is tried first
 * and hardest: every candidate pair, exact lookup then ranked search, taking
 * whichever form comes back (synced preferred, plain accepted). Only then does
 * the plain-text-only provider run, for the tracks LRCLIB does not carry.
 *
 * Provider notes: the ChartLyrics endpoint that used to be third here is dead
 * (the host no longer completes a TLS handshake), which meant every miss paid
 * a connection timeout before giving up. It has been removed rather than
 * replaced with another unverified host.
 */
export const fetchLyrics = action({
  args: {
    title: v.string(),
    artist: v.string(),
    album: v.optional(v.string()),
    duration: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { title, artist, album, duration },
  ): Promise<FetchLyricsResult | null> => {
    const dur = duration && duration > 0 ? duration : 210; // reasonable default
    const candidates = buildCandidates(title, artist);

    // `buildCandidates` drops every candidate with no usable title, so a
    // blank/whitespace title yields an EMPTY list. The miss path below ended
    // with `store(candidates[0]!, null)`, which on that empty list
    // dereferenced `undefined` and threw a TypeError — a hard action failure
    // instead of the honest "no lyrics" answer. The non-null assertion is
    // what hid it from the compiler.
    //
    // There is also nothing to cache: the key is derived from the title, and
    // there is no title. So returning here is both correct and cheaper than
    // spending four provider passes to discover there was never a query.
    if (candidates.length === 0) {
      return { lines: [], synced: false, source: "none", missing: true };
    }

    // Cached hits and cached misses both come back immediately.
    for (const candidate of candidates) {
      const cached = await ctx.runQuery(api.lyrics.cacheGet, {
        key: cacheKey(candidate),
      });
      if (cached) {
        if (cached.missing)
          return { lines: [], synced: false, source: "cache", missing: true };
        return {
          lines: cached.lines as LyricLine[],
          synced: cached.synced,
          source: cached.source,
        };
      }
    }

    const store = async (
      candidate: Candidate,
      result: FetchLyricsResult | null,
    ) => {
      await ctx.runMutation(internal.lyrics.cachePut, {
        key: cacheKey(candidate),
        lines: result?.lines ?? [],
        synced: result?.synced ?? false,
        source: result?.source ?? "none",
        missing: result === null,
        fetchedAt: Date.now(),
      });
    };

    // Each pass gets its own budget and fans its candidates out in parallel,
    // so a slow provider can no longer starve the ones behind it.

    // 1. LRCLIB, exact lookup. One request yields both forms.
    {
      const hit = await firstHit(candidates, (c) => lrclibGet(c, album, dur));
      const result = hit ? toResult(hit.value, "lrclib", dur) : null;
      if (hit && result) {
        await store(hit.candidate, result);
        return result;
      }
    }

    // 2. LRCLIB search, ranked. Reaches versions LRCLIB stores under a
    //    slightly different name than the one we were handed.
    {
      const hit = await firstHit(candidates, (c) => lrclibSearch(c, dur));
      const result = hit ? toResult(hit.value, "lrclib", dur) : null;
      if (hit && result) {
        await store(hit.candidate, result);
        return result;
      }
    }

    // 3. Musixmatch, synced first — the widest catalogue, and it can return
    //    real timings, so it is worth asking for LRC before plain text.
    //    Inert unless MUSIXMATCH_API_KEY is set on the deployment.
    for (const wantSynced of [true, false]) {
      const hit = await firstHit(candidates, (c) =>
        ctx.runAction(internal.lyricsProviders.musixmatch, {
          title: c.title,
          artist: c.artist,
          synced: wantSynced,
        }),
      );
      if (!hit) continue;
      const record: LrcRecord = {
        syncedLyrics: wantSynced ? hit.value.lrc : null,
        plainLyrics: hit.value.plain,
      };
      const result = toResult(record, "musixmatch", dur);
      if (result) {
        await store(hit.candidate, result);
        return result;
      }
    }

    // 4. Plain-text provider, for the tracks nothing else carries at all.
    //    Only the artist-bearing candidates: lyrics.ovh keys on both, and the
    //    old loop `break`ed on the first artist-less candidate instead of just
    //    skipping it.
    {
      const withArtist = candidates.filter((c) => !!c.artist);
      const hit = await firstHit(withArtist, (c) => lyricsOvh(c));
      if (hit) {
        const lines = distributePlain(hit.value, dur);
        if (lines.length > 0) {
          const result: FetchLyricsResult = {
            lines,
            synced: false,
            source: "lyrics.ovh",
          };
          await store(hit.candidate, result);
          return result;
        }
      }
    }

    // `candidates` is guaranteed non-empty by the guard above, but read it
    // defensively rather than asserting: a crash here would lose the real
    // miss result the caller is about to receive.
    const missKey = candidates[0];
    if (missKey) await store(missKey, null);
    return null;
  },
});

/**
 * Bump when the *shape* of the cached lines changes, not when a provider
 * changes. The cache stores parsed lines, so entries written before the
 * section-break markers existed would keep serving a flat, structureless
 * lyric for their whole 30-day TTL and the new panel would look broken on
 * exactly the songs people have already played.
 */
const CACHE_SCHEMA_VERSION = "v2";

function cacheKey(candidate: Candidate): string {
  return `${CACHE_SCHEMA_VERSION}|${candidate.title.toLowerCase()}|${candidate.artist.toLowerCase()}`;
}

export const cacheGet = query({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const entry = await ctx.db
      .query("lyricsCache")
      .withIndex("byKey", (q) => q.eq("key", key))
      .unique();
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) return null;
    return {
      lines: entry.lines,
      synced: entry.synced,
      source: entry.source,
      missing: entry.missing,
    };
  },
});

export const cachePut = internalMutation({
  args: {
    key: v.string(),
    lines: v.any(),
    synced: v.boolean(),
    source: v.string(),
    missing: v.boolean(),
    fetchedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("lyricsCache")
      .withIndex("byKey", (q) => q.eq("key", args.key))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, args);
      return;
    }
    await ctx.db.insert("lyricsCache", args);
  },
});
