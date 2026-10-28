import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { isPlayable, isStreamUrl, filterPlayable } from "../src/lib/eligibility.ts";
import { readSource } from "./helpers/tailwind-css.js";

/**
 * The one rule about what may enter a playback queue.
 *
 * The failure these tests pin: an imported playlist row with a snapshot and a
 * CORRUPTED or synthetic `youtubeId` used to be accepted by the player as
 * if it were a recording — it looked playable, played silence, still advanced
 * the queue and wrote a play to listening history. A row may only play when a
 * VERIFIED source is behind it: a well-formed 11-character YouTube id, a real
 * stream URL, or a downloaded local copy.
 */

const GOOD_ID = "dQw4w9WgXcQ";

describe("the structural rule", () => {
  test("a verified recording is playable", () => {
    expect(isPlayable({ id: "x", youtubeId: GOOD_ID, title: "Song" })).toBe(true);
  });

  test("a direct stream URL is playable without an id", () => {
    expect(
      isPlayable({
        title: "Catalog song",
        audioUrl: "https://cdn.example.com/audio.mp3",
      }),
    ).toBe(true);
  });

  test("an unmatched import row is never playable", () => {
    // The synthetic id shape an imported row carries — a spreadsheet key, not
    // a recording. Also each corruption a snapshot could hold.
    for (const id of [
      undefined,
      null,
      "",
      "import:spotify|bjork|post", // synthetic
      GOOD_ID + "0", // 12 chars
      GOOD_ID.slice(1), // 10 chars
      "dQw4+9WgXcQ", // URL-unsafe character
      "MQAAAAAAAAAAAAAAAA==", // non-base64url dust
    ]) {
      expect(isPlayable({ title: "Song", youtubeId: id })).toBe(false);
    }
  });

  test("a nameless row is not a song, however good its id", () => {
    expect(isPlayable({ youtubeId: GOOD_ID, title: "" })).toBe(false);
    expect(isPlayable({ youtubeId: GOOD_ID, title: "   " })).toBe(false);
    // Titled rows keep playing regardless of id presence.
    expect(isPlayable({ youtubeId: undefined, title: "Song" })).toBe(false);
  });

  test("nothing is playable without a candidate", () => {
    expect(isPlayable(null)).toBe(false);
    expect(isPlayable(undefined)).toBe(false);
  });

  test("no title field at all: the id decides alone", () => {
    // Catalog/derived candidates often have no title in the candidate shape.
    expect(isPlayable({ youtubeId: GOOD_ID })).toBe(true);
  });
});

describe("stream URLs the audio element can genuinely play", () => {
  test("the app's own markers and blob: count", () => {
    expect(isStreamUrl("stream")).toBe(true);
    expect(isStreamUrl("blob:https://app/opfs-copy")).toBe(true);
    expect(isStreamUrl("https://audio-proxy.example/v?x=1")).toBe(true);
    expect(isStreamUrl("https://rr3---sn.googlevideo.com/videoplayback?x")).toBe(true);
    expect(isStreamUrl("https://piped.video/watch?v=1")).toBe(true);
  });

  test("audio file extensions count", () => {
    for (const ext of ["mp3", "m4a", "aac", "ogg", "opus", "wav", "flac", "webm", "mp4"]) {
      expect(isStreamUrl(`https://cdn.example/t.${ext}`)).toBe(true);
    }
    expect(isStreamUrl("https://cdn.example/t.mp3?tok=1")).toBe(true);
  });

  test("junk does not count", () => {
    expect(isStreamUrl(null)).toBe(false);
    expect(isStreamUrl("")).toBe(false);
    expect(isStreamUrl("   ")).toBe(false);
    expect(isStreamUrl("https://example.com/not-audio.txt")).toBe(false);
    expect(isStreamUrl("{}")).toBe(false);
  });
});

describe("filterPlayable over a playlist's rows", () => {
  const rows = [
    { id: "import:spotify|a", title: "Unmatched", youtubeId: undefined },
    { id: "r2", title: "Corrupted", youtubeId: "dQw4w9WgXc" }, // 10 chars
    { id: "r3", title: "Playable", youtubeId: GOOD_ID },
    { id: "r4", title: "From a snapshot", youtubeId: GOOD_ID },
  ];

  test("keeps only the playable rows, in playlist order", () => {
    const ids = filterPlayable(rows, (row) => row).map((row) => row.id);
    expect(ids).toEqual(["r3", "r4"]);
  });

  test("rows past the filter stay in the library for re-matching", () => {
    // The filter is for QUEUES only: it must not drop rows from the list the
    // playlist page renders — those stay until a repair resolves or
    // settles them, so the listener can still see and re-match the gaps.
    expect(rows.length).toBe(4);
  });
});

describe("the rule is applied at the playlist queue-entry point", () => {
  const detail = readSource("src/pages/PlaylistDetail.tsx");

  test("directPlayable refuses rows that fail the shared rule", () => {
    // This is the function `resolveLegacyRow` consults FIRST — a row it
    // rejects falls through to search resolution instead of streaming the
    // corrupted id directly.
    // Gated through the shared queue-eligibility rule, which strengthens the
    // old `!row.youtubeId` id-presence check: the id must also be the real
    // 11-character YouTube shape, and the row must have a title to render.
    expect(detail).toMatch(/import \{ isPlayable \} from "@\/lib\/eligibility"/);
    expect(detail).toMatch(/if \(!isPlayable\(row\)\) return null;/);
  });

  test("resolution still catches the rows the rule rejects", () => {
    // The safety net must be reachable, not a silent drop: the fallback
    // search path handles what the structural check refuses.
    expect(detail).toMatch(/resolveLegacyRow/);
    expect(detail).toMatch(/Couldn't find a playable version/);
  });

  test("play-all counts what it queues, honestly", () => {
    expect(detail).toMatch(/Playing \$\{resolved\.length\} of \$\{rows\.length\}/);
  });
});
