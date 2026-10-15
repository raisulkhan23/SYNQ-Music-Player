import { describe, expect, test } from 'vitest';
import { readSource } from "./helpers/tailwind-css.js";

/**
 * Two small regressions, both of the same kind: a feature that was still
 * present in the code but had become invisible in the UI, so it read as though
 * it had been deleted.
 *
 * 1. The "Lyric & lo-fi videos" section was gated on `lyricResults.length > 0`
 *    while the backend reported every failure as an empty list. One transient
 *    YouTube error therefore removed the whole section, silently, with no
 *    message and no way to retry.
 * 2. The PWA install button was a plain inline `<button>`. Tailwind's preflight
 *    sets `svg { display: block }`, so the Download icon became a block and
 *    forced a line break of its own — icon stacked above the word "Install".
 */

const search = readSource("src/pages/Search.tsx");
const youtube = readSource("src/convex/youtube.ts");
const pwa = readSource("src/components/pwa/PwaManager.tsx");

const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const searchCode = stripComments(search);
const youtubeCode = stripComments(youtube);
const pwaCode = stripComments(pwa);

function convexFn(code, name) {
  const start = code.indexOf(`export const ${name} = `);
  if (start === -1) throw new Error(`no exported Convex function ${name}`);
  const next = code.indexOf("\nexport const ", start + 1);
  return code.slice(start, next === -1 ? code.length : next);
}

describe("the lyric and lo-fi search section is still here", () => {
  const action = convexFn(youtubeCode, "searchLyricVideos");
  const section = searchCode.slice(
    searchCode.indexOf("lyric-video-results-heading"),
    searchCode.indexOf("TabsContent") === -1
      ? searchCode.indexOf("lyric-video-results-heading") + 4000
      : searchCode.length,
  );

  test("the action still exists and still derives its own query", () => {
    expect(youtube).toMatch(/export const searchLyricVideos = action\(\{/);
    // The derived string must stay scoped to this action only — it is never
    // written back into the user's own search.
    expect(action).toMatch(
      /\$\{rawQuery\} \(lyric video OR lyrics OR lofi OR lo-fi OR music video\)/,
    );
  });

  test("the section is rendered whenever the lookup has settled", () => {
    // The regression: gating on `.length > 0` deleted the section whenever the
    // result was empty, including when the request had simply failed.
    expect(search).toMatch(/\{!lyricSearching && lyricResults !== null && \(/);
    expect(search).not.toMatch(/lyricResults\.length > 0 && \(/);
  });

  test("the heading and its explanation are always rendered", () => {
    expect(search).toMatch(/Lyric &amp; lo-fi videos|Lyric & lo-fi videos/);
    expect(search).toMatch(/Separate uploads/);
  });

  test("a failed lookup is distinguishable from a genuinely empty one", () => {
    // The backend used to return `{ items: [] }` for both, which is why a
    // transient error was indistinguishable from "no matches".
    expect(action).toMatch(/failed: boolean/);
    expect(action).toMatch(/return \{ items: \[\], failed: true \};/);
    expect(action).toMatch(/failed: false \}/);
  });

  test("an empty query is not treated as a failure", () => {
    expect(action).toMatch(
      /if \(!rawQuery\) return \{ items: \[\], failed: false \};/,
    );
  });

  test("the page records the failure flag", () => {
    expect(search).toMatch(/const \[lyricFailed, setLyricFailed\] = useState/);
    expect(search).toMatch(/\.then\(\(\{ items, failed \}\) => \{/);
    expect(search).toMatch(/setLyricFailed\(failed\);/);
  });

  test("the failure flag is cleared when a new search starts", () => {
    // Otherwise a successful retry would still render the error message next
    // to its own results. Asserted against the NEW-SEARCH path specifically:
    // there is a second `setLyricFailed(false)` in the empty-query branch, and
    // a bare `toMatch` would be satisfied by that one alone.
    expect(search).toMatch(
      /setLyricSearching\(true\);[\s\S]{0,300}?setLyricFailed\(false\);/,
    );
  });

  test("a failure says what happened and offers a retry", () => {
    expect(search).toMatch(/Couldn&apos;t reach YouTube for lyric and lo-fi/);
    expect(search).toMatch(
      /onClick=\{\(\) => setRetryKey\(\(k\) => k \+ 1\)\}/,
    );
    // It must be clear the main results are fine, or the listener assumes the
    // whole search broke.
    expect(search).toMatch(/Songs results above are unaffected\./);
  });

  test("a genuinely empty result is explained rather than left blank", () => {
    expect(search).toMatch(
      /No separate lyric or lo-fi uploads for this search\./,
    );
  });

  test("successful results still render as rows", () => {
    expect(section).toMatch(/<RemoteTrackRow/);
    expect(search).toMatch(/key=\{`lyric-\$\{item\.id\}`\}/);
  });

  test("the lo-fi shelf is untouched", () => {
    expect(search).toMatch(/id: "lofi"/);
    expect(search).toMatch(/title: "Late Night Lo-fi"/);
    expect(search).toMatch(/query: "lo-fi beats late night"/);
  });
});

describe("the install button fits on one line", () => {
  const button = pwaCode.slice(
    pwaCode.indexOf("void install();"),
    pwaCode.indexOf('aria-label="Dismiss install notice"'),
  );
  expect(button.length).toBeGreaterThan(200);

  test("it is a flex container, so the icon cannot claim its own line", () => {
    // Tailwind preflight sets `svg { display: block }`. Without an explicit
    // flex context the icon became a block and forced a line break, stacking
    // it above the label.
    expect(button).toMatch(/inline-flex/);
    expect(button).toMatch(/items-center/);
  });

  test("the label cannot break mid-word", () => {
    expect(button).toMatch(/whitespace-nowrap/);
  });

  test("the icon and the label are on one baseline with a gap", () => {
    expect(button).toMatch(/gap-1\.5/);
    expect(button).toMatch(/<Download className="size-3"/);
    expect(button).toMatch(/Install/);
  });

  test("it is a little roomier and cannot be squeezed by its strip", () => {
    // `px-2.5 py-1` → `px-3 py-1.5`, plus `shrink-0` so the long explanatory
    // text beside it cannot compress the button into a wrapped lozenge.
    expect(button).toMatch(/px-3 py-1\.5/);
    expect(button).toMatch(/shrink-0/);
  });
});
