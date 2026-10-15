/**
 * Hostile-input probe for SYNQ's live backend.
 *
 * Calls the deployed public functions with the arguments a browser can send
 * but the UI never would — empty strings, absurd lengths, wrong types, ids
 * that cannot exist — and reports anything that behaves unexpectedly.
 *
 * IMPORTANT ON CLASSIFICATION. Convex masks production error text, so an error
 * cannot be read as a crash by itself. Every case here therefore declares what
 * it is SUPPOSED to do:
 *
 *   ok       — the call succeeded and returned a sane shape
 *   reject   — the call was refused, which is the correct outcome (a required
 *              argument is missing or mistyped, or the function needs a signed
 *              in user and none was sent)
 *   BUG      — the call was supposed to work and did not
 *
 * Anything in the BUG bucket fails the script. A refusal is not a bug: an
 * unauthenticated `listUsers` erroring is the whole point of it being
 * protected, and `searchYoutube({})` erroring is argument validation, not a
 * crash.
 *
 *   bun scripts/audit.backend.ts [deploymentUrl]
 */

const BASE = (process.argv[2] ?? "https://impartial-ptarmigan-116.convex.cloud").replace(
  /\/$/,
  "",
);
const ENDPOINT = `${BASE}/api/action`;

type Verdict = "ok" | "reject" | "BUG";
type Row = { path: string; args: unknown; expect: Verdict; got: Verdict; note: string };

const rows: Row[] = [];

async function probe(
  path: string,
  args: unknown,
  /** What a correct server does with this call. */
  expect: Verdict,
  note: string,
) {
  let got: Verdict;
  let detail = "";
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, args, format: "json" }),
    });
    const text = await res.text();
    let body: { status?: string; value?: unknown };
    try {
      body = JSON.parse(text);
    } catch {
      got = "BUG";
      detail = `non-JSON (HTTP ${res.status}): ${text.slice(0, 120)}`;
      rows.push({ path, args, expect, got, note: detail });
      return;
    }
    got = body.status === "success" ? "ok" : "reject";
    detail =
      got === "ok" ? `${note} -> ${shapeNote(body.value)}` : `${note}: refused`;
  } catch (err) {
    got = "BUG";
    detail = `threw: ${(err as Error).message}`;
  }
  rows.push({ path, args, expect, got, note: detail });
}

/** A one-line description of a returned payload, to catch nonsense shapes. */
function shapeNote(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") {
    const keys = Object.keys(value as object);
    return `object{${keys.slice(0, 5).join(",")}${keys.length > 5 ? ",…" : ""}}`;
  }
  return `${typeof value}:${String(value).slice(0, 40)}`;
}

// ---------------------------------------------------------- search: must work
await probe("youtube:searchYoutube", { query: "" }, "ok", "empty query");
await probe("youtube:searchYoutube", { query: "   " }, "ok", "whitespace query");
await probe("youtube:searchYoutube", { query: "a".repeat(500) }, "ok", "500-char query");
await probe(
  "youtube:searchYoutube",
  { query: "\u0000\u0001\u007f" },
  "ok",
  "control chars",
);
await probe(
  "youtube:searchYoutube",
  { query: "<script>alert(1)</script>" },
  "ok",
  "xss attempt",
);
await probe("youtube:searchYoutube", { query: "日本語の歌詞 🎵" }, "ok", "unicode");
await probe("youtube:searchYoutube", {}, "reject", "MISSING required arg");
await probe("youtube:searchYoutube", { query: 123 }, "reject", "wrong type");
await probe("youtube:searchYoutube", { query: null }, "reject", "null query");
await probe("youtube:searchYoutube", { query: { a: 1 } }, "reject", "object query");

await probe("youtube:searchLyricVideos", { query: "we dont talk" }, "ok", "normal");
await probe("youtube:searchLyricVideos", {}, "reject", "missing query");

// ------------------------------------------------------------- trackMeta
await probe("youtube:trackMeta", { videoId: "dQw4w9WgXcQ" }, "ok", "real video id");
await probe("youtube:trackMeta", { videoId: "not-a-real-id" }, "ok", "bogus id");
await probe("youtube:trackMeta", { videoId: "" }, "ok", "empty id");
await probe(
  "youtube:trackMeta",
  { videoId: "../../etc/passwd" },
  "ok",
  "path traversal (must not throw)",
);
await probe("youtube:trackMeta", {}, "reject", "missing videoId");

// ------------------------------------------------------------------ jamendo
await probe("jamendo:searchJamendo", { query: "lofi" }, "ok", "normal");
await probe("jamendo:searchJamendo", { query: "" }, "ok", "empty query");
await probe("jamendo:searchJamendo", {}, "reject", "missing query");

// ------------------------------------------------------------------ lyrics
await probe("lyrics:fetchLyrics", { title: "", artist: "" }, "ok", "both empty");
await probe(
  "lyrics:fetchLyrics",
  { title: "a".repeat(300), artist: "b".repeat(300) },
  "ok",
  "very long",
);
await probe("lyrics:fetchLyrics", {}, "reject", "missing both");

// ------------------------------------------- user-scoped: MUST be refused
const unauth: [string, unknown][] = [
  ["history:mostPlayed", {}],
  ["history:recentlyPlayed", {}],
  ["history:listeningStats", {}],
  ["likes:myLikedTrackIds", {}],
  ["likes:myLikedRemote", {}],
  ["playlists:myPlaylists", {}],
  ["playlists:myImportedPlaylists", {}],
  ["users:currentUser", {}],
  ["notInterested:listNotInterested", {}],
  ["me:exportData", {}],
  ["admin:status", {}],
  ["admin:listUsers", {}],
  ["musicVectorDb:vectorStats", {}],
  ["musicVectorDb:myRole", {}],
];
for (const [path, args] of unauth) {
  await probe(path, args, "reject", "anonymous caller must be refused");
}

// ------------------------------------------------- public, no auth required
await probe("recommend:forYou", {}, "ok", "anonymous, no history");
await probe("jamendo:jamendoConfigured", {}, "ok", "config flag");

const bugs = rows.filter((r) => r.got === "BUG");
const surprises = rows.filter((r) => r.got !== r.expect && r.got !== "BUG");

console.log(
  `PROBED ${rows.length}  ok ${rows.filter((r) => r.got === "ok").length}` +
    `  rejected ${rows.filter((r) => r.got === "reject").length}` +
    `  BUG ${bugs.length}  unexpected ${surprises.length}`,
);
for (const r of rows) {
  const mark = r.got === "BUG" ? "BUG " : r.got === "reject" ? "rej " : "ok  ";
  const flag = r.got !== r.expect && r.got !== "BUG" ? "  <-- UNEXPECTED" : "";
  console.log(`  ${mark} ${r.path} ${JSON.stringify(r.args).slice(0, 40)} — ${r.note}${flag}`);
}
if (bugs.length || surprises.length) process.exit(1);