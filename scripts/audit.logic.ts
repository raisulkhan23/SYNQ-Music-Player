/**
 * Edge-case audit harness for SYNQ's PURE logic modules.
 *
 * Not a replacement for unit tests (the project has no runner) — this exists
 * to throw hostile inputs at the pure decision code and print anything that
 * misbehaves, so bugs are found by execution rather than by reading.
 *
 *   bun scripts/audit.logic.ts
 *
 * Exit code 0 when every check passes, 1 otherwise.
 */

import { formatTime, formatDuration, pluralize, greeting } from "../src/lib/format";
import { shuffleList, queueReorderKeys, moveQueueRow } from "../src/lib/queueOrder";
import { advanceOffset, requiredCopies, MAX_FRAME_SECONDS } from "../src/lib/infiniteSlider";
import { csvField, toCsv } from "../src/lib/csvExport";
import {
  artistPath,
  albumPath,
  routeParam,
  parseAlbumRoute,
  normaliseAlbumName,
  groupByAlbum,
  matchesAlbum,
  uniqueTracks,
} from "../src/lib/artistLinks";
import {
  isTrackId,
  buildTrackShareUrl,
  shareableId,
  trackIdFromShareUrl,
} from "../src/lib/shareLink";
import {
  formatRemaining,
  planSleep,
  MAX_SLEEP_MINUTES,
} from "../src/lib/sleepTimer";

let pass = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq<T>(name: string, actual: T, expected: T) {
  check(name, Object.is(actual, expected), `got ${String(actual)}, want ${String(expected)}`);
}

// --------------------------------------------------------------- format
eq("formatTime 0", formatTime(0), "0:00");
eq("formatTime 61", formatTime(61), "1:01");
eq("formatTime 3599", formatTime(3599), "59:59");
eq("formatTime 3600", formatTime(3600), "1:00:00");
eq("formatTime -5 clamps", formatTime(-5), "0:00");
eq("formatTime NaN", formatTime(NaN), "0:00");
eq("formatTime Infinity", formatTime(Infinity), "0:00");
eq("formatTime 59.9 floors", formatTime(59.9), "0:59");
eq("formatDuration undefined", formatDuration(undefined), "—");
eq("formatDuration 0", formatDuration(0), "—");
eq("formatDuration NaN", formatDuration(NaN), "—");
eq("pluralize 1", pluralize(1, "song"), "1 song");
eq("pluralize 2", pluralize(2, "song"), "2 songs");
eq("pluralize 0", pluralize(0, "song"), "0 songs");
check("greeting is a string", typeof greeting() === "string");

// ------------------------------------------------------------ queueOrder
{
  const original = [1, 2, 3, 4, 5];
  const shuffled = shuffleList(original);
  check("shuffleList does not mutate input", JSON.stringify(original) === "[1,2,3,4,5]");
  check(
    "shuffleList preserves multiset",
    [...shuffled].sort((a, b) => a - b).join() === "1,2,3,4,5",
    JSON.stringify(shuffled),
  );
  eq("shuffleList empty", shuffleList([]).length, 0);
  eq("shuffleList single", shuffleList(["a"]).length, 1);
}
{
  const rows = [{ id: "A" }, { id: "B" }, { id: "A" }];
  const keys = queueReorderKeys(rows);
  check(
    "queueReorderKeys disambiguates duplicates",
    new Set(keys).size === keys.length,
    keys.join(),
  );
  check(
    "queueReorderKeys stable across reorder",
    JSON.stringify([...queueReorderKeys(rows)].sort()) ===
      JSON.stringify([...keys].sort()),
  );
}
{
  const keys = ["a", "b", "c"];
  check("moveQueueRow moves", JSON.stringify(moveQueueRow(keys, 0, 2)) === '["b","c","a"]');
  eq("moveQueueRow no-op returns null", moveQueueRow(keys, 1, 1), null);
  eq("moveQueueRow out of range", moveQueueRow(keys, 0, 9), null);
  eq("moveQueueRow negative", moveQueueRow(keys, -1, 0), null);
  eq("moveQueueRow non-integer", moveQueueRow(keys, 0.5, 1), null);
  eq("moveQueueRow NaN", moveQueueRow(keys, NaN, 1), null);
  eq("moveQueueRow empty", moveQueueRow([], 0, 0), null);
  check("moveQueueRow does not mutate", JSON.stringify(keys) === '["a","b","c"]');
}

// --------------------------------------------------------- infiniteSlider
{
  // The invariant that matters: whatever the input, the strip must stay inside
  // one period of zero. Anything else strands it off-screen.
  const periods = [100, 137.5, 1000];
  let worst = 0;
  for (const period of periods) {
    for (const offset of [0, 1, -1, period / 2, -period / 2, period - 1]) {
      for (const delta of [
        0,
        1,
        -1,
        MAX_FRAME_SECONDS * 18,
        -MAX_FRAME_SECONDS * 18,
        1e6,
        -1e6,
      ]) {
        const out = advanceOffset(offset, delta, period);
        if (!Number.isFinite(out)) {
          check("advanceOffset stays finite", false, `offset=${offset} delta=${delta}`);
          continue;
        }
        if (out > 0 || out < -period) {
          check("advanceOffset stays in range", false, `got ${out} for period ${period}`);
        }
        worst = Math.max(worst, Math.abs(out));
      }
    }
  }
  check("advanceOffset in range for all sampled inputs", worst <= periods[2]);
  eq("advanceOffset period 0 is identity", advanceOffset(42, 10, 0), 42);
  eq("advanceOffset negative period is identity", advanceOffset(42, 10, -5), 42);
  eq("advanceOffset NaN period is identity", advanceOffset(42, 10, NaN), 42);
  check("advanceOffset never returns -0", !Object.is(advanceOffset(-3, 3, 10), -0));
}
{
  eq("requiredCopies zero width", requiredCopies(0, 800), 2);
  eq("requiredCopies negative width", requiredCopies(-10, 800), 2);
  check("requiredCopies floor is 2", requiredCopies(5000, 800) === 2);
  check("requiredCopies wide viewport", requiredCopies(100, 800) === 9);
  check(
    "requiredCopies covers viewport",
    requiredCopies(100, 800) * 100 >= 800,
  );
  check("requiredCopies never NaN", Number.isFinite(requiredCopies(NaN, 800)));
}

// --------------------------------------------------------------- csv
{
  eq("csvField null", csvField(null), "");
  eq("csvField undefined", csvField(undefined), "");
  eq("csvField plain", csvField("hello"), "hello");
  eq("csvField quotes comma", csvField("a,b"), '"a,b"');
  eq("csvField doubles quotes", csvField('say "hi"'), '"say ""hi"""');
  eq("csvField newline", csvField("a\nb"), '"a\nb"');
  // Formula injection is the whole reason csvField exists.
  check("csvField neutralises =", csvField("=cmd|'/c calc'!A1").startsWith("'="));
  check("csvField neutralises +", csvField("+1+1").startsWith("'+"));
  check("csvField neutralises -", csvField("-1+1").startsWith("'-"));
  check("csvField neutralises @", csvField("@SUM(A1)").startsWith("'@"));
  check("csvField neutralises tab", csvField("\t=1").startsWith("'\t"));
  // But a number that merely CONTAINS a minus must not be mangled.
  eq("csvField number", csvField(42), "42");
  eq("csvField boolean", csvField(true), "true");
  eq("csvField number 0", csvField(0), "0");
}
{
  const csv = toCsv([{ a: "x,y", b: 1 }], [
    { header: "A", value: (r) => r.a },
    { header: "B", value: (r) => r.b },
  ]);
  check("toCsv header row", csv.startsWith("A,B\r\n"), JSON.stringify(csv.slice(0, 8)));
  check("toCsv quotes embedded comma", csv.includes('"x,y",1'), JSON.stringify(csv));
  eq("toCsv empty rows still emits header", toCsv([], [{ header: "H", value: () => "" }]), "H\r\n");
}

// --------------------------------------------------------- artistLinks
{
  eq("artistPath null", artistPath(null), null);
  eq("artistPath empty", artistPath("   "), null);
  eq("artistPath Unknown artist", artistPath("Unknown artist"), null);
  eq("artistPath encodes", artistPath("AC/DC"), "/artist/AC%2FDC");
  eq("albumPath needs both", albumPath("A", ""), null);
  eq("albumPath rejects Single", albumPath("A", "Single"), null);
  eq("albumPath builds", albumPath("A B", "C D"), "/album/A%20B/C%20D");
  // routeParam must NOT decode: react-router already did. A second decode
  // throws URIError on any real name containing a percent sign.
  eq("routeParam leaves % alone", routeParam("100% Pure Love"), "100% Pure Love");
  eq("routeParam null", routeParam(null), "");
  let threw = false;
  try {
    routeParam("100% Pure Love");
  } catch {
    threw = true;
  }
  check("routeParam never throws on %", !threw);
  eq("parseAlbumRoute round trip", JSON.stringify(parseAlbumRoute("50% Hits", "Best Of")), '{"artist":"50% Hits","album":"Best Of"}');
  eq("parseAlbumRoute missing half", parseAlbumRoute("A", ""), null);
  eq("parseAlbumRoute rejects Single", parseAlbumRoute("A", "Single"), null);
  eq("normaliseAlbumName null", normaliseAlbumName(null), "");
  check(
    "normaliseAlbumName folds deluxe",
    normaliseAlbumName("Album (Deluxe Edition)") === normaliseAlbumName("Album"),
    normaliseAlbumName("Album (Deluxe Edition)"),
  );
}
{
  const items = [
    { id: "1", title: "t1", artist: "A", duration: 1, thumbnail: "", album: "Alb" },
    { id: "2", title: "t2", artist: "A", duration: 1, thumbnail: "", album: "Alb" },
    { id: "3", title: "t3", artist: "A", duration: 1, thumbnail: "", album: "" },
    { id: "4", title: "t4", artist: "A", duration: 1, thumbnail: "", album: "Alb" },
  ];
  const groups = groupByAlbum(items as never);
  eq("groupByAlbum drops album-less rows", groups.length, 1);
  eq("groupByAlbum keeps distinct ids", groups[0]?.items.length, 3);
  eq("groupByAlbum empty input", groupByAlbum([]).length, 0);
  // Regression: albums whose REAL title is a descriptor word ("EP", "Album")
  // used to normalise to "" and collapse into one shared bucket, so a track
  // from one album was filed under another and the album page served a wrong
  // tracklist. They must stay distinct.
  eq(
    "normaliseAlbumName keeps a real title of EP",
    normaliseAlbumName("EP"),
    "ep",
  );
  eq(
    "normaliseAlbumName keeps a real title of Album",
    normaliseAlbumName("Album"),
    "album",
  );
  check(
    "normaliseAlbumName keeps descriptor-titled albums distinct",
    normaliseAlbumName("EP") !== normaliseAlbumName("Album"),
  );
  check(
    "normaliseAlbumName still folds deluxe",
    normaliseAlbumName("Album (Deluxe Edition)") === normaliseAlbumName("Album"),
    `${normaliseAlbumName("Album (Deluxe Edition)")} vs ${normaliseAlbumName("Album")}`,
  );
  check(
    "normaliseAlbumName still folds remaster",
    normaliseAlbumName("25 (Remastered)") === normaliseAlbumName("25"),
  );
  const twoAlbums = groupByAlbum([
    { id: "1", title: "a", artist: "X", duration: 1, thumbnail: "", album: "EP" },
    { id: "2", title: "b", artist: "X", duration: 1, thumbnail: "", album: "Album" },
  ] as never);
  eq("groupByAlbum keeps EP and Album separate", twoAlbums.length, 2);
  check("matchesAlbum rejects missing album", !matchesAlbum({ album: undefined } as never, "Alb"));
  check(
    "matchesAlbum accepts equivalent spelling",
    matchesAlbum({ album: "Album (Deluxe)" } as never, "Album"),
  );
  check(
    "matchesAlbum still separates EP from Album",
    !matchesAlbum({ album: "Album" } as never, "EP"),
  );
  eq(
    "uniqueTracks dedupes",
    uniqueTracks([{ id: "1" }, { id: "1" }, { id: "2" }] as never).length,
    2,
  );
  check(
    "uniqueTracks drops empty id",
    uniqueTracks([{ id: "" }, { id: "1" }] as never).length === 1,
  );
}

// ------------------------------------------------------------ shareLink
{
  check("isTrackId valid", isTrackId("dQw4w9WgXcQ"));
  check("isTrackId rejects short", !isTrackId("abc"));
  check("isTrackId rejects long", !isTrackId("dQw4w9WgXcQQ"));
  check("isTrackId rejects bad chars", !isTrackId("dQw4w9WgXc!"));
  check("isTrackId rejects null", !isTrackId(null));
  check("isTrackId rejects undefined", !isTrackId(undefined));
  eq(
    "shareableId prefers youtubeId",
    shareableId({ id: "row", youtubeId: "vid" } as never),
    "vid",
  );
  eq("shareableId falls back to id", shareableId({ id: "row" } as never), "row");
  eq(
    "buildTrackShareUrl strips trailing slash",
    buildTrackShareUrl("https://x.dev/", { id: "dQw4w9WgXcQ" } as never),
    "https://x.dev/t/dQw4w9WgXcQ",
  );
  eq(
    "buildTrackShareUrl escapes id",
    buildTrackShareUrl("https://x.dev", { id: "a/b" } as never),
    "https://x.dev/t/a%2Fb",
  );

  // Round-trip: a shared link must parse back to the id it was built from.
  const shared = buildTrackShareUrl("https://synq.app", {
    id: "dQw4w9WgXcQ",
  } as never);
  eq("share link round-trips", trackIdFromShareUrl(shared), "dQw4w9WgXcQ");
  eq(
    "share link round-trips with trailing-slash origin",
    trackIdFromShareUrl(
      buildTrackShareUrl("https://synq.app/", { id: "kJQP7kiw5Fk" } as never),
    ),
    "kJQP7kiw5Fk",
  );

  // ANY origin is accepted: preview, custom domain, localhost.
  eq(
    "share link from a localhost preview",
    trackIdFromShareUrl("http://localhost:5173/t/dQw4w9WgXcQ"),
    "dQw4w9WgXcQ",
  );
  eq(
    "share link ignores query and hash",
    trackIdFromShareUrl("https://synq.app/t/dQw4w9WgXcQ?ref=x#y"),
    "dQw4w9WgXcQ",
  );

  // Rejections: not a share link, not a valid id, not http(s).
  eq("rejects a search url", trackIdFromShareUrl("https://x.dev/search?q=a"), null);
  eq("rejects a bare id", trackIdFromShareUrl("dQw4w9WgXcQ"), null);
  eq("rejects a bare path", trackIdFromShareUrl("/t/dQw4w9WgXcQ"), null);
  eq("rejects a short id", trackIdFromShareUrl("https://x.dev/t/abc"), null);
  eq(
    "rejects extra path segments",
    trackIdFromShareUrl("https://x.dev/t/dQw4w9WgXcQ/edit"),
    null,
  );
  eq("rejects a non-track path", trackIdFromShareUrl("https://x.dev/a/dQw4w9WgXcQ"), null);
  eq("rejects javascript: urls", trackIdFromShareUrl("javascript:/t/dQw4w9WgXcQ"), null);
  eq("rejects garbage", trackIdFromShareUrl("not a url"), null);
  eq("rejects empty", trackIdFromShareUrl(""), null);
}

// -------------------------------------------------------- sleepTimer
{
  // planSleep must set ALL THREE fields on every path, so switching modes can
  // never leave a stale flag from the previous one armed.
  const off = planSleep("off", 1000);
  eq("sleep off clears the clock", off.endsAt, null);
  eq("sleep off clears the song flag", off.atSongEnd, false);
  eq("sleep off clears the queue flag", off.atQueueEnd, false);

  const song = planSleep("song-end", 1000);
  eq("song-end arms the song flag", song.atSongEnd, true);
  eq("song-end does not arm queue", song.atQueueEnd, false);
  eq("song-end has no clock", song.endsAt, null);

  const queue = planSleep("queue-end", 5);
  eq("queue-end arms the queue flag", queue.atQueueEnd, true);
  eq("queue-end does not arm song", queue.atSongEnd, false);
  eq("queue-end has no clock", queue.endsAt, null);

  eq("a minute countdown resolves to a deadline", planSleep(15, 1000).endsAt, 1000 + 15 * 60_000);
  eq("a countdown clears the song flag", planSleep(15, 0).atSongEnd, false);
  eq("a countdown clears the queue flag", planSleep(15, 0).atQueueEnd, false);
  eq("zero minutes is effectively off", planSleep(0, 1000).endsAt, null);
  eq("negative minutes is off", planSleep(-5, 1000).endsAt, null);
  eq("NaN minutes is off", planSleep(NaN, 1000).endsAt, null);
  eq(
    "an absurd countdown is capped",
    planSleep(99999, 0).endsAt,
    MAX_SLEEP_MINUTES * 60_000,
  );

  eq("formatRemaining 0", formatRemaining(0), "0s");
  eq("formatRemaining negative clamps", formatRemaining(-5000), "0s");
  eq("formatRemaining 9s", formatRemaining(9000), "9s");
  eq("formatRemaining 60s", formatRemaining(60_000), "1:00");
  eq("formatRemaining 247000", formatRemaining(247_000), "4:07");
  check("formatRemaining NaN is safe", formatRemaining(NaN).length > 0);
}

// ------------------------------------------------------------- report
console.log(`PASS ${pass}  FAIL ${failures.length}`);
if (failures.length) {
  for (const f of failures) console.log("  FAIL:", f);
  process.exit(1);
}