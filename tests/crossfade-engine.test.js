import { describe, expect, test } from "bun:test";
import { readSource } from "./helpers/tailwind-css.js";
import {
  CROSSFADE_CHOICES,
  GAPLESS_PRELOAD_LEAD_SECONDS,
  MANUAL_SKIP_FADE_SECONDS,
  clampFade,
  fadeGains,
  normalizeCrossfade,
  planTransition,
  prepareLead,
  shouldStartFade,
  shouldStartNow,
} from "../src/lib/transition.ts";

/**
 * SYNQ's crossfade / gapless ENGINE, as opposed to its settings UI.
 *
 * Every test here corresponds to a defect that was found by tracing the real
 * execution path in the browser engine — not by reading the UI. The settings
 * for crossfade and gapless were present, persisted and rendered the whole
 * time; none of that meant a single sample of overlap was ever produced.
 *
 * The invariant that matters: the transition code must actually reach the audio
 * graph. A crossfade is two sounds at once. Anything that leaves the engine
 * untappable, or leaves one deck permanently unwired, means the feature cannot
 * work no matter what the toggle says.
 */

const audio = readSource("src/lib/audio.ts");
const player = readSource("src/store/player.ts");
const transition = readSource("src/lib/transition.ts");

/** Comments explain the bug, so they must go before asserting on shape. */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const audioCode = stripComments(audio);
const playerCode = stripComments(player);

/**
 * The body of one top-level function, found by its own declaration line.
 *
 * Slicing by a hard-coded second boundary is how these tests quietly start
 * asserting on an empty string: every function here is `function name(` at
 * column 0, so the next such line is always a real end.
 */
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

describe("RC1 — a released deck must stay usable (it was permanently dead)", () => {
  // Web Audio permits exactly one createMediaElementSource() per element, ever.
  // The old releaseDeck() disconnected it and nulled the nodes, so the released
  // element could never make a sound again and canCrossfadeNow() — which needs
  // a gain on BOTH decks — was false for the rest of the session. Net effect:
  // crossfade ran at most once per page load, and the second crossfade loaded
  // its incoming track onto a silent element.
  const release = audioCode.slice(
    audioCode.indexOf("export function releaseDeck"),
    audioCode.indexOf("export function ensureDeckAttached"),
  );
  expect(release.length).toBeGreaterThan(200);

  test("releaseDeck stops and empties the deck", () => {
    expect(release).toMatch(/deck\.el\.pause\(\)/);
    expect(release).toMatch(/deck\.el\.removeAttribute\("src"\)/);
    expect(release).toMatch(/deck\.el\.load\(\)/);
  });

  test("releaseDeck never disconnects or forgets the source/gain nodes", () => {
    expect(release).not.toMatch(/\.disconnect\(\)/);
    expect(release).not.toMatch(/deck\.source = null/);
    expect(release).not.toMatch(/deck\.gain = null/);
  });

  test("releaseDeck parks the deck's transition gain back at unity", () => {
    expect(release).toMatch(/setDeckGainNow\(slot, 1\)/);
  });

  test("releaseDeck still refuses to release the live deck", () => {
    expect(release).toMatch(/if \(slot === activeDeck\) return;/);
  });

  test("canCrossfadeNow re-attaches a missing deck instead of giving up", () => {
    // Belt and braces: even if a deck is ever found unattached, one missing
    // gain must not disable crossfade for the whole session.
    const can = audioCode.slice(
      audioCode.indexOf("export function canCrossfadeNow"),
      audioCode.indexOf("export function releaseDeck"),
    );
    expect(can).toMatch(/ensureDeckAttached\(slot\)/);
  });
});

describe("RC2 — the crossfade engine has to be reachable at all", () => {
  // The decisive defect. Default YouTube playback goes through the IFrame API,
  // which Web Audio cannot tap, and `wantFilter` was only true for an EQ or an
  // effect preset. So for an ordinary listener with a flat EQ: playback used the
  // IFrame, crossfadePossible() was false, and every plan silently became a
  // cut — while the settings screen said crossfade was on.
  const load = playerCode.slice(
    playerCode.indexOf("const wantFilter ="),
    playerCode.indexOf("if (wantDeckEngine && track.youtubeId)"),
  );

  test("asking for a crossfade routes playback onto the audio decks", () => {
    expect(load).toMatch(
      /wantFilter \|\| get\(\)\.crossfade > 0 \|\| get\(\)\.gapless/,
    );
  });

  test("the audio graph is actually built on that path", () => {
    // canCrossfadeNow() requires a RUNNING AudioContext, and the context is
    // only ever created lazily. Without this, the context is often never
    // constructed and the feature is off for the whole session.
    expect(load).toMatch(/if \(wantDeckEngine\) ensureGraph\(\);/);
  });

  test("the deck engine branch is the one that loads", () => {
    expect(playerCode).toMatch(/if \(wantDeckEngine && track\.youtubeId\) \{/);
  });
});

describe("RC3 — the incoming deck must be silent before it is asked to play", () => {
  // resetAllDeckGains() sets BOTH decks to 1 and scheduleCrossfade() only runs
  // after `await incoming.play()` has resolved. The next song was therefore
  // audible at 100% for the length of the play() promise, then slammed to zero
  // and faded up — a loud unmasked burst immediately before the blend.
  const run = bodyOf(playerCode, "maybeRunCrossfade");
  expect(run.length).toBeGreaterThan(500);

  test("the incoming gain is zeroed before play() is called", () => {
    const zero = run.indexOf("setDeckGainNow(incomingSlot, 0)");
    const play =
      run.indexOf("incoming\n      .play()") >= 0
        ? run.indexOf("incoming\n      .play()")
        : run.indexOf(".play()");
    expect(zero).toBeGreaterThan(-1);
    expect(play).toBeGreaterThan(-1);
    expect(zero).toBeLessThan(play);
  });

  test("master volume is never used as the blend control", () => {
    // The listener's volume must survive a transition untouched.
    expect(run).toMatch(/incoming\.volume = s\.volume;/);
    expect(run).not.toMatch(/incoming\.volume = 0/);
  });
});

describe("RC4 — a refused blend must not orphan a playing element", () => {
  // scheduleCrossfade() runs AFTER incoming.play(). If it refused, the old code
  // cancelled the transition but left the incoming element playing: two songs
  // at once, and handleEnded() later advanced to a third.
  const run = bodyOf(playerCode, "maybeRunCrossfade");

  test("a refused automation pauses the incoming element", () => {
    expect(run).toMatch(/if \(!ok\) \{[\s\S]{0,600}?incoming\.pause\(\)/);
  });

  test("a refused automation silences the incoming deck and resets both", () => {
    expect(run).toMatch(
      /if \(!ok\) \{[\s\S]{0,600}?setDeckGainNow\(incomingSlot, 0\);[\s\S]{0,200}?resetAllDeckGains\(\);/,
    );
  });
});

describe("RC5 — manual Next must actually blend", () => {
  // armTransition(reason, 0) passed currentTime 0, so `remaining` was the full
  // track length and shouldStartFade (which fires at remaining <= leadSeconds)
  // could never be satisfied. The blend was armed and then abandoned. On top of
  // that, next() called playIndex immediately, tearing down the current track
  // before any blend could run.
  test("a manual skip is armed with the real playhead position", () => {
    const req = playerCode.slice(
      playerCode.indexOf("export function requestTransition"),
      playerCode.indexOf("async function runManualBlend"),
    );
    expect(req.length).toBeGreaterThan(200);
    expect(req).toMatch(/armTransition\(reason, s\.currentTime\)/);
    expect(req).not.toMatch(/armTransition\(reason, 0\)/);
  });

  test("Next defers the advance until the blend has run", () => {
    const next = playerCode.slice(
      playerCode.indexOf("const next = () => {"),
      playerCode.indexOf("const prev = () => {"),
    );
    expect(next).toMatch(/void runManualBlend\(advance\);/);
  });

  test("a manual blend is a short one, not the full configured crossfade", () => {
    const plan = planTransition({
      crossfadeSeconds: 10,
      gaplessEnabled: false,
      reason: "manual-next",
      currentDuration: 240,
      currentTime: 30,
      hasNext: true,
      canCrossfade: true,
      sameAlbum: false,
      abRepeatActive: false,
      repeatOne: false,
      paused: false,
    });
    expect(plan.mode).toBe("crossfade");
    expect(plan.seconds).toBe(MANUAL_SKIP_FADE_SECONDS);
    expect(plan.seconds).toBeLessThan(10);
  });

  test("a manual skip starts immediately rather than at the track's end", () => {
    // The bug in one assertion: with leadSeconds = 0.9 and a track that has
    // 210s left, the run-down trigger can never fire.
    const plan = planTransition({
      crossfadeSeconds: 6,
      gaplessEnabled: false,
      reason: "manual-next",
      currentDuration: 240,
      currentTime: 30,
      hasNext: true,
      canCrossfade: true,
      sameAlbum: false,
      abRepeatActive: false,
      repeatOne: false,
      paused: false,
    });
    expect(shouldStartNow(plan)).toBe(true);
    expect(shouldStartFade(plan, 210, null)).toBe(false);
  });

  test("an automatic crossfade still waits for the run-down", () => {
    const plan = planTransition({
      crossfadeSeconds: 6,
      gaplessEnabled: true,
      reason: "track-ended",
      currentDuration: 240,
      currentTime: 233,
      hasNext: true,
      canCrossfade: true,
      sameAlbum: false,
      abRepeatActive: false,
      repeatOne: false,
      paused: false,
    });
    expect(shouldStartNow(plan)).toBe(false);
    expect(shouldStartFade(plan, 7, null)).toBe(false);
    // Crossing the boundary from above is what identifies the moment.
    expect(shouldStartFade(plan, 6, 7.2)).toBe(true);
  });
});

describe("RC6 — gapless is a hand-off, not a zero-length crossfade", () => {
  // `maybeRunCrossfade` returned immediately for any non-crossfade plan, and
  // `tickTransition` only armed at all when crossfade > 0. So with crossfade
  // OFF, gapless never preloaded anything: the next stream was not resolved
  // until after `ended`, i.e. inside the very gap the setting exists to remove.
  test("a gapless plan gets a real preparation lead", () => {
    const plan = planTransition({
      crossfadeSeconds: 0,
      gaplessEnabled: true,
      reason: "track-ended",
      currentDuration: 240,
      currentTime: 200,
      hasNext: true,
      canCrossfade: false,
      sameAlbum: false,
      abRepeatActive: false,
      repeatOne: false,
      paused: false,
    });
    expect(plan.mode).toBe("gapless");
    expect(prepareLead(plan)).toBe(GAPLESS_PRELOAD_LEAD_SECONDS);
    expect(GAPLESS_PRELOAD_LEAD_SECONDS).toBeGreaterThan(0);
  });

  test("the scheduler arms for gapless even with crossfade off", () => {
    const tick = playerCode.slice(
      playerCode.indexOf("function tickTransition"),
      playerCode.indexOf("function onTimeUpdate"),
    );
    expect(tick).toMatch(/\? GAPLESS_PRELOAD_LEAD_SECONDS/);
    expect(tick).toMatch(/: 0;/);
  });

  test("the incoming track is prepared for every mode, not only crossfade", () => {
    const arm = bodyOf(playerCode, "armTransition");
    expect(arm).toMatch(/void prepareIncoming\(next\.track\);/);
    expect(arm).not.toMatch(/plan\.mode === "crossfade" && preloadLead/);
  });

  test("the hand-off delegates the readiness gate to the executed predicate", () => {
    // The three conditions (prepared, resolved, buffered) now live in
    // `canHandOffGapless` in `lib/transition`, which
    // `tests/transition-execution.test.js` EXECUTES across every case. Here we
    // only pin that the store actually calls it — a source-text assertion can
    // see that, and cannot see whether the values that reach the audio graph
    // are correct, which is what the executed test is for.
    const handoff = bodyOf(playerCode, "tryGaplessHandoff");
    expect(handoff.length).toBeGreaterThan(200);
    expect(handoff).toMatch(/canHandOffGapless\(\{/);
    expect(handoff).toMatch(/if \(!readiness\.ready\)/);
    expect(handoff).toMatch(/incoming\.play\(\)/);
  });

  test("the hand-off runs before the end-of-track cancel", () => {
    const ended = playerCode.slice(
      playerCode.indexOf("function completeEndedTrack"),
      playerCode.indexOf("function completeEndedTrack") + 2500,
    );
    const handoff = ended.indexOf("tryGaplessHandoff()");
    const cancel = ended.indexOf('cancelTransition("ended")');
    expect(handoff).toBeGreaterThan(-1);
    expect(cancel).toBeGreaterThan(-1);
    expect(handoff).toBeLessThan(cancel);
  });

  test("gapless is not implemented as a zero-second crossfade", () => {
    // prepareLead() used to return 0 for gapless, which is precisely the
    // "crossfade with 0 seconds" the spec forbids.
    expect(transition).toMatch(
      /if \(plan\.mode === "gapless"\) return GAPLESS_PRELOAD_LEAD_SECONDS;/,
    );
  });
});

describe("ACCEPTANCE 1 — crossfade = 6s, two tracks audibly overlap", () => {
  const plan = planTransition({
    crossfadeSeconds: 6,
    gaplessEnabled: true,
    reason: "track-ended",
    currentDuration: 240,
    currentTime: 0,
    hasNext: true,
    canCrossfade: true,
    sameAlbum: false,
    abRepeatActive: false,
    repeatOne: false,
    paused: false,
  });

  test("a 6s crossfade on a 240s track begins 6s before the end", () => {
    expect(plan.mode).toBe("crossfade");
    expect(plan.seconds).toBe(6);
    expect(plan.leadSeconds).toBe(6);
  });

  test("it fires at 234s, not at 240s", () => {
    expect(shouldStartFade(plan, 7, 8)).toBe(false);
    expect(shouldStartFade(plan, 6, 7)).toBe(true);
  });

  test("the two decks are genuinely different elements", () => {
    // One element cannot overlap with itself. This is the mechanism.
    expect(audioCode).toMatch(/__ssAudio/);
    expect(audioCode).toMatch(/__ssAudioSpare/);
    expect(audioCode).toMatch(/const slot = activeDeck === "a" \? "b" : "a";/);
  });

  test("the blend is driven by two independent gain nodes", () => {
    expect(audioCode).toMatch(
      /export function scheduleCrossfade\([\s\S]{0,200}?outgoingSlot: "a" \| "b",[\s\S]{0,200}?incomingSlot: "a" \| "b",/,
    );
    expect(audioCode).toMatch(/const out = d\[outgoingSlot\]\.gain;/);
    expect(audioCode).toMatch(/const inc = d\[incomingSlot\]\.gain;/);
  });

  test("the curve is equal-power, so the blend holds its level", () => {
    // A linear crossfade dips ~6dB in the middle, which listeners hear as a
    // surge when the new song takes over. Note cos(pi/2) is 6.1e-17, not 0,
    // so the endpoints are compared with a tolerance rather than exactly.
    const start = fadeGains(0);
    expect(Math.abs(start.outgoing - 1)).toBeLessThan(1e-9);
    expect(Math.abs(start.incoming - 0)).toBeLessThan(1e-9);
    const end = fadeGains(1);
    expect(Math.abs(end.outgoing - 0)).toBeLessThan(1e-9);
    expect(Math.abs(end.incoming - 1)).toBeLessThan(1e-9);
    const mid = fadeGains(0.5);
    // Constant power: the squares sum to 1 across the whole blend, so the
    // summed loudness never sags. Compared with a 1e-6 tolerance rather than
    // toBeCloseTo, whose digit argument is easy to misread.
    const power = mid.outgoing ** 2 + mid.incoming ** 2;
    expect(Math.abs(power - 1)).toBeLessThan(1e-6);
    // Equal gain at the midpoint, not the -6dB of a linear blend.
    expect(Math.abs(mid.outgoing - mid.incoming)).toBeLessThan(1e-9);
    // A linear crossfade at the midpoint would be 0.5/0.5; this is ~0.707.
    expect(mid.outgoing).toBeGreaterThan(0.7);
  });

  test("master volume is independent of the blend gains", () => {
    // Requirement 15: the user's volume must survive a transition. The blend
    // multiplier lives on a per-deck GainNode upstream of the EQ, and the
    // element's own volume is set to the listener's value, never to a fade
    // value.
    expect(audioCode).toMatch(/export function setDeckVolume/);
    expect(audioCode).toMatch(/d\[slot\]\.el\.volume = value;/);
    const commit = playerCode.slice(
      playerCode.indexOf("function commitTransition"),
      playerCode.indexOf("function finishTransition"),
    );
    expect(commit).toMatch(/incoming\.volume = s\.volume;/);
  });
});

describe("ACCEPTANCE 2 — crossfade OFF leaves normal transitions working", () => {
  test("OFF + gapless OFF is a plain cut", () => {
    const plan = planTransition({
      crossfadeSeconds: 0,
      gaplessEnabled: false,
      reason: "track-ended",
      currentDuration: 240,
      currentTime: 239,
      hasNext: true,
      canCrossfade: true,
      sameAlbum: false,
      abRepeatActive: false,
      repeatOne: false,
      paused: false,
    });
    expect(plan.mode).toBe("cut");
    expect(plan.seconds).toBe(0);
    expect(shouldStartNow(plan)).toBe(false);
  });

  test("a crossfade length of 0 is off, whatever is stored", () => {
    expect(normalizeCrossfade(0)).toBe(0);
    expect(normalizeCrossfade("nonsense")).toBe(0);
    expect(normalizeCrossfade(-4)).toBe(0);
    // A sub-perceptible fade is a click, not a blend.
    expect(normalizeCrossfade(0.2)).toBe(0);
  });
});

describe("ACCEPTANCE 3 — gapless ON with crossfade OFF", () => {
  test("it plans gapless, not a cut and not a blend", () => {
    const plan = planTransition({
      crossfadeSeconds: 0,
      gaplessEnabled: true,
      reason: "track-ended",
      currentDuration: 240,
      currentTime: 239,
      hasNext: true,
      canCrossfade: false,
      sameAlbum: false,
      abRepeatActive: false,
      repeatOne: false,
      paused: false,
    });
    expect(plan.mode).toBe("gapless");
    expect(plan.seconds).toBe(0);
    expect(plan.leadSeconds).toBe(0);
  });
});

describe("ACCEPTANCE 4/5 — queue and autoplay use the same engine", () => {
  test("the transition target is the queue's own next track", () => {
    // Requirement 7: the transition must not choose a different song just
    // because a blend wants one. peekNextTrack() mirrors handleEnded's
    // shuffle / repeat-all / end-of-queue rules exactly.
    const peek = playerCode.slice(
      playerCode.indexOf("function peekNextTrack"),
      playerCode.indexOf("function crossfadePossible"),
    );
    expect(peek).toMatch(
      /pickShuffleIndex\(s\.queue\.length, s\.queueIndex, s\.smartShuffle\)/,
    );
    expect(peek).toMatch(/s\.repeat === "all"/);
    expect(peek).toMatch(/return null; \/\/ end of queue/);
  });

  test("the queue advances exactly once per transition", () => {
    // One commit site, shared by the crossfade and the gapless hand-off.
    const commits = playerCode.match(/commitCrossfadeAdvance\?\.\(/g) ?? [];
    expect(commits).toHaveLength(1);
  });

  test("autoplay is planned through the same transition engine", () => {
    expect(transition).toMatch(/\| "autoplay"/);
    const plan = planTransition({
      crossfadeSeconds: 6,
      gaplessEnabled: true,
      reason: "autoplay",
      currentDuration: 240,
      // Mid-track, so `remaining` is far larger than the fade and the clamp
      // (which trims 0.05s so a sliver of the outgoing track stays audible)
      // does not shorten it.
      currentTime: 100,
      hasNext: true,
      canCrossfade: true,
      sameAlbum: false,
      abRepeatActive: false,
      repeatOne: false,
      paused: false,
    });
    expect(plan.mode).toBe("crossfade");
    expect(plan.seconds).toBe(6);
  });
});

describe("ACCEPTANCE 7 — rapid Next leaves exactly one stream playing", () => {
  test("every skip cancels the transition in flight first", () => {
    // next(), prev(), seek(), togglePlay(), clearQueue() and resetForSignOut()
    // all cancel before acting, so a second press can never stack a blend.
    for (const why of [
      "manual-next",
      "manual-prev",
      "seek",
      "pause",
      "manual-skip",
    ]) {
      expect(playerCode).toMatch(new RegExp(`cancelTransition\\("${why}"\\)`));
    }
  });

  test("a running blend is not re-entered", () => {
    const arm = bodyOf(playerCode, "armTransition");
    expect(arm).toMatch(
      /if \(transition\?\.armed \|\| transition\?\.running\) return;/,
    );
    const run = bodyOf(playerCode, "maybeRunCrossfade");
    expect(run).toMatch(/if \(!t \|\| !t\.armed \|\| t\.running\) return;/);
  });

  test("a blend that is superseded is not committed late", () => {
    const run = bodyOf(playerCode, "maybeRunCrossfade");
    expect(run.length).toBeGreaterThan(500);
    // The blend is abandoned if the queue moved on while the incoming element
    // was starting, and again before it is allowed to commit.
    expect(run).toMatch(
      /if \(!prepared \|\| !transition \|\| transition !== t\) return;/,
    );
    // An abandoned blend that had also swallowed the outgoing track's `ended`
    // has to hand that boundary back, or the listener is left in silence.
    expect(run).toMatch(
      /if \(transition !== t \|\| t\.committed\) \{[\s\S]{0,300}?if \(t\.endedSeen\) recoverDeferredAdvance\(t\);[\s\S]{0,80}?return;/,
    );
  });
});

describe("ACCEPTANCE 8 — a track shorter than the crossfade", () => {
  test("a 3s track with a 10s crossfade never fades", () => {
    // 3s < MIN_TRACK_FOR_FADE_SECONDS, so overlapping would destroy it.
    const plan = planTransition({
      crossfadeSeconds: 10,
      gaplessEnabled: true,
      reason: "track-ended",
      currentDuration: 3,
      currentTime: 2.9,
      hasNext: true,
      canCrossfade: true,
      sameAlbum: false,
      abRepeatActive: false,
      repeatOne: false,
      paused: false,
    });
    expect(plan.mode).toBe("gapless");
    expect(plan.seconds).toBe(0);
  });

  test("the fade is clamped so it can never outlast the track", () => {
    expect(clampFade(10, 240, 0.02)).toBe(0);
    expect(clampFade(10, 240, 3)).toBeLessThanOrEqual(2.95);
    expect(clampFade(10, 5, 100)).toBe(0);
  });

  test("the schedule is never negative or NaN", () => {
    const plan = planTransition({
      crossfadeSeconds: 6,
      gaplessEnabled: false,
      reason: "track-ended",
      currentDuration: 240,
      currentTime: 245, // past the reported duration
      hasNext: true,
      canCrossfade: true,
      sameAlbum: false,
      abRepeatActive: false,
      repeatOne: false,
      paused: false,
    });
    expect(Number.isFinite(plan.seconds)).toBe(true);
    expect(plan.seconds).toBeGreaterThanOrEqual(0);
    expect(shouldStartFade(plan, -1, null)).toBe(false);
    expect(shouldStartFade(plan, NaN, null)).toBe(false);
  });
});

describe("ACCEPTANCE 9 — a next track that will not load", () => {
  test("a failed prepare resolves to null instead of throwing", () => {
    const prepare = bodyOf(playerCode, "prepareIncoming");
    expect(prepare.length).toBeGreaterThan(200);
    expect(prepare).toMatch(/return ready\(\)\.catch\(\(\) => null\)/);
  });

  test("a failed incoming leaves the current song playing at full volume", () => {
    const run = bodyOf(playerCode, "maybeRunCrossfade");
    // No pause, no gain change, no deck swap on this path.
    expect(run).toMatch(
      /if \(!started \|\| !transition \|\| transition !== t\) \{[\s\S]{0,300}?cancelTransition\("incoming-failed"\);[\s\S]{0,60}?return;/,
    );
  });

  test("end of track still advances when a transition could not run", () => {
    // The failure path must never be the reason a listener hears nothing.
    const ended = bodyOf(playerCode, "completeEndedTrack");
    expect(ended).toMatch(/cancelTransition\("ended"\);/);
  });

  test("a preload that resolves after the queue moved on is discarded", () => {
    // Otherwise a slow resolver loads a track the listener already skipped past.
    const prepare = bodyOf(playerCode, "prepareIncoming");
    expect(prepare).toMatch(/if \(transition !== t && t\) return null;/);
    expect(prepare).toMatch(
      /if \(transition === t && t\) t\.preparedFor = track\.id;/,
    );
  });
});

describe("ACCEPTANCE 10 — master volume survives a crossfade", () => {
  test("the outgoing deck is not muted by the blend", () => {
    // The blend is a per-deck GainNode multiplier upstream of the EQ, so the
    // element's own volume (the listener's setting) is never overwritten with a
    // fade value.
    const run = bodyOf(playerCode, "maybeRunCrossfade");
    expect(run).not.toMatch(/\.volume = 0\b/);
    expect(run).not.toMatch(/\.muted = true/);
  });

  test("volume is applied to BOTH decks, not just the live one", () => {
    // After a crossfade the live deck changes; applying volume to one element
    // would leave the other at the old level.
    expect(audioCode).toMatch(
      /export function setDeckVolume[\s\S]{0,400}?for \(const slot of \["a", "b"\] as const\)/,
    );
  });

  test("both decks are muted together, for the same reason", () => {
    expect(audioCode).toMatch(
      /export function setDeckMuted[\s\S]{0,400}?for \(const slot of \["a", "b"\] as const\)/,
    );
  });
});

describe("ACCEPTANCE — settings actually reach the engine", () => {
  test("every offered crossfade length is accepted", () => {
    expect([...CROSSFADE_CHOICES]).toEqual([0, 2, 4, 6, 8, 10]);
    for (const seconds of CROSSFADE_CHOICES) {
      expect(normalizeCrossfade(seconds)).toBe(seconds);
    }
  });

  test("changing the length cancels whatever was in flight", () => {
    // A blend scheduled at 10s must not keep running after switching to 2s.
    const set = playerCode.slice(
      playerCode.indexOf("setCrossfade: (seconds: number) => {"),
      playerCode.indexOf("setCrossfade: (seconds: number) => {") + 400,
    );
    expect(set).toMatch(/cancelTransition\("setting-changed"\);/);
  });

  test("gapless and crossfade compose rather than contradict", () => {
    // Crossfade ON + gapless ON: the blend wins for normal transitions, and
    // gapless still governs the cases a blend cannot cover (album boundaries,
    // tracks too short to fade).
    const crossfading = planTransition({
      crossfadeSeconds: 6,
      gaplessEnabled: true,
      reason: "track-ended",
      currentDuration: 240,
      currentTime: 235,
      hasNext: true,
      canCrossfade: true,
      sameAlbum: false,
      abRepeatActive: false,
      repeatOne: false,
      paused: false,
    });
    expect(crossfading.mode).toBe("crossfade");

    // An EXPLICIT crossfade wins even across an album boundary. It used to
    // silently return gapless here, which overrode the listener's own setting
    // with no message, log or UI hint — so crossfade appeared broken on exactly
    // the tracks most likely to be played together. See PHASE 25.
    const albumBoundary = planTransition({
      crossfadeSeconds: 6,
      gaplessEnabled: true,
      reason: "track-ended",
      currentDuration: 240,
      currentTime: 235,
      hasNext: true,
      canCrossfade: true,
      sameAlbum: true,
      abRepeatActive: false,
      repeatOne: false,
      paused: false,
    });
    expect(albumBoundary.mode).toBe("crossfade");
    expect(albumBoundary.because).toContain("explicit crossfade");

    // ...but with NO crossfade configured, the album seam is still preserved.
    const noCrossfadeAlbum = planTransition({
      crossfadeSeconds: 0,
      gaplessEnabled: true,
      reason: "track-ended",
      currentDuration: 240,
      currentTime: 239,
      hasNext: true,
      canCrossfade: true,
      sameAlbum: true,
      abRepeatActive: false,
      repeatOne: false,
      paused: false,
    });
    expect(noCrossfadeAlbum.mode).toBe("gapless");

    // Same album, no gapless either: the tracks simply butt-join.
    expect(
      planTransition({
        crossfadeSeconds: 0,
        gaplessEnabled: false,
        reason: "track-ended",
        currentDuration: 240,
        currentTime: 239,
        hasNext: true,
        canCrossfade: true,
        sameAlbum: true,
        abRepeatActive: false,
        repeatOne: false,
        paused: false,
      }).mode,
    ).toBe("cut");

    const tooShort = planTransition({
      crossfadeSeconds: 6,
      gaplessEnabled: true,
      reason: "track-ended",
      currentDuration: 12,
      currentTime: 11,
      hasNext: true,
      canCrossfade: true,
      sameAlbum: false,
      abRepeatActive: false,
      repeatOne: false,
      paused: false,
    });
    expect(tooShort.mode).toBe("gapless");
  });

  test("repeat one and A-B repeat never blend", () => {
    // Requirement 22: a repeat means "play this again", and a crossfade here
    // would be the same song twice at once.
    const base = {
      crossfadeSeconds: 6,
      gaplessEnabled: true,
      reason: "track-ended",
      currentDuration: 240,
      currentTime: 235,
      hasNext: true,
      canCrossfade: true,
      sameAlbum: false,
      paused: false,
    };
    expect(
      planTransition({ ...base, abRepeatActive: false, repeatOne: true }).mode,
    ).toBe("cut");
    expect(
      planTransition({ ...base, abRepeatActive: true, repeatOne: false }).mode,
    ).toBe("cut");
  });
});

describe("the engine is instrumented for diagnosis, dev only", () => {
  test("a configured crossfade that plans as gapless is never silent", () => {
    // The one case a listener cannot tell apart from a bug: crossfade is ON and
    // the engine is deliberately doing something else. It has to be reported.
    expect(player).toContain('"plan=gapless-despite-crossfade"');
    // The window allows the listener-facing note that now runs first, so this
    // pins the BEHAVIOUR (the branch still traces) rather than the exact
    // statement that happens to follow the `if`.
    expect(playerCode).toMatch(
      /if \(plan\.mode === "gapless" && s\.crossfade > 0\) \{[\s\S]{0,400}?traceTransition\("plan=gapless-despite-crossfade"/,
    );
  });
  test("tracing exists and is gated to development builds", () => {
    // Every one of these failures used to look identical from the UI.
    expect(playerCode).toMatch(
      /const traceTransition = import\.meta\.env\.DEV/,
    );
    for (const event of [
      "armed",
      "blend",
      "complete",
      "refused:no-running-graph",
      "gapless:handoff",
      "gapless:skipped",
    ]) {
      expect(player).toContain(`"${event}"`);
    }
  });
});
