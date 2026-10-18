import { describe, expect, test } from "bun:test";
import { readSource } from "./helpers/tailwind-css.js";

const store = readSource("src/store/player.ts");
const panel = readSource("src/components/player/QueuePanel.tsx");
const row = readSource("src/components/tracks/RemoteTrackRow.tsx");
const recent = readSource("src/pages/Recent.tsx");
const admin = readSource("src/pages/Admin.tsx");
const csv = readSource("src/lib/csvExport.ts");
const download = readSource("src/lib/download.ts");

describe("the queue can be tidied without reordering it by hand", () => {
  test("duplicates are dropped, keeping the first occurrence", () => {
    const start = store.indexOf("removeQueueDuplicates: () => {");
    expect(start).toBeGreaterThan(-1);
    const body = store.slice(start, start + 1400);
    expect(body).toMatch(/seen\.has\(track\.id\)/);
    // First occurrence wins, so the dedupe is stable rather than keeping
    // whichever copy happened to be added last.
    expect(body).toMatch(
      /seen\.add\(track\.id\);\s*\n\s*queue\.push\(track\);/,
    );
  });

  test("deduping keeps queueIndex on the song that is actually playing", () => {
    // Removing rows above the current one shifts it; leaving the index alone
    // would make "next" skip a song and the now-playing row jump.
    const start = store.indexOf("removeQueueDuplicates: () => {");
    const body = store.slice(start, start + 1400);
    expect(body).toMatch(/queue\.findIndex\(\(t\) => t\.id === playing\.id\)/);
    expect(body).toMatch(
      /saveQueue\(queue, queueIndex, playing\?\.id \?\? null\)/,
    );
  });

  test("cleanup discards the unshuffle snapshot", () => {
    // Otherwise turning shuffle off after a cleanup brought every removed
    // track back from the dead — the bug clearQueue had to fix once already.
    for (const action of [
      "removeQueueDuplicates: () => {",
      "clearPlayedTracks: () => {",
      "shuffleUpcoming: () => {",
    ]) {
      const start = store.indexOf(action);
      expect(start).toBeGreaterThan(-1);
      expect(store.slice(start, start + 1400).replace(/\s+/g, " ")).toMatch(
        /unshuffledQueue: null, unshuffledIndex: -1/,
      );
    }
  });

  test("clearing played history keeps the current track playing", () => {
    const start = store.indexOf("clearPlayedTracks: () => {");
    expect(start).toBeGreaterThan(-1);
    const body = store.slice(start, start + 900);
    expect(body).toMatch(/if \(s2\.queueIndex <= 0\) return \{\};/);
    expect(body).toMatch(
      /const queue = playing \? \[playing, \.\.\.upcoming\] : upcoming;/,
    );
    expect(body).toMatch(/queueIndex: playing \? 0 : -1/);
  });

  test("shuffling the queue only touches what plays next", () => {
    const start = store.indexOf("shuffleUpcoming: () => {");
    expect(start).toBeGreaterThan(-1);
    const body = store.slice(start, start + 900);
    // The head (everything up to and including the current track) is sliced
    // off untouched, which is what keeps queueIndex valid.
    expect(body).toMatch(
      /const start = s2\.queueIndex >= 0 \? s2\.queueIndex \+ 1 : 0;/,
    );
    expect(body).toMatch(/const head = s2\.queue\.slice\(0, start\);/);
    expect(body).toMatch(/Math\.floor\(Math\.random\(\) \* \(i \+ 1\)\)/);
  });

  test("the queue panel exposes the three tools with honest toasts", () => {
    expect(panel).toMatch(/const removeQueueDuplicates = usePlayerStore/);
    expect(panel).toMatch(/const clearPlayedTracks = usePlayerStore/);
    expect(panel).toMatch(/const shuffleUpcoming = usePlayerStore/);
    expect(panel).toMatch(/aria-label="Remove duplicate songs"/);
    expect(panel).toMatch(/aria-label="Remove already played songs"/);
    expect(panel).toMatch(/aria-label="Randomize playing next"/);
    // "Removed 3 duplicates", not a silent reshuffle of a list being read.
    expect(panel).toMatch(/`Removed \$\{removed\} duplicate\$\{/);
    expect(panel).toMatch(/No duplicates in the queue/);
  });

  test("the tools are hidden when they would do nothing", () => {
    expect(panel).toMatch(
      /\{upcoming\.length > 1 && \(\s*\n\s*<button[^>]*aria-label="Randomize playing next"/,
    );
    expect(panel).toMatch(/\{queueIndex > 0 && \(/);
  });
});

describe("shared links go to the song, not to a search box", () => {
  test("the row menu copies an in-app deep link", () => {
    // It used to copy `/search?q=<title> <artist>`, which dumped the recipient
    // on a pre-filled search box they still had to submit.
    //
    // The menu itself now lives in the shared track-actions module, used by
    // both the row and the Home media cards — so that is where the link is
    // built. `row` must still reach it, or the row would have grown a second,
    // private menu.
    const actions = readSource("src/components/tracks/useTrackActions.tsx");
    expect(actions).toMatch(
      /buildTrackShareUrl\(window\.location\.origin, actions\.track\)/,
    );
    expect(actions).not.toMatch(/search\?q=\$\{encodeURIComponent/);
    expect(row).toMatch(/<TrackActionsMenu/);
  });

  test("the queue's current-track button shares in-app too", () => {
    // It used to hand out a youtu.be link, dropping the recipient into YouTube
    // with no queue and no account.
    expect(panel).toMatch(
      /buildTrackShareUrl\(window\.location\.origin, current\)/,
    );
    expect(panel).not.toMatch(/https:\/\/youtu\.be\//);
  });
});

describe("the whole history can be handed to the player", () => {
  test("play all and shuffle all act on the filtered list", () => {
    expect(recent).toMatch(/const playAll = \(shuffled: boolean\) => \{/);
    // Ordered playback, NOT the app's global shuffle switch: a page button
    // that flips a persisted preference leaves it on for every other list.
    expect(recent).toMatch(/play\(head, ordered\.slice\(1\), true\);/);
    expect(recent).toMatch(
      /const ordered = shuffled \? shuffleList\(items\) : items;/,
    );
    expect(recent).not.toMatch(/startShuffle\(\)/);
  });

  test("the shuffle keeps the caller's list intact", () => {
    // Now a shared helper rather than a per-page copy, so all four pages
    // shuffle the same (non-mutating) way.
    expect(recent).toContain('import { shuffleList } from "@/lib/queueOrder"');
    const queueOrder = readSource("src/lib/queueOrder.ts");
    expect(queueOrder).toMatch(
      /export function shuffleList<T>\(list: readonly T\[\]\): T\[\] \{\s*\n\s*const out = \[\.\.\.list\];/,
    );
  });

  test("both buttons are disabled when the filter matches nothing", () => {
    expect(recent).toMatch(
      /onClick=\{\(\) => playAll\(false\)\}\s*\n\s*disabled=\{items\.length === 0\}/,
    );
    expect(recent).toMatch(
      /onClick=\{\(\) => playAll\(true\)\}\s*\n\s*disabled=\{items\.length === 0\}/,
    );
  });
});

describe("the admin accounts table can be exported", () => {
  test("fields are quoted and formula-looking values are defused", () => {
    // A display name comes from an OAuth profile, so `=…` is a real input.
    expect(csv).toMatch(
      /if \(\/\^\[=\+\\-\@\\t\\r\]\/\.test\(text\)\) text = `'\$\{text\}`;/,
    );
    expect(csv).toMatch(/return \/\[",\\n\\r\]\/\.test\(text\)/);
  });

  test("the download carries a BOM so Excel reads UTF-8", () => {
    expect(csv).toMatch(/const BOM = "\\uFEFF";/);
    expect(csv).toMatch(
      /downloadFile\(filename, BOM \+ csv, "text\/csv;charset=utf-8;"\)/,
    );
  });

  test("the object URL is revoked after the click, not during it", () => {
    // Revoking synchronously cancels the download in Safari.
    expect(download).toMatch(
      /setTimeout\(\(\) => URL\.revokeObjectURL\(url\), 1000\)/,
    );
  });

  test("the export respects the filters the admin is looking at", () => {
    expect(admin).toMatch(/toCsv\(filteredUsers, \[/);
    expect(admin).toMatch(/header: "Sign-in"/);
    expect(admin).toMatch(/synq-accounts-\$\{stamp\}\.csv/);
    expect(admin).toMatch(/Couldn't export the accounts/);
  });
});
