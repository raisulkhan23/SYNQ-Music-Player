/**
 * SYNQ Cold-Start Onboarding — "What are you into?"
 *
 * A brand-new listener has no plays, no likes and no playlists, so every
 * personalised shelf is empty and the app has nothing to go on. Rather than
 * showing a blank Home page, SYNQ asks once: pick a few artists and a couple of
 * moods. Those picks become REAL SEARCH SEEDS, not a fabricated taste vector —
 * the same vocabulary the rest of the app searches with, so the first row a
 * listener sees is genuinely built from what they chose.
 *
 * ── The honesty rule ───────────────────────────────────────────────────────
 *
 * SYNQ has no genre metadata, so "moods" here are curated SEARCH QUERIES that
 * were measured to return real results (the same list the Home mood tiles use),
 * never a genre label attached to a track. The artist list is a set of real
 * artist names the upstream search can resolve. Nothing is inferred about the
 * listener from a pick beyond "they asked for this".
 *
 * ── Why it is pure ─────────────────────────────────────────────────────────
 *
 * Storage helpers are thin localStorage wrappers (mirroring the player store);
 * everything else — eligibility, seed ordering, validation — is pure so the
 * cold-start decision can be tested.
 */

export const ONBOARDING_DONE_KEY = "ss.onboardingDone";
export const TASTE_KEY = "ss.tasteProfile";

export interface TasteProfile {
  /** Artist names the listener picked. */
  artists: string[];
  /** Mood ids (see TASTE_MOODS) the listener picked. */
  moods: string[];
}

export const EMPTY_TASTE: TasteProfile = { artists: [], moods: [] };

/** Max artists/moods that count. Beyond this the picks stop being signal. */
export const MAX_TASTE_ARTISTS = 6;
export const MAX_TASTE_MOODS = 3;
/** Below this many total picks the onboarding is too thin to seed from. */
export const MIN_TASTE_PICKS = 2;

/**
 * Artist picks. Names only — the seed is the name itself, searched upstream.
 * Chosen to span distinct scenes so the first row is not six flavours of the
 * same thing.
 */
export const TASTE_ARTISTS: string[] = [
  "The Weeknd",
  "Taylor Swift",
  "Drake",
  "Billie Eilish",
  "Coldplay",
  "Kendrick Lamar",
  "Arijit Singh",
  "Fleetwood Mac",
  "Daft Punk",
  "Arctic Monkeys",
  "SZA",
  "Bad Bunny",
];

/**
 * Mood picks, each a concrete query with a measured result count — the same
 * "concrete genre noun" vocabulary the Home tiles use, because descriptive
 * English ("focus concentration music") returns nothing upstream.
 */
export const TASTE_MOODS: Array<{ id: string; label: string; query: string }> = [
  { id: "focus", label: "Focus", query: "lofi hip hop" },
  { id: "chill", label: "Chill", query: "acoustic lofi" },
  { id: "workout", label: "Workout", query: "sport electronic" },
  { id: "night", label: "Late night", query: "midnight lofi" },
  { id: "party", label: "Party", query: "funk" },
  { id: "throwback", label: "Throwback", query: "cheesy 80s love songs" },
];

function isMoodId(value: unknown): value is string {
  return typeof value === "string" && TASTE_MOODS.some((m) => m.id === value);
}

/** Coerce a possibly-partial stored profile into a valid, capped one. */
export function normalizeTasteProfile(partial: Partial<TasteProfile> | undefined): TasteProfile {
  const p = partial ?? {};
  const artists: string[] = [];
  const seenArtists = new Set<string>();
  for (const artist of Array.isArray(p.artists) ? p.artists : []) {
    const name = typeof artist === "string" ? artist.trim() : "";
    if (!name) continue;
    const key = name.toLowerCase();
    if (seenArtists.has(key)) continue;
    seenArtists.add(key);
    artists.push(name);
    if (artists.length >= MAX_TASTE_ARTISTS) break;
  }
  const moods: string[] = [];
  for (const mood of Array.isArray(p.moods) ? p.moods : []) {
    if (!isMoodId(mood) || moods.includes(mood)) continue;
    moods.push(mood);
    if (moods.length >= MAX_TASTE_MOODS) break;
  }
  return { artists, moods };
}

export function tastePickCount(profile: TasteProfile): number {
  return profile.artists.length + profile.moods.length;
}

/** Whether the picks are substantial enough to seed a first shelf from. */
export function tasteIsUsable(profile: TasteProfile): boolean {
  return tastePickCount(profile) >= MIN_TASTE_PICKS;
}

/**
 * The search queries a taste profile seeds, in priority order: chosen artists
 * first (the strongest signal), then chosen moods. Deduped.
 */
export function tasteSeedQueries(profile: TasteProfile, max = 6): string[] {
  const queries: string[] = [];
  const seen = new Set<string>();
  const push = (query: string) => {
    const key = query.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    queries.push(query);
  };
  for (const artist of profile.artists) push(artist);
  for (const mood of profile.moods) {
    const match = TASTE_MOODS.find((m) => m.id === mood);
    if (match) push(match.query);
  }
  return queries.slice(0, max);
}

/** Human summary of a profile, e.g. "Taylor Swift, Drake + Chill". */
export function describeTaste(profile: TasteProfile): string {
  const parts = [...profile.artists, ...profile.moods.map((id) => TASTE_MOODS.find((m) => m.id === id)?.label ?? id)];
  if (parts.length === 0) return "";
  const head = parts.slice(0, 2).join(", ");
  return parts.length > 2 ? `${head} +${parts.length - 2}` : head;
}

/**
 * Should onboarding be offered right now?
 *
 * Only to a signed-in listener who has never finished it, has no server-side
 * taste saved, and has no listening history yet — offering "what are you into?"
 * to someone with 400 plays would be insulting.
 */
export function shouldOfferOnboarding(args: {
  signedIn: boolean;
  done: boolean;
  serverTasteSet: boolean;
  hasHistory: boolean;
}): boolean {
  if (!args.signedIn) return false;
  if (args.done) return false;
  if (args.serverTasteSet) return false;
  if (args.hasHistory) return false;
  return true;
}

// --- storage glue ----------------------------------------------------------

export function readTasteProfile(): TasteProfile {
  try {
    const raw = localStorage.getItem(TASTE_KEY);
    if (!raw) return { ...EMPTY_TASTE };
    return normalizeTasteProfile(JSON.parse(raw) as Partial<TasteProfile>);
  } catch {
    return { ...EMPTY_TASTE };
  }
}

export function writeTasteProfile(profile: TasteProfile): TasteProfile {
  const normalized = normalizeTasteProfile(profile);
  try {
    localStorage.setItem(TASTE_KEY, JSON.stringify(normalized));
  } catch {
    // Storage unavailable; the session still holds the choice in memory.
  }
  return normalized;
}

export function isOnboardingDone(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_DONE_KEY) === "1";
  } catch {
    return false;
  }
}

export function markOnboardingDone(): void {
  try {
    localStorage.setItem(ONBOARDING_DONE_KEY, "1");
  } catch {
    // Ignore.
  }
  try {
    window.dispatchEvent(new Event("synq:onboarding-changed"));
  } catch {
    // Ignore.
  }
}
