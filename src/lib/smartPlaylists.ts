/**
 * SYNQ Smart Playlists — pure rules over data SYNQ already has.
 *
 * A "smart playlist" is a saved RULE SET, not a saved track list. The listener
 * describes what they want ("songs I've played more than 5 times", "liked songs
 * I haven't touched in a month") and SYNQ recomputes the playlist every time it
 * is opened. This is SYNQ's answer to Apple Music's smart playlists, and it is
 * deliberately built from signals that already exist here:
 *
 *   - play counts and last-played time  (playHistory / trackSignals)
 *   - the liked-songs list              (likedSongs / likedRemote)
 *
 * ── The honesty rule ───────────────────────────────────────────────────────
 *
 * SYNQ has NO genre, mood, tempo or year metadata anywhere (see
 * `lib/recommend.ts` for the same constraint). A smart rule therefore CANNOT be
 * "genre is Jazz" or "released in the 80s" — that data does not exist, and a
 * rule that pretended to filter on it would silently match nothing (or worse,
 * match on a guessed string). Every field below is a number or a substring of
 * text SYNQ genuinely stores, so a rule can only ever select tracks it can
 * actually justify.
 *
 * ── Why it is pure ─────────────────────────────────────────────────────────
 *
 * No I/O, no clock reads except an injected `now`, no React. The match/sort
 * behaviour is then testable without a database, and the Convex resolver stays a
 * thin "read the library, hand it here" layer rather than a second rules engine.
 */

/** One track as the rules see it — library metadata only, never a stream URL. */
export interface SmartTrack {
  trackId: string;
  title: string;
  artistName: string;
  coverUrl: string;
  duration: number;
  /** Total plays recorded for this track. 0 when never played. */
  playCount: number;
  /** Epoch ms of the last play, or 0 when never played. */
  lastPlayedAt: number;
  /** Epoch ms the track was liked, or 0 when it is not liked. */
  likedAt: number;
  /** Provider/source label, kept for display only. */
  source?: string;
}

/** What pool a smart playlist draws from. */
export type SmartSource =
  | "any"
  | "liked"
  | "played"
  | "never_played"
  | "rediscover";

/** How the matched tracks are ordered. */
export type SmartSort = "most_played" | "least_played" | "recent" | "oldest" | "title";

/**
 * A saved rule set. All fields are required after `normalizeSmartRules`; the
 * optional form exists only so a stored row written by an older build still
 * loads.
 */
export interface SmartRules {
  source: SmartSource;
  /** Only tracks with at least this many plays. */
  minPlays: number;
  /** Only tracks with no more than this many plays. 0 = no cap. */
  maxPlays: number;
  /**
   * Restrict to tracks last played within this many days. 0 = any time.
   * Ignored for `never_played`, which is unbounded by definition.
   */
  withinDays: number;
  /**
   * Restrict to tracks NOT played in the last this-many days. 0 = no floor.
   * The "rediscover" mechanic: things you used to love and stopped playing.
   */
  notWithinDays: number;
  /** Case-insensitive substring of the artist name. "" = any. */
  artist: string;
  /** Case-insensitive substring of the title. "" = any. */
  title: string;
  /** Cap on returned tracks. */
  limit: number;
  sort: SmartSort;
}

export const SMART_DEFAULT_RULES: SmartRules = {
  source: "any",
  minPlays: 0,
  maxPlays: 0,
  withinDays: 0,
  notWithinDays: 0,
  artist: "",
  title: "",
  limit: 50,
  sort: "most_played",
};

export const SMART_MIN_LIMIT = 5;
export const SMART_MAX_LIMIT = 200;
export const MIN_SMART_TRACKS = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Source labels and help text for the builder UI. */
export const SMART_SOURCES: Array<{ id: SmartSource; label: string }> = [
  { id: "any", label: "My whole library" },
  { id: "liked", label: "Liked songs" },
  { id: "played", label: "Songs I've played" },
  { id: "never_played", label: "Songs I've never played" },
  { id: "rediscover", label: "Songs I haven't played lately" },
];

export const SMART_SORTS: Array<{ id: SmartSort; label: string }> = [
  { id: "most_played", label: "Most played" },
  { id: "least_played", label: "Least played" },
  { id: "recent", label: "Recently played" },
  { id: "oldest", label: "Not played in a while" },
  { id: "title", label: "Title (A–Z)" },
];

function isSource(value: unknown): value is SmartSource {
  return SMART_SOURCES.some((s) => s.id === value);
}

function isSort(value: unknown): value is SmartSort {
  return SMART_SORTS.some((s) => s.id === value);
}

/** Clamp a number into [min,max], falling back when it is not finite. */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Coerce a stored (or partially built) rule set into the exact shape the
 * evaluator expects, clamping every numeric field so a hostile or stale row can
 * never request a 10-million-track playlist or a negative window.
 */
/**
 * The staleness floor applied by default to the `rediscover` source. Named so
 * the UI and tests refer to the same number.
 */
export const REDISCOVER_DEFAULT_DAYS = 30;

export function normalizeSmartRules(partial: Partial<SmartRules> | undefined): SmartRules {
  const p = partial ?? {};
  const source = isSource(p.source) ? p.source : SMART_DEFAULT_RULES.source;
  const notWithinDays = clampInt(p.notWithinDays, 0, 3650, 0);
  return {
    source,
    minPlays: clampInt(p.minPlays, 0, 1_000_000, 0),
    maxPlays: clampInt(p.maxPlays, 0, 1_000_000, 0),
    withinDays: clampInt(p.withinDays, 0, 3650, 0),
    // "Songs I haven't played lately" is only true if there IS a staleness
    // floor. Left at 0 the source is indistinguishable from "Songs I've
    // played" — the label would be a lie. Default the floor when the source is
    // `rediscover` and none was supplied; an explicit value is always honoured.
    notWithinDays:
      source === "rediscover" && notWithinDays === 0
        ? REDISCOVER_DEFAULT_DAYS
        : notWithinDays,
    artist: text(p.artist),
    title: text(p.title),
    limit: clampInt(p.limit, SMART_MIN_LIMIT, SMART_MAX_LIMIT, SMART_DEFAULT_RULES.limit),
    sort: isSort(p.sort) ? p.sort : SMART_DEFAULT_RULES.sort,
  };
}

/** Case/diacritic-insensitive substring test for the text filters. */
function matchesText(haystack: string, needle: string): boolean {
  if (!needle) return true;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Does one track pass the rule set? `now` is injected so "within N days" is
 * deterministic under test. A track with `lastPlayedAt === 0` (never played) is
 * treated as infinitely old for the recency windows.
 */
export function trackMatchesRules(
  track: SmartTrack,
  rules: SmartRules,
  now: number,
): boolean {
  switch (rules.source) {
    case "liked":
      if (track.likedAt <= 0) return false;
      break;
    case "played":
      if (track.playCount <= 0) return false;
      break;
    case "never_played":
      if (track.playCount > 0) return false;
      break;
    case "rediscover":
      if (track.playCount <= 0) return false;
      break;
    case "any":
      break;
  }

  if (track.playCount < rules.minPlays) return false;
  if (rules.maxPlays > 0 && track.playCount > rules.maxPlays) return false;

  if (rules.source !== "never_played" && rules.withinDays > 0) {
    if (track.lastPlayedAt <= 0) return false;
    if (now - track.lastPlayedAt > rules.withinDays * DAY_MS) return false;
  }

  if (rules.notWithinDays > 0 && track.lastPlayedAt > 0) {
    if (now - track.lastPlayedAt < rules.notWithinDays * DAY_MS) return false;
  }

  if (!matchesText(track.artistName, rules.artist)) return false;
  if (!matchesText(track.title, rules.title)) return false;

  return true;
}

function compare(a: SmartTrack, b: SmartTrack, sort: SmartSort): number {
  switch (sort) {
    case "most_played":
      return b.playCount - a.playCount || b.lastPlayedAt - a.lastPlayedAt;
    case "least_played":
      return a.playCount - b.playCount || a.lastPlayedAt - b.lastPlayedAt;
    case "recent":
      return b.lastPlayedAt - a.lastPlayedAt;
    case "oldest":
      return a.lastPlayedAt - b.lastPlayedAt;
    case "title":
      return a.title.localeCompare(b.title);
  }
}

/**
 * Evaluate a rule set against a library, returning the matched tracks in the
 * requested order, capped at `limit`. Deduplicates by track id first so a
 * library assembled from two sources cannot show the same song twice.
 */
export function evaluateSmartRules(
  library: SmartTrack[],
  rules: SmartRules,
  now: number = Date.now(),
): SmartTrack[] {
  const seen = new Set<string>();
  const matched: SmartTrack[] = [];
  for (const track of library) {
    if (!track.trackId || seen.has(track.trackId)) continue;
    seen.add(track.trackId);
    if (trackMatchesRules(track, rules, now)) matched.push(track);
  }
  matched.sort((a, b) => compare(a, b, rules.sort));
  return matched.slice(0, rules.limit);
}

/**
 * A short human description of a rule set, e.g. "Liked songs, played at least
 * 3 times". Used as the subtitle under the playlist name and as the default
 * name when the listener does not supply one.
 */
export function describeSmartRules(rules: SmartRules): string {
  const parts: string[] = [];
  switch (rules.source) {
    case "liked":
      parts.push("Liked songs");
      break;
    case "played":
      parts.push("Songs you've played");
      break;
    case "never_played":
      parts.push("Songs you've never played");
      break;
    case "rediscover":
      parts.push("Songs you haven't played lately");
      break;
    case "any":
      parts.push("Your whole library");
      break;
  }
  if (rules.minPlays > 0) parts.push(`played at least ${rules.minPlays}×`);
  if (rules.maxPlays > 0) parts.push(`played at most ${rules.maxPlays}×`);
  if (rules.source !== "never_played" && rules.withinDays > 0) {
    parts.push(`in the last ${rules.withinDays} days`);
  }
  if (rules.notWithinDays > 0) parts.push(`not played for ${rules.notWithinDays} days`);
  if (rules.artist) parts.push(`by “${rules.artist}”`);
  if (rules.title) parts.push(`titled “${rules.title}”`);
  return parts.join(", ");
}

/** The default name for a brand-new smart playlist. */
export function defaultSmartName(rules: SmartRules): string {
  const description = describeSmartRules(rules);
  const name = description.charAt(0).toUpperCase() + description.slice(1);
  return name.length > 60 ? `${name.slice(0, 57)}…` : name;
}

/** A stable, redacted id for a rule set — used to detect "unchanged" saves. */
export function smartRulesFingerprint(rules: SmartRules): string {
  return [
    rules.source,
    rules.minPlays,
    rules.maxPlays,
    rules.withinDays,
    rules.notWithinDays,
    rules.artist.toLowerCase(),
    rules.title.toLowerCase(),
    rules.limit,
    rules.sort,
  ].join("|");
}
