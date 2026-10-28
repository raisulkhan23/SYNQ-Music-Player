import { describe, expect, test } from "bun:test";
import { readSource } from "./helpers/tailwind-css.js";

/**
 * The crossfade BOUNDARY, where the outgoing track's `ended` collides with the
 * blend that is finishing.
 *
 * These four defects all survived the first round of fixes and all of them
 * were audible, which is the argument for testing the boundary rather than the
 * blend itself. A blend that is scheduled correctly can still be destroyed in
 * the ~120ms window where the two meet.
 *
 * The worst of them is a genuine race that fired on EVERY crossfade, not
 * occasionally: a 6s blend on a 240s track finishes its automation at the same
 * instant the outgoing element ends.
 */

const player = readSource("src/store/player.ts");

const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const playerCode = stripComments(player);

function bodyOf(code, name) {
  const start = Math.max(
    code.indexOf(`\nfunction ${name}(`),
    code.indexOf(`\nasync function ${name}(`),
  );
  if (start === -1) throw new Error(`no top-level function ${name}`);
  const next = code.indexOf("\nfunction ", start + 1);
  const altNext = code.indexOf("\nasync function ", start + 1);
  const ends = [next, altNext].filter((i) => i !== -1);
  return code.slice(start, ends.length ? Math.min(...ends) : code.length);
}

describe("BUG1 — a running blend owns its own end-of-track boundary", () => {
  // THE race. Timeline for crossfade=6 on a 240s track:
  //   234.0s  blend starts, incoming.play()
  //   240.0s  outgoing element fires `ended`   <-- arrives FIRST
  //   240.1s  the blend's completion poll fires
  //
  // The old handler read that `ended` as "the transition failed" and so:
  //   - cancelled the blend mid-flight,
  //   - called resetAllDeckGains(), which forces the ALREADY-PLAYING incoming
  //     deck back to gain 1, and
  //   - advanced the queue onto the track after the one fading in.
  // Net effect on every crossfade: two songs at once, the fading-in one
  // orphaned at full volume, and the store pointing at an unheard track.
  const ended = bodyOf(playerCode, "handleEnded");

  test("handleEnded defers the event while a blend is running", () => {
    expect(ended).toMatch(
      /if \(t\?\.running\) \{[\s\S]{0,300}?t\.endedSeen = true;[\s\S]{0,200}?return;/,
    );
  });

  test("it does not cancel or advance in that case", () => {
    const runningBranch = ended.slice(
      ended.indexOf("if (t?.running)"),
      ended.indexOf("if (t?.committed)"),
    );
    expect(runningBranch).not.toMatch(/cancelTransition\(/);
    expect(runningBranch).not.toMatch(/completeEndedTrack\(/);
    // The single most damaging statement in the old version: un-fading the
    // mid-blend incoming deck to unity.
    expect(runningBranch).not.toMatch(/resetAllDeckGains/);
  });

  test("the completed-transition guard is still there", () => {
    expect(ended).toMatch(
      /if \(t\?\.committed\) \{[\s\S]{0,300}?transition = null;[\s\S]{0,200}?return;/,
    );
  });

  test("anything else falls through to the normal end-of-track path", () => {
    expect(ended).toMatch(/completeEndedTrack\(\);/);
  });

  test("the transition records that it deferred an `ended`", () => {
    expect(playerCode).toMatch(/endedSeen: boolean;/);
    expect(playerCode).toMatch(/endedSeen: false,/);
  });

  test("a deferred `ended` is recovered if the blend is then abandoned", () => {
    // Otherwise swallowing the event has no owner: the outgoing element is
    // spent, the blend is cancelled, and nothing ever advances the queue.
    const run = bodyOf(playerCode, "maybeRunCrossfade");
    expect(run).toMatch(
      /if \(transition !== t \|\| t\.committed\) \{[\s\S]{0,300}?if \(t\.endedSeen\) recoverDeferredAdvance\(t\);/,
    );
    const recover = bodyOf(playerCode, "recoverDeferredAdvance");
    expect(recover).toMatch(/if \(t\.advanceRecovered\) return;/);
    expect(recover).toMatch(/completeEndedTrack\(\);/);
  });

  test("recovery cannot double-advance after a manual Next", () => {
    // The store is the arbiter: if `current` is no longer the track the blend
    // was fading out, a manual skip already advanced and the queue must not
    // move again.
    const recover = bodyOf(playerCode, "recoverDeferredAdvance");
    expect(recover).toMatch(
      /if \(t\.outgoingId && s\.current && s\.current\.id !== t\.outgoingId\) return;/,
    );
  });

  test("the transition remembers which track it was fading out", () => {
    expect(playerCode).toMatch(/outgoingId: string \| null;/);
    expect(playerCode).toMatch(/outgoingId: s\.current\?\.id \?\? null,/);
  });
});

describe("BUG2 — cancelling a blend must STOP the incoming deck", () => {
  // resetAllDeckGains() sets BOTH decks to unity. A transition abandoned after
  // incoming.play() had resolved therefore left the incoming song playing at
  // FULL VOLUME next to the outgoing one. Every cancel path hit this: seek,
  // Next, clearing the queue, switching repeat mode, changing the crossfade
  // length, signing out.
  const cancel = bodyOf(playerCode, "cancelTransition");

  test("it pauses the incoming element it had already started", () => {
    expect(cancel).toMatch(
      /if \(t\.incomingStarted\) \{[\s\S]{0,300}?t\.incomingEl\?\.pause\(\);/,
    );
  });

  test("it still resets the gains afterwards", () => {
    expect(cancel).toMatch(/resetAllDeckGains\(\);/);
  });

  test("the transition tracks the element and that it has been started", () => {
    expect(playerCode).toMatch(/incomingEl: HTMLAudioElement \| null;/);
    expect(playerCode).toMatch(/incomingStarted: boolean;/);
    expect(playerCode).toMatch(/incomingStarted: false,/);
  });

  test("the incoming element is recorded BEFORE it is asked to play", () => {
    // Recording it after `play()` leaves a window in which a cancel cannot
    // stop what is already audible.
    const run = bodyOf(playerCode, "maybeRunCrossfade");
    const record = run.indexOf("t.incomingEl = incoming;");
    const play = run.indexOf(".play()");
    expect(record).toBeGreaterThan(-1);
    expect(play).toBeGreaterThan(-1);
    expect(record).toBeLessThan(play);
  });

  test("`incomingStarted` is set only once play() has actually been called", () => {
    const run = bodyOf(playerCode, "maybeRunCrossfade");
    const started = run.indexOf("t.incomingStarted = true;");
    const play = run.indexOf(".play()");
    expect(started).toBeGreaterThan(-1);
    expect(started).toBeGreaterThan(play);
  });
});

describe("BUG3 — a gapless boundary still records the play as completed", () => {
  // The gapless hand-off returned from handleEnded BEFORE settleEngagement ran.
  // The outgoing track's engagement session was therefore never closed, and
  // got settled later against the NEXT track's position — producing both a
  // wrong completion percentage and a false "skipped" flag in the
  // recommendation signals.
  const ended = bodyOf(playerCode, "completeEndedTrack");

  test("engagement is settled before the hand-off", () => {
    const settle = ended.indexOf('settleEngagement("ended")');
    const handoff = ended.indexOf("tryGaplessHandoff()");
    expect(settle).toBeGreaterThan(-1);
    expect(handoff).toBeGreaterThan(-1);
    expect(settle).toBeLessThan(handoff);
  });

  test("it is also settled before the ordinary advance", () => {
    const settle = ended.indexOf('settleEngagement("ended")');
    const cancel = ended.indexOf('cancelTransition("ended")');
    expect(settle).toBeLessThan(cancel);
  });
});

describe("BUG4 — 'stop after this song' beats the gapless hand-off", () => {
  // The hand-off used to run first, so arming "stop after this song" with
  // gapless on started the NEXT track instead of stopping — the opposite of
  // what was asked for.
  const ended = bodyOf(playerCode, "completeEndedTrack");

  test("the sleep check comes before the hand-off", () => {
    const sleep = ended.indexOf("s.sleepAtSongEnd");
    const handoff = ended.indexOf("tryGaplessHandoff()");
    expect(sleep).toBeGreaterThan(-1);
    expect(sleep).toBeLessThan(handoff);
  });

  test("stopping still silences both decks and the engine", () => {
    expect(ended).toMatch(
      /if \(s\.sleepAtSongEnd\) \{[\s\S]{0,400}?pauseAllDecks\(\);[\s\S]{0,200}?ytEngine\.pause\(\);/,
    );
  });

  test("repeat-one is handled before the hand-off too", () => {
    const repeat = ended.indexOf('s.repeat === "one"');
    const handoff = ended.indexOf("tryGaplessHandoff()");
    expect(repeat).toBeGreaterThan(-1);
    expect(repeat).toBeLessThan(handoff);
    expect(ended).toMatch(/restartCurrent\(\);/);
  });

  test("both early returns cancel any armed transition first", () => {
    // Otherwise a blend stays armed across a stop, and arms again on resume.
    expect(ended).toMatch(/cancelTransition\("sleep-end"\);/);
    expect(ended).toMatch(/cancelTransition\("repeat-one"\);/);
  });
});
