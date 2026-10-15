import { describe, expect, test } from 'vitest';
import { readSource } from "./helpers/tailwind-css.js";

/**
 * Why some artist pages showed "Nothing found".
 *
 * `src/convex/playlists.ts` records a measurement taken against this very
 * deployment, next to the import-repair resolver:
 *
 *   "Fanning these out with Promise.allSettled looked like the obvious way to
 *    make a 107-track playlist finish quickly. Live, two concurrent InnerTube
 *    searches return `{"items": []}` while the identical two queries run one
 *    after the other return full results. YouTube throttles the burst and
 *    answers with silence rather than with an error."
 *
 *   "Even paced, roughly half of all searches from this IP come back empty, so
 *    one retry after a pause recovers most of them."
 *
 * `src/pages/Artist.tsx` was doing precisely the rejected thing — a
 * `Promise.all` of two InnerTube searches — and it wrapped both in
 * `.catch(() => ({ items: [] }))`. So a throttled search and a genuine
 * "this artist has no tracks" produced the identical page:
 *
 *   "Nothing found — We couldn't find any playable tracks for <artist>."
 *
 * That is a fabrication: the tracks exist (the listener can see the song is by
 * that artist), the request was simply refused.
 */

/**
 * Collapses the source to a single whitespace-normalised line so the
 * assertions below are immune to prettier's line wrapping — and strips `//`
 * comment markers FIRST.
 *
 * Both halves are load-bearing. Collapsing without stripping leaves the `//`
 * sitting in the middle of a wrapped sentence, so `"two concurrent InnerTube
 * searches return"` becomes `"two concurrent // InnerTube searches return"`
 * and the assertion fails on text that is plainly there. And these are
 * assertions about CODE: the `Promise.all` anti-pattern is *quoted in a
 * comment* right above the fixed code, so a naive `not.toMatch` would flag
 * the explanation of the bug as the bug.
 */
const code = (relativePath) =>
  readSource(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/\s+/g, " ");

/** Same normalisation, but comments KEPT — for the assertions that exist to
 *  stop a measured finding from being deleted along with its explanation. */
const withComments = (relativePath) => {
  const raw = readSource(relativePath);
  return (
    (raw.match(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm) ?? [])
      .join(" ")
      // Drop the leading `//` of each wrapped comment line. A sentence broken
      // across lines is still one sentence, and joining the lines *with* their
      // markers splices `//` into the middle of it.
      .replace(/(^|\s)\/\/\s?/g, " ")
      .replace(/\s+/g, " ")
  );
};

const artist = code("src/pages/Artist.tsx");
const artistComments = withComments("src/pages/Artist.tsx");
const playlistsComments = withComments("src/convex/playlists.ts");

describe("artist page searches survive YouTube throttling", () => {
  test("the two searches are never fired concurrently", () => {
    // The documented anti-pattern. Two concurrent InnerTube searches return
    // empty items from this deployment; that is the whole bug.
    expect(artist).not.toMatch(/Promise\.all\(\s*\[\s*searchYt/);
    expect(artist).not.toMatch(/Promise\.allSettled\(\s*\[\s*searchYt/);
    // The related-artists search must be awaited on its own line, after the
    // first one has resolved.
    expect(artist).toMatch(/const mine = await search\(/);
    expect(artist).toMatch(/const similar =[^=]*await search\(/);
  });

  test("an empty result is retried, spaced out", () => {
    // "roughly half of all searches from this IP come back empty, so one
    // retry after a pause recovers most of them."
    expect(artist).toMatch(/REPAIR_SEARCH_ATTEMPTS/);
    expect(artist).toMatch(/REPAIR_SEARCH_GAP_MS/);
    expect(artist).toMatch(
      /for \(\s*let attempt = 0;\s*attempt < REPAIR_SEARCH_ATTEMPTS/,
    );
    // The pause has to happen BETWEEN attempts, not after the loop.
    expect(artist).toMatch(/attempt > 0[\s\S]{0,120}setTimeout/);
  });

  test("it reuses the constants the repair path already proved", () => {
    // One set of numbers, measured once, instead of a second guess at pacing.
    // Prettier wraps the import; the collapsed form carries a trailing comma.
    expect(artist).toMatch(
      /import \{ REPAIR_SEARCH_ATTEMPTS, REPAIR_SEARCH_GAP_MS,? \} from "@\/lib\/importRepair"/,
    );
    const repair = readSource("src/lib/importRepair.ts");
    expect(repair).toMatch(/export const REPAIR_SEARCH_ATTEMPTS = 3/);
    expect(repair).toMatch(/export const REPAIR_SEARCH_GAP_MS = 3_000/);
  });

  test("a thrown search is not reported as an empty artist", () => {
    // The `.catch(() => ({ items: [] }))` conflation is what let a rate-limited
    // request masquerade as "this artist has no tracks".
    expect(artist).not.toMatch(
      /\.catch\(\(\) => \(\{ items: \[\] as YtItem\[\] \}\)\)/,
    );
    expect(artist).toMatch(/setFailedKey\(mine\.errored \? query : null\)/);
  });
});

describe("the artist page tells the truth about an empty page", () => {
  test("a throttled search is named as such, not as a missing artist", () => {
    expect(artist).toMatch(/Couldn't reach YouTube/);
    expect(artist).toMatch(/rate-limiting/);
    expect(artist).toMatch(/searchTerm=\{artistName\}/);
  });

  test("a genuine empty result still says Nothing found", () => {
    // The honest answer must still be available — the fix is to stop lying
    // about the throttled case, not to stop reporting empty artists.
    expect(artist).toMatch(
      /searchFailed \? "Couldn't reach YouTube" : "Nothing found"/,
    );
  });

  test("there is a retry that actually re-runs the search", () => {
    expect(artist).toMatch(/Try again/);
    // `retryNonce` has to be in the effect's dependency list, otherwise the
    // button re-renders without re-fetching and is just another dead control.
    expect(artist).toMatch(/\}, \[query, searchYt, retryNonce\]\)/);
  });

  test("the error from one artist cannot leak onto the next", () => {
    // The failure is TAGGED with the query it belongs to and derived by
    // comparison, so a stale flag can never describe a different artist.
    // Asserting the absence of the resetting effect matters as much as the
    // presence of the tag: `useEffect(() => setSearchFailed(false), [query])`
    // also "works", but it is a synchronous setState in an effect and cascades
    // a render on every artist-to-artist navigation.
    expect(artist).toMatch(/failedKey === query/);
    expect(artist).not.toMatch(/useEffect\(\(\) => \{ setSearchFailed/);
    expect(artist).not.toMatch(/setSearchFailed\(false\)/);
  });
});

describe("the measured evidence stays on the record", () => {
  test("the throttling finding this fix relies on is still documented", () => {
    // If this comment is ever deleted, the pacing looks arbitrary and someone
    // will "optimise" the sequential searches back into a Promise.all.
    expect(playlistsComments).toMatch(
      /two concurrent InnerTube searches return/,
    );
    expect(playlistsComments).toMatch(
      /roughly half of all searches from this IP/,
    );
  });

  test("the artist page explains the sequential pacing in place", () => {
    // Same reason: the non-obvious ordering needs to be defended where it is
    // written, not only in a resolver three files away.
    expect(artistComments).toMatch(/SEQUENTIAL, paced, and retried/);
    expect(artistComments).toMatch(/playlists\.ts/);
  });
});
