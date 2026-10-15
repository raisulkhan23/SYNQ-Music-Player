/**
 * Acceptance harness for the SYNQ search relevance engine.
 *
 * Run with:  bun scripts/searchRelevance.acceptance.ts
 *
 * Not part of the app build (tsconfig only includes `src`), so it can use
 * bun's runner without pulling test types into the app tsconfig.
 */
import {
  normalizeForMatch,
  parseQuery,
  rankSearchResults,
  stripVersions,
  detectVersions,
  buildSuggestions,
} from "../src/lib/searchRelevance";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail: string) {
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push(`${name}\n    ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// Section 2 / 14 — normalization equivalence
// ---------------------------------------------------------------------------
console.log("== normalization equivalence ==");
const equivalent = [
  "we don't talk anymore",
  "we dont talk anymore",
  "We Don't Talk Anymore",
  "WE DONT TALK ANYMORE",
  "we-dont-talk-anymore",
  "we_dont_talk_anymore",
  "we  dont  talk  anymore",
  '"We Don\'t Talk Anymore"',
  "(We Don't Talk Anymore)",
];
const canonical = normalizeForMatch("we dont talk anymore");
for (const variant of equivalent) {
  check(
    `normalize ${JSON.stringify(variant)}`,
    normalizeForMatch(variant) === canonical,
    `got ${JSON.stringify(normalizeForMatch(variant))}`,
  );
}
check(
  "diacritics fold",
  normalizeForMatch("Beyoncé") === normalizeForMatch("beyonce"),
  normalizeForMatch("Beyoncé"),
);
check(
  "upload descriptors are stripped before title comparison",
  stripVersions("we-dont-talk-anymore [Official Audio]") === "we dont talk anymore",
  stripVersions("we-dont-talk-anymore [Official Audio]"),
);
check(
  "non-latin survives",
  normalizeForMatch("宇多田ヒカル") === normalizeForMatch("宇多田ヒカル"),
  normalizeForMatch("宇多田ヒカル"),
);

// ---------------------------------------------------------------------------
// Section 3 — apostrophes / contractions
// ---------------------------------------------------------------------------
console.log("== apostrophe / contraction handling ==");
for (const [typed, title] of [
  ["dont", "Don't"],
  ["cant", "Can't"],
  ["wont", "Won't"],
  ["ive", "I've"],
  ["im", "I'm"],
] as const) {
  const top = rankSearchResults(
    [{ id: "1", title, artist: "Someone" }],
    typed,
  )[0];
  check(
    `${typed} -> ${title}`,
    Boolean(top) && top.tier <= 2,
    top ? `tier ${top.tier}` : "no result",
  );
}

// ---------------------------------------------------------------------------
// Section 5 / 16 — tier ordering on a realistic YouTube Music response
// ---------------------------------------------------------------------------
console.log("== tier ordering (exact match must win) ==");

// Deliberately adversarial: the exact match is NOT first in provider order,
// and there are lyric / live / slowed / cover uploads of the same song plus
// completely unrelated uploads that happen to share a word.
const WDTA_POOL = [
  { id: "a1", title: "We Don't Talk Anymore (Lyrics)", artist: "Charlie Puth" },
  { id: "a2", title: "I Ain't Worried", artist: "Unified Spontaneity" },
  { id: "a3", title: "We Don't Talk Anymore - slowed + reverb", artist: "Charlie Puth" },
  { id: "a4", title: "We Don't Talk Anymore", artist: "Charlie Puth • Selena Gomez" },
  { id: "a5", title: "Talk Anymore", artist: "Some Cover Artist" },
  { id: "a6", title: "We Don't Talk Anymore (feat. Selena Gomez)", artist: "Charlie Puth" },
  { id: "a7", title: "Charlie Puth We Don't Talk Anymore", artist: "Charlie Puth" },
  { id: "a8", title: "We Dont Stop Now", artist: "Andrey Faustov" },
  { id: "a9", title: "The Talk", artist: "Random Band" },
  { id: "a10", title: "We Don't Talk Anymore - Live", artist: "Charlie Puth" },
];

for (const q of [
  "we dont talk anymore",
  "we don't talk anymore",
  "We Don't Talk Anymore",
  "we-dont-talk-anymore",
  "WE  DONT  TALK  ANYMORE",
  '  "we dont talk anymore"  ',
]) {
  const ranked = rankSearchResults(WDTA_POOL, q);
  const top = ranked[0];
  check(
    `top result for ${JSON.stringify(q)}`,
    top?.item.id === "a4" && top.tier === 1,
    top ? `got ${JSON.stringify(top.item.title)} (tier ${top.tier}, ${top.score})` : "nothing",
  );
  check(
    `irrelevant "We Dont Stop Now" not in top 3 for ${JSON.stringify(q)}`,
    !ranked.slice(0, 3).some((r) => r.item.id === "a8"),
    ranked
      .slice(0, 3)
      .map((r) => r.item.title)
      .join(" | "),
  );
}

// Section 16 — the expected ordering shape.
{
  const ranked = rankSearchResults(WDTA_POOL, "we dont talk anymore");
  const titles = ranked.map((r) => r.item.title);
  const canonicalIndex = titles.findIndex(
    (t) => stripVersions(t) === "we dont talk anymore" && !detectVersions(t).length,
  );
  check(
    "canonical ranks first",
    canonicalIndex === 0,
    titles.join(" | "),
  );
  const liveIndex = titles.findIndex((t) => detectVersions(t).includes("live"));
  const lyricsIndex = titles.findIndex((t) => detectVersions(t).includes("lyrics"));
  const slowedIndex = titles.findIndex((t) => detectVersions(t).includes("slowed"));
  check(
    "live/lyrics/slowed present but below canonical",
    liveIndex > canonicalIndex && lyricsIndex > canonicalIndex && slowedIndex > canonicalIndex,
    `canonical=${canonicalIndex} live=${liveIndex} lyrics=${lyricsIndex} slowed=${slowedIndex}`,
  );
}

// ---------------------------------------------------------------------------
// Section 6 / 7 — artist + title, word order independent
// ---------------------------------------------------------------------------
console.log("== artist + title intelligence ==");
for (const q of [
  "we dont talk anymore charlie puth",
  "charlie puth we dont talk anymore",
  "charlie puth dont talk anymore",
  "we don't talk anymore selena gomez",
]) {
  const ranked = rankSearchResults(WDTA_POOL, q);
  const top = ranked[0];
  check(
    `top for ${JSON.stringify(q)}`,
    Boolean(top && stripVersions(top.item.title) === "we dont talk anymore"),
    top ? `got ${JSON.stringify(top.item.title)} (tier ${top.tier})` : "nothing",
  );
}

check(
  "artist-only query surfaces the artist's songs",
  (() => {
    const ranked = rankSearchResults(WDTA_POOL, "charlie puth");
    return ranked.length > 0 && ranked.every((r) => r.tier <= 5);
  })(),
  "artist query produced no artist-tier results",
);

// ---------------------------------------------------------------------------
// Section 8 — typo tolerance
// ---------------------------------------------------------------------------
console.log("== typo tolerance ==");
const TYPO_POOL = [
  { id: "t1", title: "We Don't Talk Anymore", artist: "Charlie Puth" },
  { id: "t2", title: "Mary Jane", artist: "Rick Astley" },
];
// "we dont talke anymore" / "we dont talk anmore" must reach the exact track
// through fuzzy title matching. "charli puth" is an ARTIST query with a typo,
// so it legitimately resolves at the artist tier.
for (const q of ["we dont talke anymore", "we dont talk anmore"]) {
  const ranked = rankSearchResults(TYPO_POOL, q);
  const top = ranked[0];
  check(
    `typo ${JSON.stringify(q)} still finds the song`,
    Boolean(top && top.tier <= 3),
    top ? `got ${JSON.stringify(top.item.title)} tier ${top.tier}` : "nothing",
  );
}
{
  const top = rankSearchResults(TYPO_POOL, "charli puth")[0];
  check(
    'typo "charli puth" still finds the Charlie Puth track',
    Boolean(top && top.item.id === "t1"),
    top ? `got ${JSON.stringify(top.item.title)} tier ${top.tier}` : "nothing",
  );
}

// Typo tolerance must not admit unrelated songs.
{
  const ranked = rankSearchResults(
    [
      { id: "x1", title: "We Don't Talk Anymore", artist: "Charlie Puth" },
      { id: "x2", title: "Walking On Sunshine", artist: "Katrina & The Waves" },
      { id: "x3", title: "Don't Start Now", artist: "Dua Lipa" },
    ],
    "we dont talk anymore",
  );
  check(
    "unrelated songs excluded",
    ranked.every((r) => r.item.id === "x1"),
    ranked.map((r) => r.item.title).join(" | "),
  );
}

// ---------------------------------------------------------------------------
// Section 11 / 16 — relevance threshold
// ---------------------------------------------------------------------------
console.log("== relevance threshold ==");
{
  const ranked = rankSearchResults(
    [
      { id: "s1", title: "We Don't Talk Anymore", artist: "Charlie Puth" },
      { id: "s2", title: "A Song About We", artist: "Talker" },
      { id: "s3", title: "Talking", artist: "Someone" },
    ],
    "we dont talk anymore",
  );
  check(
    "single-common-word results dropped",
    ranked.length === 1 && ranked[0].item.id === "s1",
    ranked.map((r) => `${r.item.title}(${r.tier})`).join(" | "),
  );
}

// ---------------------------------------------------------------------------
// Section 12 / 13 — version awareness adapts to the query
// ---------------------------------------------------------------------------
console.log("== version awareness ==");
{
  const base = rankSearchResults(WDTA_POOL, "we dont talk anymore");
  check(
    "no version asked -> canonical first",
    base[0].item.id === "a4",
    base[0]?.item.title,
  );

  const live = rankSearchResults(WDTA_POOL, "we dont talk anymore live");
  check(
    "live asked -> live version first",
    live[0].item.id === "a10" && live[0].versions.includes("live"),
    `${live[0]?.item.title} ${JSON.stringify(live[0]?.versions)}`,
  );

  const lyrics = rankSearchResults(WDTA_POOL, "we dont talk anymore lyrics");
  check(
    "lyrics asked -> lyrics version first",
    lyrics[0].item.id === "a1",
    lyrics[0]?.item.title,
  );

  const slowed = rankSearchResults(WDTA_POOL, "we dont talk anymore slowed");
  check(
    "slowed asked -> slowed version first",
    slowed[0].item.id === "a3",
    slowed[0]?.item.title,
  );
}

check("stripVersions removes bracketed lyric markers", stripVersions("We Don't Talk Anymore (Lyrics)") === "we dont talk anymore", stripVersions("We Don't Talk Anymore (Lyrics)"));
check("detectVersions finds slowed+reverb", detectVersions("We Don't Talk Anymore - slowed + reverb").includes("slowed"), JSON.stringify(detectVersions("We Don't Talk Anymore - slowed + reverb")));

// ---------------------------------------------------------------------------
// Section 15 — deduplication without merging genuine versions
// ---------------------------------------------------------------------------
console.log("== dedupe ==");
{
  const ranked = rankSearchResults(
    [
      { id: "d1", title: "We Don't Talk Anymore", artist: "Charlie Puth" },
      { id: "d2", title: "We Don't Talk Anymore", artist: "Charlie Puth" },
      { id: "d3", title: "we   dont  talk  anymore", artist: "Charlie Puth" },
      { id: "d4", title: "We Don't Talk Anymore (Lyrics)", artist: "Charlie Puth" },
    ],
    "we dont talk anymore",
  );
  const canonicalCount = ranked.filter((r) => !r.versions.length).length;
  check(
    "duplicate canonical uploads collapse to one",
    canonicalCount === 1,
    JSON.stringify(ranked.map((r) => `${r.item.id}:${r.item.title}`)),
  );
  check(
    "lyrics version NOT merged into canonical",
    ranked.some((r) => r.item.id === "d4"),
    JSON.stringify(ranked.map((r) => r.item.id)),
  );
}

// ---------------------------------------------------------------------------
// Section 26 — full acceptance list
// ---------------------------------------------------------------------------
console.log("== section 26 acceptance queries ==");
const CATALOG = [
  { id: "1", title: "We Don't Talk Anymore", artist: "Charlie Puth • Selena Gomez" },
  { id: "2", title: "We Don't Talk Anymore (Lyrics)", artist: "Charlie Puth" },
  { id: "3", title: "We Don't Talk Anymore - slowed + reverb", artist: "Charlie Puth" },
  { id: "4", title: "We Don't Talk Anymore (feat. Selena Gomez)", artist: "Charlie Puth" },
  { id: "5", title: "I Ain't Worried", artist: "Lucie Silvas" },
  { id: "6", title: "Don't Stop Me Now", artist: "Queen" },
  { id: "7", title: "Don't Stop Believin'", artist: "Journey" },
  { id: "8", title: "Ain't No Sunshine", artist: "Bill Withers" },
  { id: "9", title: "The Weeknd", artist: "Blinding Lights" },
  { id: "10", title: "Blinding Lights", artist: "The Weeknd" },
  { id: "11", title: "Mary Jane", artist: "Rick Astley" },
];

const EXPECTED_TOP: Record<string, RegExp> = {
  "we dont talk anymore": /^we don't talk anymore$/i,
  "we don't talk anymore": /^we don't talk anymore$/i,
  "We Don't Talk Anymore": /^we don't talk anymore$/i,
  "we-dont-talk-anymore": /^we don't talk anymore$/i,
  "charlie puth we dont talk anymore": /^we don't talk anymore$/i,
  "we dont talke anymore": /^we don't talk anymore$/i,
  "charli puth": /^we don't talk anymore$/i,
  "the weeknd": /blinding lights|the weeknd/i,
  "i aint worried": /i ain't worried/i,
  "i ain't worried": /i ain't worried/i,
  "aint no sunshine": /ain't no sunshine/i,
  "dont stop believin": /don't stop believin/i,
};

for (const [q, expected] of Object.entries(EXPECTED_TOP)) {
  const top = rankSearchResults(CATALOG, q)[0];
  check(
    `acceptance: ${JSON.stringify(q)}`,
    Boolean(top && expected.test(top.item.title)),
    top ? `got ${JSON.stringify(top.item.title)} (tier ${top.tier}, score ${top.score})` : "nothing",
  );
}

// Variant queries must behave identically to their canonical form.
{
  const variants = [
    "we dont talk anymore",
    "we don't talk anymore",
    "We Don't Talk Anymore",
    "we-dont-talk-anymore",
    "we_dont_talk_anymore",
  ];
  const tops = new Set(
    variants.map((v) => rankSearchResults(CATALOG, v)[0]?.item.id),
  );
  check(
    "all punctuation variants produce the SAME top result",
    tops.size === 1,
    JSON.stringify([...tops]),
  );
}

// ---------------------------------------------------------------------------
// Section 13 — intent parsing
// ---------------------------------------------------------------------------
console.log("== intent parsing ==");
check("song intent", parseQuery("we dont talk anymore").intent === "song", parseQuery("we dont talk anymore").intent);
check("version intent", parseQuery("we dont talk anymore live").intent === "version", parseQuery("we dont talk anymore live").intent);
check("lyrics intent", parseQuery("dont stop believin lyrics").intent === "lyrics", parseQuery("dont stop believin lyrics").intent);
check("album intent", parseQuery("nine track mind album").intent === "album", parseQuery("nine track mind album").intent);
check("raw query preserved verbatim", parseQuery("  We DON'T Talk Anymore  ").raw === "  We DON'T Talk Anymore  ", JSON.stringify(parseQuery("  We DON'T Talk Anymore  ").raw));
check(
  "core excludes version words",
  parseQuery("we dont talk anymore slowed").core === "we dont talk anymore",
  parseQuery("we dont talk anymore slowed").core,
);

// ---------------------------------------------------------------------------
// Section 18 — suggestions
// ---------------------------------------------------------------------------
console.log("== suggestions ==");
{
  const candidates = CATALOG.map((c) => c.title).concat(CATALOG.map((c) => c.artist));
  check(
    'partial "we dont tal" suggests the full title',
    buildSuggestions("we dont tal", candidates, 6).includes("We Don't Talk Anymore"),
    JSON.stringify(buildSuggestions("we dont tal", candidates, 6)),
  );
  check(
    'partial "charli put" suggests the artist',
    buildSuggestions("charli put", candidates, 6).some((s) =>
      /charlie puth/i.test(s),
    ),
    JSON.stringify(buildSuggestions("charli put", candidates, 6)),
  );
  check(
    'partial "dont stop believ" suggests the song',
    buildSuggestions("dont stop believ", candidates, 6).some((s) =>
      /don't stop believin/i.test(s),
    ),
    JSON.stringify(buildSuggestions("dont stop believ", candidates, 6)),
  );
  check(
    "no suggestions for a 1-char query",
    buildSuggestions("w", candidates, 6).length === 0,
    JSON.stringify(buildSuggestions("w", candidates, 6)),
  );
  check(
    "punctuation-insensitive suggestion",
    buildSuggestions("we don't tal", candidates, 6).includes("We Don't Talk Anymore"),
    JSON.stringify(buildSuggestions("we don't tal", candidates, 6)),
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log("");
console.log(`PASS ${pass}  FAIL ${fail}`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}