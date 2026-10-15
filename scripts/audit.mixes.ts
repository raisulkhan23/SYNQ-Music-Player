/**
 * Audit harness for SYNQ's Mix assembly and motion-level logic.
 *
 *   bun scripts/audit.mixes.ts
 *
 * Both modules are pure, so they can be exercised directly with no browser,
 * no network and no store. Exit code 0 when every check passes, 1 otherwise.
 */

import { buildMixes, mixCover, MIN_MIX_TRACKS, MAX_MIX_TRACKS } from "../src/lib/mixes";
import type { Mix, MixSources } from "../src/lib/mixes";
import type { YtItem } from "../src/lib/youtube";
import {
  ANIMATION_LEVELS,
  ANIMATION_LEVEL_META,
  isAnimationLevel,
  readAnimationLevel,
} from "../src/lib/motion";

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

function track(id: string, extra: Partial<YtItem> = {}): YtItem {
  return {
    id,
    title: `Track ${id}`,
    artist: `Artist ${id}`,
    duration: 200,
    thumbnail: `https://i.ytimg.com/vi/${id}/hq.jpg`,
    ...extra,
  };
}

function many(prefix: string, n: number): YtItem[] {
  return Array.from({ length: n }, (_, i) => track(`${prefix}${i}`));
}

function ids(mix: Mix): string[] {
  return mix.items.map((i) => i.id);
}

// ------------------------------------------------------------------ empty
{
  const mixes = buildMixes({});
  eq("empty sources produce no mixes", mixes.length, 0);
}

// ------------------------------------------------------- minimum threshold
{
  const tooFew = buildMixes({ mostPlayed: many("a", MIN_MIX_TRACKS - 1) });
  eq("a set below the minimum is not a mix", tooFew.length, 0);

  const enough = buildMixes({ mostPlayed: many("a", MIN_MIX_TRACKS) });
  eq("a set at the minimum becomes a mix", enough.length, 1);
  eq("the mix is the on-repeat one", enough[0]!.id, "on_repeat");
  eq("all tracks are kept", enough[0]!.items.length, MIN_MIX_TRACKS);
}

// ------------------------------------------------------------- dedupe
{
  // A history with the same id repeated must not become a mix of duplicates.
  const duplicated = [
    track("x"),
    track("x"),
    track("x"),
    track("x"),
    track("x"),
    track("y"),
    track("z"),
    track("w"),
  ];
  const mixes = buildMixes({ recent: duplicated });
  eq("dedupe leaves one mix", mixes.length, 1);
  eq("dedupe keeps unique ids only", mixes[0]!.items.length, 4);
  check(
    "no duplicate ids in a mix",
    new Set(ids(mixes[0]!)).size === ids(mixes[0]!).length,
  );
}

// ------------------------------------------------------------- unusable rows
{
  const withJunk: YtItem[] = [
    track("a"),
    { id: "", title: "no id", artist: "", duration: 0, thumbnail: "" } as YtItem,
    { id: "b", title: "", artist: "x", duration: 0, thumbnail: "" } as YtItem,
    track("c"),
    track("d"),
    track("e"),
  ];
  const mixes = buildMixes({ mostPlayed: withJunk });
  eq("unusable rows are dropped", mixes[0]!.items.length, 4);
}

// ------------------------------------------------------------- max cap
{
  const huge = many("h", MAX_MIX_TRACKS + 50);
  const mixes = buildMixes({ mostPlayed: huge });
  eq("a mix is capped", mixes[0]!.items.length, MAX_MIX_TRACKS);
}

// ------------------------------------------------------------- every source
{
  const sources: MixSources = {
    mostPlayed: many("m", 6),
    recent: many("r", 6),
    discovery: many("d", 6),
    newMusic: many("n", 6),
    soundAlike: many("s", 6),
    timeOfDay: many("t", 6),
  };
  const mixes = buildMixes(sources);
  eq("all six sources produce six mixes", mixes.length, 6);
  eq(
    "display order matches the catalogue",
    mixes.map((m) => m.id).join(","),
    "on_repeat,recent,sound_alike,discovery,new_music,right_now",
  );
  check(
    "every mix has a real name and subtitle",
    mixes.every((m) => m.name.length > 0 && m.subtitle.length > 0),
  );
  check(
    "every mix meets the minimum",
    mixes.every((m) => m.items.length >= MIN_MIX_TRACKS),
  );
}

// ------------------------------------------------------------- favorites
{
  // Favorites comes first when present, and only when it has enough tracks.
  const mixes = buildMixes({
    favorites: many("v", 6),
    mostPlayed: many("m", 6),
  });
  eq("favorites leads the order", mixes[0]!.id, "favorites");
  eq("favorites is followed by on-repeat", mixes[1]!.id, "on_repeat");

  const tooFewLikes = buildMixes({ favorites: many("v", 2) });
  eq("two likes is not a Favorites Mix", tooFewLikes.length, 0);
}

// ------------------------------------------------------- first track stable
{
  // The opener is the mix's cover and must not be rotated out from under a
  // listener who presses play again the next day.
  const sources: MixSources = { mostPlayed: many("f", 12) };
  const day1 = buildMixes(sources, new Date("2026-01-01T09:00:00Z"))[0]!;
  const day2 = buildMixes(sources, new Date("2026-01-02T09:00:00Z"))[0]!;
  eq("the first track is stable across days", day1.items[0]!.id, day2.items[0]!.id);
  check(
    "the tail does rotate (or is at least a permutation)",
    new Set(ids(day2)).size === ids(day2).length,
  );
  check(
    "rotation never loses a track",
    [...ids(day1)].sort().join() === [...ids(day2)].sort().join(),
  );
}

// ------------------------------------------------------------- cover
{
  const withCover = buildMixes({ mostPlayed: many("g", 5) })[0]!;
  check("mixCover returns the first thumbnail", mixCover(withCover).length > 0);

  const noCover = buildMixes({
    mostPlayed: [
      track("a", { thumbnail: "" }),
      track("b", { thumbnail: "" }),
      track("c", { thumbnail: "" }),
      track("d", { thumbnail: "" }),
    ],
  })[0]!;
  eq("mixCover is empty when no track has artwork", mixCover(noCover), "");
}

// ------------------------------------------------------------- cold listener
{
  // Only a live shelf is available — a mix may still form, and it must never
  // claim to be the listener's own most-played.
  const mixes = buildMixes({ newMusic: many("z", 8) });
  eq("a cold listener gets the new-music mix only", mixes.length, 1);
  eq("and it is correctly labelled", mixes[0]!.id, "new_music");
}

// ------------------------------------------------------------- motion levels
{
  check("full is a valid animation level", isAnimationLevel("full"));
  check("reduced is a valid animation level", isAnimationLevel("reduced"));
  check("off is a valid animation level", isAnimationLevel("off"));
  check("an unknown string is not", !isAnimationLevel("ludicrous"));
  check("null is not", !isAnimationLevel(null));
  check("undefined is not", !isAnimationLevel(undefined));
  check("a boolean is not", !isAnimationLevel(true));

  eq("there are exactly three levels", ANIMATION_LEVELS.length, 3);
  check(
    "the levels are unique",
    new Set(ANIMATION_LEVELS).size === ANIMATION_LEVELS.length,
  );
  check(
    "every level has a label and description",
    ANIMATION_LEVELS.every(
      (l) => ANIMATION_LEVEL_META[l].label && ANIMATION_LEVEL_META[l].description,
    ),
  );

  // No storage in this runtime: the reader must fall back to full rather than
  // throwing, which is exactly the boot path on a first visit.
  eq("no stored setting defaults to full", readAnimationLevel(), "full");
}

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} check(s) failed:\n`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error(`\n${pass} passed, ${failures.length} failed\n`);
  process.exit(1);
} else {
  console.log(`✓ mixes + motion: ${pass}/${pass} checks passed`);
}
