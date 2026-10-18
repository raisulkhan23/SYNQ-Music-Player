import { describe, expect, test } from "bun:test";
import { readSource } from "./helpers/tailwind-css.js";

const storeSource = readSource("src/store/player.ts");
const engineSource = readSource("src/lib/youtubePlayer.ts");

/** Body of a `function name(...) { ... }` declared at module scope. */
function fn(name) {
  const start = storeSource.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`missing ${name}`);
  const end = storeSource.indexOf("\n}\n", start);
  return storeSource.slice(start, end === -1 ? undefined : end + 3);
}

/** Body of a `const name = (...) => { ... }` declared inside the store factory. */
function factoryFn(name) {
  const start = storeSource.indexOf(`  const ${name} = (`);
  if (start === -1) throw new Error(`missing ${name}`);
  const end = storeSource.indexOf("\n  const ", start + 10);
  return storeSource.slice(start, end === -1 ? undefined : end);
}

const restartCurrent = fn("restartCurrent");
const togglePlay = factoryFn("togglePlay");
// The end-of-track advance lives in `completeEndedTrack`; `handleEnded`
// delegates to it and a deferred blend calls it back.
const handleEnded = fn("completeEndedTrack");
const scheduleEffectRetry = factoryFn("scheduleEffectRetry");

describe("repeat one restarts the source that is actually making sound", () => {
  test("the <audio> element is restarted when it owns playback", () => {
    // The store's `current` still carries a youtubeId after an effect swap, so
    // the old code always reloaded the IFrame: the element stayed parked at
    // the end of the song while a dry second copy of the track started on top
    // of it, which also made the effect inaudible.
    expect(restartCurrent).toMatch(
      /if \(s\.current && audioElementIsSource\(s\.current\)\)/,
    );
    const guard = restartCurrent.indexOf("audioElementIsSource(s.current)");
    const setTime = restartCurrent.indexOf("audio.currentTime = 0");
    const play = restartCurrent.indexOf("audio.play()");
    expect(guard).toBeGreaterThan(-1);
    // Both the rewind and the replay have to happen inside that guard.
    expect(setTime).toBeGreaterThan(guard);
    expect(play).toBeGreaterThan(guard);
    // ...and the guard must return, before falling through to the IFrame path.
    const afterGuard = restartCurrent.slice(guard);
    const returnIdx = afterGuard.indexOf("return;");
    const iframeIdx = afterGuard.indexOf("if (s.current?.youtubeId) {");
    expect(returnIdx).toBeGreaterThan(-1);
    expect(iframeIdx).toBeGreaterThan(returnIdx);
  });

  test("the IFrame path is still reachable for ordinary YouTube tracks", () => {
    expect(restartCurrent).toMatch(/if \(s\.current\?\.youtubeId\) \{/);
    expect(restartCurrent).toMatch(/ytEngine\s*\n?\s*\.play\(/);
  });
});

describe("Pause follows the engine, not the polled flag", () => {
  test("the engine exposes its raw state", () => {
    expect(engineSource).toMatch(/export function getEngineState\(\): number/);
    expect(engineSource).toMatch(/getPlayerState/);
  });

  test("togglePlay reads the real engine state before pausing", () => {
    // When `isPlaying` and the engine disagreed, Pause called pauseVideo() on
    // an already-paused player: nothing happened and the button looked stuck.
    expect(togglePlay).toMatch(
      /const engineState = ytEngine\.getEngineState\(\)/,
    );
    expect(togglePlay).not.toMatch(/if \(s\.isPlaying\) ytEngine\.pause\(\)/);
    expect(togglePlay).toMatch(/engineState === 1 \|\| engineState === 3/);
    expect(togglePlay).toMatch(/engineState === 2/);
  });

  test("resuming loads the track when the engine does not already have it", () => {
    // A bare resume() is a no-op on an unstarted player, so pressing play after
    // a pause-at-zero (or after a failed load) did nothing at all.
    expect(togglePlay).toMatch(
      /ytEngine\.getLoadedVideoId\(\) === s\.current\.youtubeId/,
    );
    expect(togglePlay).toMatch(
      /ytEngine\s*\n?\s*\.play\(s\.current\.youtubeId/,
    );
  });
});

describe("end of queue advances to the track it actually appended", () => {
  test("the advance index uses the appended count, not the fetched count", () => {
    // `related.length` overcounts whenever some of the mix was already
    // queued, so the auto-advance started the wrong song.
    expect(handleEnded).toMatch(/let appended = 0;/);
    expect(handleEnded).toMatch(/appended = fresh\.length/);
    // Compare against the comment-stripped body so prose about the old
    // expression cannot satisfy (or trip) the assertion.
    const code = handleEnded.replace(/\/\/[^\n]*/g, "");
    // `autoAdvanceToIndex` is the UNGATED advance. Autoplay must not route
    // through the deferred-auth gate: a queue running dry is playback already
    // in progress, and gating it would throw a sign-in dialog at someone the
    // moment a song ended.
    expect(code).toMatch(
      /autoAdvanceToIndex\?\.\(after\.queue\.length - appended\)/,
    );
    expect(code).not.toMatch(/related\.length/);
  });

  test("a fully duplicate mix does not jump to an arbitrary earlier track", () => {
    // Scope this to the related-mix fallback. handleEnded now tries the
    // recommendation engine first, and that branch has its own advance, so
    // a bare indexOf would find that one instead of the fallback's.
    const fallback = handleEnded.indexOf("fetchRelatedMix(seed, s.queue, 5");
    expect(fallback).toBeGreaterThan(-1);
    const body = handleEnded.slice(fallback);
    const guard = body.indexOf("if (appended === 0) return;");
    const advance = body.indexOf("autoAdvanceToIndex?.(");
    expect(guard).toBeGreaterThan(-1);
    expect(advance).toBeGreaterThan(guard);
  });
});

describe("the video slave is corrected against a live clock", () => {
  test("drift resync uses the element clock, not the polled snapshot", () => {
    const start = storeSource.indexOf("Periodic drift resync");
    const body = storeSource.slice(
      start,
      storeSource.indexOf("}, 3000);", start),
    );
    expect(body).toMatch(/const live = audio\.currentTime/);
    expect(body).toMatch(
      /Math\.abs\(ytEngine\.getEngineTime\(\) - live\) > 1\.5/,
    );
    // No resync while stalled — seeking a buffering player digs it deeper.
    expect(body).toMatch(/if \(!s\.isPlaying \|\| s\.isBuffering\) return;/);
    // ...and never against an element that has not loaded metadata. Right
    // after a stream swap `audio.src` has just been reassigned and
    // `currentTime` reads 0 until `loadedmetadata` fires, so correcting
    // against it snapped the picture to the start of the track while the
    // audio was already minutes in. A swap does not set `isBuffering`, so the
    // guard above does not catch it.
    expect(body.indexOf("HAVE_METADATA")).toBeLessThan(
      body.indexOf("const live = audio.currentTime"),
    );
    expect(body.indexOf("HAVE_METADATA")).toBeGreaterThan(-1);
  });
});

describe("a dropped stream resolve does not end the retry chain", () => {
  test("the retry timer is re-armed on rejection, not only on a null url", () => {
    expect(scheduleEffectRetry).toMatch(/const retryLater = \(\) => \{/);
    expect(scheduleEffectRetry).toMatch(/retryLater\(\);/);
    expect(scheduleEffectRetry).toMatch(/\.catch\(\(\) => retryLater\(\)\)/);
  });

  test("the retry budget is still bounded", () => {
    expect(scheduleEffectRetry).toMatch(/if \(attempts < 8\)/);
  });
});
