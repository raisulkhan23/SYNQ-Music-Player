/**
 * SYNQ Artist-Repetition Control — pure, plus the small amount of storage glue.
 *
 * Smart shuffle already avoids replaying the exact same TRACK too soon. This
 * module handles the other half of the annoyance: hearing the same ARTIST three
 * times in a row because the queue happens to cluster them. The listener picks
 * how hard SYNQ should work to spread artists out, and every shuffle pick
 * consults that preference.
 *
 * ── Why it is pure-ish ─────────────────────────────────────────────────────
 *
 * The selection rule (`applyArtistRepetition`) is a pure function so it can be
 * tested without a store, a queue or a browser. The only side effects are the
 * two tiny localStorage helpers, which mirror how the rest of the player store
 * persists small preferences.
 *
 * ── The no-dead-end rule ───────────────────────────────────────────────────
 *
 * Filtering can always empty a candidate pool: a queue with a single artist, or
 * a `strict` window wider than the queue itself. When that happens the rule
 * FALLS BACK to the unfiltered pool rather than returning nothing. Avoiding a
 * repeat is a preference; refusing to play anything is a bug.
 */

export type ArtistRepetitionLevel = "off" | "balanced" | "strict";

export const ARTIST_REPETITION_KEY = "ss.artistRepetition";

export interface ArtistRepetitionMeta {
  label: string;
  description: string;
}

export const ARTIST_REPETITION_META: Record<ArtistRepetitionLevel, ArtistRepetitionMeta> = {
  off: {
    label: "Off",
    description: "Shuffle freely, even if the same artist comes up twice.",
  },
  balanced: {
    label: "Balanced",
    description: "Avoid repeating an artist among the last few songs.",
  },
  strict: {
    label: "Strict",
    description: "Work hard to spread artists out across a longer stretch.",
  },
};

export const ARTIST_REPETITION_LEVELS: ArtistRepetitionLevel[] = ["off", "balanced", "strict"];

/** How many recently-played artists each level tries to avoid. */
export function repetitionWindow(level: ArtistRepetitionLevel): number {
  switch (level) {
    case "strict":
      return 10;
    case "balanced":
      return 3;
    case "off":
      return 0;
  }
}

export function isArtistRepetitionLevel(value: unknown): value is ArtistRepetitionLevel {
  return value === "off" || value === "balanced" || value === "strict";
}

export function normalizeArtistRepetition(value: unknown): ArtistRepetitionLevel {
  return isArtistRepetitionLevel(value) ? value : "balanced";
}

/** Read the stored preference, defaulting to `balanced`. */
export function readArtistRepetition(): ArtistRepetitionLevel {
  try {
    const raw = localStorage.getItem(ARTIST_REPETITION_KEY);
    if (raw === null) return "balanced";
    return normalizeArtistRepetition(raw);
  } catch {
    return "balanced";
  }
}

/** Persist the preference. Returns the value written. */
export function writeArtistRepetition(level: ArtistRepetitionLevel): ArtistRepetitionLevel {
  try {
    localStorage.setItem(ARTIST_REPETITION_KEY, level);
  } catch {
    // Storage can be unavailable (private mode). The in-memory store still
    // holds the choice for this session; nothing here should throw.
  }
  return level;
}

/**
 * A comparison key for an artist name: lowercased and trimmed so "Daft Punk"
 * and "daft punk " collapse to one artist. Deliberately does NOT strip
 * punctuation or "the"/"feat" — over-normalising would merge genuinely
 * different artists, which is a worse error than occasionally missing a match.
 */
export function artistKey(name: string | undefined | null): string {
  return (name ?? "").trim().toLowerCase();
}

/**
 * A de-duplicated, most-recent-first list of artist keys from an ordered list
 * of recently played tracks (index 0 = most recent).
 */
export function recentArtistKeys(
  recent: Array<{ artistName?: string }>,
  limit = 12,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of recent) {
    const key = artistKey(item.artistName);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Filter a candidate pool down to tracks that do NOT repeat a recently-played
 * artist. Falls back to the full pool when the filter would empty it.
 */
export function applyArtistRepetition<T>(
  candidates: T[],
  artistOf: (candidate: T) => string | undefined,
  recentArtists: string[],
  level: ArtistRepetitionLevel,
): T[] {
  const window = repetitionWindow(level);
  if (window === 0 || candidates.length === 0) return candidates;
  const avoid = new Set(recentArtists.slice(0, window).map(artistKey));
  if (avoid.size === 0) return candidates;
  const fresh = candidates.filter((candidate) => {
    const key = artistKey(artistOf(candidate));
    return key === "" || !avoid.has(key);
  });
  return fresh.length > 0 ? fresh : candidates;
}

/** The option list for a settings radio group. */
export function artistRepetitionOptions(): Array<{
  id: ArtistRepetitionLevel;
  label: string;
  description: string;
}> {
  return ARTIST_REPETITION_LEVELS.map((id) => ({
    id,
    label: ARTIST_REPETITION_META[id].label,
    description: ARTIST_REPETITION_META[id].description,
  }));
}
