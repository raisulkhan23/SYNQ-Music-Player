/**
 * SYNQ Mixes — pure logic, no imports beyond the shared track shape.
 *
 * A "Mix" here is SYNQ's answer to Apple Music's personalised mixes: a short,
 * named, continuously-usable set of tracks that a listener can press play on
 * and let run. It is NOT a new playback engine and NOT a new recommender. Every
 * track in a mix comes from data SYNQ already has (the recommendation sections
 * the Home page fetches, the listening history, the most-played shelf, the live
 * discovery shelves). This file only decides which of those sets deserve to be
 * called a mix, what to call them, and in what order.
 *
 * ── Why it is pure ─────────────────────────────────────────────────────────
 *
 * No I/O, no clock reads except an injected date, no React. The assembly rules
 * (dedupe, minimum size, daily rotation) can then be tested without a network
 * or a browser, and the Home page stays a renderer rather than a second
 * recommender.
 *
 * ── What it deliberately will NOT do ───────────────────────────────────────
 *
 * It never invents a themed genre. SYNQ has no genre or mood metadata anywhere
 * (see `lib/recommend.ts`), so a "Chill Mix" built by guessing would be fiction
 * wearing a label. Every mix below is named for the real signal that fills it:
 * a mix is "On repeat" because it is the listener's most-played tracks, not
 * because a classifier decided they are energetic.
 *
 * The one playful exception, Guilty Pleasures, is a curated SEARCH (a real
 * upstream query that returns real results on demand) rather than a mix built
 * here — see `MOOD_LAUNCHES` on the Home page. It is kept out of this builder
 * so no mix card can ever claim a taste profile the data cannot support.
 */

import type { YtItem } from "@/lib/youtube";

/** Shape of a stored remote like, as returned by `api.likes.myLikedRemote`. */
export interface RemoteLike {
  trackId: string;
  title: string;
  artistName: string;
  coverUrl: string;
  duration: number;
  youtubeId?: string;
  source: string;
}

/**
 * Build the "favorites" source rows for a mix from the signed-in liked tracks,
 * failing over to tracks the listener has already played when those are thin.
 *
 * The Favorites Mix is the one mix every signed-in listener should actually own,
 * so it is built from the strongest available signal instead of only the liked set
 * (which can be empty when the app cannot reach the provider's catalog). Liked
 * tracks win when present; history and most-played are used as a strict, order-
 * stable fallback.
 */
export function buildFavoritesItems(
  liked: RemoteLike[] | undefined,
  recent: YtItem[],
  mostPlayed: YtItem[],
): YtItem[] {
  const likedItems = likedToYtItems(liked);
  if (likedItems.length > 0) {
    return likedItems.slice(0, MAX_MIX_TRACKS);
  }

  // Fall back to tracks the listener has already chosen for themselves. Most-
  // played is the stronger personal signal, so it comes first; recent augments
  // it when there are not enough most-played tracks to fill the mix.
  const pool = [...mostPlayed, ...recent];
  const seen = new Set<string>();
  const out: YtItem[] = [];
  for (const item of pool) {
    if (!item || !item.id || !item.title || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
    if (out.length >= MAX_MIX_TRACKS) break;
  }
  return out;
}

/** Map the liked-remote snapshot shape onto the `YtItem` shape `buildMixes` uses. */
function likedToYtItems(liked: RemoteLike[] | undefined): YtItem[] {
  if (!liked || liked.length === 0) return [];
  return liked
    .filter((r) => Boolean(r.youtubeId && r.title))
    .map((r) => ({
      id: r.youtubeId!,
      title: r.title,
      artist: r.artistName,
      duration: r.duration,
      thumbnail: r.coverUrl,
    }));
}

/** One personalized mix, ready to render or play. */
export interface Mix {
  id: string;
  name: string;
  subtitle: string;
  items: YtItem[];
  /** Static Tailwind gradient classes for the tile, from SYNQ's palette. */
  accent: string;
  /** Full-width gradient-from-key for the OpenAI cardface render. */
  cardFrom?: string;
}

/** The already-fetched Home data a mix may be assembled from. */
export interface MixSources {
  /** Tracks the listener has liked, newest first (signed-in only). */
  favorites?: RemoteLike[];
  /** The listener's most-played tracks, most played first. */
  mostPlayed?: YtItem[];
  /** Recently played, most recent first. */
  recent?: YtItem[];
  /** The engine's "Discover something new" row. */
  discovery?: YtItem[];
  /** New releases / this week's picks. */
  newMusic?: YtItem[];
  /** The engine's "Sounds like what you play" row. */
  soundAlike?: YtItem[];
  /** Time-of-day picks ("evening music hits" and friends). */
  timeOfDay?: YtItem[];
}

/**
 * How many real tracks a set needs before it is allowed to be called a mix.
 *
 * Below this the card is a lie: three songs is a playlist someone made, not an
 * endless personal mix. Matches the recommendation engine's own hesitancy to
 * personalise from two data points.
 */
export const MIN_MIX_TRACKS = 4;

/** Cap so a huge history does not build a 400-track mix card. */
export const MAX_MIX_TRACKS = 40;

/** A track is usable only if it can actually be identified and played. */
function usable(item: YtItem | undefined | null): item is YtItem {
  return Boolean(item && item.id && item.title);
}

/** De-duplicate by track id, preserving order, and drop unusable rows. */
function clean(items: YtItem[] | undefined): YtItem[] {
  if (!items || items.length === 0) return [];
  const seen = new Set<string>();
  const out: YtItem[] = [];
  for (const item of items) {
    if (!usable(item) || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
    if (out.length >= MAX_MIX_TRACKS) break;
  }
  return out;
}

/** Deterministic rotation so a mix "refreshes" without a stored cursor. */
function rotate<T>(items: T[], by: number): T[] {
  if (items.length === 0) return items;
  const n = ((by % items.length) + items.length) % items.length;
  if (n === 0) return items;
  return [...items.slice(n), ...items.slice(0, n)];
}

/** Day index since the epoch. The seed for the once-a-day mix reshuffle. */
function dayIndex(date: Date): number {
  return Math.floor(date.getTime() / 86_400_000);
}

interface MixBlueprint {
  id: string;
  name: string;
  subtitle: string;
  accent: string;
  /** Full-width gradient-from for the card face when the opener has no art. */
  cardFrom?: string;
  /** Where this mix's tracks come from. */
  pick: (sources: MixSources) => YtItem[];
}

/**
 * The mix catalogue, in display order.
 *
 * Order is by how confident we are the shelf is genuinely personal: "On
 * repeat" is the listener's own play counts, while "Fresh for you" is a live
 * shelf shared by everyone. A brand-new visitor therefore sees the mixes that
 * need no taste at the bottom, and the ones that do at the top never render
 * empty.
 */
const BLUEPRINTS: MixBlueprint[] = [
  {
    id: "favorites",
    name: "Favorites Mix",
    subtitle: "The songs you saved, plus the ones you keep coming back to",
    accent: "from-rose-400/28 to-transparent",
    cardFrom: "from-[rgb(244_63_94/0.32)] via-rose-500/20 to-transparent",
    pick: (s) => buildFavoritesItems(s.favorites, s.recent ?? [], s.mostPlayed ?? []),
  },
  {
    id: "on_repeat",
    name: "On Repeat",
    subtitle: "The songs you keep coming back to",
    accent: "from-[rgb(var(--tint)_/_0.28)] to-transparent",
    cardFrom: "from-[rgb(var(--tint)_/_0.32)] via-[rgb(var(--tint)_/18)] to-transparent",
    pick: (s) => s.mostPlayed ?? [],
  },
  {
    id: "recent",
    name: "Recently Played",
    subtitle: "Pick up where you left off",
    accent: "from-cyan-400/25 to-transparent",
    cardFrom: "from-[rgb(34_211_238/0.32)] via-cyan-400/18 to-transparent",
    pick: (s) => s.recent ?? [],
  },
  {
    id: "sound_alike",
    name: "Sounds Like You",
    subtitle: "Matched by sound, not by name",
    accent: "from-violet-400/25 to-transparent",
    cardFrom: "from-[rgb(139_92_246/0.32)] via-violet-400/18 to-transparent",
    pick: (s) => s.soundAlike ?? [],
  },
  {
    id: "discovery",
    name: "Discovery Mix",
    subtitle: "Near your taste, outside your history",
    accent: "from-emerald-400/25 to-transparent",
    cardFrom: "from-[rgb(5_150_105/0.32)] via-emerald-400/18 to-transparent",
    pick: (s) => s.discovery ?? [],
  },
  {
    id: "new_music",
    name: "New Music",
    subtitle: "Fresh releases worth a listen",
    accent: "from-amber-400/25 to-transparent",
    cardFrom: "from-[rgb(245_158_11/0.32)] via-amber-400/18 to-transparent",
    pick: (s) => s.newMusic ?? [],
  },
  {
    id: "right_now",
    name: "Right Now",
    subtitle: "Picked for this time of day",
    accent: "from-sky-400/25 to-transparent",
    cardFrom: "from-[rgb(14_165_233/0.32)] via-sky-400/18 to-transparent",
    pick: (s) => s.timeOfDay ?? [],
  },
];

/**
 * Build the mixes that have enough real tracks to be worth showing.
 *
 * `date` is injected (defaulting to now) purely so tests can pin the daily
 * rotation; the app never needs to pass it.
 */
export function buildMixes(
  sources: MixSources,
  date: Date = new Date(),
): Mix[] {
  const day = dayIndex(date);
  const mixes: Mix[] = [];
  for (const blueprint of BLUEPRINTS) {
    const items = clean(blueprint.pick(sources));
    if (items.length < MIN_MIX_TRACKS) continue;
    // Shuffle the tail of the larger shelves once a day so a mix the listener
    // plays every morning is not literally the same order forever. The FIRST
    // track is left alone: it is the mix's cover and its opener, and changing
    // it out from under a listener who pressed play yesterday is jarring.
    const rotated =
      items.length > MIN_MIX_TRACKS ? [items[0]!, ...rotate(items.slice(1), day)] : items;
    mixes.push({
      id: blueprint.id,
      name: blueprint.name,
      subtitle: blueprint.subtitle,
      items: rotated,
      accent: blueprint.accent,
    });
  }
  return mixes;
}

/** The artwork for a mix: its opening track's cover, or "" when it has none. */
export function mixCover(mix: Mix): string {
  return mix.items.find((item) => item.thumbnail)?.thumbnail ?? "";
}
