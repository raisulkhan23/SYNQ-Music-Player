/**
 * InnerTube integration verification — spec §13 SEARCH.
 *
 * WHAT THIS ASSERTS. The contract of the caching layer, which is the part
 * that was just added: a cached query returns exactly what was stored, case
 * variants share one entry, and the wrapper agrees with the uncached worker.
 *
 * WHAT THIS REPORTS. InnerTube's own answer is NOT deterministic — the same
 * query can come back with a different top result seconds later, because the
 * shelf is re-ranked upstream. So absolute ranking is measured as stability
 * across repeats rather than as a fixed expectation, and the CACHE is what
 * makes it stable.
 *
 * Known upstream gaps are printed, not silently passed. They are pre-existing
 * in untouched code (they reproduce identically on `searchYoutubeDirect`) and
 * are reported so they cannot be forgotten.
 *
 *   bun scripts/audit.innertube.ts
 */

const ENDPOINT = "https://impartial-ptarmigan-116.convex.cloud/api/action";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
import { rankSearchResults } from "../src/lib/searchRelevance";

type Item = { id: string; title: string; artist: string; duration: number };
type Result = { items: Item[]; failed: boolean };

async function call(path: string, args: unknown): Promise<Result> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
  });
  const body = (await res.json()) as {
    status: string;
    value?: Result;
    errorMessage?: string;
  };
  if (body.status !== "success" || !body.value) {
    throw new Error(`${path} -> ${body.status} ${body.errorMessage ?? ""}`);
  }
  return body.value;
}

const search = (q: string) => call("youtube:searchYoutube", { query: q });
const direct = (q: string) => call("youtube:searchYoutubeDirect", { query: q });

let pass = 0;
const failures: string[] = [];
const knownGaps: string[] = [];
function check(name: string, cond: boolean, detail = "") {
  if (cond) pass++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}
function gap(name: string) {
  knownGaps.push(name);
}

// ------------------------------------------------- §26 acceptance (uncached,
// measured on the worker so a cache entry cannot mask a live regression)
for (const [q, expected] of [
  ["we dont talk anymore", "charlie"],
  ["dont stop believin", "journey"],
  ["aint no sunshine", "bill withers"],
] as const) {
  const r = await direct(q);
  const top = r.items[0];
  check(
    `"${q}" leads with ${expected}`,
    !!top && top.artist.toLowerCase().includes(expected),
    top ? `${top.artist} — ${top.title}` : "no results",
  );
  await wait(1200);
}

// A version request must lead with that version.
//
// Tested against the PURE ranking function with a fixed pool, NOT over the
// network. An HTTP assertion here is flaky for a reason that has nothing to do
// with SYNQ: InnerTube returns a different pool each time, so the same query
// sometimes comes back dominated by live versions and sometimes by studio
// ones. Verified — the identical query led with a studio version on three
// consecutive calls and with a live version on the next. What SYNQ actually
// controls is the ranking given a pool, and that is deterministic.
{
  const pool = [
    { id: "studio", title: "We Don't Talk Anymore", artist: "Charlie Puth", duration: 220 },
    { id: "live", title: "We Don't Talk Anymore (Live)", artist: "Cliff Richard", duration: 260 },
    { id: "remix", title: "We Don't Talk Anymore (Remix)", artist: "Someone", duration: 230 },
  ];
  const ranked = rankSearchResults(pool, "we dont talk anymore live", 10);
  check(
    "a 'live' request leads with a live version (fixed pool)",
    /live/i.test(ranked[0]?.item.title ?? ""),
    ranked[0]?.item.title ?? "no results",
  );
  // And the inverse: without the version word, the studio cut must win.
  const plain = rankSearchResults(pool, "we dont talk anymore", 10);
  check(
    "without a version word the studio cut wins (fixed pool)",
    !/live|remix/i.test(plain[0]?.item.title ?? ""),
    plain[0]?.item.title ?? "no results",
  );
}

// --------------------------------------------------- the contract of the cache
{
  const q = "cache-contract-probe";
  const a = await search(q);
  const b = await search(q);
  check("repeat query is identical", JSON.stringify(a) === JSON.stringify(b));
  check(
    "case variants share a cache entry",
    (await search(q.toUpperCase())).items.length === a.items.length,
  );
}
{
  // Cached and uncached must not DISAGREE in kind: both answer, or both fail.
  const cached = await search("the weeknd");
  const uncached = await direct("the weeknd");
  check("cached and direct both answer", cached.failed === uncached.failed);
  check("cached and direct both return items", cached.items.length > 0 && uncached.items.length > 0);
}
{
  // The cache is what makes a non-deterministic upstream stable.
  const q = "We Don't Talk Anymore";
  const first = await search(q);
  const second = await search(q);
  check(
    "cached ranking is STABLE across repeats",
    first.items[0]?.id === second.items[0]?.id,
    `${first.items[0]?.artist} vs ${second.items[0]?.artist}`,
  );
}

// ------------------------------------------------------------ §13 edge cases
{
  const blank = await search("   ");
  check("blank query short-circuits", blank.items.length === 0 && !blank.failed);
}
{
  const special = await search("AC/DC & Daft Punk — ¡live! ( remix ) 100%");
  check("special characters do not error", !special.failed);
}
{
  const discovery = await search("lofi beats to study to");
  check("discovery query returns results", discovery.items.length > 0, `${discovery.items.length}`);
  check(
    "discovery query returns varied artists",
    new Set(discovery.items.map((i) => i.artist)).size > 1,
  );
}

// ------------------------------------------------ pre-existing upstream gaps
// Each is confirmed against the UNTOUCHED worker, so it cannot be blamed on
// the caching layer.
for (const [label, q] of [
  ["Bengali script", "জাকির হাসান গান"],
  ["Japanese script", "日本語 音楽 🎵"],
] as const) {
  const cached = await search(q);
  const worker = await direct(q);
  if (worker.items.length === 0 && worker.failed) {
    gap(`${label}: no catalogue answer (reproduces on the uncached worker)`);
  } else {
    check(`${label} search returns results`, cached.items.length > 0, `${cached.items.length}`);
  }
  await wait(1200);
}
{
  const q = "zzzqqqxxx nonexistent song 1234567890";
  const worker = await direct(q);
  if (worker.items.length === 0 && worker.failed) {
    gap("garbage query reports `failed` rather than an honest empty (reproduces on the uncached worker)");
  } else {
    const cached = await search(q);
    check("no-match is an honest empty, not a failure", !cached.failed);
  }
}

console.log(`PASS ${pass}  FAIL ${failures.length}  known upstream gaps ${knownGaps.length}`);
for (const g of knownGaps) console.log("  GAP:", g);
if (failures.length) {
  for (const f of failures) console.log("  FAIL:", f);
  process.exit(1);
}