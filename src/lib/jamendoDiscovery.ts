/**
 * Jamendo as a DISCOVERY index, never as a playback source.
 *
 * WHY THIS FILE EXISTS. Jamendo was wired in as a second playable provider:
 * search returned its Creative Commons streams and the player fed them
 * straight to the `<audio>` element. That path does not work — a listener
 * reported every track silent, Jamendo included, with an ad blocker on.
 *
 * The parts of Jamendo that are still worth having are the parts that never
 * touch the audio element: it is a large index of independent, Creative
 * Commons and openly-licensed music that YouTube search does not rank
 * reliably. So Jamendo now answers the question "what music should I be
 * offered?" and YouTube answers "where does it actually play?".
 *
 * The rule this module exists to enforce: a Jamendo track NEVER becomes a
 * Playable. Every discovery hit must be resolved to a real YouTube upload
 * before it can reach a queue, and an unresolvable hit is dropped rather
 * than shown. A recommendation that cannot play is worse than no
 * recommendation — it teaches the listener the row is decoration.
 *
 * PURE. Resolving a discovery hit to a YouTube upload is a network round
 * trip, so the matching decision is separated from the fetching and can be
 * tested without a browser, a key or a deployment.
 */

import { matchScore } from "./playbackFallback";

/** A Jamendo result, reduced to the fields discovery actually needs. */
export interface DiscoveryTrack {
  jamendoId: string;
  title: string;
  artistName: string;
  duration: number;
}

/** The minimum a YouTube result must have to be matched against. */
export interface DiscoveryCandidate {
  id: string;
  title: string;
  artist: string;
  duration: number;
}

/** A discovery hit that was successfully found on YouTube. */
export interface ResolvedDiscovery {
  /** Kept so the row can credit the independent release it came from. */
  jamendoId: string;
  /** The YouTube video id — this is what will actually play. */
  ytId: string;
  /** Which discovery track produced it. */
  title: string;
  artist: string;
  /** 0..1. */
  score: number;
}

/**
 * Below this, the YouTube result is a different song that happens to share a
 * name. Playing it would be worse than playing nothing: the listener hears
 * music and concludes the app worked.
 */
const MIN_DISCOVERY_MATCH = 0.5;

/** What we search Jamendo for, when the listener has given us nothing. */
export const DISCOVERY_FALLBACKS = ["chillout", "acoustic"] as const;

/**
 * The Jamendo queries to run for a listener.
 *
 * Derived from the artists they actually spend time on rather than from a
 * fixed genre list: a fixed list recommends the same twelve tracks to
 * everybody, which is exactly what this row is supposed not to be.
 *
 * Hard-capped. Each query costs a Jamendo call and then a YouTube lookup per
 * hit, so the fan-out is a reliability decision, not a tuning one.
 */
export function jamendoDiscoveryQueries(
  artistNames: readonly string[],
  limit = 2,
): string[] {
  const seen = new Set<string>();
  const queries: string[] = [];
  for (const raw of artistNames) {
    if (queries.length >= limit) break;
    const name = raw.split(",")[0]?.trim() ?? "";
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(name);
  }
  // Fallbacks are for a listener we know NOTHING about. Padding a partially
  // known listener's queries with generic genres would dilute their own taste
  // with results they never asked for.
  if (queries.length === 0) {
    for (const fallback of DISCOVERY_FALLBACKS) {
      if (queries.length >= limit) break;
      queries.push(fallback);
    }
  }
  return queries;
}

/** True when a Jamendo track is worth trying to resolve at all. */
export function isResolvableDiscovery(track: DiscoveryTrack): boolean {
  // No title means nothing to match on; no duration means the row would be
  // unplayable even if it resolved, which is the exact failure being removed.
  return !!track.title.trim() && track.duration > 0;
}

/**
 * Pick the YouTube upload that is actually the discovered song.
 *
 * Returns null rather than the best available result, for the same reason the
 * playback fallback does: a wrong song is worse than silence.
 */
export function matchDiscovery(
  track: DiscoveryTrack,
  candidates: readonly DiscoveryCandidate[],
): ResolvedDiscovery | null {
  let best: ResolvedDiscovery | null = null;
  for (const candidate of candidates) {
    if (!candidate?.id) continue;
    if (!candidate.duration || candidate.duration <= 0) continue;
    const score = matchScore(
      { title: track.title, artist: track.artistName },
      { title: candidate.title, artist: candidate.artist },
    );
    if (!best || score > best.score) {
      best = {
        jamendoId: track.jamendoId,
        ytId: candidate.id,
        title: track.title,
        artist: track.artistName,
        score,
      };
    }
  }
  if (!best || best.score < MIN_DISCOVERY_MATCH) return null;
  return best;
}

/**
 * Resolve several discovery hits at once, dropping the duplicates and the
 * unresolvable ones.
 *
 * Duplicate YouTube ids are dropped because two different Creative Commons
 * releases of the same song both matching the same upload would otherwise
 * occupy two slots in one row, which reads as a rendering bug.
 */
export function resolveDiscoveries(
  tracks: readonly DiscoveryTrack[],
  resultsByJamendoId: ReadonlyMap<string, readonly DiscoveryCandidate[]>,
): ResolvedDiscovery[] {
  const seen = new Set<string>();
  const resolved: ResolvedDiscovery[] = [];
  for (const track of tracks) {
    if (!isResolvableDiscovery(track)) continue;
    const candidates = resultsByJamendoId.get(track.jamendoId);
    if (!candidates || candidates.length === 0) continue;
    const hit = matchDiscovery(track, candidates);
    if (!hit) continue;
    if (seen.has(hit.ytId)) continue;
    seen.add(hit.ytId);
    resolved.push(hit);
  }
  return resolved;
}
