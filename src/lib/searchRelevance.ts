/**
 * SYNQ search relevance engine.
 *
 * This module is the single source of truth for "does this result answer what
 * the user typed?" It is pure — no React, no Convex, no network — so the
 * backend ranks with exactly the same function the UI uses to explain itself.
 *
 * Why it exists: results used to be returned in whatever order YouTube Music
 * happened to use, filtered only by "is this a music track". Nothing compared
 * the user's query to the result's own title, so an approximate but obvious
 * song query ("we dont talk anymore") could return a lyric upload, a live
 * cover, or an unrelated upload that happened to share the word "talk".
 *
 * Everything here is deliberately general. No query is special-cased.
 */

// ---------------------------------------------------------------------------
// 1. Normalization
// ---------------------------------------------------------------------------

/**
 * Apostrophe-like characters across scripts. These are DELETED rather than
 * replaced with a space, which is the whole trick behind "don't" === "dont":
 *
 *   replacing with a space would give "don t" — two tokens that match nothing.
 *   Deleting gives "dont" — the exact shape users actually type.
 */
const APOSTROPHES = /['’ʼʻ`´ʽ＇]/g;

/**
 * Canonical form used for every comparison in the engine.
 *
 *   "We Don't Talk Anymore"   -> "we dont talk anymore"
 *   "we-dont-talk-anymore"    -> "we dont talk anymore"
 *   "we_dont_talk_anymore"    -> "we dont talk anymore"
 *   "WE  DONT  TALK  ANYMORE" -> "we dont talk anymore"
 *   '"We Don\'t Talk Anymore"' -> "we dont talk anymore"
 *
 * Diacritics fold (so "Beyoncé" matches "beyonce") via combining-mark
 * stripping only, which leaves non-Latin scripts (Cyrillic, CJK, Arabic)
 * intact rather than destroying them.
 *
 * This NEVER touches what the user sees. Displayed titles come from the source
 * verbatim; this string exists only to compare against.
 */
export function normalizeForMatch(value: string): string {
  if (!value) return "";
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritical marks
    .toLowerCase()
    .replace(APOSTROPHES, "")
    .replace(/&/g, " and ")
    // Everything that is not a letter or number becomes a single space:
    // hyphens, underscores, brackets, quotes, slashes, dots, plus, unicode
    // dashes and quotation marks.
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Split normalized text into comparison tokens. */
export function matchTokens(value: string): string[] {
  const normalized = normalizeForMatch(value);
  return normalized.length === 0 ? [] : normalized.split(" ");
}

// ---------------------------------------------------------------------------
// 2. Contraction handling
// ---------------------------------------------------------------------------

/**
 * A deliberately SHORT expansion table.
 *
 * Blindly transforming words is unsafe, so expansion is used only as an
 * *additional matching signal* layered on top of punctuation-insensitive
 * matching — never as a gate, and never to rewrite a query.
 *
 * "dont"/"don't" already match through `normalizeForMatch`. This table covers
 * the case where a user types a fuller word than the title does
 * ("i cannot fly" vs "I Can't Fly").
 */
const CONTRACTIONS: Record<string, string> = {
  dont: "do not",
  doesnt: "does not",
  didnt: "did not",
  cant: "can not",
  cannot: "can not",
  couldnt: "could not",
  wont: "will not",
  wouldnt: "would not",
  shouldnt: "should not",
  isnt: "is not",
  arent: "are not",
  wasnt: "was not",
  werent: "were not",
  hasnt: "has not",
  havent: "have not",
  hadnt: "had not",
  im: "i am",
  ive: "i have",
  ill: "i will",
  id: "i would",
};

const CONTRACTED_TO_EXPANDED: Record<string, string> = Object.fromEntries(
  Object.entries(CONTRACTIONS).map(([k, v]) => [v, k]),
);

/**
 * Queries that spell out a contraction the title uses in short form.
 * "i cannot fly" must still find "I Can't Fly".
 */
const CONTRACTED_SYNONYMS: Record<string, string> = {
  cannot: "cant",
  willnot: "wont",
};

/** Collapsed form of an already-normalized token list ("do not" -> "dont"). */
function collapseTokens(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const pair = `${tokens[i]} ${tokens[i + 1] ?? ""}`.trim();
    const collapsed = CONTRACTED_TO_EXPANDED[pair];
    if (collapsed) {
      out.push(collapsed);
      i++;
    } else {
      out.push(tokens[i]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3. Fuzzy matching
// ---------------------------------------------------------------------------

/** Damerau-Levenshtein with an early exit, for short music tokens. */
function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let prevPrev: number[] = [];
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      // transposition ("form" / "from")
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, prevPrev[j - 2] + 1);
      }
      row.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    prevPrev = prev;
    prev = row;
  }
  return prev[b.length];
}

/**
 * Typos are tolerated only where a typo is plausible. Two-letter words are
 * never fuzzy-matched — otherwise "we" matching "wo" would flood the results.
 */
export function fuzzyTokenEqual(a: string, b: string): boolean {
  if (a === b) return true;
  const longer = Math.max(a.length, b.length);
  if (longer < 4) return false;
  const tolerance = longer >= 8 ? 2 : 1;
  return editDistance(a, b, tolerance) <= tolerance;
}

// ---------------------------------------------------------------------------
// 4. Version awareness
// ---------------------------------------------------------------------------

export type VersionKind =
  | "lyrics"
  | "live"
  | "remix"
  | "cover"
  | "acoustic"
  | "instrumental"
  | "karaoke"
  | "spedup"
  | "slowed"
  | "reverb"
  | "edit"
  | "remaster"
  | "descriptor"
  | "topic";

/**
 * Order matters only for readability — the first hit wins, so "slowed +
 * reverb" classifies as `slowed` rather than as two unrelated markers.
 */
const VERSION_PATTERNS: Array<[VersionKind, RegExp]> = [
  ["slowed", /\b(?:slowed|slow\s*ed|slow\s*n\s*reverb)\b/],
  ["reverb", /\breverb\b/],
  ["spedup", /\b(?:sped\s*up|spedup|nightcore|fast\s*version)\b/],
  ["lyrics", /\b(?:lyrics?|lyrical|letra|lyric\s*video)\b/],
  ["live", /\b(?:live|unplugged|in\s*concert)\b/],
  ["remix", /\b(?:remix|bootleg|mashup|rework|flip)\b/],
  ["cover", /\b(?:cover(?:ed)?|cover\s*version|tribute)\b/],
  ["acoustic", /\bacoustic\b/],
  ["instrumental", /\b(?:instrumental|instrumental\s*version|backing\s*track)\b/],
  ["karaoke", /\b(?:karaoke|in\s*the\s*key\s*of|off\s*vocal)\b/],
  ["edit", /\b(?:radio\s*edit|extended\s*(?:mix|version)|single\s*version|album\s*version)\b/],
  ["remaster", /\b(?:remaster(?:ed)?|\d{4}\s*remaster)\b/],
  // Upload descriptors. These are not "versions" musically, but they MUST be
  // stripped before comparing titles, or "Song [Official Audio]" stops being an
  // exact match for the plain title.
  [
    "descriptor",
    /\b(?:official\s*(?:music\s*)?(?:video|audio)|official|lyric\s*video|music\s*video|visuali[sz]er|hd|hq|4k|full\s*album)\b/,
  ],
  ["topic", /\btopic\b/],
];

const ALL_VERSION_PATTERN = new RegExp(
  VERSION_PATTERNS.map(([, pattern]) => pattern.source).join("|"),
  "g",
);

/** Every version marker present in a title, most significant first. */
export function detectVersions(title: string): VersionKind[] {
  const normalized = normalizeForMatch(title);
  const found: VersionKind[] = [];
  for (const [kind, pattern] of VERSION_PATTERNS) {
    if (pattern.test(normalized)) found.push(kind);
  }
  return found;
}

/** The dominant version marker of a title, or null for a canonical track. */
export function primaryVersion(title: string): VersionKind | null {
  return detectVersions(title)[0] ?? null;
}

/**
 * A featured-artist credit — "(feat. Selena Gomez)", "(ft. L'vibe)" — is a
 * decoration on the title, not a different song. Removing it matters: without
 * this, "We Don't Talk Anymore (feat. Selena Gomez)" is NOT an exact title
 * match for "we dont talk anymore", so every exact-titled cover of the song
 * outranked the artist's own release. It is removed from the RAW title (before
 * normalization) because the brackets have to still be intact for this.
 */
const FEAT_CREDIT_RE = /[([][^)\]]*\b(?:feat|ft|featuring)\b[^)\]]*[)\]]/gi;

/**
 * Title text with version markers removed — the "canonical core" of a song.
 *
 * Falls back to the unstripped title when stripping would empty it (a title
 * that is nothing but a descriptor still has to be comparable to something).
 */
export function stripVersions(title: string): string {
  const withoutFeat = title.replace(FEAT_CREDIT_RE, " ");
  const normalized = normalizeForMatch(withoutFeat);
  const stripped = normalized
    .replace(ALL_VERSION_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length > 0 ? stripped : normalized;
}

/** Human-readable label for a version marker, used in the result row. */
export function versionLabel(kind: VersionKind): string {
  switch (kind) {
    case "lyrics":
      return "Lyrics";
    case "live":
      return "Live";
    case "remix":
      return "Remix";
    case "cover":
      return "Cover";
    case "acoustic":
      return "Acoustic";
    case "instrumental":
      return "Instrumental";
    case "karaoke":
      return "Karaoke";
    case "spedup":
      return "Sped up";
    case "slowed":
      return "Slowed";
    case "reverb":
      return "Reverb";
    case "edit":
      return "Edit";
    case "remaster":
      return "Remaster";
    case "topic":
      return "Topic";
    default:
      return "Official";
  }
}

// ---------------------------------------------------------------------------
// 5. Query intent
// ---------------------------------------------------------------------------

export type SearchIntent = "song" | "artist" | "album" | "version" | "lyrics";

export interface ParsedQuery {
  /** Exactly what the user typed. Never rewritten. Used for history/display. */
  raw: string;
  /** Normalized form of the whole query, version words included. */
  normalized: string;
  /** Normalized query with version markers removed. */
  core: string;
  tokens: string[];
  /** Tokens with version markers removed. */
  coreTokens: string[];
  /** Version markers the user explicitly asked for, e.g. ["live"]. */
  wantedVersions: VersionKind[];
  intent: SearchIntent;
}

const ALBUM_HINT = /\b(?:album|ep|discography|vinyl|full\s*album)\b/i;

/**
 * Parse a user query into everything the ranker needs.
 *
 * Matching is token-based and therefore order-insensitive, but the exact-phrase
 * check still uses `core`, so a literal phrase match keeps a higher score.
 */
export function parseQuery(raw: string): ParsedQuery {
  const normalized = normalizeForMatch(raw);
  const wantedVersions = detectVersions(raw);
  const core = stripVersions(raw);
  const tokens = normalized.length ? normalized.split(" ") : [];
  const coreTokens = core.length ? core.split(" ") : [];

  let intent: SearchIntent = "song";
  if (wantedVersions.length > 0) {
    intent = wantedVersions.includes("lyrics") ? "lyrics" : "version";
  } else if (ALBUM_HINT.test(raw)) {
    intent = "album";
  } else if (/\b(?:lyrics?)\b/i.test(raw)) {
    intent = "lyrics";
  }

  return { raw, normalized, core, tokens, coreTokens, wantedVersions, intent };
}

// ---------------------------------------------------------------------------
// 6. Scoring
// ---------------------------------------------------------------------------

/** A minimal result shape; the engine does not care where results come from. */
export interface RankableItem {
  id: string;
  title: string;
  artist: string;
  album?: string;
}

export interface ScoredItem<T extends RankableItem = RankableItem> {
  item: T;
  score: number;
  /** 1 (exact) … 6 (weakly related). Lower is better. */
  tier: number;
  /** Fraction of core query tokens found in title+artist, fuzzy allowed. */
  coverage: number;
  /** Short human-readable reasons, used for the result row's match badge. */
  reasons: string[];
  versions: VersionKind[];
}

/**
 * Tier weights. The gaps are deliberate: an exact title match must never be
 * displaced by a partial match, however many tokens that partial match covers.
 */
const TIER_SCORE: Record<number, number> = {
  1: 10_000, // exact normalized title match
  2: 6_000, // title is the query plus/minus minor decoration
  3: 3_200, // every query word is in the title (any order), or title + artist
  4: 1_400, // strong partial title match
  5: 600, // artist match
  6: 150, // weak / related
};

/**
 * Results below this are not shown at all. This is what stops a result that
 * shares a single common word ("we", "the", "talk") from being displayed.
 */
export const MIN_RELEVANCE = 90;

/**
 * Below this much token coverage anywhere in a pool, the pool was not an
 * answer to the query — see `bestPoolCoverage`.
 */
export const MIN_POOL_COVERAGE = 0.25;

/** A title must account for at least this much of the query to count as
 *  "the query is contained in / contains the title" at tier 2. Without it,
 *  a two-word title buried inside a four-word query outranks the real song. */
const TIER2_LENGTH_RATIO = 0.6;

/** Word-boundary-safe phrase containment over normalized strings. */
function containsPhrase(haystack: string, needle: string): boolean {
  if (!needle) return false;
  if (haystack === needle) return true;
  return ` ${haystack} `.includes(` ${needle} `);
}

/** Ordered subsequence check — is `needleTokens` an ordered subsequence of `haystackTokens`? */
function isSubsequence(needleTokens: string[], haystackTokens: string[]): boolean {
  if (needleTokens.length === 0) return true;
  let i = 0;
  for (const token of haystackTokens) {
    if (i < needleTokens.length && token === needleTokens[i]) i++;
  }
  return i === needleTokens.length;
}

/**
 * Resolve "title AND artist" queries in EITHER word order.
 *
 * The query is split at every possible boundary; a split is accepted when the
 * artist field fully accounts for one side (fuzzy-tolerant) and the remaining
 * side is the result's own title. Both orderings are tried, so
 *
 *   "charlie puth we dont talk anymore"
 *   "we dont talk anymore charlie puth"
 *   "charlie puth dont talk anymore"
 *
 * all resolve to the same canonical entry — which is what makes word order
 * irrelevant without weakening the exact-title path.
 *
 * Contiguity is not required of the artist field, only of the query split, so
 * this stays cheap: at most 2n checks for n query tokens.
 */
function resolvesTitleAndArtist(
  coreTokens: string[],
  titleCore: string,
  artistTokens: string[],
): boolean {
  if (coreTokens.length < 2 || !titleCore || artistTokens.length === 0) return false;
  const artistCovers = (part: string[]): boolean =>
    part.length > 0 &&
    part.every((token) => artistTokens.some((c) => fuzzyTokenEqual(c, token)));
  const titleAgrees = (part: string[]): boolean => {
    const phrase = part.join(" ");
    return (
      phrase.length > 0 &&
      (containsPhrase(titleCore, phrase) || containsPhrase(phrase, titleCore))
    );
  };
  for (let k = 1; k < coreTokens.length; k++) {
    const head = coreTokens.slice(0, k);
    const tail = coreTokens.slice(k);
    if (artistCovers(head) && titleAgrees(tail)) return true;
    if (artistCovers(tail) && titleAgrees(head)) return true;
  }
  return false;
}

/**
 * Coverage of `queryTokens` by `targetTokens`, allowing fuzzy token matches
 * and contraction expansion/collapse in both directions.
 */
function coverageOf(
  queryTokens: string[],
  targetTokens: string[],
  allowFuzzy: boolean,
): { covered: number; fuzzy: number; matched: string[] } {
  const collapsed = collapseTokens(targetTokens);
  let fuzzy = 0;
  const matched: string[] = [];
  const claim = (token: string, wasFuzzy: boolean) => {
    matched.push(token);
    if (wasFuzzy) fuzzy++;
  };
  for (const token of queryTokens) {
    if (targetTokens.includes(token) || collapsed.includes(token)) {
      claim(token, false);
      continue;
    }
    // The result spells the token out in full ("do not") while the query used
    // the contraction ("dont"), or vice versa.
    const expansion = CONTRACTIONS[token];
    if (expansion) {
      const parts = expansion.split(" ");
      if (parts.every((part) => targetTokens.includes(part) || collapsed.includes(part))) {
        claim(token, true);
        continue;
      }
    }
    const reverse = CONTRACTED_SYNONYMS[token];
    if (reverse && (targetTokens.includes(reverse) || collapsed.includes(reverse))) {
      claim(token, true);
      continue;
    }
    if (allowFuzzy && targetTokens.some((candidate) => fuzzyTokenEqual(candidate, token))) {
      claim(token, true);
    }
  }
  return { covered: matched.length, fuzzy, matched };
}

/**
 * Score a single result against a parsed query.
 *
 * Returns `null` when the result is not relevant enough to show at all.
 */
export function scoreItem<T extends RankableItem>(
  item: T,
  parsed: ParsedQuery,
): ScoredItem<T> | null {
  const { core, coreTokens } = parsed;
  if (coreTokens.length === 0) return null;

  const titleCore = stripVersions(item.title);
  const titleTokens = titleCore.length ? titleCore.split(" ") : [];
  const artistCore = normalizeForMatch(item.artist);
  const artistTokens = artistCore.length ? artistCore.split(" ") : [];
  const combinedTokens = titleTokens.concat(artistTokens);

  const versions = detectVersions(item.title);
  const resultVersions = new Set(versions);
  const reasons: string[] = [];

  const combined = coverageOf(coreTokens, combinedTokens, true);
  const coverage = combined.covered / coreTokens.length;
  const title = coverageOf(coreTokens, titleTokens, true);
  const titleCoverage = title.covered / coreTokens.length;
  const artist = coverageOf(coreTokens, artistTokens, true);
  const artistCoverage = artist.covered / coreTokens.length;
  // Union coverage: how much of the query is accounted for when the title and
  // artist fields are allowed to split the work between them.
  const unionCovered = new Set<string>([...title.matched, ...artist.matched]).size;
  const splitMatched = resolvesTitleAndArtist(coreTokens, titleCore, artistTokens);

  // --- version intent ------------------------------------------------------
  let versionBonus = 0;
  if (parsed.wantedVersions.length > 0) {
    if (parsed.wantedVersions.some((v) => resultVersions.has(v))) {
      versionBonus += 2_200;
      reasons.push("requested version");
    }
  } else if (versions.length > 0) {
    // No version was requested, so a derived upload must not outrank the
    // canonical track.
    versionBonus -= 700;
  }

  // --- tier selection ------------------------------------------------------
  let tier: number;
  let score: number;

  const exactTitle = core.length > 0 && titleCore === core;
  // A query that names BOTH the title and the artist, resolved to a single
  // catalog entry, outranks a title-only match: it satisfies more of what the
  // user actually asked for.
  const fullIntent = splitMatched;
  const queryPhraseInTitle = containsPhrase(titleCore, core);
  const titlePhraseInQuery =
    titleCore.length > 0 &&
    containsPhrase(core, titleCore) &&
    titleTokens.length / coreTokens.length >= TIER2_LENGTH_RATIO;
  const titleIsSubsequence =
    titleTokens.length >= 2 &&
    isSubsequence(titleTokens, coreTokens) &&
    titleTokens.length / coreTokens.length >= TIER2_LENGTH_RATIO;
  const queryIsArtist = artistCoverage === 1 && artistTokens.length > 0;

  if (fullIntent) {
    tier = 1;
    score = TIER_SCORE[1] + 1_000;
    reasons.push("title and artist match");
  } else if (exactTitle) {
    tier = 1;
    score = TIER_SCORE[1];
    reasons.push("exact title match");
  } else if (queryPhraseInTitle) {
    tier = 2;
    score = TIER_SCORE[2];
    reasons.push("title contains query");
  } else if (titlePhraseInQuery || titleIsSubsequence) {
    tier = 2;
    score = TIER_SCORE[2];
    reasons.push("title matches query");
  } else if (unionCovered === coreTokens.length && titleCoverage > 0 && artistCoverage > 0) {
    // Every query word is accounted for, split across title and artist.
    tier = 3;
    score = TIER_SCORE[3];
    reasons.push("title and artist match");
  } else if (titleCoverage === 1 && queryIsArtist) {
    tier = 3;
    score = TIER_SCORE[3];
    reasons.push("title and artist match");
  } else if (titleCoverage === 1) {
    // Every query word is in the title, just not adjacent or in order.
    tier = 3;
    score = TIER_SCORE[3] * 0.85;
    reasons.push("all query words in title");
  } else if (titleCoverage >= 0.75 && coverage >= 0.75) {
    // e.g. query "we dont talk anymore" -> title "Don't Talk Anymore".
    tier = 4;
    score = TIER_SCORE[4];
    reasons.push("strong partial title match");
  } else if (queryIsArtist && coverage >= 0.5) {
    tier = 5;
    score = TIER_SCORE[5];
    reasons.push("artist match");
  } else if (coverage >= 0.6 && titleCoverage > 0) {
    tier = 6;
    score = TIER_SCORE[6];
    reasons.push("partial match");
  } else {
    return null;
  }

  score += versionBonus;

  // --- tie-breakers (never large enough to cross a tier gap) ----------------
  // Adjacency: the query words appear next to each other somewhere.
  if (tier > 1 && containsPhrase(combinedTokens.join(" "), core)) score += 260;
  // Fuzzy matches rank below exact ones inside the same tier.
  score -= (combined.fuzzy + title.fuzzy) * 30;
  // The query naming the artist is a strong signal — but it must never lift a
  // result out of its tier, or an artist-only match would beat a real title.
  if (artistCoverage > 0) {
    score += Math.min(300, Math.round(artistCoverage * 300));
    if (tier <= 3 && artistTokens.length > 0) reasons.push("artist matches query");
  }
  // A title much longer than the query is usually a different song that merely
  // embeds the words ("12 songs we dont talk anymore mix").
  const lengthRatio = core.length / Math.max(1, titleCore.length);
  if (lengthRatio < 0.5 && tier > 1) score -= 220;
  // Prefer shorter, tidier titles at equal relevance.
  score += Math.max(0, 60 - titleTokens.length * 6);

  if (score < MIN_RELEVANCE) return null;

  return {
    item,
    score: Math.round(score),
    tier,
    coverage,
    reasons,
    versions,
  };
}

// ---------------------------------------------------------------------------
// 7. Ranking + dedupe
// ---------------------------------------------------------------------------

/**
 * Stable sort: the provider's own ordering is preserved for equal scores, so
 * ranking never shuffles results that the engine considers equally relevant.
 */
function sortScored<T extends RankableItem>(scored: ScoredItem<T>[]): ScoredItem<T>[] {
  return scored
    .map((value, index) => ({ value, index }))
    .sort((a, b) => b.value.score - a.value.score || a.index - b.index)
    .map(({ value }) => value);
}

/**
 * Rank and deduplicate across ALL sources at once.
 *
 * Sources are NOT concatenated: every candidate competes in one global
 * ranking, so a weak hit from one source can never sit above a strong hit from
 * another.
 *
 * The version kind is part of the dedupe key, so a live take and the studio
 * cut are never merged — but three uploads of the same canonical track by the
 * same artist collapse to the best-scoring one.
 */
export function rankSearchResults<T extends RankableItem>(
  items: T[],
  rawQuery: string,
  limit = 25,
): ScoredItem<T>[] {
  const parsed = parseQuery(rawQuery);
  const scored: ScoredItem<T>[] = [];
  for (const item of items) {
    const result = scoreItem(item, parsed);
    if (result) scored.push(result);
  }

  const seenIds = new Set<string>();
  const seenTracks = new Set<string>();
  const deduped: ScoredItem<T>[] = [];

  for (const candidate of sortScored(scored)) {
    if (seenIds.has(candidate.item.id)) continue;
    const versionKey = candidate.versions[0] ?? "canonical";
    const trackKey = `${stripVersions(candidate.item.title)}|${normalizeForMatch(
      candidate.item.artist,
    )}|${versionKey}`;
    if (seenTracks.has(trackKey)) continue;
    seenIds.add(candidate.item.id);
    seenTracks.add(trackKey);
    deduped.push(candidate);
    if (deduped.length >= limit) break;
  }

  return deduped;
}

/** Rank, then map back to the original item shape. */
export function rankAndStrip<T extends RankableItem>(
  items: T[],
  rawQuery: string,
  limit = 25,
): T[] {
  return rankSearchResults(items, rawQuery, limit).map((entry) => entry.item);
}

/**
 * Fallback ladder (spec §22): progressively broader matching, used when the
 * strict pass finds nothing. Returns a better-than-nothing ordering of the
 * same candidate pool without inventing unrelated content.
 */
export function broadFallbackOrder<T extends RankableItem>(
  items: T[],
  rawQuery: string,
  limit = 10,
): T[] {
  const parsed = parseQuery(rawQuery);
  // Re-score with the version words stripped from BOTH sides, so a request
  // that named a version can still fall back to the canonical track.
  const relaxed: ParsedQuery = {
    ...parsed,
    core: stripVersions(parsed.core),
    coreTokens: (stripVersions(parsed.core) || parsed.core).split(" ").filter(Boolean),
    wantedVersions: [],
  };
  const relaxedScored: ScoredItem<T>[] = [];
  for (const item of items) {
    const result = scoreItem(item, relaxed);
    if (result) relaxedScored.push(result);
  }
  return sortScored(relaxedScored)
    .slice(0, limit)
    .map((entry) => entry.item);
}

/**
 * Best token coverage found anywhere in a result pool.
 *
 * Used to tell two very different situations apart, which look identical
 * from the outside — both surface as "no results":
 *
 *   1. The catalogue genuinely has no such song.
 *   2. The source never really answered and returned a generic shelf.
 *
 * A shelf in which not even ONE query word appears anywhere is not an answer
 * to that query. This measures that without knowing anything about the song.
 * General, and not tied to any particular query.
 */
export function bestPoolCoverage(
  items: readonly RankableItem[],
  rawQuery: string,
): number {
  const parsed = parseQuery(rawQuery);
  if (parsed.coreTokens.length === 0) return 1;
  let best = 0;
  for (const item of items) {
    const titleCore = stripVersions(item.title);
    const titleTokens = titleCore.length ? titleCore.split(" ") : [];
    const artistTokens = normalizeForMatch(item.artist)
      .split(" ")
      .filter(Boolean);
    const { covered } = coverageOf(
      parsed.coreTokens,
      titleTokens.concat(artistTokens),
      true,
    );
    best = Math.max(best, covered / parsed.coreTokens.length);
  }
  return best;
}

// ---------------------------------------------------------------------------
// 8. Suggestions
// ---------------------------------------------------------------------------

/**
 * Rank candidate strings as type-ahead suggestions for a partial query.
 *
 * Suggestions use the SAME normalized/fuzzy comparison as ranking, so typing
 * "we dont tal" surfaces "We Don't Talk Anymore" instead of only strings that
 * happen to reproduce the user's exact punctuation.
 *
 * Candidates come from metadata already in memory, so suggestions cost no
 * extra network request.
 */
export function buildSuggestions(
  rawQuery: string,
  candidates: readonly string[],
  limit = 6,
): string[] {
  const normalized = normalizeForMatch(rawQuery);
  if (normalized.length < 2) return [];
  const queryTokens = normalized.split(" ");

  const seen = new Set<string>();
  const scored: Array<{ label: string; score: number }> = [];

  for (const label of candidates) {
    const normalizedLabel = normalizeForMatch(label);
    if (!normalizedLabel || seen.has(normalizedLabel)) continue;
    seen.add(normalizedLabel);

    if (normalizedLabel.startsWith(normalized)) {
      scored.push({ label, score: 1_000 + normalized.length });
      continue;
    }

    const labelTokens = normalizedLabel.split(" ");
    let matched = 0;
    let prefixHits = 0;
    for (const queryToken of queryTokens) {
      const hit = labelTokens.find(
        (token) =>
          fuzzyTokenEqual(token, queryToken) ||
          token.startsWith(queryToken) ||
          queryToken.startsWith(token),
      );
      if (hit) {
        matched++;
        if (hit.startsWith(queryToken)) prefixHits++;
      }
    }
    // Require most of the partial query to land, so a single shared character
    // never produces a suggestion list.
    if (matched < Math.max(1, Math.ceil(queryTokens.length * 0.7))) continue;
    scored.push({
      label,
      score: matched * 100 + prefixHits * 40 - labelTokens.length,
    });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.label.length - b.label.length)
    .slice(0, limit)
    .map((entry) => entry.label);
}