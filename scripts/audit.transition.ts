/**
 * Audit harness for SYNQ's PURE transition engine (`src/lib/transition.ts`).
 *
 *   bun scripts/audit.transition.ts
 *
 * The crossfade/gapless rules are the part most likely to regress quietly: a
 * wrong guard means the app silently plays one track after another with no
 * blend and nothing on screen saying why. This executes every decision the
 * scheduler relies on, with hostile inputs, and exits non-zero on any failure.
 */

import {
  MAX_FADE_SECONDS,
  MAX_PREP_SECONDS,
  MIN_TRACK_FOR_FADE_SECONDS,
  GAPLESS_PRELOAD_LEAD_SECONDS,
  MANUAL_SKIP_FADE_SECONDS,
  DEFAULT_CROSSFADE,
  canHandOffGapless,
  clampFade,
  fadeGains,
  isPresetCrossfade,
  normalizeCrossfade,
  planTransition,
  preloadLead,
  prepareLead,
  shouldStartFade,
  shouldStartNow,
  type TransitionRequest,
} from "../src/lib/transition";

let pass = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = "") {
  if (cond) pass++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function eq<T>(name: string, actual: T, expected: T) {
  check(
    name,
    Object.is(actual, expected),
    `got ${String(actual)}, want ${String(expected)}`,
  );
}

function near(name: string, actual: number, expected: number, eps = 1e-9) {
  check(
    name,
    Math.abs(actual - expected) <= eps,
    `got ${actual}, want ~${expected}`,
  );
}

/** A request with sane defaults; override what each case is about. */
function req(over: Partial<TransitionRequest> = {}): TransitionRequest {
  return {
    crossfadeSeconds: 6,
    gaplessEnabled: true,
    reason: "track-ended",
    currentDuration: 240,
    currentTime: 200,
    hasNext: true,
    canCrossfade: true,
    sameAlbum: false,
    abRepeatActive: false,
    repeatOne: false,
    paused: false,
    ...over,
  };
}

// ------------------------------------------------------------- normalizeCrossfade
eq("normalize 0 stays off", normalizeCrossfade(0), 0);
eq("normalize negative is off", normalizeCrossfade(-4), 0);
eq("normalize NaN is off", normalizeCrossfade(NaN), 0);
eq("normalize string", normalizeCrossfade("6"), 6);
eq("normalize above max clamps", normalizeCrossfade(99), MAX_FADE_SECONDS);
eq("sub-perceptible is off", normalizeCrossfade(0.3), 0);
eq("rounds to a tenth", normalizeCrossfade(6.456), 6.5);
eq(
  "default crossfade is a valid off value",
  normalizeCrossfade(DEFAULT_CROSSFADE),
  DEFAULT_CROSSFADE,
);
check("6s is a preset", isPresetCrossfade(6));
check("7s is not a preset", !isPresetCrossfade(7));

// ------------------------------------------------------------- clampFade
eq(
  "fade never swallows a short clip",
  clampFade(6, MIN_TRACK_FOR_FADE_SECONDS - 1, 20),
  0,
);
eq("fade clamps to the max", clampFade(99, 240, 200), MAX_FADE_SECONDS);
eq("fade leaves a sliver when little remains", clampFade(6, 240, 3), 2.95);
eq("fade of zero is zero", clampFade(0, 240, 200), 0);
eq("fade with unknown duration still clamps", clampFade(6, NaN, 200), 6);

// ------------------------------------------------------------- planTransition guards
{
  const p = planTransition(req({ repeatOne: true }));
  eq("repeat-one never crossfades", p.mode, "cut");

  const ab = planTransition(req({ abRepeatActive: true }));
  eq("A-B repeat never crossfades", ab.mode, "cut");

  const paused = planTransition(req({ paused: true }));
  eq("paused never crossfades", paused.mode, "cut");

  const none = planTransition(req({ hasNext: false }));
  eq("nothing queued is a cut", none.mode, "cut");
}

// ------------------------------------------------------------- planTransition modes
{
  const cross = planTransition(req());
  eq("normal track-ended crossfades", cross.mode, "crossfade");
  eq("crossfade uses the configured seconds", cross.seconds, 6);
  eq("crossfade lead equals its length", cross.leadSeconds, 6);
}
{
  const manual = planTransition(req({ reason: "manual-next" }));
  eq("manual next crossfades", manual.mode, "crossfade");
  eq(
    "manual next uses the short blend",
    manual.seconds,
    Math.min(6, MANUAL_SKIP_FADE_SECONDS),
  );
  check("manual next starts immediately", shouldStartNow(manual));
}
{
  const prev = planTransition(req({ reason: "manual-prev" }));
  eq("previous never takes the fade path", prev.mode, "cut");
}
{
  // A configured crossfade the source cannot perform degrades honestly.
  const g = planTransition(req({ canCrossfade: false, gaplessEnabled: true }));
  eq("no-capability falls back to gapless", g.mode, "gapless");
  const c = planTransition(req({ canCrossfade: false, gaplessEnabled: false }));
  eq("no-capability, no-gapless is a cut", c.mode, "cut");
}
{
  // Album boundary: explicit crossfade WINS; otherwise preserve the seam.
  const withFade = planTransition(req({ sameAlbum: true, crossfadeSeconds: 6 }));
  eq("explicit crossfade overrides album seam", withFade.mode, "crossfade");
  const noFade = planTransition(req({ sameAlbum: true, crossfadeSeconds: 0 }));
  eq("album seam is gapless when no fade", noFade.mode, "gapless");
  const noFadeNoGapless = planTransition(
    req({ sameAlbum: true, crossfadeSeconds: 0, gaplessEnabled: false }),
  );
  eq("album seam is a cut with nothing configured", noFadeNoGapless.mode, "cut");
}

// ------------------------------------------------------------- short-track handling
{
  // Duration shorter than the fade: must not produce a negative/absurd fade.
  const short = planTransition(
    req({ currentDuration: 3, currentTime: 0, crossfadeSeconds: 6 }),
  );
  check(
    "short track never crossfades",
    short.mode !== "crossfade",
    `mode=${short.mode}`,
  );
  check("short track has no negative timing", short.seconds >= 0);
}

// ------------------------------------------------------------- fadeGains (equal power)
{
  const a = fadeGains(0);
  near("fade start: outgoing full", a.outgoing, 1);
  near("fade start: incoming silent", a.incoming, 0);
  const b = fadeGains(1);
  near("fade end: outgoing silent", b.outgoing, 0, 1e-12);
  near("fade end: incoming full", b.incoming, 1, 1e-12);
  const m = fadeGains(0.5);
  near("midpoint is equal-power", m.outgoing, Math.SQRT1_2, 1e-9);
  near("midpoint is equal-power (in)", m.incoming, Math.SQRT1_2, 1e-9);
  // Constant summed power is the whole point of sin/cos over linear.
  let worst = 0;
  for (let i = 0; i <= 100; i++) {
    const g = fadeGains(i / 100);
    worst = Math.max(worst, Math.abs(g.outgoing ** 2 + g.incoming ** 2 - 1));
  }
  check("summed power is constant across the fade", worst < 1e-9, `${worst}`);
  near("clamps below zero", fadeGains(-3).outgoing, 1);
  near("clamps above one", fadeGains(9).incoming, 1);
  near("NaN treated as start", fadeGains(NaN).outgoing, 1);
}

// ------------------------------------------------------------- shouldStartFade
{
  const plan = planTransition(req());
  check("no fade for a cut plan", !shouldStartFade({ ...plan, mode: "cut" }, 1, null));
  const gaplessPlan = planTransition(
    req({ gaplessEnabled: true, crossfadeSeconds: 0 }),
  );
  eq("gapless plan has zero lead", gaplessPlan.leadSeconds, 0);
  check(
    "a zero-lead plan never triggers a fade",
    !shouldStartFade(gaplessPlan, 0.1, null),
  );
  check("does not fire while far from the end", !shouldStartFade(plan, 30, null));
  // Crossing from ABOVE the lead is what identifies the moment: the previous
  // poll must have been past the boundary, so a late/duplicate poll cannot
  // re-trigger the same fade.
  check("fires once the boundary is crossed", shouldStartFade(plan, 5.9, 6.1));
  check("ignores a poll from below the boundary", !shouldStartFade(plan, 5.9, 5.8));
  check("does not re-fire after it started", !shouldStartFade(plan, 5, 4.9));
  check("ignores non-finite remaining", !shouldStartFade(plan, NaN, null));
  check("ignores negative remaining", !shouldStartFade(plan, -1, null));
}

// ------------------------------------------------------------- preload timing
{
  const cross = planTransition(req({ crossfadeSeconds: 6 }));
  eq(
    "crossfade preloads a fade-length plus lead ahead",
    preloadLead(cross),
    Math.min(MAX_PREP_SECONDS, 6 + 12),
  );
  eq("gapless has no preloadLead (it does not overlap)", preloadLead(planTransition(req({ gaplessEnabled: true, crossfadeSeconds: 0 }))), 0);
  eq(
    "prepareLead for gapless is the buffering lead",
    prepareLead(planTransition(req({ gaplessEnabled: true, crossfadeSeconds: 0 }))),
    GAPLESS_PRELOAD_LEAD_SECONDS,
  );
  eq("prepareLead for a cut is zero", prepareLead(planTransition(req({ repeatOne: true }))), 0);
}

// ------------------------------------------------------------- gapless readiness
{
  const noPreload = canHandOffGapless({
    preparedFor: null,
    trackId: "b",
    currentSrc: "https://x/audio",
    readyState: 4,
  });
  check("gapless refuses an unprepared deck", !noPreload.ready);

  const noSrc = canHandOffGapless({
    preparedFor: "b",
    trackId: "b",
    currentSrc: null,
    readyState: 4,
  });
  check("gapless refuses a missing src", !noSrc.ready);

  const nonHttp = canHandOffGapless({
    preparedFor: "b",
    trackId: "b",
    currentSrc: "data:audio/mpeg;base64,AAAA",
    readyState: 4,
  });
  check("gapless refuses a non-http src", !nonHttp.ready);

  const notBuffered = canHandOffGapless({
    preparedFor: "b",
    trackId: "b",
    currentSrc: "https://x/audio",
    readyState: 1,
  });
  check("gapless refuses an unbuffered deck", !notBuffered.ready);

  const wrongTrack = canHandOffGapless({
    preparedFor: "a",
    trackId: "b",
    currentSrc: "https://x/audio",
    readyState: 4,
  });
  check("gapless refuses a deck prepared for another track", !wrongTrack.ready);

  const ready = canHandOffGapless({
    preparedFor: "b",
    trackId: "b",
    currentSrc: "https://x/audio",
    readyState: 2,
  });
  check("gapless allows a buffered, matched deck", ready.ready);
}

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} transition check(s) failed:\n`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error(`\n${pass} passed, ${failures.length} failed\n`);
  process.exit(1);
} else {
  console.log(`✓ transition: ${pass}/${pass} checks passed`);
}
