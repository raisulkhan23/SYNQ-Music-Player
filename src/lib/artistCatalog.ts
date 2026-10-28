import { cleanArtistName, type YtItem } from "@/lib/youtube";
import { POPULAR_LIMIT } from "@/lib/artistQueries";

// The query plan lives in a dependency-free module because the Convex action
// bundles it; re-exported here so page code has one import to reach for.
export {
  CATALOG_PAGE_QUERIES,
  CATALOG_QUERY_GAP_MS,
  catalogPage,
  catalogQueries,
  POPULAR_LIMIT,
} from "@/lib/artistQueries";

/**
 * Building an artist's catalogue out of search results.
 *
 * SYNQ has no artist table and no discography endpoint: the connected source
 * answers with songs, not with an artist id and a release list. The old artist
 * page therefore treated a single search shelf as "the artist", which is why
 * Popular looked like the whole catalogue.
 *
 * The honest fix is to ask the source a *series* of artist-scoped questions
 * (songs, albums, singles, EPs, live, remixes, features) and then assemble what
 * actually comes back. Nothing here invents a release, a track count, a year or
 * a play count: every row below is a real result the provider returned, and an
 * artist with fewer releases than expected is a truthful answer.
 *
 * Identity is the other half. Matching on display name alone either mixes
 * artists who share a name or drops every collaboration. The rules encoded
 * below are:
 *  - a credit is split into primary credits and `feat.`-style featured credits;
 *  - only a PRIMARY credit can put a track in the artist's own catalogue;
 *  - a featured credit is shown separately and never counted as a release;
 *  - comparison is token-based, so "Daya" does not match "Dayawave".
 */

export type ReleaseKind =
  | "album"
  | "single"
  | "ep"
  | "live"
  | "compilation"
  | "other";

/** Order the discography categories are shown in. */
export const RELEASE_KIND_ORDER: ReleaseKind[] = [
  "album",
  "ep",
  "single",
  "live",
  "compilation",
  "other",
];

export const RELEASE_KIND_LABEL: Record<ReleaseKind, string> = {
  album: "Albums",
  ep: "Singles & EPs",
  single: "Singles",
  live: "Live & acoustic",
  compilation: "Compilations",
  other: "Other releases",
};

/** Fold case, accents and punctuation so two spellings compare equal. */
function fold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * The comparison key for an artist name.
 *
 * Empty when there is no usable name. "Unknown artist" is the sentinel the
 * metadata layer uses for "we have no credit", so it is NOT an identity: a page
 * must never collect every uncredited track under it.
 */
export function artistKey(name: string | null | undefined): string {
  const raw = (name ?? "").trim();
  if (!raw) return "";
  const cleaned = cleanArtistName(raw);
  if (cleaned === "Unknown artist") return "";
  return fold(cleaned);
}

const FEAT_SPLIT_RE = /\b(?:feat|ft|featuring|with)\b\.?\s+(.+)$/i;

/**
 * Split a credit into the artists who are actually billed on it.
 *
 * `"The Chainsmokers feat. Daya"` → primary `["The Chainsmokers"]`, featured
 * `["Daya"]`. Bracketed features (`"Song (feat. X)"`) are attributed the same
 * way. Commas separate names; `&` does NOT, because it is part of plenty of
 * real artist names ("Simon & Garfunkel").
 */
export function splitCredit(credit: string | null | undefined): {
  primary: string[];
  featured: string[];
} {
  const raw = (credit ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return { primary: [], featured: [] };

  const bracketed = raw.match(/[([][^)\]]*\b(?:feat|ft|featuring|with)\b\.?[^)\]]*[)\]]/i);
  // Remove the bracketed feature from the head so "Song (feat. X)" leaves the
  // main artist alone, then read the featured names out of it.
  let head = bracketed ? raw.replace(bracketed[0], " ") : raw;
  const featured: string[] = [];

  if (bracketed) {
    const inner = bracketed[0].match(FEAT_SPLIT_RE);
    if (inner?.[1]) featured.push(...splitNames(inner[1]));
  }

  const inline = head.match(FEAT_SPLIT_RE);
  if (inline) {
    featured.push(...splitNames(inline[1]));
    head = head.slice(0, head.length - inline[0].length);
  }

  return {
    primary: splitNames(head),
    featured: featured.filter(Boolean),
  };
}

function splitNames(value: string): string[] {
  return value
    .replace(/[()[\]]/g, " ")
    // Slashes are NOT separators: AC/DC is one artist, and splitting it made
    // every one of their tracks match neither half of their own name.
    .split(/\s*(?:,|;|\bx\b)\s*/i)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0 && /[\p{L}\p{N}]/u.test(part));
}

/**
 * Does this search row belong to the artist we are showing?
 *
 * True for both a primary credit and a featured one; use `isFeaturedOnly` to
 * tell them apart. A row with no credit never matches.
 */
export function artistMatches(item: YtItem, artist: string): boolean {
  const target = artistKey(artist);
  if (!target) return false;
  const { primary, featured } = splitCredit(item.artist);
  return (
    primary.some((name) => artistKey(name) === target) ||
    featured.some((name) => artistKey(name) === target)
  );
}

/**
 * True when the artist appears only as a guest on the track.
 *
 * These are real appearances, but filing them under the artist's own catalogue
 * would inflate it with someone else's release.
 */
export function isFeaturedOnly(item: YtItem, artist: string): boolean {
  const target = artistKey(artist);
  if (!target) return false;
  const { primary, featured } = splitCredit(item.artist);
  const isPrimary = primary.some((name) => artistKey(name) === target);
  if (isPrimary) return false;
  return featured.some((name) => artistKey(name) === target);
}

/**
 * Which kind of release an album string describes.
 *
 * Only explicit markers count. A bare album name is an album; nothing here
 * guesses a year, a track count or an edition that was not spelled out.
 */
export function releaseKind(album: string | null | undefined): ReleaseKind {
  const value = (album ?? "").toLowerCase();
  if (!value.trim()) return "other";
  if (/\b(live|acoustic|unplugged)\b/.test(value)) return "live";
  if (/\b(greatest hits|best of|compilation|anthology|collection|essential|hits)\b/.test(value))
    return "compilation";
  if (/\b(ep|extended play)\b/.test(value)) return "ep";
  if (/\bsingle\b/.test(value)) return "single";
  return "album";
}

/**
 * The identity of one release.
 *
 * Deliberately STRICTER than `normaliseAlbumName`: that one folds deluxe and
 * remastered editions together, which is right when asking "is this the same
 * album?" but wrong for a discography, where a deluxe edition has its own
 * tracklist. Only decoration that changes no tracklist is folded here.
 */
export function releaseKey(album: string): string {
  return fold(
    album
      // Only decoration that cannot change a tracklist is removed. Edition
      // words (deluxe, expanded, anniversary) stay in the key on purpose:
      // those are exactly the releases whose tracklists differ.
      .replace(/\((?:remaster(?:ed)?|explicit|clean|official[^)]*)\)/gi, " ")
      .replace(/\((?:feat|ft|featuring)\.[^)]*\)/gi, " ")
      .replace(/\[(?:official|audio|video|lyrics?|visuali[sz]er)[^\]]*\]/gi, " ")
      .replace(/\s+/g, " "),
  ).trim();
}

/**
 * Is this row from the exact edition that was asked for?
 *
 * `matchesAlbum` in `artistLinks` folds editions together, which is right when
 * asking "is this a track from Thriller" and wrong on an album page for
 * "Thriller (Deluxe)": the deluxe tracklist is the one the listener clicked.
 * Strict first, loose second, and the caller says which one it got.
 */
export function matchesRelease(
  item: YtItem,
  album: string | null | undefined,
): boolean {
  const wanted = releaseKey(album ?? "");
  if (!wanted) return false;
  const reported = releaseKey(item.album ?? "");
  if (!reported) return false;
  return reported === wanted;
}

export interface Release {
  /** The album string the provider actually reported. */
  album: string;
  artist: string;
  kind: ReleaseKind;
  items: YtItem[];
}

/**
 * Group the artist's tracks into the releases they report.
 *
 * Tracks with no album are dropped rather than filed under a placeholder, and
 * two editions of one album stay separate as long as their album strings differ
 * — which is what keeps a deluxe edition from silently absorbing the standard
 * one.
 */
export function buildReleases(items: YtItem[]): Release[] {
  const groups = new Map<string, Release>();
  for (const item of items) {
    const album = (item.album ?? "").replace(/\s+/g, " ").trim();
    if (!album) continue;
    const key = releaseKey(album) || fold(album);
    if (!key) continue;
    const existing = groups.get(key);
    if (existing) {
      if (!existing.items.some((entry) => entry.id === item.id)) {
        existing.items.push(item);
      }
      continue;
    }
    groups.set(key, {
      album,
      artist: cleanArtistName(item.artist, item.title),
      kind: releaseKind(album),
      items: [item],
    });
  }
  return [...groups.values()].sort((a, b) => {
    const byKind =
      RELEASE_KIND_ORDER.indexOf(a.kind) - RELEASE_KIND_ORDER.indexOf(b.kind);
    if (byKind !== 0) return byKind;
    if (b.items.length !== a.items.length) return b.items.length - a.items.length;
    return a.album.localeCompare(b.album);
  });
}

export interface ArtistCatalog {
  /** Every primary-credit track, deduplicated, provider order preserved. */
  catalog: YtItem[];
  /** The leading rows of the provider's own ranking. */
  popular: YtItem[];
  /** This artist's own releases, grouped. */
  releases: Release[];
  /** Appearances where the artist is a guest. Never counted as releases. */
  featured: YtItem[];
}

/**
 * Assemble the catalogue view from however many rows have been fetched.
 *
 * `raw` is expected to be every row collected so far, in fetch order. Working
 * from the raw stream (rather than a pre-filtered list) means a row that
 * arrives twice from two different queries is counted once, in the position the
 * earlier — provider-ranked — query gave it.
 */
export function buildCatalog(raw: YtItem[], artist: string): ArtistCatalog {
  const seen = new Set<string>();
  const catalog: YtItem[] = [];
  const featured: YtItem[] = [];

  for (const item of raw) {
    if (!item?.id || seen.has(item.id) || item.duration <= 0) continue;
    if (!artistMatches(item, artist)) continue;
    seen.add(item.id);
    if (isFeaturedOnly(item, artist)) featured.push(item);
    else catalog.push(item);
  }

  return {
    catalog,
    popular: catalog.slice(0, POPULAR_LIMIT),
    releases: buildReleases(catalog),
    featured,
  };
}

/** Group releases by kind, in display order, dropping empty categories. */
export function releasesByKind(releases: Release[]): Array<{
  kind: ReleaseKind;
  label: string;
  releases: Release[];
}> {
  return RELEASE_KIND_ORDER.map((kind) => ({
    kind,
    label: RELEASE_KIND_LABEL[kind],
    releases: releases.filter((release) => release.kind === kind),
  })).filter((group) => group.releases.length > 0);
}
