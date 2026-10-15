import { describe, expect, test } from 'vitest';
import { readFileSync } from "node:fs";

/**
 * The buffering watchdog must never make buffering worse.
 *
 * `armAudioBufferWatchdog` runs 8s after a `waiting`/`stalled` event. Its job is
 * to unstick a genuinely stalled element. It used to do that by calling
 * `audio.load()` unconditionally — and `load()` DISCARDS every byte already
 * downloaded and starts the fetch again from zero.
 *
 * So a buffer that was merely SLOW to fill (two proxies between the listener and
 * the CDN) had all its progress thrown away every eight seconds, the element
 * fell back to `HAVE_NOTHING`, the next `stalled` re-armed the watchdog, and the
 * song looped between "buffering" and "buffering" forever. That is precisely
 * the "the song just keeps buffering" report: a retry mechanism that guaranteed
 * the condition it existed to fix.
 *
 * There was no ceiling on retries either, so nothing could ever settle.
 *
 * Source-shape on purpose: this is a decision about which `HTMLMediaElement`
 * calls happen under which `readyState`, which needs a real media pipeline to
 * execute. A fake element that always reported `HAVE_NOTHING` — or always
 * `HAVE_FUTURE_DATA` — would pass either version of this code, so executing it
 * against a stub would prove nothing. What CAN be pinned is the shape of the
 * decision itself.
 */

const player = readFileSync("src/store/player.ts", "utf8");

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

describe("the buffering watchdog", () => {
  test("does not discard a partial buffer", () => {
    const body = bodyOf(player, "armAudioBufferWatchdog");
    // The reload must be gated on the element having NOTHING — the only state
    // in which discarding progress can possibly help.
    expect(body).toMatch(
      /if \(audio\.readyState === HTMLMediaElement\.HAVE_NOTHING\) \{\s*audio\.load\(\)/,
    );
    // And `load()` must not be reachable from anywhere else in the watchdog.
    const loads = body.match(/audio\.load\(\)/g) ?? [];
    expect(loads).toHaveLength(1);
  });

  test("has a ceiling, and says so when it reaches it", () => {
    const body = bodyOf(player, "armAudioBufferWatchdog");
    expect(body).toMatch(/if \(bufferRetries >= 2\) \{/);
    // Giving up silently is how a stuck track becomes "the app is broken".
    expect(body).toMatch(/noteTransition\(/);
  });

  test("the retry budget resets once audio actually plays", () => {
    // Otherwise a listener who stalls twice in one session is permanently
    // denied recovery for every later track.
    expect(player).toMatch(
      /on\("playing",[\s\S]{0,300}?bufferRetries = 0;[\s\S]{0,200}?isBuffering: false/,
    );
  });

  test("it still recovers a source that never arrived at all", () => {
    // The gate must not become a no-op: a genuinely dead element still needs
    // the reload, or the fix would trade a loop for silence.
    const body = bodyOf(player, "armAudioBufferWatchdog");
    expect(body).toMatch(/void audio\.play\(\)\.catch\(\(\) => undefined\);/);
    expect(body).toMatch(/restorePosition/);
  });
});
