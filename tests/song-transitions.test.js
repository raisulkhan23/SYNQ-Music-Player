import { describe, expect, test } from 'vitest';
import {
  clampFade,
  CROSSFADE_CHOICES,
  DEFAULT_CROSSFADE,
  DEFAULT_GAPLESS,
  fadeGains,
  isPresetCrossfade,
  MAX_FADE_SECONDS,
  MAX_PREP_SECONDS,
  MIN_TRACK_FOR_FADE_SECONDS,
  MANUAL_SKIP_FADE_SECONDS,
  normalizeCrossfade,
  planTransition,
  preloadLead,
  PRELOAD_LEAD_SECONDS,
  shouldStartFade,
} from "../src/lib/transition.ts";
import { readSource } from "./helpers/tailwind-css.js";

/**
 * SYNQ plays through a single <audio> element plus the YouTube IFrame engine.
 * A real crossfade needs the outgoing and incoming songs to be audible at the
 * same time and to have their levels under our control, which is only true
 * when both come from the <audio> element — the IFrame's audio lives in a
 * cross-origin frame Web Audio cannot tap.
 *
 * These tests cover the decisions. Anything that cannot be blended must fall
 * back to gapless or a plain cut, and the guards that must never blend
 * (repeat-one, A-B repeat, paused, nothing queued) are the ones most likely to
 * regress silently.
 */

/** A request with everything permissive, so each test varies one field. */
const base = (over = {}) => ({
  crossfadeSeconds: 6,
  gaplessEnabled: false,
  reason: "track-ended",
  currentDuration: 200,
  currentTime: 0,
  hasNext: true,
  canCrossfade: true,
  sameAlbum: false,
  abRepeatActive: false,
  repeatOne: false,
  paused: false,
  ...over,
});

describe("crossfade settings", () => {
  test("offers Off plus 2–10 second presets", () => {
    expect([...CROSSFADE_CHOICES]).toEqual([0, 2, 4, 6, 8, 10]);
  });

  test("defaults to off and gapless on", () => {
    // A crossfade overlaps two songs and hides an outro, so it is opt-in.
    // Gapless only removes silence that SYNQ itself invented, so it is safe
    // to leave on.
    expect(DEFAULT_CROSSFADE).toBe(0);
    expect(DEFAULT_GAPLESS).toBe(true);
  });

  test("normalizes stored and junk values", () => {
    expect(normalizeCrossfade(6)).toBe(6);
    expect(normalizeCrossfade("8")).toBe(8);
    expect(normalizeCrossfade(-4)).toBe(0);
    expect(normalizeCrossfade(Number.NaN)).toBe(0);
    expect(normalizeCrossfade(undefined)).toBe(0);
    expect(normalizeCrossfade(null)).toBe(0);
    expect(normalizeCrossfade("nonsense")).toBe(0);
  });

  test("caps an absurd stored value instead of honouring it", () => {
    expect(normalizeCrossfade(600)).toBe(MAX_FADE_SECONDS);
  });

  test("treats a sub-perceptible fade as off rather than as a click", () => {
    expect(normalizeCrossfade(0.2)).toBe(0);
  });

  test("recognises the preset lengths", () => {
    for (const c of CROSSFADE_CHOICES) expect(isPresetCrossfade(c)).toBe(true);
    expect(isPresetCrossfade(3)).toBe(false);
  });
});

describe("clampFade", () => {
  test("never fades for more than the absolute cap", () => {
    expect(clampFade(60, 600, 600)).toBe(MAX_FADE_SECONDS);
  });

  test("never outlasts the time remaining", () => {
    expect(clampFade(10, 300, 3)).toBeCloseTo(2.95, 5);
  });

  test("leaves a sliver of the outgoing track audible", () => {
    expect(clampFade(10, 300, 0.02)).toBe(0);
  });

  test("refuses to blend a track that is too short", () => {
    expect(clampFade(6, MIN_TRACK_FOR_FADE_SECONDS - 1, 25)).toBe(0);
  });

  test("allows the full length on a long track with room left", () => {
    expect(clampFade(6, 300, 100)).toBe(6);
  });

  test("an unknown duration does not clamp to nothing", () => {
    // Live radio-style streams report no duration; that must not disable the
    // transition outright.
    expect(clampFade(6, 0, 0)).toBe(6);
  });
});

describe("planTransition guards", () => {
  test("repeat-one never transitions", () => {
    // Repeat-one restarts the SAME song. A blend here would play it twice at
    // once and then hand off to a track the listener never asked for.
    const p = planTransition(base({ repeatOne: true }));
    expect(p.mode).toBe("cut");
    expect(p.seconds).toBe(0);
    expect(p.because).toContain("repeat-one");
  });

  test("A-B repeat is never interrupted", () => {
    const p = planTransition(base({ abRepeatActive: true }));
    expect(p.mode).toBe("cut");
    expect(p.because).toContain("A-B");
  });

  test("paused playback does not transition", () => {
    expect(planTransition(base({ paused: true })).mode).toBe("cut");
  });

  test("an empty queue does not transition", () => {
    expect(planTransition(base({ hasNext: false })).mode).toBe("cut");
  });

  test("cuts when crossfade is off and gapless is off", () => {
    const p = planTransition(
      base({ crossfadeSeconds: 0, gaplessEnabled: false }),
    );
    expect(p.mode).toBe("cut");
    expect(p.seconds).toBe(0);
  });
});

describe("planTransition crossfade", () => {
  test("crossfades when both tracks are on the audio element", () => {
    const p = planTransition(base({ crossfadeSeconds: 6 }));
    expect(p.mode).toBe("crossfade");
    expect(p.seconds).toBe(6);
    // The overlap IS the lead: the blend has to start that long before the end.
    expect(p.leadSeconds).toBe(6);
  });

  test("each supported duration produces that duration", () => {
    for (const seconds of [2, 4, 6, 8, 10]) {
      const p = planTransition(base({ crossfadeSeconds: seconds }));
      expect(p.mode).toBe("crossfade");
      expect(p.seconds).toBe(seconds);
    }
  });

  test("falls back to gapless when the source cannot be blended", () => {
    // The YouTube IFrame engine owns its audio in a cross-origin frame that
    // Web Audio cannot reach, so there is genuinely nothing to fade.
    const p = planTransition(
      base({ canCrossfade: false, gaplessEnabled: true }),
    );
    expect(p.mode).toBe("gapless");
    expect(p.seconds).toBe(0);
    expect(p.leadSeconds).toBe(0);
  });

  test("cuts when the source cannot be blended and gapless is off", () => {
    const p = planTransition(
      base({ canCrossfade: false, gaplessEnabled: false }),
    );
    expect(p.mode).toBe("cut");
    expect(p.because).toContain("cannot be crossfaded");
  });

  test("a very short track is cut rather than half-blended away", () => {
    // A 20s clip blended for 6s would be 30% gone before the new track is
    // audible, which is a cut with extra steps.
    const p = planTransition(
      base({ crossfadeSeconds: 6, currentDuration: 20 }),
    );
    expect(p.mode).not.toBe("crossfade");
  });

  test("a manual skip uses a short blend, not the configured one", () => {
    // Pressing Next means "play it now". A 10s blend would make the button
    // feel broken.
    const p = planTransition(
      base({ crossfadeSeconds: 10, reason: "manual-next", currentTime: 100 }),
    );
    expect(p.mode).toBe("crossfade");
    expect(p.seconds).toBe(MANUAL_SKIP_FADE_SECONDS);
  });

  test("a manual skip still fits when barely any track is left", () => {
    const p = planTransition(
      base({ crossfadeSeconds: 6, reason: "manual-next", currentTime: 199.5 }),
    );
    expect(p.mode).toBe("crossfade");
    expect(p.seconds).toBeLessThan(MANUAL_SKIP_FADE_SECONDS);
  });

  test("previous never takes the end-of-track crossfade path", () => {
    // Going back is a navigation intent. The store's own behaviour (restart
    // the song if past 3s, otherwise step back) owns it.
    const p = planTransition(base({ reason: "manual-prev" }));
    expect(p.mode).toBe("cut");
    expect(p.because).toContain("previous");
  });
});

describe("planTransition gapless", () => {
  test("an album prefers gapless when no crossfade is configured", () => {
    // Albums, live sets and DJ mixes have boundaries the artist recorded.
    // Overlapping two of them destroys the transition they wrote, so with
    // crossfade OFF the boundary is preserved rather than blended.
    const p = planTransition(
      base({ sameAlbum: true, crossfadeSeconds: 0, gaplessEnabled: true }),
    );
    expect(p.mode).toBe("gapless");
    expect(p.because).toContain("album");
  });

  test("an album butt-joins when gapless is off too", () => {
    const p = planTransition(
      base({ sameAlbum: true, crossfadeSeconds: 0, gaplessEnabled: false }),
    );
    expect(p.mode).toBe("cut");
    expect(p.because).toContain("album");
  });

  test("an EXPLICIT crossfade outranks the album boundary", () => {
    // This used to return gapless unconditionally, silently overriding the
    // listener's own setting: crossfade was on in Settings and the app quietly
    // did something else, with no message, log or UI hint. On an album or an
    // imported playlist — the tracks most likely to be played together — that
    // presents as "crossfade is broken".
    const p = planTransition(
      base({ sameAlbum: true, crossfadeSeconds: 10, gaplessEnabled: true }),
    );
    expect(p.mode).toBe("crossfade");
    expect(p.seconds).toBe(10);
    expect(p.leadSeconds).toBe(10);
    expect(p.because).toContain("explicit crossfade");
  });

  test("the explicit crossfade is still clamped on a short album track", () => {
    // Honouring the setting must not mean ignoring the safety clamps.
    const p = planTransition(
      base({
        sameAlbum: true,
        crossfadeSeconds: 10,
        gaplessEnabled: true,
        currentDuration: 20,
        currentTime: 8,
      }),
    );
    expect(p.mode).toBe("gapless");
    expect(p.seconds).toBe(0);
  });

  test("autoplay uses the same transition system as a queued track", () => {
    const queued = planTransition(base({ reason: "track-ended" }));
    const autoplay = planTransition(base({ reason: "autoplay" }));
    expect(autoplay.mode).toBe(queued.mode);
    expect(autoplay.seconds).toBe(queued.seconds);
  });
});

describe("fadeGains", () => {
  test("starts on the outgoing track and ends on the incoming one", () => {
    expect(fadeGains(0).outgoing).toBeCloseTo(1, 6);
    expect(fadeGains(0).incoming).toBeCloseTo(0, 6);
    expect(fadeGains(1).outgoing).toBeCloseTo(0, 6);
    expect(fadeGains(1).incoming).toBeCloseTo(1, 6);
  });

  test("holds constant power through the middle", () => {
    // A LINEAR crossfade of two songs dips ~6dB in the middle, which
    // listeners hear as a dip then a surge. sin/cos keeps the summed power
    // flat instead.
    const mid = fadeGains(0.5);
    expect(mid.outgoing).toBeCloseTo(Math.SQRT1_2, 6);
    expect(mid.incoming).toBeCloseTo(Math.SQRT1_2, 6);
    expect(mid.outgoing ** 2 + mid.incoming ** 2).toBeCloseTo(1, 6);
  });

  test("holds power across the whole blend", () => {
    for (let i = 0; i <= 20; i++) {
      const g = fadeGains(i / 20);
      expect(g.outgoing ** 2 + g.incoming ** 2).toBeCloseTo(1, 6);
    }
  });

  test("is monotonic and clamped at both ends", () => {
    let prevOut = 1;
    let prevIn = 0;
    for (let i = 0; i <= 20; i++) {
      const g = fadeGains(i / 20);
      expect(g.outgoing).toBeLessThanOrEqual(prevOut + 1e-9);
      expect(g.incoming).toBeGreaterThanOrEqual(prevIn - 1e-9);
      prevOut = g.outgoing;
      prevIn = g.incoming;
    }
    for (const t of [-5, -0.001, 1.001, 42]) {
      const g = fadeGains(t);
      expect(g.outgoing).toBeGreaterThanOrEqual(0);
      expect(g.outgoing).toBeLessThanOrEqual(1);
      expect(g.incoming).toBeGreaterThanOrEqual(0);
      expect(g.incoming).toBeLessThanOrEqual(1);
    }
  });

  test("a nonsense progress cannot produce a bad gain", () => {
    for (const t of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const g = fadeGains(t);
      expect(Number.isFinite(g.outgoing)).toBe(true);
      expect(Number.isFinite(g.incoming)).toBe(true);
    }
  });
});

describe("shouldStartFade", () => {
  const crossfade = {
    mode: "crossfade",
    seconds: 6,
    leadSeconds: 6,
    reason: "track-ended",
    because: "",
  };

  test("does not fire early", () => {
    expect(shouldStartFade(crossfade, 30, 31)).toBe(false);
  });

  test("fires exactly on the boundary", () => {
    expect(shouldStartFade(crossfade, 5.9, 6.1)).toBe(true);
  });

  test("fires only once even if the poll lands late", () => {
    // timeupdate can skip seconds on a slow device. Re-firing would stack a
    // second blend on top of the first — two songs audible at once.
    expect(shouldStartFade(crossfade, 4, 4)).toBe(false);
    expect(shouldStartFade(crossfade, 2, 2)).toBe(false);
  });

  test("fires when the previous sample is unknown", () => {
    expect(shouldStartFade(crossfade, 5, null)).toBe(true);
  });

  test("never fires for a cut plan", () => {
    const cut = { ...crossfade, mode: "cut", seconds: 0, leadSeconds: 0 };
    expect(shouldStartFade(cut, 0, 10)).toBe(false);
  });

  test("never fires for gapless, which has no overlap to start", () => {
    const gapless = { ...crossfade, mode: "gapless", leadSeconds: 0 };
    expect(shouldStartFade(gapless, 0, 10)).toBe(false);
  });

  test("ignores a non-finite position", () => {
    expect(shouldStartFade(crossfade, Number.NaN, 10)).toBe(false);
  });
});

describe("preloadLead", () => {
  test("prepares the next track before the blend needs it", () => {
    const lead = preloadLead({
      mode: "crossfade",
      seconds: 6,
      leadSeconds: 6,
      reason: "track-ended",
      because: "",
    });
    expect(lead).toBe(6 + PRELOAD_LEAD_SECONDS);
  });

  test("never prepares earlier than the cap", () => {
    const lead = preloadLead({
      mode: "crossfade",
      seconds: MAX_FADE_SECONDS,
      leadSeconds: MAX_FADE_SECONDS,
      reason: "track-ended",
      because: "",
    });
    expect(lead).toBe(MAX_PREP_SECONDS);
  });

  test("prepares nothing for gapless or a cut", () => {
    expect(
      preloadLead({
        mode: "gapless",
        seconds: 0,
        leadSeconds: 0,
        reason: "track-ended",
        because: "",
      }),
    ).toBe(0);
    expect(
      preloadLead({
        mode: "cut",
        seconds: 0,
        leadSeconds: 0,
        reason: "track-ended",
        because: "",
      }),
    ).toBe(0);
  });
});

// --- integration with the real store and audio module -------------------------

const playerSource = readSource("src/store/player.ts");
const audioSource = readSource("src/lib/audio.ts");
const settingsSource = readSource("src/components/settings/SettingsDialog.tsx");

describe("crossfade is built on two real audio decks", () => {
  test("a second <audio> element exists — one element cannot overlap itself", () => {
    // This is the whole mechanism. Without a second element a crossfade is
    // only ever a UI animation.
    expect(audioSource).toMatch(/function createDeckElement\(\)/);
    expect(audioSource).toMatch(/__ssAudioSpare/);
  });

  test("each deck gets its own MediaElementSource and gain", () => {
    // The spec allows ONE MediaElementSource per ELEMENT, so two elements may
    // each have exactly one — that is what lets both songs be live at once.
    expect(audioSource).toMatch(/createMediaElementSource\(d\[slot\]\.el\)/);
    expect(audioSource).toMatch(/deck\.gain = audioCtx\.createGain\(\)/);
  });

  test("the transition gain sits before the EQ, not on the user's volume", () => {
    // The spec requires master volume to stay independent of the transition,
    // so the blend gain is a separate node feeding the head of the chain.
    expect(audioSource).toMatch(/deck\.gain\.connect\(eqBassNode\)/);
    expect(audioSource).toMatch(/getAudio\(\)\.volume = /);
  });

  test("both decks feed the same EQ / balance / effects chain", () => {
    expect(audioSource).toMatch(/gainOut\.connect\(analyser\)/);
    expect(audioSource).toMatch(/filterSource = d\[activeDeck\]\.source/);
  });

  test("the chain reaches the speakers BEFORE any element is captured", () => {
    // `createMediaElementSource` permanently diverts an element's output into
    // the graph, so capturing before `destination` is wired risks a captured
    // element feeding nothing — silent playback with the progress bar still
    // running. `tests/audio-graph-resilience.test.js` proves it by execution;
    // this pins the ordering in the source so the two agree.
    const wired = audioSource.indexOf("analyser.connect(audioCtx.destination)");
    const captured = audioSource.indexOf("createMediaElementSource(");
    expect(wired).toBeGreaterThan(-1);
    expect(captured).toBeGreaterThan(-1);
    expect(wired).toBeLessThan(captured);
  });

  test("the fade is scheduled as Web Audio automation, not stepped", () => {
    // Stepping gain once per timeupdate is what produces clicks and zipper
    // noise; scheduled automation moves the gain every sample.
    // The SAMPLED curve is what must reach the graph: between the curve's
    // endpoints `linearRampToValueAtTime` is a straight line — the very blend
    // the equal-power curve exists to replace. `transition-execution.test.js`
    // executes `scheduleCrossfade` and asserts the curve is applied, so this
    // only pins that no regression swaps it back for a plain ramp.
    expect(audioSource).toMatch(/setValueCurveAtTime\(outCurve/);
    expect(audioSource).toMatch(/gain\.cancelScheduledValues/);
  });

  test("a suspended context refuses the fade instead of fading to silence", () => {
    expect(audioSource).toMatch(/ctx\.state !== "running"/);
    expect(audioSource).toMatch(/export function canCrossfadeNow\(\)/);
  });

  test("the outgoing deck is released after a transition", () => {
    // Otherwise a decoded stream and a network connection stay alive for the
    // whole session — a slow leak across an evening of listening.
    expect(audioSource).toMatch(/export function releaseDeck/);
    expect(audioSource).toMatch(/removeAttribute\("src"\)/);
    expect(playerSource).toMatch(/releaseDeck\(outgoingSlot\)/);
  });

  test("a released deck can never be the live one", () => {
    expect(audioSource).toMatch(/if \(slot === activeDeck\) return;/);
  });
});

describe("only one transition can run at a time", () => {
  test("arming is refused while another transition is live", () => {
    expect(playerSource).toMatch(
      /if \(transition\?\.armed \|\| transition\?\.running\) return;/,
    );
  });

  test("a started transition is marked running before anything else happens", () => {
    expect(playerSource).toMatch(/t\.running = true;/);
  });

  test("rapid Next presses abandon the running blend first", () => {
    // Pressing Next twice must not stack two blends: the in-flight one is
    // cancelled FIRST, then the short manual blend is armed. The advance
    // itself is deferred behind the blend (see `runManualBlend`) because the
    // old code called `playIndex` immediately, tearing the current track down
    // before the blend could run — which is why manual Next never faded.
    expect(playerSource).toMatch(
      /const next = \(\) => \{[\s\S]{0,1200}?cancelTransition\("manual-next"\);[\s\S]{0,1200}?runManualBlend\(advance\)/,
    );
    // The blend is bounded, so a stuck transition can never eat the button.
    expect(playerSource).toMatch(
      /async function runManualBlend[\s\S]{0,2000}?if \(transition === t\) \{[\s\S]{0,200}?cancelTransition\("manual-budget"\);[\s\S]{0,120}?advance\(\);/,
    );
    // A COMMITTED blend already advanced through `commitCrossfadeAdvance`, so
    // the trailing `advance()` had to be skipped — otherwise Next faded into
    // the next song and then skipped straight past it (the queue moved twice).
    expect(playerSource).toMatch(
      /async function runManualBlend[\s\S]{0,2000}?if \(t\.committed\) return;[\s\S]{0,300}?advance\(\);/,
    );
  });

  test("changing the crossfade length cancels what is in flight", () => {
    expect(playerSource).toMatch(
      /setCrossfade[\s\S]{0,400}?cancelTransition\("setting-changed"\)/,
    );
  });

  test("previous cancels any blend but never starts one", () => {
    expect(playerSource).toMatch(
      /const prev = \(\) => \{[\s\S]{0,400}?cancelTransition\("manual-prev"\);/,
    );
  });
});

describe("pause, seek and sleep stop BOTH decks", () => {
  test("pausing silences the incoming deck too", () => {
    // A crossfade has two songs audible. Pausing only the live deck left the
    // incoming one playing under a "paused" UI, and resuming brought both back
    // together at once.
    expect(audioSource).toMatch(/export function pauseAllDecks\(\)/);
    expect(playerSource).toMatch(
      /cancelTransition\("pause"\);\s*\n\s*pauseAllDecks\(\);/,
    );
  });

  test("resuming does not restart a half-finished blend", () => {
    expect(playerSource).toMatch(
      /if \(audio\.paused\) \{[\s\S]{0,400}?cancelTransition\("resume"\);/,
    );
  });

  test("the sleep timer stops the music outright", () => {
    expect(playerSource).toMatch(
      /if \(s\.sleepAtSongEnd\) \{[\s\S]{0,200}?pauseAllDecks\(\);/,
    );
    expect(playerSource).toMatch(/sleepEndsAt: null, isPlaying: false/);
  });

  test("seeking abandons the transition rather than leaving a stray song", () => {
    expect(playerSource).toMatch(
      /if \(!Number\.isFinite\(time\)\) return;\s*\n\s*\/\/[\s\S]{0,200}?cancelTransition\("seek"\);/,
    );
  });

  test("switching to repeat-one cancels a blend in flight", () => {
    // Repeat-one restarts the same track; a blend running into it would play
    // the song twice at once.
    expect(playerSource).toMatch(
      /const cycleRepeat[\s\S]{0,400}?cancelTransition\("repeat-changed"\);/,
    );
  });

  test("clearing the queue cancels a transition targeting a removed track", () => {
    expect(playerSource).toMatch(
      /clearQueue: \(\) => \{[\s\S]{0,200}?cancelTransition\("queue-cleared"\);/,
    );
  });
});

describe("failure always falls back to normal playback", () => {
  test("a failed incoming track leaves the current song playing", () => {
    // The listener must never be left in silence because a transition failed.
    expect(playerSource).toMatch(
      /cancelTransition\("incoming-failed"\);\s*return;/,
    );
  });

  test("a refused or unavailable graph cancels rather than half-fading", () => {
    expect(playerSource).toMatch(/cancelTransition\("no-running-graph"\)/);
    expect(playerSource).toMatch(/cancelTransition\("automation-refused"\)/);
  });

  test("a stream that will not resolve returns null instead of throwing", () => {
    expect(playerSource).toMatch(/return ready\(\)\.catch\(\(\) => null\)/);
  });

  test("end of track always advances, armed transition or not", () => {
    // The fallback path has to remain the original behaviour. It now lives in
    // `completeEndedTrack`, which `handleEnded` delegates to and which a
    // deferred-then-abandoned blend calls back into.
    expect(playerSource).toMatch(
      /function completeEndedTrack\(\)[\s\S]{0,2500}?cancelTransition\("ended"\);/,
    );
    // ...and the gapless attempt runs before that cancel, and only reports
    // success when the incoming track is genuinely buffered and ready.
    expect(playerSource).toMatch(
      /function completeEndedTrack\(\)[\s\S]{0,2500}?if \(tryGaplessHandoff\(\)\) return;/,
    );
    // The gate itself is executed in `transition-execution.test.js`; here we
    // only pin that the hand-off consults it and bails when it says no.
    expect(playerSource).toMatch(
      /function tryGaplessHandoff[\s\S]{0,2000}?canHandOffGapless\(\{[\s\S]{0,600}?if \(!readiness\.ready\) \{[\s\S]{0,300}?return false;/,
    );
  });
});

describe("queue and playback state stay correct", () => {
  test("a completed crossfade does not advance the queue a second time", () => {
    // The old element still fires `ended` at the natural boundary. Without
    // this guard the listener skips a track and the queue index points at a
    // song they never heard.
    expect(playerSource).toMatch(
      /function handleEnded\(\)[\s\S]{0,900}?if \(t\?\.committed\)[\s\S]{0,300}?return;/,
    );
  });

  test("a crossfaded load does not reassign src and restart the song", () => {
    expect(playerSource).toMatch(/if \(opts\?\.deckAlreadyPlaying\) \{/);
    expect(playerSource).toMatch(
      /loadTrack\(s\.queue\[index\], undefined, \{ deckAlreadyPlaying: true \}\)/,
    );
  });

  test("the store's listeners follow the deck swap", () => {
    // Without re-binding, position, buffering and end-of-track would keep
    // coming from the element that just went silent.
    expect(playerSource).toMatch(/onActiveDeckChange\(\(next\) => \{/);
    expect(playerSource).toMatch(/bindAudioDeck\(getAudio\(\)\)/);
  });

  test("listeners ignore events from a deck that is no longer live", () => {
    expect(playerSource).toMatch(
      /const live = \(\) => audio === getAudio\(\);/,
    );
  });

  test("the next-track peek agrees with how the queue actually advances", () => {
    // If these disagree, SYNQ fades into one song and then plays another.
    const peek = playerSource.slice(
      playerSource.indexOf("function peekNextTrack"),
      playerSource.indexOf("function crossfadePossible"),
    );
    expect(peek).toMatch(/pickShuffleIndex/);
    expect(peek).toMatch(/s\.repeat === "all"/);
    expect(peek).toMatch(/s\.queueIndex \+ 1/);
  });

  test("only one track is ever prepared ahead", () => {
    expect(playerSource).toMatch(/const el = getSpareAudio\(\);/);
  });
});

describe("settings use the existing storage system", () => {
  test("both settings persist through the existing ss.* writer", () => {
    expect(playerSource).toMatch(
      /writeSetting\("ss\.crossfade", String\(next\)\)/,
    );
    expect(playerSource).toMatch(
      /writeSetting\("ss\.gapless", state\.gapless \? "0" : "1"\)/,
    );
  });

  test("changing either setting cancels any armed transition under the old setting", () => {
    expect(playerSource).toMatch(
      /cancelTransition\("setting-changed"\)/,
    );
    expect(playerSource).toMatch(
      /cancelTransition\("gapless-toggled"\)/,
    );
  });

  test("both settings restore on startup", () => {
    expect(playerSource).toMatch(
      /normalizeCrossfade\(\s*readNum\("ss\.crossfade", DEFAULT_CROSSFADE\),\s*\)/,
    );
    expect(playerSource).toMatch(/readBool\("ss\.gapless", DEFAULT_GAPLESS\)/);
  });

  test("the setting lives in the existing Audio section, not a new page", () => {
    expect(settingsSource).toMatch(/Crossfade/);
    expect(settingsSource).toMatch(/Gapless playback/);
    expect(settingsSource).toMatch(/CROSSFADE_CHOICES\.map/);
    expect(settingsSource).toMatch(/id="settings-audio"/);
  });

  test("the current crossfade value is shown", () => {
    expect(settingsSource).toMatch(
      /\{crossfade === 0 \? "Off" : `\$\{crossfade\}s`\}/,
    );
  });

  test("the radio group is labelled and reports its selection", () => {
    // Accessibility: the control must announce its value, not rely on colour.
    expect(settingsSource).toMatch(/role="radiogroup"/);
    expect(settingsSource).toMatch(/aria-label="Crossfade duration"/);
    expect(settingsSource).toMatch(/aria-checked=\{crossfade === seconds\}/);
  });
});

describe("existing player behaviour is preserved", () => {
  test("volume, mute and rate reach both decks", () => {
    // After a crossfade the idle deck already holds the next song; a setting
    // that missed it would silently apply to the wrong track.
    expect(playerSource).toMatch(/setDeckVolume\(v\)/);
    expect(playerSource).toMatch(/setDeckMuted\(nextMuted\)/);
    expect(playerSource).toMatch(/setDeckRate\(r\)/);
  });

  test("the master volume is never used as the transition volume", () => {
    // The blend is a separate GainNode per deck; the listener's volume setting
    // is untouched by a transition and survives it.
    expect(playerSource).toMatch(/incoming\.volume = s\.volume;/);
  });

  test("previous keeps its restart-if-past-3s behaviour", () => {
    expect(playerSource).toMatch(
      /const prev = \(\) => \{[\s\S]{0,300}?if \(s\.currentTime > 3\) \{\s*s\.seek\(0\);/,
    );
  });

  test("a crossfade is refused while the YouTube engine owns the sound", () => {
    // The IFrame's audio is in a cross-origin frame Web Audio cannot tap, so
    // claiming to crossfade it would be exactly the fake the spec forbids.
    expect(playerSource).toMatch(
      /function crossfadePossible[\s\S]{0,300}?if \(!audioElementIsSource\(current\)\) return false;/,
    );
  });
});
