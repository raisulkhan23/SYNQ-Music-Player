import { describe, expect, test } from 'vitest';
import { isEmbedBlocked, isFatalError } from "../src/lib/youtubePlayer.ts";
import { readSource } from "./helpers/tailwind-css.js";

/**
 * Fail fast.
 *
 * The bug that started this: playback was completely dead, with no feedback at
 * all. Three independent causes had to be fixed, and ALL of them were about
 * failure never being reported:
 *
 *  1. `isFatalError` did not include YT error code 153. That is the code a
 *     network blocker (uBlock/AdGuard/1Blocker) produces when it stops
 *     `youtube.com/embed/*`. Not fatal meant no error surfaced, so nothing
 *     escalated and the only rescue was a 12-second watchdog.
 *  2. `loadApi()` had no `onerror` and no timeout, so a blocked
 *     `youtube.com/iframe_api` left its promise pending FOREVER — play()
 *     neither resolved nor rejected.
 *  3. `audio.play()`'s rejection was swallowed, and a track with no video id
 *     and no stream URL assigned `audio.src = undefined` — the page itself,
 *     which never plays and never errors.
 *
 * There is deliberately NO cross-provider fallback any more. Jamendo was tried
 * in that role, its streams were silent too, and a second silent provider is
 * not a fallback — it is a second way to be silent. It is a discovery index
 * now; see `tests/jamendo-discovery.test.js`.
 */

describe("a blocked YouTube embed fails immediately, not after 12 seconds", () => {
  test("153 (embedding refused — what a blocker causes) is fatal", () => {
    // This was the bug. Without 153 here, no error was ever surfaced.
    expect(isFatalError(153)).toBe(true);
  });

  test("the codes that were already fatal still are", () => {
    for (const code of [2, 5, 100, 101, 150]) {
      expect(isFatalError(code)).toBe(true);
    }
  });

  test("an unknown code is not escalated into a fallback storm", () => {
    // Escalating on anything unrecognised would tear through the queue on a
    // stray state value, so the set stays explicit.
    for (const code of [-1, 0, 1, 3, 4, 12, 99]) {
      expect(isFatalError(code)).toBe(false);
    }
  });
});

describe("only a refused embed may blame the listener's blocker", () => {
  test("153 (embed refused — what a blocker causes) is the only code that does", () => {
    expect(isEmbedBlocked(153)).toBe(true);
  });

  test("owner-disabled embeds and removed videos never blame the listener", () => {
    // 101/150 = the VIDEO OWNER disabled embedding, 2/5/100 = bad or removed
    // video. None of these is something a listener can fix by touching their
    // blocker, so none of them may produce "your blocker is blocking YouTube".
    for (const code of [2, 5, 100, 101, 150, -1, 0, 1, 99]) {
      expect(isEmbedBlocked(code)).toBe(false);
    }
  });

  test("blaming a blocker is a strict subset of failing fast", () => {
    // Anything allowed to name a blocker must still be a fatal error, or the
    // rescue chain would never run in the first place.
    for (const code of [2, 5, 100, 101, 150, 153, 99, -1]) {
      if (isEmbedBlocked(code)) expect(isFatalError(code)).toBe(true);
    }
  });
});

describe("the wired-up player actually does this", () => {
  const playerSrc = readSource("src/store/player.ts");
  const ytSrc = readSource("src/lib/youtubePlayer.ts");
  const barSrc = readSource("src/components/player/PlayerBar.tsx");

  test("the silent watchdog is no longer 12 seconds", () => {
    // 12s of nothing is what was reported. The fatal paths short-circuit long
    // before this, so the watchdog only covers genuinely slow networks.
    expect(playerSrc).toMatch(
      /ytLoadWatchdog = setTimeout\([\s\S]{0,400}?5_000/,
    );
    expect(playerSrc).not.toMatch(
      /ytLoadWatchdog = setTimeout\([\s\S]{0,400}?12_000/,
    );
  });

  test("a blocked iframe_api request rejects instead of hanging forever", () => {
    expect(ytSrc).toContain("tag.onerror");
    expect(ytSrc).toMatch(/API_LOAD_TIMEOUT_MS/);
    expect(ytSrc).toMatch(/finish\(\s*\n?\s*new Error/);
  });

  test("a rejected play() promise is no longer swallowed on load", () => {
    // `.catch(() => undefined)` on the LOAD path was a silent dead end: no
    // element error event, no fallback, just silence.
    expect(playerSrc).toMatch(
      /audio\.play\(\)\.catch\(\(err: unknown\)[\s\S]{0,500}?reportLoadFailure\(seq, track\.id\)/,
    );
  });

  test("resuming an already-good source still swallows its rejection", () => {
    // Guard against over-correction: a NotAllowedError on resume/repeat must
    // not look like a broken source and trigger a fallback storm.
    expect(playerSrc).toContain("void audio.play().catch(() => undefined);");
  });

  test("autoplay-policy rejections are still not treated as broken sources", () => {
    // NotAllowedError means "needs a tap", not "unplayable" — escalating
    // there would swap the song for no reason.
    expect(playerSrc).toContain('name === "NotAllowedError"');
    expect(playerSrc).toContain('name === "AbortError"');
  });

  test("a track with no video id and no stream URL is refused up front", () => {
    // `audio.src = undefined` resolves to the page itself: never playable,
    // never an error. This is the silent case that must never happen.
    //
    // The guard's block grew a user-facing toast with Retry / Play next
    // actions, so the window is wide enough to reach its `return;`. What the
    // test is actually about is that the guard exists AND returns, instead of
    // falling through to an engine with nothing to play.
    expect(playerSrc).toMatch(
      /if \(!track\.youtubeId && !track\.audioUrl\) \{[\s\S]{0,900}?toast\.error\([\s\S]{0,600}?return;/,
    );
  });

  test("the blocked stream-rescue paths report failure too", () => {
    // A blocked stream host fails silently on the rescue path as well, and
    // that rescue is the last thing standing when YouTube is blocked.
    const guards = playerSrc.match(
      /watchAudioErrors\(audio, seq, track\.id\)/g,
    );
    expect(guards?.length).toBe(3);
  });

  test("the dead cross-provider fallback is gone from the rescue chain", () => {
    // Jamendo is a discovery index now. Leaving it in the chain only bought
    // more silence, and it kept a second broken path alive in the code.
    expect(barSrc).not.toContain("tryJamendoVersion");
    expect(barSrc).not.toContain("pickJamendoFallback");
    expect(barSrc).not.toContain("toPlayableJamendo");
    expect(barSrc).not.toContain("searchJamendo");
  });

  test("running out of ways to play still says something, without inventing a blocker", () => {
    // The end of the chain must still produce a message — total silence was
    // the bug this whole file exists for.
    expect(barSrc).toMatch(
      /const next = alternatives\[attempts\.current - 1\][\s\S]{0,900}?giveUpNotice\(/,
    );
    // But it may name a blocker ONLY from the engine's own verdict. A
    // hardcoded "YouTube" here is exactly what told listeners with no blocker
    // running that their blocker was blocking YouTube — the false positive
    // this test now guards against.
    expect(barSrc).not.toContain('blockedProvider: "YouTube"');
    expect(barSrc).toMatch(/blockedProvider: s\.blockedProvider/);
  });

  test("the store only records a blocker from the engine's blocked-embed signal", () => {
    expect(playerSrc).toMatch(
      /blockedProvider: ytEngine\.isEmbedBlocked\(code\)/,
    );
    // And it must be cleared at the start of every load, so one blocked track
    // cannot brand the next, unrelated one as blocked too.
    const clears = playerSrc.match(/blockedProvider: null/g) ?? [];
    expect(clears.length).toBeGreaterThanOrEqual(2);
  });
});
