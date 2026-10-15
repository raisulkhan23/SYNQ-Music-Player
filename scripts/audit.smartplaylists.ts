/**
 * Audit harness for SYNQ's smart playlists, artist-repetition control and
 * cold-start onboarding. All three modules are pure (or fall back safely with
 * no browser storage), so they run directly under bun with no network.
 *
 *   bun scripts/audit.smartplaylists.ts
 */

import {
  REDISCOVER_DEFAULT_DAYS,
  SMART_DEFAULT_RULES,
  SMART_MAX_LIMIT,
  SMART_MIN_LIMIT,
  defaultSmartName,
  describeSmartRules,
  evaluateSmartRules,
  normalizeSmartRules,
  smartRulesFingerprint,
  trackMatchesRules,
  type SmartRules,
  type SmartTrack,
} from "../src/lib/smartPlaylists";
import {
  applyArtistRepetition,
  artistKey,
  recentArtistKeys,
  repetitionWindow,
  normalizeArtistRepetition,
  isArtistRepetitionLevel,
} from "../src/lib/artistRepetition";
import {
  MAX_TASTE_ARTISTS,
  MAX_TASTE_MOODS,
  describeTaste,
  normalizeTasteProfile,
  shouldOfferOnboarding,
  tasteIsUsable,
  tastePickCount,
  tasteSeedQueries,
  TASTE_MOODS,
} from "../src/lib/onboarding";

let pass = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = "") {
  if (cond) pass++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function eq<T>(name: string, actual: T, expected: T) {
  check(name, Object.is(actual, expected), `got ${String(actual)}, want ${String(expected)}`);
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 15); // 2026-09-15

function st(overrides: Partial<SmartTrack>): SmartTrack {
  return {
    trackId: "t",
    title: "Track",
    artistName: "Artist",
    coverUrl: "",
    duration: 200,
    playCount: 0,
    lastPlayedAt: 0,
    likedAt: 0,
    ...overrides,
  };
}

const library: SmartTrack[] = [
  st({ trackId: "a", title: "Alpha", artistName: "Adele", playCount: 12, lastPlayedAt: NOW - 1 * DAY, likedAt: NOW - 30 * DAY }),
  st({ trackId: "b", title: "Bravo", artistName: "Adele", playCount: 3, lastPlayedAt: NOW - 10 * DAY, likedAt: NOW - 20 * DAY }),
  st({ trackId: "c", title: "Charlie", artistName: "Bowie", playCount: 0, lastPlayedAt: NOW - 90 * DAY, likedAt: 0 }),
  st({ trackId: "d", title: "Delta", artistName: "Coldplay", playCount: 40, lastPlayedAt: NOW - 200 * DAY, likedAt: NOW - 100 * DAY }),
  st({ trackId: "e", title: "Echo", artistName: "Drake", playCount: 1, lastPlayedAt: NOW - 400 * DAY, likedAt: 0 }),
];

// ------------------------------------------------------------- normalization
{
  const r = normalizeSmartRules(undefined);
  eq("undefined normalizes to defaults", r.source, SMART_DEFAULT_RULES.source);
  eq("min limit is clamped up", normalizeSmartRules({ limit: 1 }).limit, SMART_MIN_LIMIT);
  eq("max limit is clamped down", normalizeSmartRules({ limit: 999999 }).limit, SMART_MAX_LIMIT);
  eq("negative windows clamp to 0", normalizeSmartRules({ withinDays: -5 }).withinDays, 0);
  eq("bad source falls back", normalizeSmartRules({ source: "genre" as unknown as SmartRules["source"] }).source, "any");
  eq("bad sort falls back", normalizeSmartRules({ sort: "az" as unknown as SmartRules["sort"] }).sort, "most_played");
  eq("artist is trimmed", normalizeSmartRules({ artist: "  Adele  " }).artist, "Adele");
  // rediscover is only meaningful with a staleness floor, so it defaults one.
  eq(
    "rediscover gets a default staleness floor",
    normalizeSmartRules({ source: "rediscover" }).notWithinDays,
    REDISCOVER_DEFAULT_DAYS,
  );
  eq(
    "an explicit rediscover floor is honoured",
    normalizeSmartRules({ source: "rediscover", notWithinDays: 7 }).notWithinDays,
    7,
  );
  eq(
    "non-rediscover sources keep a zero floor",
    normalizeSmartRules({ source: "played" }).notWithinDays,
    0,
  );
}

// --------------------------------------------------------------- sources
{
  const liked = evaluateSmartRules(library, normalizeSmartRules({ source: "liked" }), NOW);
  check("liked source returns only liked", liked.every((t) => t.likedAt > 0));
  eq("liked count", liked.length, 3);

  const played = evaluateSmartRules(library, normalizeSmartRules({ source: "played" }), NOW);
  check("played source returns only played", played.every((t) => t.playCount > 0));
  eq("played count", played.length, 4);

  const never = evaluateSmartRules(library, normalizeSmartRules({ source: "never_played" }), NOW);
  eq("never_played count", never.length, 1);
  eq("never_played returns the unplayed one", never[0]!.trackId, "c");
}

// --------------------------------------------------------------- play bands
{
  const high = evaluateSmartRules(library, normalizeSmartRules({ minPlays: 10 }), NOW);
  check("minPlays filters", high.every((t) => t.playCount >= 10));
  const low = evaluateSmartRules(library, normalizeSmartRules({ maxPlays: 3 }), NOW);
  check("maxPlays filters", low.every((t) => t.playCount <= 3));
}

// --------------------------------------------------------------- windows
{
  const fresh = evaluateSmartRules(library, normalizeSmartRules({ withinDays: 15 }), NOW);
  check("withinDays keeps recent plays", fresh.every((t) => t.lastPlayedAt > 0 && NOW - t.lastPlayedAt <= 15 * DAY));
  eq("withinDays count", fresh.length, 2);

  const stale = evaluateSmartRules(library, normalizeSmartRules({ source: "rediscover", notWithinDays: 30 }), NOW);
  check("notWithinDays keeps only old plays", stale.every((t) => NOW - t.lastPlayedAt >= 30 * DAY));
  // d (played 200d ago) and e (played 400d ago) qualify; a and b do not.
  eq("notWithinDays count", stale.length, 2);
}

// --------------------------------------------------------------- text + sort
{
  const byArtist = evaluateSmartRules(library, normalizeSmartRules({ artist: "adele" }), NOW);
  eq("artist substring is case-insensitive", byArtist.length, 2);

  const sorted = evaluateSmartRules(library, normalizeSmartRules({ title: "a", sort: "title" }), NOW);
  const titles = sorted.map((t) => t.title);
  check("title sort is alphabetical", titles.join() === [...titles].sort().join());

  const most = evaluateSmartRules(library, normalizeSmartRules({ sort: "most_played" }), NOW);
  eq("most_played puts the highest first", most[0]!.trackId, "d");
  const least = evaluateSmartRules(library, normalizeSmartRules({ sort: "least_played" }), NOW);
  eq("least_played puts the lowest first", least[0]!.trackId, "c");
}

// --------------------------------------------------------------- limit + dedupe
{
  eq("a limit below the floor is clamped up", normalizeSmartRules({ limit: 2 }).limit, SMART_MIN_LIMIT);
  const sixDeep = [...library, st({ trackId: "f", title: "Foxtrot", playCount: 2 })];
  const limited = evaluateSmartRules(sixDeep, normalizeSmartRules({ limit: SMART_MIN_LIMIT }), NOW);
  eq("limit caps results", limited.length, SMART_MIN_LIMIT);

  const dupes = [library[0]!, library[0]!, library[1]!];
  const deduped = evaluateSmartRules(dupes, normalizeSmartRules({}), NOW);
  eq("duplicate ids collapse", deduped.length, 2);

  // A hostile rule cannot produce more than the cap.
  const huge = Array.from({ length: 500 }, (_, i) => st({ trackId: `x${i}` }));
  const capped = evaluateSmartRules(huge, normalizeSmartRules({ limit: 999999 }), NOW);
  eq("cap holds", capped.length, SMART_MAX_LIMIT);
}

// --------------------------------------------------------------- copy + name
{
  const r = normalizeSmartRules({ source: "liked", minPlays: 3, withinDays: 30 });
  const desc = describeSmartRules(r);
  check("description mentions liked songs", desc.includes("Liked songs"));
  check("description mentions the play floor", desc.includes("at least 3"));
  const name = defaultSmartName(r);
  check("default name is capitalised", name[0] === name[0]!.toUpperCase());
  check("fingerprint is stable", smartRulesFingerprint(r) === smartRulesFingerprint(normalizeSmartRules(r)));
  check("fingerprint changes with rules", smartRulesFingerprint(r) !== smartRulesFingerprint(normalizeSmartRules({ source: "liked", minPlays: 4 })));
}

// --------------------------------------------------------------- trackMatchesRules
{
  const rules = normalizeSmartRules({ source: "liked", minPlays: 2 });
  check("match respects source+plays", trackMatchesRules(library[0]!, rules, NOW));
  check("non-match respects source+plays", !trackMatchesRules(library[2]!, rules, NOW));
}

// --------------------------------------------------------------- artist repetition
{
  eq("off avoids nobody", repetitionWindow("off"), 0);
  check("balanced avoids a few", repetitionWindow("balanced") >= 1);
  check("strict avoids more than balanced", repetitionWindow("strict") > repetitionWindow("balanced"));

  const cands = [
    { id: "1", artistName: "Adele" },
    { id: "2", artistName: "Bowie" },
    { id: "3", artistName: "Coldplay" },
    { id: "4", artistName: "Adele" },
  ];
  const recent = ["Adele", "Coldplay"];
  const balanced = applyArtistRepetition(cands, (c) => c.artistName, recent, "balanced");
  check("balanced drops repeated artists", balanced.every((c) => c.artistName === "Bowie"));
  eq("balanced keeps the uncontested one", balanced.length, 1);

  const off = applyArtistRepetition(cands, (c) => c.artistName, recent, "off");
  eq("off returns everything", off.length, 4);

  // Dead-end fallback: every candidate repeats a recent artist.
  const allRepeated = applyArtistRepetition(
    cands,
    (c) => c.artistName,
    ["Adele", "Bowie", "Coldplay"],
    "strict",
  );
  eq("falls back rather than emptying", allRepeated.length, 4);

  eq("artistKey normalizes case/space", artistKey("  Daft Punk "), "daft punk");
  eq("recentArtistKeys dedupes and limits", recentArtistKeys([{ artistName: "A" }, { artistName: "a" }, { artistName: "B" }]).join(), "a,b");
  check("level validation", isArtistRepetitionLevel("strict") && !isArtistRepetitionLevel("maybe"));
  eq("unknown level normalizes to balanced", normalizeArtistRepetition("wild"), "balanced");
}

// --------------------------------------------------------------- onboarding
{
  const profile = normalizeTasteProfile({ artists: ["Drake", "drake", "  ", "SZA"], moods: ["chill", "bogus", "chill"] });
  eq("artists dedupe case-insensitively", profile.artists.length, 2);
  eq("unknown moods are dropped", profile.moods.join(), "chill");
  eq("pick count", tastePickCount(profile), 3);
  check("two picks are usable", tasteIsUsable(profile));
  check("one pick is not", !tasteIsUsable(normalizeTasteProfile({ artists: ["Drake"] })));

  const capped = normalizeTasteProfile({ artists: Array.from({ length: 20 }, (_, i) => `A${i}`), moods: TASTE_MOODS.map((m) => m.id) });
  eq("artists are capped", capped.artists.length, MAX_TASTE_ARTISTS);
  eq("moods are capped", capped.moods.length, MAX_TASTE_MOODS);

  const seeds = tasteSeedQueries(normalizeTasteProfile({ artists: ["Drake", "SZA"], moods: ["chill"] }));
  eq("seed order: artists then moods", seeds.join("|"), "Drake|SZA|acoustic lofi");
  eq("seeds are deduped", tasteSeedQueries(normalizeTasteProfile({ artists: ["Drake", "drake"] })).length, 1);

  check("description summarizes", describeTaste(normalizeTasteProfile({ artists: ["Drake", "SZA"], moods: ["chill"] })).includes("Drake"));

  check("offer to a cold signed-in listener", shouldOfferOnboarding({ signedIn: true, done: false, serverTasteSet: false, hasHistory: false }));
  check("never to a signed-out visitor", !shouldOfferOnboarding({ signedIn: false, done: false, serverTasteSet: false, hasHistory: false }));
  check("not once done", !shouldOfferOnboarding({ signedIn: true, done: true, serverTasteSet: false, hasHistory: false }));
  check("not with history", !shouldOfferOnboarding({ signedIn: true, done: false, serverTasteSet: false, hasHistory: true }));
  check("not with saved taste", !shouldOfferOnboarding({ signedIn: true, done: false, serverTasteSet: true, hasHistory: false }));
}

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} check(s) failed:\n`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error(`\n${pass} passed, ${failures.length} failed\n`);
  process.exit(1);
} else {
  console.log(`✓ smart playlists + artist repetition + onboarding: ${pass}/${pass} checks passed`);
}
