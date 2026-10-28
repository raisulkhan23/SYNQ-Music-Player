import { cleanArtistName, type YtItem } from "@/lib/youtube";

/**
 * Artist and album routing.
 *
 * SYNQ has no artist table and no album table — there is no stable id for
 * either, only the display strings that came back with a track. These helpers
 * therefore route on those real names, which is the same thing the app already
 * does when it links an artist into a search (`artistSearchQuery`). Nothing
 * here invents an identifier: if a name is missing, there is no link.
 */

/**
 * Fold an album title to something two spellings of the same album match on.
 *
 * The descriptor words ("Album", "EP", "Explicit", "Single") are stripped so
 * "Thriller (Deluxe Edition)" and "Thriller" land on one key — but ONLY while
 * something survives. An album genuinely titled "EP" or "Album" used to
 * normalise to the empty string, and the empty string is a perfectly good map
 * key: every such album by one artist collapsed into a single group, so a
 * track from "Album" was filed under the EP and an album page served a track
 * list that was simply wrong. Falling back to the un-stripped form keeps those
 * albums distinct while still folding the deluxe/remaster variants together.
 */
export function normaliseAlbumName(raw: string | null | undefined): string {
  if (!raw) return "";
  const squash = (s: string) =>
    s
      .replace(/\((?:deluxe|expanded|remastered)[^)]*\)/g, " ")
      .replace(/\[[^\]]*\]/g, " ")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  const base = squash(raw.toLowerCase());
  if (!base) return "";
  const withoutDescriptors = squash(
    base.replace(/\b(album|ep|explicit|single)\b/g, " "),
  );
  // Deliberately NO `|| base` fallback. It used to resurrect the raw name
  // whenever stripping left nothing, so an upload whose "album" field is
  // literally "Single" normalised to "single" — a placeholder that then
  // MATCHED an album search for the same placeholder. A name made only of
  // format words is not an album, and must normalise to nothing. See
  // `matchesAlbum`, which treats empty as "not a match".
  return withoutDescriptors;
}

/** `/artist/Rick Astley` — a real name or nothing. */
export function artistPath(artist: string | null | undefined): string | null {
  const name = artist?.trim();
  if (!name || name === "Unknown artist") return null;
  return `/artist/${encodeURIComponent(name)}`;
}

/** `/album/<artist>/<album>` — both halves must be real. */
export function albumPath(
  artist: string | null | undefined,
  album: string | null | undefined,
): string | null {
  const artistName = artist?.trim();
  const albumName = album?.trim();
  if (!artistName || !albumName) return null;
  if (artistName === "Unknown artist" || albumName === "Single") return null;
  return `/album/${encodeURIComponent(artistName)}/${encodeURIComponent(albumName)}`;
}

/**
 * Read a route param that react-router has ALREADY decoded.
 *
 * react-router v7 percent-decodes every path segment while matching, so
 * `params.artist` is the display name, not an encoded string. Decoding it a
 * second time is not just redundant, it is a crash: a real artist name
 * containing a percent sign ("50% Hits", "100% Pure Love") decodes to a
 * truncated escape and `decodeURIComponent` throws a URIError, which took the
 * whole page down and left the error boundary on screen.
 *
 * The value is returned as-is. `decodeURIComponent` must NOT be applied here.
 */
export function routeParam(raw: string | undefined | null): string {
  return (raw ?? "").trim();
}

/**
 * Split an album route back into its two names.
 *
 * Returns null for anything that is not a usable pair, so a hand-typed or
 * truncated URL produces an honest empty state rather than a search for
 * "undefined".
 */
export function parseAlbumRoute(
  artistParam: string | undefined,
  albumParam: string | undefined,
): { artist: string; album: string } | null {
  // Already decoded by react-router — see `routeParam`. A second
  // `decodeURIComponent` threw a URIError on any album or artist with a "%"
  // in the name.
  const artist = routeParam(artistParam);
  const album = routeParam(albumParam);
  if (!artist || !album) return null;
  if (artist === "Unknown artist" || album === "Single") return null;
  return { artist, album };
}

/** An album the app actually has tracks for. */
export interface AlbumGroup {
  album: string;
  artist: string;
  items: YtItem[];
  /** Newest first is not known here — callers order by their own rule. */
}

/**
 * Group tracks into the albums they really report.
 *
 * Only tracks whose source supplied an album name are grouped. A track with no
 * album is dropped rather than filed under a placeholder, which is what keeps
 * an album page from silently showing a made-up tracklist.
 */
export function groupByAlbum(items: YtItem[]): AlbumGroup[] {
  const groups = new Map<string, AlbumGroup>();
  for (const item of items) {
    const album = item.album?.trim();
    if (!album) continue;
    const artist = cleanArtistName(item.artist, item.title);
    const key = `${artistKeyOf(artist)}|${normaliseAlbumName(album)}`;
    const existing = groups.get(key);
    if (existing) {
      if (!existing.items.some((entry) => entry.id === item.id)) {
        existing.items.push(item);
      }
      continue;
    }
    groups.set(key, { album, artist, items: [item] });
  }
  return [...groups.values()].sort((a, b) => b.items.length - a.items.length);
}

function artistKeyOf(artist: string): string {
  return artist.toLowerCase();
}

/**
 * Do these two items really belong to the same album?
 *
 * Used to filter search results down to the requested album. A missing album
 * on the result is NOT treated as a match: the album page shows only tracks it
 * can actually place.
 */
export function matchesAlbum(item: YtItem, album: string): boolean {
  const itemAlbum = normaliseAlbumName(item.album);
  if (!itemAlbum) return false;
  return itemAlbum === normaliseAlbumName(album);
}

/**
 * Deduplicate a tracklist for display, keeping the first occurrence.
 * Shared with the queue's own duplicate rule so a page and the player agree.
 */
export function uniqueTracks(items: YtItem[]): YtItem[] {
  const seen = new Set<string>();
  const out: YtItem[] = [];
  for (const item of items) {
    if (!item || !item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}
