import { describe, expect, test } from 'vitest';

/**
 * The YouTube IFrame must never be left playing UNDER the <audio> decks.
 *
 * The symptom this pins down is the one reported as "crackly, stuttering, or
 * quiet" — not silence, not a wrong song, just permanently rough audio that has
 * been there "for a while".
 *
 * The cause is an ordering bug between two functions that do not share an
 * ordering guarantee:
 *
 *   - `ytEngine.play()` is async. It awaits `ensurePlayer()` and only then calls
 *     `loadVideoById()`.
 *   - `ytEngine.pause()` is synchronous.
 *
 * The store starts the IFrame first and hands sound to the decks as soon as a
 * direct stream resolves, so it issues `play()` and `pause()` inside one tick.
 * While the IFrame API is still initialising, `pause()` has no player to pause
 * and silently does nothing — and the pending `play()` then starts the video
 * anyway.
 *
 * Two copies of one signal, summed microseconds out of phase, is a comb filter:
 * gritty, crackly, and quieter than either copy alone. Nothing in the app was
 * broken; the audio was simply being played twice.
 *
 * These are source-shape assertions on purpose. The race lives in the ORDER of
 * an `await` against a synchronous call, which cannot be executed without a
 * real YouTube IFrame API — and a fake that resolved `ensurePlayer()`
 * synchronously would hide exactly the bug being pinned, the same way the old
 * fake AudioContext hid the missing `createStereoPanner`.
 */

import { readFileSync } from "node:fs";

const yt = readFileSync("src/lib/youtubePlayer.ts", "utf8");
const player = readFileSync("src/store/player.ts", "utf8");

/**
 * The body of a top-level function, for asserting about its internals.
 *
 * The parameter list is skipped BEFORE counting braces, because an inline
 * object type — `opts: { volume: number }` — contains a `}` that would close
 * the "body" immediately and yield a nine-character fragment. That is a real
 * hazard here: `play()` carries exactly such a parameter.
 */
function bodyOf(code, name) {
  const start = code.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} not found`);
  let parens = 0;
  let i = code.indexOf("(", start);
  for (; i < code.length; i++) {
    if (code[i] === "(") parens++;
    else if (code[i] === ")") {
      parens--;
      if (parens === 0) break;
    }
  }
  const open = code.indexOf("{", i);
  if (open === -1) throw new Error(`no body for ${name}`);
  let depth = 0;
  for (let j = open; j < code.length; j++) {
    if (code[j] === "{") depth++;
    else if (code[j] === "}") {
      depth--;
      if (depth === 0) return code.slice(start, j + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

describe("a pause issued while a play is in flight still wins", () => {
  test("play records the intent BEFORE it awaits the player", () => {
    const body = bodyOf(yt, "play");
    const intent = body.indexOf("wantPlaying = true");
    const await_ = body.indexOf("await ensurePlayer()");
    // The order is the whole fix. Recording intent after the await reproduces
    // the original bug exactly.
    expect(intent).toBeGreaterThan(-1);
    expect(await_).toBeGreaterThan(-1);
    expect(intent).toBeLessThan(await_);
  });

  test("play pauses again if a pause landed while it was waiting", () => {
    const body = bodyOf(yt, "play");
    // After `loadVideoById`, and guarded by the intent flag.
    expect(body).toMatch(
      /loadVideoById\([\s\S]{0,400}?if \(!wantPlaying\) \{[\s\S]{0,200}?pauseVideo\(\)/,
    );
  });

  test("pause records the intent, so it works with no player loaded", () => {
    const body = bodyOf(yt, "pause");
    expect(body).toContain("wantPlaying = false");
    // The old `player?.pauseVideo()` alone is the no-op this replaces.
    expect(body).toContain("pauseVideo()");
  });
});

describe("the IFrame stops talking once the decks own the sound", () => {
  test("state changes from a fallback IFrame are ignored", () => {
    // Without this the `autoplay:1` related-video snap-back re-started a dry
    // copy of the track the deck was already playing.
    expect(player).toMatch(
      /onStateChange: \(state\) => \{[\s\S]{0,900}?if \(audioElementIsSource\(usePlayerStore\.getState\(\)\.current\)\) return;/,
    );
  });

  test("its clock cannot overwrite the deck's position", () => {
    expect(player).toMatch(
      /onTime: \(currentTime, duration\) => \{[\s\S]{0,800}?if \(audioElementIsSource\(usePlayerStore\.getState\(\)\.current\)\) return;/,
    );
  });

  test("the guard uses the one predicate the rest of the store already trusts", () => {
    // Several call sites already branch on this (`restartCurrent`, `seek`,
    // `next`, the buffering watchdog). A second, subtly different predicate is
    // how the two sources drifted apart in the first place.
    const uses = player.match(/audioElementIsSource\(/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(8);
  });
});
