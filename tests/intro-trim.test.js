import { describe, expect, test } from 'vitest';
import { readSource } from "./helpers/tailwind-css.js";
// introTrim.ts has no imports, so the decision logic is tested for real.
import {
  clampIntroSkip,
  DEFAULT_INTRO_TRIM_OPTIONS,
  detectIntroEnd,
  formatSkipped,
  SILENCE_FLOOR,
} from "../src/lib/introTrim.ts";

/**
 * Smart intro trim.
 *
 * Long cinematic uploads open with up to a minute of near-silence. These tests
 * pin the DECISION — the part that, if wrong, annoys people by jumping them
 * into the middle of a song — and then the wiring that carries it out.
 */

const hook = readSource("src/components/player/useIntroTrim.ts");
const store = readSource("src/store/player.ts");
const playerBar = readSource("src/components/player/PlayerBar.tsx");
const settings = readSource("src/components/settings/SettingsDialog.tsx");
const appShell = readSource("src/components/layout/AppShell.tsx");

const flat = (s) => s.replace(/\s+/g, " ");

/**
 * A synthetic level series: `leadSeconds` of near-silence followed by the
 * actual track, sampled at the real probe interval.
 */
function series(
  leadSeconds,
  { interval = 0.25, quiet = 0.001, loud = 0.2, tail = 40 } = {},
) {
  const out = [];
  for (let t = 0; t < leadSeconds; t += interval) {
    out.push({ t: Number(t.toFixed(2)), level: quiet });
  }
  for (let t = leadSeconds; t < leadSeconds + tail; t += interval) {
    out.push({ t: Number(t.toFixed(2)), level: loud });
  }
  return out;
}

describe("detectIntroEnd", () => {
  test("finds a long quiet lead-in and proposes skipping past it", () => {
    const skip = detectIntroEnd(series(40));
    // The intro ends at 40s; the detector reports the start of the content,
    // minus the sustain it had to hear first.
    expect(skip).toBeGreaterThan(35);
    expect(skip).toBeLessThanOrEqual(40);
  });

  test("handles the 60s cinematic lead-in from the feature request", () => {
    const skip = detectIntroEnd(series(60));
    expect(skip).toBeGreaterThan(55);
  });

  test("leaves a track that starts immediately alone", () => {
    expect(detectIntroEnd(series(0))).toBe(0);
  });

  test("ignores a short fade-in rather than seeking for a fraction of a second", () => {
    // Below minSkipSeconds a seek costs more than it saves.
    expect(detectIntroEnd(series(3))).toBe(0);
  });

  test("is not fooled by a single spike in a quiet intro", () => {
    // A door slam is one loud sample, not a sustained start.
    const samples = series(40);
    const spikeAt = samples.findIndex((s) => s.t > 20);
    samples[spikeAt] = { t: samples[spikeAt].t, level: 0.9 };
    expect(detectIntroEnd(samples)).toBeGreaterThan(35);
  });

  test("still trims when the lead-in is quiet rather than digitally silent", () => {
    // Cinematic intros are usually an ambient bed, not zeros. A clear step up
    // in level is still a lead-in worth skipping.
    expect(detectIntroEnd(series(40, { quiet: 0.03 }))).toBeGreaterThan(35);
  });

  test("leaves a track alone when the level never steps up decisively", () => {
    // A modest 3x lift is normal dynamics, not an intro. Guessing here is
    // worse than missing a trim, so the detector declines.
    expect(detectIntroEnd(series(40, { quiet: 0.05, loud: 0.15 }))).toBe(0);
  });

  test("handles an intro that is digital silence", () => {
    // A true zero floor must not collapse the threshold to zero and read the
    // whole track as content.
    expect(detectIntroEnd(series(40, { quiet: 0 }))).toBeGreaterThan(35);
  });

  test("never skips past the configured maximum", () => {
    const skip = detectIntroEnd(series(200));
    expect(skip).toBeLessThanOrEqual(DEFAULT_INTRO_TRIM_OPTIONS.maxSkipSeconds);
  });

  test("returns 0 on a window that never goes quiet", () => {
    // All-loud: the run is already in progress at the first considered sample,
    // which is not an intro.
    const loud = Array.from({ length: 200 }, (_, i) => ({
      t: i * 0.25,
      level: 0.3,
    }));
    expect(detectIntroEnd(loud)).toBe(0);
  });

  test("returns 0 when there is not enough evidence", () => {
    expect(detectIntroEnd([])).toBe(0);
    expect(detectIntroEnd([{ t: 0, level: 0 }])).toBe(0);
    // Everything inside the priming head is ignored, so a very short probe
    // leaves nothing to judge.
    expect(detectIntroEnd([{ t: 0.25, level: 0.001 }])).toBe(0);
  });

  test("uses the same silence bar the player already uses for 'audio is flowing'", () => {
    // Keeps the meaning of "audible" identical across the two features.
    expect(SILENCE_FLOOR).toBe(0.004);
  });

  test("declines when the whole probe window sits inside the priming head", () => {
    // There is no evidence of an intro here at all, so no evidence means no
    // seek.
    const samples = [
      { t: 0, level: 0 },
      { t: 1, level: 0 },
      { t: 20, level: 0.3 },
      { t: 25, level: 0.3 },
      { t: 30, level: 0.3 },
    ];
    expect(detectIntroEnd(samples)).toBe(0);
  });
});

describe("clampIntroSkip", () => {
  test("keeps a manual skip inside the track", () => {
    expect(clampIntroSkip(30, 200)).toBe(30);
    // A 20s song cannot be trimmed by 30s.
    expect(clampIntroSkip(30, 20)).toBe(19);
  });

  test("never exceeds the automatic maximum", () => {
    expect(clampIntroSkip(300, 3600)).toBe(
      DEFAULT_INTRO_TRIM_OPTIONS.maxSkipSeconds,
    );
  });

  test("rejects nonsense input instead of seeking to NaN", () => {
    expect(clampIntroSkip(NaN, 200)).toBe(0);
    expect(clampIntroSkip(-50, 200)).toBe(0);
  });
});

describe("formatSkipped", () => {
  test("renders seconds, minutes, and minutes with a remainder", () => {
    expect(formatSkipped(42)).toBe("42s");
    expect(formatSkipped(60)).toBe("1m");
    expect(formatSkipped(72)).toBe("1m 12s");
  });
});

describe("intro trim wiring", () => {
  test("the setting is a persisted store preference", () => {
    expect(store).toContain("introTrim: boolean");
    expect(store).toContain('readBool("ss.introTrim", false)');
    expect(store).toContain('writeSetting("ss.introTrim"');
  });

  test("the per-track trim result resets when the track changes", () => {
    // Otherwise the chip from song N would still claim song N+1 was trimmed.
    const occurrences = store.split("introTrimSkipped: null").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(4);
  });

  test("skipping seeks and reports how far it went", () => {
    const fn = store.slice(store.indexOf("const skipIntro = "));
    expect(fn).toContain("clampIntroSkip(");
    expect(fn).toContain("seek(skip)");
    expect(fn).toContain("return skip");
  });

  test("pressing skip again walks further into a long intro", () => {
    const fn = store.slice(store.indexOf("const skipIntro = "));
    expect(fn).toContain("s.introTrimSkipped * 2");
  });

  test("undo puts the playhead back at the start", () => {
    const fn = store.slice(store.indexOf("const undoIntroTrim = "));
    expect(fn).toContain("seek(0)");
  });

  test("the probe samples the analyser and defers to the pure decision", () => {
    expect(hook).toContain("export function useIntroTrim");
    expect(hook).toContain("getSignalLevel()");
    expect(hook).toContain("detectIntroEnd(samples.current)");
    expect(hook).toContain("INTRO_SAMPLE_INTERVAL_MS");
  });

  test("the probe gives up rather than sampling forever", () => {
    expect(hook).toContain("DEFAULT_INTRO_TRIM_OPTIONS.maxSkipSeconds");
    expect(hook).toContain("clearInterval(timer)");
  });

  test("an unavailable analyser is reported once, not spammed", () => {
    expect(hook).toContain("GRAPH_GRACE_MS");
    expect(hook).toContain("if (!warned");
  });

  test("the probe restarts for a new track instead of reusing its levels", () => {
    // Reusing them would make the next song look like it had already passed
    // its own intro.
    expect(hook).toContain("lastTrackId");
    expect(hook).toContain("samples.current = []");
  });

  test("the probe is mounted app-wide", () => {
    expect(appShell).toContain("<IntroTrimProbe />");
    expect(appShell).toContain("useIntroTrim();");
  });

  test("the player bar can skip manually and undo", () => {
    expect(playerBar).toContain("function IntroTrimChip");
    expect(playerBar).toContain("skipIntro()");
    expect(playerBar).toContain("undoIntroTrim()");
    // The chip is icon-only in the bar, so the figure it trimmed is carried by
    // an accessible label rather than by visible text.
    expect(playerBar).toContain("Intro trimmed by ${formatSkipped(skipped)}");
  });

  test("the icon is present even when smart trim is off", () => {
    // Removing the pill's TEXT was the request. Removing the control entirely
    // was not: the chip used to return null unless smart trim was enabled, and
    // smart trim defaults to OFF, so for most listeners there was no button at
    // all — which reads as the button having been deleted.
    const chip = playerBar.slice(
      playerBar.indexOf("function IntroTrimChip()"),
      playerBar.indexOf("function ReadingSessionNav()"),
    );
    // The only bail-out left is "nothing is playing".
    expect(chip).toMatch(/if \(!hasTrack\) return null;/);
    expect(chip).not.toMatch(/if \(!introTrim \|\| !inIntro\) return null;/);
    // With smart trim off the same icon turns it on, so the control is not a
    // dead button either.
    expect(chip).toMatch(/if \(!introTrim\) \{/);
    expect(chip).toContain('aria-label="Turn on smart intro trim"');
    expect(chip).toMatch(/toggleIntroTrim\(\);/);
  });

  test("the probe never samples a track the graph cannot hear", () => {
    // The analyser lives inside the Web Audio graph. A track playing through
    // the YouTube IFrame puts nothing into that graph, so it reads digital
    // silence — indistinguishable from a genuinely quiet intro. The probe
    // then treated the first real audio (once the stream swapped onto the
    // deck) as the start of the track and seeked the listener 8s+ into a song
    // that had been playing all along. That is the "sometimes it bugs out the
    // player" report.
    expect(hook).toMatch(/import \{[^}]*soundIsOnAudioElement[^}]*\} from/);
    expect(hook).toMatch(/if \(!soundIsOnAudioElement\(\)\) return;/);
    // It must bail BEFORE reading the level, or the false silence is already
    // in the sample series.
    const guard = hook.indexOf("if (!soundIsOnAudioElement()) return;");
    const read = hook.indexOf("const level = getSignalLevel();");
    expect(guard).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(read);
    // ...and the predicate must exist and be exported for the hook to use.
    expect(store).toMatch(/export function soundIsOnAudioElement\(\)/);
  });

  test("the icon stays visible once the intro has passed", () => {
    // Otherwise the control appeared for the first 60s of a song and vanished,
    // which is indistinguishable from it being broken.
    const chip = playerBar.slice(
      playerBar.indexOf("function IntroTrimChip()"),
      playerBar.indexOf("function ReadingSessionNav()"),
    );
    expect(chip).toMatch(/if \(!inIntro\) \{/);
    expect(chip).toContain('aria-label="Smart intro trim is on"');
  });

  test("settings exposes the toggle and builds the audio graph on the click", () => {
    // An AudioContext can only be created inside a user gesture, and this
    // click is the one the feature gets.
    expect(settings).toContain("Smart intro trim");
    expect(flat(settings)).toContain("if (!introTrim) ensureGraph()");
  });
});
