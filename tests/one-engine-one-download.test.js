import { describe, expect, test } from 'vitest';
import { readFileSync } from "node:fs";

/**
 * Only ONE engine may ever play a track — and only one may ever download it.
 *
 * The chronic symptom was "the song just keeps buffering", on a connection that
 * the backend proved was fine (10/10 range requests through `/audio-proxy`
 * returned 206 at ~0.2s TTFB). Stream resolution and delivery were never the
 * problem.
 *
 * The app was the problem, and structurally rather than by accident:
 *
 *   1. `loadTrack` started the YouTube IFrame "so effects never delay the
 *      first sound".
 *   2. It then resolved a direct stream and loaded the SAME song onto the
 *      `<audio>` deck through the Convex proxy — a second, simultaneous
 *      download of identical audio from an unrelated CDN.
 *   3. `prepareIncoming` had already begun pulling the NEXT track onto the spare
 *      deck, twenty seconds before it was needed.
 *
 * That is three concurrent audio streams per song on one connection, and the
 * live deck was the one that lost the bandwidth and stalled. Pausing the IFrame
 * does not help: YouTube buffers ahead regardless of play state, so the wasted
 * download kept running after the deck took over.
 *
 * A source-shape test on purpose — this is about WHICH engine a load path
 * starts, which needs a live YouTube IFrame API and a real media element to
 * execute. The claim is structural: there must be no path that starts both.
 */

const player = readFileSync("src/store/player.ts", "utf8");

function sliceBetween(code, from, to) {
  const a = code.indexOf(from);
  if (a === -1) throw new Error(`missing: ${from}`);
  const b = code.indexOf(to, a);
  if (b === -1) throw new Error(`missing: ${to}`);
  return code.slice(a, b);
}

describe("one engine, one download", () => {
  test("the deck path no longer starts the YouTube IFrame alongside it", () => {
    const branch = sliceBetween(
      player,
      // Anchored on the declaration only: the expression is wrapped across
      // lines by prettier, so pinning `= wantFilter` here made a formatting
      // change look like a deleted branch.
      "const wantDeckEngine",
      "getAudio().pause();",
    );
    // The IFrame may still appear — as the FALLBACK when resolution fails —
    // but it must not be started in parallel with the deck.
    const plays = branch.match(/ytEngine\s*\.\s*play\(/g) ?? [];
    expect(plays).toHaveLength(1);
    // ...and that single call must be inside the `if (!url)` fallback.
    // ...and that single call must be inside the `if (!url)` fallback. The window
    // is generous because that branch now also arms a load watchdog.
    expect(branch).toMatch(
      /if \(!url\) \{[\s\S]{0,1600}?ytEngine\s*\.\s*play\(/,
    );
  });

  test("the resolver starts no playback at all", () => {
    // It used to fire `ytEngine.play()` so the listener would hear the dry
    // track "while the direct stream is being resolved" — a THIRD path into
    // the same double-download, reachable from any EQ or effect change.
    const fn = sliceBetween(
      player,
      "const resolveYoutubeStream = async",
      "const ytResolveCache = new Map",
    );
    expect(fn).not.toMatch(/ytEngine\s*\.\s*play\(/);
  });

  test("the IFrame is still a real fallback, not deleted", () => {
    const branch = sliceBetween(
      player,
      // Anchored on the declaration only: the expression is wrapped across
      // lines by prettier, so pinning `= wantFilter` here made a formatting
      // change look like a deleted branch.
      "const wantDeckEngine",
      "getAudio().pause();",
    );
    // Resolver failures must still produce sound rather than silence.
    expect(branch).toMatch(/if \(!url\) \{/);
    expect(branch).toMatch(/ytEngine/);
  });

  test("a still-running IFrame can no longer be resurrected by an EQ change", () => {
    // `resolveAndPlayWithFilter` pauses the engine before it hands over. With
    // the deck owning the sound, the IFrame must stay a fallback.
    const filter = sliceBetween(
      player,
      "const resolveAndPlayWithFilter =",
      "const setSleepTimer =",
    );
    expect(filter).toMatch(/ytEngine\.pause\(\)/);
  });
});
