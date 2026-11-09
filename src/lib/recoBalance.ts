/**
 * Home-level recommendation coordination — PURE.
 *
 * THE BUG THIS FIXES
 * ------------------
 * Every shelf used to be ranked on its own, and the discovery shelf was filled
 * from a single text search anchored on the listener's top artist
 * (`new songs like <artist>`). The provider answers that query with the
 * artist's OWN catalogue. So a listener who played one Taylor Swift track got
 * an entire "Discover something new" row of Taylor Swift — the exact opposite
 * of discovery — and, because the per-row artist cap was 2, a row of exactly
 * two cards. The same artist then reappeared in every other row too, since
 * `usedIds` deduplicated TRACKS across shelves but nothing deduplicated
 * ARTISTS.
 *
 * Three separate coordination problems, three separate functions here:
 *
 *   1. `discoveryAnchors` + `excludeAnchors`
 *      A discovery row must never be filled by the artist it was discovered
 *      FROM. This is a structural rule, not a query tweak: it holds even when
 *      the provider ignores the "new songs like" phrasing and returns the
 *      anchor's catalogue anyway.
 *
 *   2. `blendDiscovery`
 *      Discovery is a blend of related / adjacent / broad candidates rather
 *      than one search's output, so no single source can define the row.
 *
 *   3. `allocateWithBudget`
 *      One coordinator sees every shelf at once and spends each candidate
 *      once, under a page-wide per-artist budget. Ranking each shelf in
 *      isolation is what let one artist own half the page.
 *
 * Nothing here invents metadata: artists are compared with the engine's own
 * `artistKey`, and candidates come in already resolved to real playable
 * tracks. Everything is deterministic given its input, so the balance rules
 * can be tested without a network or a database.
 */

import { trackKey } from "./recommend";
// The COMPARISON key, not the display-oriented one in `recommend.ts`.
//
// `notInterested.artistKey` is the app's canonical identity for an artist: it
// is what exclusions are stored and matched with, and it strips the channel
// noise ("- Topic", a glued "VEVO") that makes one artist look like three.
// Anchor filtering has to use the same key, or a row could exclude "Taylor
// Swift" and still show "TaylorSwiftVEVO".
import { artistKey } from "./notInterested";

/** The minimum a candidate needs for the rules below. */
export interface BalanceItem {
  id: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  thumbnail?: string;
}

/**
 * How many tracks one artist may occupy across the whole Home page.
 *
 * Four, not two and not unlimited. Two is what produced "this shelf has two
 * songs"; unlimited is what let one artist own the page. With five shelves of
 * up to fourteen cards, an artist at four is clearly present but never the
 * story.
 */
export const DEFAULT_ARTIST_BUDGET = 4;

/** Per-shelf artist cap. Discovery is deliberately stricter (see below). */
export const DEFAULT_SECTION_ARTIST_CAP = 2;

/**
 * Discovery allows exactly one track per artist.
 *
 * The row's promise is "music you have not explored yet"; two tracks by the
 * same new artist is not an exploration, it is a playlist.
 */
export const DISCOVERY_ARTIST_CAP = 1;

/** Below this a shelf is dropped instead of rendered as a stub. */
export const DEFAULT_MIN_PER_SECTION = 4;

/**
 * The artists a discovery row must NOT be filled with.
 *
 * Anchors are the strongest artists in the listener's profile — the ones whose
 * names were used to build the discovery searches. Excluding them is what
 * makes the row honest: the engine searched "new songs like X" *in order to
 * find things that are not X*.
 *
 * Capped at three anchors: beyond that the profile is rich enough that
 * excluding everyone it knows would leave nothing to discover.
 */
export function discoveryAnchors(
  artists: Iterable<{ key: string; affinity: number }>,
  limit = 3,
): Set<string> {
  const ranked = [...artists]
    .map((entry) => ({ ...entry, key: artistKey(entry.key) }))
    .filter((entry) => entry.key && entry.affinity > 0)
    .sort((a, b) => b.affinity - a.affinity)
    .slice(0, Math.max(0, limit));
  return new Set(ranked.map((entry) => entry.key));
}

/**
 * Drop anything by an anchor artist.
 *
 * Compared with `artistKey`, so "Taylor Swift", "TaylorSwiftVEVO" and
 * "Taylor Swift - Topic" are all recognised as the same anchor.
 */
export function excludeAnchors<T extends BalanceItem>(
  items: T[],
  anchors: Iterable<string>,
): T[] {
  const blocked = anchors instanceof Set ? anchors : new Set(anchors);
  if (blocked.size === 0) return items;
  return items.filter((item) => {
    const key = artistKey(item.artist);
    return !key || !blocked.has(key);
  });
}

/**
 * Keep at most `max` tracks per artist, preserving input order.
 *
 * Used for the single-artist-pool case: if a provider hands back fifteen
 * tracks by one artist and nothing else, this returns at most `max` of them
 * rather than pretending the row is diverse.
 */
export function capPerArtist<T extends BalanceItem>(
  items: T[],
  max = DEFAULT_SECTION_ARTIST_CAP,
): T[] {
  if (max <= 0) return [];
  const counts = new Map<string, number>();
  const out: T[] = [];
  for (const item of items) {
    const key = artistKey(item.artist);
    const seen = key ? (counts.get(key) ?? 0) : 0;
    if (key && seen >= max) continue;
    if (key) counts.set(key, seen + 1);
    out.push(item);
  }
  return out;
}

/** Absolute maximum length of a discovery row. */
export const DISCOVERY_LIMIT = 14;

/** The three sources a discovery row is blended from. */
export interface DiscoveryPools<T> {
  /**
   * "More like what you play" — results of the anchor-based discovery
   * searches, with the anchors themselves already removed.
   */
  related: T[];
  /**
   * Sound-similarity results from the music vector index. This is the only
   * source that can surface an artist the listener never named.
   */
  adjacent: T[];
  /** Real, broad provider searches — the exploration floor of the row. */
  broad: T[];
}

/** Starting balance of the discovery row. Tunable, not sacred. */
export interface DiscoveryWeights {
  related: number;
  adjacent: number;
  broad: number;
}

export const DEFAULT_DISCOVERY_WEIGHTS: DiscoveryWeights = {
  related: 0.6,
  adjacent: 0.25,
  broad: 0.15,
};

/**
 * Interleave the three discovery pools into one row.
 *
 * Quotas are computed from the weights and then filled in rounds, so a pool
 * that is short (say the vector index is cold) does not leave a gap: its
 * unused slots roll over to the pools that do have candidates. The result is
 * always as long as the available distinct, artist-capped material allows —
 * and never padded with a repeat.
 *
 * Order inside the row is also interleaved rather than concatenated, so the
 * first cards a listener sees are not all "related" and the last ones all
 * "broad".
 */
export function blendDiscovery<T extends BalanceItem>(
  pools: DiscoveryPools<T>,
  options: {
    limit?: number;
    weights?: DiscoveryWeights;
    maxPerArtist?: number;
    /** Ids/keys already used elsewhere on the page. */
    reserved?: Iterable<string>;
  } = {},
): T[] {
  const limit = Math.max(0, options.limit ?? DISCOVERY_LIMIT);
  if (limit === 0) return [];
  const weights = options.weights ?? DEFAULT_DISCOVERY_WEIGHTS;
  const maxPerArtist = Math.max(1, options.maxPerArtist ?? DISCOVERY_ARTIST_CAP);

  const reserved = new Set<string>(options.reserved ?? []);
  const usedArtists = new Map<string, number>();
  const out: T[] = [];
  const seenIds = new Set<string>();
  const seenTracks = new Set<string>();

  /** Is this candidate still usable? */
  const available = (item: T) => {
    if (!item || !item.id || !item.title) return false;
    if (seenIds.has(item.id) || reserved.has(item.id)) return false;
    const identity = trackKey(item);
    if (identity && seenTracks.has(identity)) return false;
    const key = artistKey(item.artist);
    if (key && (usedArtists.get(key) ?? 0) >= maxPerArtist) return false;
    return true;
  };

  const accept = (item: T) => {
    seenIds.add(item.id);
    const identity = trackKey(item);
    if (identity) seenTracks.add(identity);
    const key = artistKey(item.artist);
    if (key) usedArtists.set(key, (usedArtists.get(key) ?? 0) + 1);
    out.push(item);
  };

  // Working copies, so a rejected candidate is never reconsidered.
  const queues: Array<{ key: keyof DiscoveryPools<T>; items: T[]; cursor: number }> = (
    ["related", "adjacent", "broad"] as const
  ).map((key) => ({ key, items: pools[key] ?? [], cursor: 0 }));

  /** Pull the next usable candidate from one queue, advancing past rejects. */
  const take = (queue: (typeof queues)[number]): T | null => {
    while (queue.cursor < queue.items.length) {
      const candidate = queue.items[queue.cursor];
      queue.cursor += 1;
      if (candidate && available(candidate)) return candidate;
    }
    return null;
  };

  const totalWeight =
    Math.max(0, weights.related) +
      Math.max(0, weights.adjacent) +
      Math.max(0, weights.broad) || 1;

  /**
   * Quotas, in slots out of `limit`. Floors leave a remainder that is spent
   * later by whoever still has material, which is what lets one short pool
   * hand its share to the others.
   */
  const quota = (weight: number) =>
    Math.floor((Math.max(0, weight) / totalWeight) * limit);

  const quotas = new Map<keyof DiscoveryPools<T>, number>([
    ["related", quota(weights.related)],
    ["adjacent", quota(weights.adjacent)],
    ["broad", quota(weights.broad)],
  ]);

  // Round 1: fill each pool's own quota.
  for (const queue of queues) {
    const want = quotas.get(queue.key) ?? 0;
    let taken = 0;
    while (taken < want && out.length < limit) {
      const candidate = take(queue);
      if (!candidate) break;
      accept(candidate);
      taken += 1;
    }
  }

  // Round 2: spend the remainder, cycling pools in weight order so the row
  // still leans the way the weights say rather than by whichever pool happens
  // to be longest.
  const order = [...queues].sort(
    (a, b) => (weights[b.key] ?? 0) - (weights[a.key] ?? 0),
  );
  let progressed = true;
  while (out.length < limit && progressed) {
    progressed = false;
    for (const queue of order) {
      if (out.length >= limit) break;
      const candidate = take(queue);
      if (!candidate) continue;
      accept(candidate);
      progressed = true;
    }
  }

  return out;
}

/** One shelf's ranked pool, in priority order. */
export interface SectionPool<T> {
  id: string;
  /** Generously ranked — the coordinator spends from here. */
  pool: T[];
}

/** A shelf after coordination. `items: []` means "do not render". */
export interface AllocatedSection<T> {
  id: string;
  items: T[];
}

/**
 * Spend the whole page's candidates at once.
 *
 * Sections are served in the order given, which is priority order: the first
 * shelf keeps its best cards, and later shelves get the next distinct ones.
 * Three limits apply together:
 *
 *   - a page-wide per-artist budget (`maxPerArtistTotal`),
 *   - a per-shelf per-artist cap (`sectionArtistCap`, default 2),
 *   - a per-shelf length (`perSection`).
 *
 * A shelf that cannot reach `minPerSection` is returned empty rather than as a
 * stub, and nothing is ever padded with a filler track to reach a count: fewer
 * honest cards beat a padded row.
 */
export function allocateWithBudget<T extends BalanceItem>(
  sections: Array<SectionPool<T>>,
  options: {
    perSection?: number;
    minPerSection?: number;
    maxPerArtistTotal?: number;
    sectionArtistCap?: Record<string, number>;
    /**
     * Per-shelf override for `minPerSection`.
     *
     * "Recommended for you" is the page's headline row: three honest cards
     * there is better than no row at all, whereas a three-card Discovery row
     * would read as a failure. Different shelves, different floors.
     */
    sectionMin?: Record<string, number>;
    /** Ids/recording keys already visible elsewhere on the page. */
    reserved?: Iterable<string>;
  } = {},
): Array<AllocatedSection<T>> {
  const perSection = Math.max(1, options.perSection ?? 14);
  const minPerSection = Math.max(1, options.minPerSection ?? DEFAULT_MIN_PER_SECTION);
  const totalBudget = Math.max(
    1,
    options.maxPerArtistTotal ?? DEFAULT_ARTIST_BUDGET,
  );
  const reserved = new Set<string>(options.reserved ?? []);

  /** Artist -> tracks already spent, across every shelf so far. */
  const spent = new Map<string, number>();
  const shownIds = new Set<string>(reserved);
  const shownTracks = new Set<string>();

  return sections.map((section) => {
    const cap = Math.max(
      1,
      options.sectionArtistCap?.[section.id] ?? DEFAULT_SECTION_ARTIST_CAP,
    );
    const floor = Math.max(
      1,
      options.sectionMin?.[section.id] ?? minPerSection,
    );
    const inSection = new Map<string, number>();
    const chosen: T[] = [];

    for (const item of section.pool) {
      if (chosen.length >= perSection) break;
      if (!item || !item.id || !item.title) continue;
      if (shownIds.has(item.id)) continue;
      const identity = trackKey(item);
      if (identity && shownTracks.has(identity)) continue;
      const key = artistKey(item.artist);
      if (key) {
        if ((spent.get(key) ?? 0) >= totalBudget) continue;
        if ((inSection.get(key) ?? 0) >= cap) continue;
        spent.set(key, (spent.get(key) ?? 0) + 1);
        inSection.set(key, (inSection.get(key) ?? 0) + 1);
      }
      shownIds.add(item.id);
      if (identity) shownTracks.add(identity);
      chosen.push(item);
    }

    return {
      id: section.id,
      items: chosen.length >= floor ? chosen : [],
    };
  });
}
