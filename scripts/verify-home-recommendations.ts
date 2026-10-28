// Verifies that Home's shelves never show the same recording twice.
//
// It re-implements Home's own shaping (the "seen at top" filter, the per-artist
// "On repeat" pick and the allocator reservation) and feeds it a pool that
// deliberately overlaps: history re-appears in the remote pools under a
// different album label and a different provider id, exactly like a reissue or
// a deluxe edition. If the allocator's identity rules are wrong, a title shows
// up twice and this script exits 1.
import { readFileSync, existsSync } from "node:fs";
import { cleanArtistName } from "../src/lib/youtube";
import { allocateSections, recordingKey } from "../src/lib/homeShelves";

// The play history lives in localStorage under ss.playHistory. Export it from
// the app's own storage to run this against real listener data; otherwise fall
// back to a fixture with the same shape.
const browserData = process.env.SYNQ_HISTORY_JSON;
const history =
  browserData && existsSync(browserData)
    ? JSON.parse(readFileSync(browserData, "utf8"))
    : [
        {
          id: "t1",
          youtubeId: "t1",
          title: "Anti-Hero",
          artistName: "Taylor Swift",
          playCount: 9,
          at: Date.now() - 1000,
        },
        {
          id: "t2",
          youtubeId: "t2",
          title: "Cruel Summer",
          artistName: "Taylor Swift",
          playCount: 4,
          at: Date.now() - 2000,
        },
        {
          id: "t3",
          youtubeId: "t3",
          title: "Take Me to Church",
          artistName: "Hozier",
          playCount: 7,
          at: Date.now() - 3000,
        },
        {
          id: "t4",
          youtubeId: "t4",
          title: "Movement",
          artistName: "Hozier",
          playCount: 3,
          at: Date.now() - 4000,
        },
        {
          id: "t5",
          youtubeId: "t5",
          title: "Blank Space",
          artistName: "Taylor Swift",
          playCount: 5,
          at: Date.now() - 5000,
        },
      ];

console.log(
  `history entries: ${history.length} (${browserData ? "real capture" : "fixture"})`,
);
if (history.length === 0) {
  console.log("No history recorded yet — nothing to verify.");
  process.exit(0);
}

const historyItems = history.map((h: any) => ({
  id: h.youtubeId ?? h.id,
  title: h.title,
  artist: cleanArtistName(h.artistName, h.title),
}));

// ── Home's "seen at top" ────────────────────────────────────────────────────
// The hero and the continue card already show the newest play, so "Recently
// played" must not show it again.
const seenAtTop = new Set<string>();
for (const item of historyItems.slice(0, 1)) seenAtTop.add(item.id);

const recentItems = historyItems.filter((item: any) => !seenAtTop.has(item.id));

// ── Home's "On repeat" ─────────────────────────────────────────────────────
// Most-played track per artist, minus anything "Recently played" shows.
const byArtist = new Map<string, { item: any; total: number }>();
for (const item of historyItems) {
  const entry = history.find((h: any) => (h.youtubeId ?? h.id) === item.id);
  const plays = entry?.playCount ?? 0;
  const artist = item.artist || "";
  const existing = byArtist.get(artist);
  if (existing) {
    existing.total += plays;
    const existingPlays =
      history.find((h: any) => (h.youtubeId ?? h.id) === existing.item.id)
        ?.playCount ?? 0;
    if (plays > existingPlays) existing.item = item;
  } else {
    byArtist.set(artist, { item, total: plays });
  }
}
const recentIds = new Set(recentItems.map((item: any) => item.id));
const mostPlayedItems = [...byArtist.values()]
  .sort((a, b) => b.total - a.total)
  .map((entry) => entry.item)
  .filter((item: any) => !recentIds.has(item.id));

// ── The remote pools ───────────────────────────────────────────────────────
// Each shelf gets its own pool, but they overlap each other and re-include
// history under a different provider id and a different album label.
const overlap = (item: any, id: string, album: string) => ({
  id,
  title: item.title,
  artist: item.artist,
  album,
});
const pools = [
  {
    id: "discover",
    items: [
      { id: "d1", title: "Song D1", artist: "Remote A", album: "Alpha" },
      { id: "d2", title: "Song D2", artist: "Remote B", album: "Beta" },
      overlap(historyItems[0], "d3", "Deluxe Edition"),
      { id: "d4", title: "Willow", artist: "Remote C", album: "Gamma" },
      { id: "d5", title: "Willow (Live)", artist: "Remote C", album: "Live" },
    ],
  },
  {
    id: "timeOfDay",
    items: [
      { id: "m1", title: "Song M1", artist: "Remote D", album: "Delta" },
      overlap(historyItems[1], "m2", "Single Version"),
      { id: "m3", title: "Song D1", artist: "Remote A", album: "Alpha" },
      { id: "m4", title: "Song M4", artist: "Remote E", album: "Epsilon" },
    ],
  },
  {
    id: "seasonal",
    items: [
      { id: "s1", title: "Song S1", artist: "Remote F", album: "Zeta" },
      { id: "s2", title: "Song S2", artist: "Remote G", album: "Eta" },
      overlap(historyItems[2], "s3", "Special Edition"),
    ],
  },
];

// ── Home's reservation ─────────────────────────────────────────────────────
// Home reserves the WHOLE history (not just "Recently played"), the on-repeat
// shelf, the chart and the recommendation shelves — every id, plus a
// title+artist key with the album dropped, because the album label is the one
// field that drifts between a history row and a search row.
const reserved = new Set<string>();
for (const item of [...historyItems, ...mostPlayedItems]) {
  if (item?.id) reserved.add(item.id);
  if (item?.title && item?.artist) {
    reserved.add(recordingKey({ title: item.title, artist: item.artist }));
  }
}

const sections = allocateSections(pools as any, {
  perSection: 6,
  minPerSection: 1,
  reserved,
});

// ── The check ──────────────────────────────────────────────────────────────
const groups: Array<{ label: string; titles: string[] }> = [
  { label: "Recently played", titles: recentItems.map((i: any) => i.title) },
  { label: "On repeat", titles: mostPlayedItems.map((i: any) => i.title) },
  ...sections.map((s: any) => ({
    label: s.id,
    titles: s.items.map((i: any) => i.title),
  })),
];

console.log(
  `remote sections: ${sections.map((s: any) => `${s.id}=${s.items.length}`).join(", ")}`,
);

let failures = 0;
const seen = new Map<string, string>();
for (const group of groups) {
  for (const title of group.titles) {
    const key = title.toLowerCase();
    const where = seen.get(key);
    if (where) {
      console.log(`  DUP: "${title}" appears in both ${where} and ${group.label}`);
      failures += 1;
    } else {
      seen.set(key, group.label);
    }
  }
}

console.log(`total rows: ${[...seen.keys()].length}`);
if (failures) {
  console.log(`FAIL: ${failures} duplicate row(s) across Home sections`);
  process.exit(1);
}
console.log("PASS: no recording appears in more than one Home section");
