import { describe, expect, test } from 'vitest';
import { readSource } from "./helpers/tailwind-css.js";

const lyricsSource = readSource("src/convex/lyrics.ts");
const schemaSource = readSource("src/convex/schema.ts");
const playerSource = readSource("src/components/player/FullscreenPlayer.tsx");
// The lyrics client moved out of the fullscreen player into its own hook, so
// the fetching logic is asserted against where it actually lives now.
const lyricsHookSource = readSource("src/components/player/useTrackLyrics.ts");

describe("lyrics lookup matches more songs", () => {
  test("titles are normalised instead of searched verbatim", () => {
    // The catalogue shape is "Artist - Title (Remaster) [feat. X]", and a
    // verbatim search for that finds nothing in any provider.
    expect(lyricsSource).toMatch(
      /export function cleanTitle\(title: string\): string/,
    );
    expect(lyricsSource).toMatch(
      /export function cleanArtist\(artist: string\): string/,
    );
    expect(lyricsSource).toContain('out.replace(/\\((?:[^()]*)\\)/g, " ")');
    expect(lyricsSource).toContain('out.replace(/\\[(?:[^\\][]*)\\]/g, " ")');
    expect(lyricsSource).toMatch(/FEATURED/);
    expect(lyricsSource).toMatch(/VERSION_WORDS/);
  });

  test("every plausible pair is tried, most literal first", () => {
    const body = lyricsSource.slice(
      lyricsSource.indexOf("export function buildCandidates"),
    );
    const fn = body.slice(0, body.indexOf("\n}"));
    expect(fn).toMatch(/tidy\(title\), artist: tidy\(artist\)/);
    expect(fn).toMatch(/title: cleanT, artist: cleanA/);
    // A title-only lookup rescues a track whose artist field is wrong.
    expect(fn).toMatch(/title: cleanT, artist: ""/);
    expect(fn).toMatch(/const seen = new Set<string>\(\)/);
  });

  test("a title that is only decoration never searches for nothing", () => {
    const body = lyricsSource.slice(
      lyricsSource.indexOf("export function cleanTitle"),
    );
    const fn = body.slice(0, body.indexOf("\n}"));
    expect(fn).toMatch(/return out\.length >= 2 \? out : tidy\(title\)/);
  });

  test("search results are ranked instead of taken first-come", () => {
    expect(lyricsSource).toMatch(
      /function similarity\(a: string, b: string\): number/,
    );
    // Whitespace-tolerant: prettier reflows the parameter list across lines,
    // and a source assertion should track the code, not the formatter.
    expect(lyricsSource.replace(/\s+/g, " ")).toMatch(
      /function rank\( results: LrcRecord\[\], candidate: Candidate/,
    );
    expect(lyricsSource).toMatch(/if \(score > bestScore\)/);
    // A live/acoustic cut is a worse answer than the studio recording, and a
    // duration that is 20s out is usually a different song entirely.
    expect(lyricsSource).toMatch(/score -= 12/);
    expect(lyricsSource).toMatch(/score -= 10/);
  });

  test("a result that does not match the title is never returned", () => {
    // The +18 for carrying synced lyrics was enough to win on its own, so a
    // search result with a blank `trackName` was accepted and the user was
    // shown a different song's lyrics — worse than being told there are none.
    const body = lyricsSource.slice(
      lyricsSource.indexOf("function rank("),
      lyricsSource.indexOf("async function lrclibSearch"),
    );
    expect(body).toMatch(/const titleMatch = similarity\(candidate\.title/);
    expect(body).toMatch(/if \(titleMatch === 0\) continue;/);
    expect(body).toMatch(/bestTitleMatch >= 0\.3/);
  });

  test("cleaning a title is not affected by leftover regex state", () => {
    // `VERSION_WORDS` is /g, and `RegExp.test` on a global regex resumes from
    // `lastIndex` instead of 0. The "Artist - Title" branch read whatever the
    // previous call left behind, so the same input could be cleaned differently
    // on two consecutive lookups.
    const body = lyricsSource.slice(
      lyricsSource.indexOf("export function cleanTitle"),
      lyricsSource.indexOf("export function cleanArtist"),
    );
    expect(lyricsSource).toMatch(
      /function isVersionWord\(value: string\): boolean/,
    );
    expect(lyricsSource).toMatch(/VERSION_WORDS\.lastIndex = 0;/);
    expect(body).toMatch(/!isVersionWord\(dash\[1\]\)/);
    expect(body).not.toMatch(/VERSION_WORDS\.test\(/);
  });

  test("synced and plain lyrics are read from one request, with fallbacks", () => {
    // One `/api/get` call returns both LRC and plain text; a second provider
    // covers the songs the first has never heard of.
    expect(lyricsSource).toMatch(/syncedLyrics|plainLyrics/);
    expect(lyricsSource).toMatch(/lyrics\.ovh/);
    expect(lyricsSource).toMatch(/AbortSignal\.timeout/);
  });

  test("a miss is cached too, so a song with no lyrics is only looked up once", () => {
    expect(lyricsSource).toMatch(/CACHE_TTL_MS = 1000 \* 60 \* 60 \* 24 \* 30/);
    // Each provider pass gets its own budget now. A single shared deadline
    // across all providers is what starved the later ones.
    expect(lyricsSource).toMatch(/STAGE_BUDGET_MS/);
    expect(lyricsSource).not.toMatch(/LOOKUP_BUDGET_MS/);
    expect(schemaSource).toMatch(/lyricsCache/);
    expect(schemaSource).toMatch(/byKey/);
  });

  test("the client re-fetches when the track changes", () => {
    // The fetch effect listed only the action in its dependencies, so the
    // panel cleared itself on a track change and then never asked again:
    // every song after the first sat on "loading" for the rest of the session.
    const effect = lyricsHookSource.slice(
      lyricsHookSource.indexOf("const fetchLyrics = useAction"),
      lyricsHookSource.indexOf("const activeIndex = useMemo"),
    );
    expect(effect).toMatch(/\}, \[enabled, fetchLyrics, key\]\);/);
    // The timings flag is per-result and must not survive into the next song.
    expect(lyricsHookSource).toMatch(/setSynced\(true\);/);
  });

  test("the client tells the user when lyrics have no timings", () => {
    // Plenty of songs only exist in the plain-text database; they must still
    // render, just without auto-scroll and highlighting.
    expect(playerSource).toMatch(/No timings/);
    expect(playerSource).toMatch(/synced/);
  });
});
