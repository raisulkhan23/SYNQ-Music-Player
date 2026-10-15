/**
 * Audit harness for SYNQ's ADAPTIVE personalization math.
 *
 *   bun scripts/audit.personalization.ts
 *
 * The point of adaptivity is that it reacts to real behaviour without ever
 * overriding the listener outright. These checks pin the two properties that
 * matter — it MOVES with the evidence, and it is BOUNDED — plus the guards that
 * stop it acting on noise.
 */

import {
  ADAPT_MAX_SHIFT,
  ADAPT_MIN_SAMPLES,
  DEFAULT_EXPLORATION,
  adaptExploration,
  adaptiveTuning,
  buildTuning,
  clampExploration,
  explainReason,
  measureFeedbackTolerance,
  type PlaySignal,
} from "../src/lib/recommend";

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

function play(origin: PlaySignal["origin"], skipped = false): PlaySignal {
  return { trackId: "t", at: 0, origin, ...(skipped ? { skipped: true } : {}) };
}

function repeat<T>(n: number, fn: (i: number) => T): T[] {
  return Array.from({ length: n }, (_, i) => fn(i));
}

// --------------------------------------------------- measureFeedbackTolerance
{
  const empty = measureFeedbackTolerance([]);
  eq("no plays => nothing recommended", empty.recommended, 0);
  eq("no plays => nothing skipped", empty.skipped, 0);

  const selfDirected = measureFeedbackTolerance([
    play("user"),
    play("user"),
    play(undefined),
  ]);
  eq("user-chosen plays are not counted", selfDirected.recommended, 0);

  const mixed = measureFeedbackTolerance([
    play("recommendation"),
    play("recommendation", true),
    play("autoplay"),
    play("radio", true),
    play("user"),
  ]);
  eq("recommended/autoplay/radio are counted", mixed.recommended, 4);
  eq("skips among them are counted", mixed.skipped, 2);
}

// ------------------------------------------------------- no adaptation on noise
{
  const below = measureFeedbackTolerance(
    repeat(ADAPT_MIN_SAMPLES - 1, () => play("recommendation", true)),
  );
  eq(
    "below the sample floor the dial does not move",
    adaptExploration(50, below),
    50,
  );
}

// ------------------------------------------------------------- moves with evidence
{
  const heavySkipper = { recommended: 40, skipped: 40 };
  const enthusiast = { recommended: 40, skipped: 0 };
  check(
    "a listener who skips recommendations gets more familiar music",
    adaptExploration(50, heavySkipper) < 50,
  );
  check(
    "a listener who enjoys recommendations gets more discovery",
    adaptExploration(50, enthusiast) > 50,
  );
  eq("a neutral hit rate leaves the dial alone", adaptExploration(50, { recommended: 40, skipped: 20 }), 50);
}

// ------------------------------------------------------------- bounded
{
  eq(
    "the shift never exceeds its cap (down)",
    adaptExploration(50, { recommended: 100, skipped: 100 }),
    50 - ADAPT_MAX_SHIFT,
  );
  eq(
    "the shift never exceeds its cap (up)",
    adaptExploration(50, { recommended: 100, skipped: 0 }),
    50 + ADAPT_MAX_SHIFT,
  );
  check(
    "the result is always a valid preference",
    [0, 5, 50, 95, 100].every((base) => {
      const v = adaptExploration(base, { recommended: 100, skipped: 100 });
      return v >= 0 && v <= 100;
    }),
  );
  eq(
    "a class of skips cannot switch discovery to zero",
    adaptExploration(0, { recommended: 100, skipped: 100 }),
    0,
  );
}

// ------------------------------------------------------------- confidence ramp
{
  const early = adaptExploration(50, { recommended: ADAPT_MIN_SAMPLES, skipped: 0 });
  const settled = adaptExploration(50, { recommended: 60, skipped: 0 });
  check(
    "the correction grows as the picture becomes clear",
    early - 50 < settled - 50,
    `early=${early}, settled=${settled}`,
  );
  check("early correction is gentle but non-zero", early > 50);
}

// ------------------------------------------------------------- robust inputs
{
  eq("undefined base falls back to the default", adaptExploration(undefined, { recommended: 0, skipped: 0 }), DEFAULT_EXPLORATION);
  eq("NaN base falls back to the default", clampExploration(NaN), DEFAULT_EXPLORATION);
  eq("clamp rejects huge values", clampExploration(150), 100);
  eq("clamp rejects negatives", clampExploration(-5), 0);
  eq("clamp accepts a numeric string", clampExploration("70"), 70);
}

// ------------------------------------------------------------- adaptiveTuning
{
  const base = buildTuning(DEFAULT_EXPLORATION);
  const skipper = adaptiveTuning(DEFAULT_EXPLORATION, repeat(40, () => play("recommendation", true)));
  const fan = adaptiveTuning(DEFAULT_EXPLORATION, repeat(40, () => play("recommendation", false)));
  check(
    "adaptive tuning lowers discovery for a skipper",
    skipper.discoveryBonus < base.discoveryBonus,
  );
  check(
    "adaptive tuning raises discovery for an engaged listener",
    fan.discoveryBonus > base.discoveryBonus,
  );
  check(
    "adaptive tuning never abandons familiarity entirely",
    fan.familiarityBonus > 0 && skipper.familiarityBonus > 0,
  );
  // The explorer should also spend more seeds on discovery.
  check(
    "an engaged listener gets at least as many discovery seeds",
    fan.discoverySeeds >= skipper.discoverySeeds,
  );
}

// ------------------------------------------------------------- buildTuning shape
{
  const familiar = buildTuning(0);
  const exploratory = buildTuning(100);
  check(
    "more exploration means less familiarity weight",
    exploratory.familiarityBonus < familiar.familiarityBonus,
  );
  check(
    "more exploration means more discovery weight",
    exploratory.discoveryBonus > familiar.discoveryBonus,
  );
  check(
    "repeated artists are penalised harder when exploring",
    exploratory.diversityPerRepeat < familiar.diversityPerRepeat,
  );
}

// ------------------------------------------------------------- explainReason ("why this song?")
{
  // Every reason the engine can emit must have honest, human copy — an
  // undefined label would leave a Home card with an empty "why" line.
  const reasons: Array<Parameters<typeof explainReason>[0]> = [
    "based_on_likes",
    "because_you_listened",
    "favorite_artist",
    "similar_song",
    "playlist_related",
    "discovery",
    "new_release",
    "continuing_mix",
    "global_fallback",
  ];
  check(
    "every reason has copy",
    reasons.every((r) => typeof explainReason(r) === "string" && explainReason(r)!.length > 0),
  );
  eq("null has no copy", explainReason(null), null);
  eq("undefined has no copy", explainReason(undefined), null);
  check("likes read as personal", explainReason("based_on_likes")!.includes("liked"));
  check(
    "global fallback does not claim personalisation",
    !/you|your/i.test(explainReason("global_fallback")!),
  );
}

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} personalization check(s) failed:\n`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error(`\n${pass} passed, ${failures.length} failed\n`);
  process.exit(1);
} else {
  console.log(`✓ personalization: ${pass}/${pass} checks passed`);
}
