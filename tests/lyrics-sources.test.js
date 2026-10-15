import { describe, expect, test } from 'vitest';
import { readSource } from "./helpers/tailwind-css.js";

const lyrics = readSource("src/convex/lyrics.ts");
const providers = readSource("src/convex/lyricsProviders.ts");

describe("every lyrics provider actually gets to run", () => {
  test("each pass has its own budget instead of one shared deadline", () => {
    // This is why so many songs came back empty. Five candidates at up to 4s
    // each could burn the entire 6s inside the LRCLIB exact pass, so the
    // deadline tripped before the search pass and before the plain-text
    // provider — which made lyrics.ovh dead code in practice.
    expect(lyrics).toMatch(/const STAGE_BUDGET_MS = 4000;/);
    expect(lyrics).not.toMatch(/const LOOKUP_BUDGET_MS = 6000;/);
  });

  test("candidates are fanned out in parallel, not awaited one by one", () => {
    // Sequential awaits cost one round trip per candidate, which is both slow
    // and what exhausted the budget.
    expect(lyrics).toMatch(/async function firstHit<T>\(/);
    expect(lyrics).toMatch(
      /const settled: Promise<\(\{ candidate: Candidate; value: T \| null \} \| null\)\[]> =\s*\n?\s*Promise\.all\(/,
    );
    // The whole pass is still bounded, so one stalling provider can't hold up
    // the passes queued behind it.
    expect(lyrics).toMatch(/Promise\.race\(\[\s*\n\s*settled,/);
  });

  test("the first-hit helper survives a rejecting provider", () => {
    // One thrown fetch must not take the whole candidate list down with it.
    expect(lyrics).toMatch(/firstHit[\s\S]{0,600}catch \{\s*\n\s*return null;/);
  });

  test("all four passes are present and in priority order", () => {
    const lrclibGet = lyrics.indexOf("lrclibGet(c, album, dur)");
    const lrclibSearch = lyrics.indexOf("lrclibSearch(c, dur)");
    const musixmatch = lyrics.indexOf("internal.lyricsProviders.musixmatch");
    const ovh = lyrics.indexOf("lyricsOvh(c)");
    expect(lrclibGet).toBeGreaterThan(-1);
    // Synced timings first, then the wider catalogue, then plain text.
    expect(lrclibSearch).toBeGreaterThan(lrclibGet);
    expect(musixmatch).toBeGreaterThan(lrclibSearch);
    expect(ovh).toBeGreaterThan(musixmatch);
  });

  test("the plain-text pass skips artist-less candidates instead of stopping", () => {
    // The old loop `break`ed on the first candidate with no artist, so every
    // candidate after it was never tried.
    expect(lyrics).toMatch(
      /const withArtist = candidates\.filter\(\(c\) => !!c\.artist\);/,
    );
    expect(lyrics).toMatch(/firstHit\(withArtist, \(c\) => lyricsOvh\(c\)\)/);
  });
});

describe("Musixmatch is an optional, private provider", () => {
  test("it is an internal action, so the key-gated provider is not public API", () => {
    expect(providers).toMatch(/export const musixmatch = internalAction\(\{/);
    expect(providers).not.toMatch(/export const musixmatch = action\(\{/);
  });

  test("it needs a key and returns null without one", () => {
    // Inert by default: no key, no behaviour change, no wasted request.
    expect(providers).toMatch(
      /const key = apiKey\(\);\s*\n\s*if \(!key \|\| !artist\.trim\(\)\) return null;/,
    );
    expect(providers).toMatch(/process\.env\.MUSIXMATCH_API_KEY/);
  });

  test("it runs in the Node runtime so process.env exists", () => {
    expect(providers.startsWith('"use node";')).toBe(true);
    // A `"use node"` module may only contain actions, which is why the query
    // and mutation stayed in lyrics.ts.
    expect(providers).not.toMatch(/= query\(\{/);
    expect(providers).not.toMatch(/= mutation\(\{/);
  });

  test("it asks for synced LRC before plain text", () => {
    expect(providers).toMatch(/namespace: "lyrics_richsynched"/);
    expect(providers).toMatch(/subtitle_format: "lrc"/);
    // The ladder drives the preference: synced pass, then plain.
    expect(lyrics).toMatch(/for \(const wantSynced of \[true, false\]\)/);
  });

  test("a non-200 provider status is treated as a miss, not a hit", () => {
    expect(providers).toMatch(
      /if \(data\.message\?\.header\?\.status_code !== 200\) return null;/,
    );
  });
});

describe("per-request timeouts stay inside the stage budget", () => {
  test("no request may outlive the pass that contains it", () => {
    expect(lyrics).not.toContain("AbortSignal.timeout(4000)");
    expect(lyrics).toMatch(/const REQUEST_TIMEOUT_MS = 3500;/);
    expect(lyrics).toMatch(/AbortSignal\.timeout\(REQUEST_TIMEOUT_MS\)/);
  });
});
