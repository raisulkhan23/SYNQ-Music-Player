/**
 * Parsers for YouTube Music's `browse` API — the endpoint that actually has a
 * discography.
 *
 * The artist page used to be built from `search`, and that is why it stopped at
 * about ten songs: a search shelf is a *ranked sample* of an artist, roughly
 * twenty rows, with no albums, no release types and no tracklists. `browse` is
 * a different question — it returns the artist's real release list (the
 * "show all" grid, up to 100 releases in one page), and browsing a release
 * returns its complete tracklist.
 *
 * Everything here is a pure function over the JSON the API returned, so the
 * shapes are testable against recorded fixtures instead of only against the
 * live service. `src/convex/artistCatalog.ts` does the fetching; this module
 * never performs IO.
 *
 * Convex bundles this file directly, so it deliberately imports nothing.
 */

export interface BrowseRelease {
  /** `MPREb_…` — the release's own browse id (stable per release). */
  id: string;
  /** `OLAK5uy_…` playlist id, when the API reports one. */
  playlistId?: string;
  title: string;
  /** Raw provider subtitle, e.g. "Album • 2026". */
  subtitle: string;
  kind: ReleaseType;
  /** Only when the provider states it. Never inferred from an album name. */
  year?: string;
  thumbnail?: string;
}

export type ReleaseType =
  | "album"
  | "single"
  | "ep"
  | "live"
  | "compilation"
  | "soundtrack"
  | "other";

export interface BrowseTrack {
  videoId: string;
  title: string;
  /** Artists in provider order; the first is the primary credit. */
  artists: string[];
  album?: string;
  /** Seconds, parsed from the row's own duration cell. */
  duration: number;
  /** 1-based position inside the release. */
  index: number;
}

export interface BrowseAlbumMeta {
  title?: string;
  year?: string;
  kind: ReleaseType;
  /** "16 songs" → 16, only when the header says it. */
  trackCount?: number;
}

/** Narrow accessor that never throws on a missing path. */
function at(value: unknown, path: Array<string | number>): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

/** Depth-first walk that preserves document order. */
function visit(
  node: unknown,
  onNode: (node: Record<string, unknown>) => void,
  depth = 0,
): void {
  if (node == null || typeof node !== "object" || depth > 80) return;
  if (Array.isArray(node)) {
    for (const child of node) visit(child, onNode, depth + 1);
    return;
  }
  onNode(node as Record<string, unknown>);
  for (const value of Object.values(node as Record<string, unknown>)) {
    visit(value, onNode, depth + 1);
  }
}

/** Jump to a key without visiting everything in between. */
function collect(
  root: unknown,
  key: string,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  visit(root, (node) => {
    const value = node[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out.push(value as Record<string, unknown>);
    }
  });
  return out;
}

/** Runs of a text node, joined. Text fields arrive as `{ runs: [{text}] }`. */
function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  const runs = at(value, ["runs"]);
  if (Array.isArray(runs)) {
    return runs.map((run) => str(at(run, ["text"]))).join("");
  }
  return str(at(value, ["simpleText"]));
}

/**
 * Text of one flex column.
 *
 * Columns are wrapped in `musicResponsiveListItemFlexColumnRenderer`, so a
 * plain `textOf(column)` finds nothing — that wrapper is exactly what made the
 * first version of these parsers return zero rows on correct input.
 */
function columnText(column: unknown): string {
  return (
    textOf(
      at(column, ["musicResponsiveListItemFlexColumnRenderer", "text"]),
    ) || textOf(column)
  );
}

function lastThumbnail(value: unknown): string | undefined {
  const list =
    at(value, ["thumbnail", "musicThumbnailRenderer", "thumbnail", "thumbnails"]) ??
    at(value, ["musicThumbnailRenderer", "thumbnail", "thumbnails"]) ??
    at(value, ["thumbnail", "thumbnails"]) ??
    at(value, ["thumbnails"]);
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const url = str(at(list[list.length - 1], ["url"]));
  return url || undefined;
}

/**
 * A release's type and year, read ONLY from the provider's subtitle.
 *
 * "Album • 2026", "Single • 2020", "EP • 2019", "Live • 2011". The subtitle is
 * the provider's own classification; album titles are not scanned for words
 * like "Live", because "Live Forever" is a song, not a live album.
 */
export function parseReleaseSubtitle(subtitle: string): {
  kind: ReleaseType;
  year?: string;
} {
  const parts = subtitle
    .split("•")
    .map((part) => part.trim())
    .filter(Boolean);
  const kindWord = (parts[0] ?? "").toLowerCase();
  const year = parts.find((part) => /^(19|20)\d{2}$/.test(part));
  let kind: ReleaseType = "other";
  if (/^album/.test(kindWord)) kind = "album";
  else if (/^single/.test(kindWord)) kind = "single";
  else if (/^(ep|extended play)/.test(kindWord)) kind = "ep";
  else if (/^live/.test(kindWord)) kind = "live";
  else if (/^compilation/.test(kindWord)) kind = "compilation";
  else if (/^soundtrack/.test(kindWord)) kind = "soundtrack";
  return { kind, ...(year ? { year } : {}) };
}

/**
 * Artist search rows — the only reliable way to turn a display name into a
 * stable artist id. Matching on the name alone is what let "Hoizer" (a typo
 * account) and "Hozier" share a page.
 */
export function parseArtistSearch(data: unknown): Array<{
  artistId: string;
  name: string;
  subtitle: string;
}> {
  const rows = collect(data, "musicResponsiveListItemRenderer");
  const out: Array<{ artistId: string; name: string; subtitle: string }> = [];
  for (const row of rows) {
    const artistId = str(
      at(row, ["navigationEndpoint", "browseEndpoint", "browseId"]),
    );
    if (!artistId.startsWith("UC")) continue;
    const name = columnText(at(row, ["flexColumns", 0])).trim();
    if (!name) continue;
    if (out.some((entry) => entry.artistId === artistId)) continue;
    out.push({
      artistId,
      name,
      subtitle: columnText(at(row, ["flexColumns", 1])).trim(),
    });
  }
  return out;
}

/** The artist header: real artwork and the provider's own blurb. */
export function parseArtistHeader(data: unknown): {
  name?: string;
  thumbnail?: string;
  description?: string;
} {
  const [header] =
    collect(data, "musicImmersiveHeaderRenderer").length > 0
      ? collect(data, "musicImmersiveHeaderRenderer")
      : collect(data, "musicVisualHeaderRenderer").length > 0
        ? collect(data, "musicVisualHeaderRenderer")
        : collect(data, "musicResponsiveHeaderRenderer");
  if (!header) return {};
  const description =
    textOf(at(header, ["description"])) ||
    textOf(
      collect(data, "musicDescriptionShelfRenderer").map((node) => node.text)[0],
    );
  return {
    name: textOf(at(header, ["title"])).trim() || undefined,
    thumbnail:
      lastThumbnail(at(header, ["foregroundThumbnail"])) ??
      lastThumbnail(at(header, ["thumbnail"])),
    description: description.trim() || undefined,
  };
}

/**
 * The artist's release list.
 *
 * Every release on the artist's page (albums, singles, EPs, live, compilations)
 * arrives in one grid of up to 100 entries. `nextCursor` is returned when the
 * API offers a continuation; the caller must follow it rather than assume the
 * first page is the discography.
 */
export function parseReleaseGrid(data: unknown): {
  releases: BrowseRelease[];
  nextCursor: string | null;
} {
  const releases: BrowseRelease[] = [];
  const seen = new Set<string>();
  for (const item of collect(data, "musicTwoRowItemRenderer")) {
    const id = str(at(item, ["navigationEndpoint", "browseEndpoint", "browseId"]));
    const title = textOf(at(item, ["title"])).trim();
    if (!id.startsWith("MPRE") || !title || seen.has(id)) continue;
    seen.add(id);
    const subtitle = textOf(at(item, ["subtitle"])).trim();
    const { kind, year } = parseReleaseSubtitle(subtitle);
    const playlistId = str(
      at(item, ["navigationEndpoint", "watchPlaylistEndpoint", "playlistId"]),
    );
    const thumbnail = lastThumbnail(at(item, ["thumbnail"]));
    releases.push({
      id,
      ...(playlistId ? { playlistId } : {}),
      title,
      subtitle,
      kind,
      ...(year ? { year } : {}),
      ...(thumbnail ? { thumbnail } : {}),
    });
  }
  return { releases, nextCursor: findContinuation(data) };
}

/** "3:28" / "1:02:03" → seconds. Unknown stays 0, never a guess. */
export function parseDuration(value: string): number {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return 0;
  const [, a, b, c] = match;
  return c
    ? Number(a) * 3600 + Number(b) * 60 + Number(c)
    : Number(a) * 60 + Number(b);
}

/**
 * A release's tracklist, in provider order.
 *
 * Album rows pack everything into flex columns: [title, artists, album] with
 * the duration in a fixed column. The video id lives on the title's own watch
 * endpoint, which is also the stable recording id used for deduplication.
 */
export function parseReleaseTracks(data: unknown): {
  tracks: BrowseTrack[];
  nextCursor: string | null;
} {
  const rows = collect(data, "musicResponsiveListItemRenderer");
  const tracks: BrowseTrack[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const titleColumn = at(row, ["flexColumns", 0]);
    const title = columnText(titleColumn).trim();
    const videoId =
      str(
        at(titleColumn, [
          "musicResponsiveListItemFlexColumnRenderer",
          "text",
          "runs",
          0,
          "navigationEndpoint",
          "watchEndpoint",
          "videoId",
        ]),
      ) ||
      str(
        at(row, [
          "overlay",
          "musicItemThumbnailOverlayRenderer",
          "content",
          "musicPlayButtonRenderer",
          "playNavigationEndpoint",
          "watchEndpoint",
          "videoId",
        ]),
      ) ||
      str(at(row, ["playlistItemData", "videoId"]));
    if (!videoId || !title || seen.has(videoId)) continue;

    const columns = at(row, ["flexColumns"]);
    const artists: string[] = [];
    let album: string | undefined;
    if (Array.isArray(columns)) {
      const artistColumn = columnText(columns[1]).trim();
      if (artistColumn) {
        for (const name of artistColumn.split("•")) {
          const trimmed = name.trim();
          if (trimmed && !artists.includes(trimmed)) artists.push(trimmed);
        }
      }
      const albumColumn = columnText(columns[2]).trim();
      if (albumColumn) album = albumColumn;
    }
    // The duration arrives in a fixed column on album rows, and as the last
    // run of the artist column on some playlist rows.
    const duration =
      parseDuration(
        textOf(
          at(row, [
            "fixedColumns",
            0,
            "musicResponsiveListItemFixedColumnRenderer",
            "text",
          ]),
        ),
      ) ||
      parseDuration(textOf(at(row, ["fixedColumns", 0]))) ||
      parseDuration(
        (
          columnText(at(row, ["flexColumns", 1])).match(/\d{1,2}:\d{2}(?::\d{2})?$/) ??
          [""]
        )[0],
      );

    seen.add(videoId);
    tracks.push({
      videoId,
      title,
      artists,
      ...(album ? { album } : {}),
      duration,
      index: tracks.length + 1,
    });
  }
  return { tracks, nextCursor: findContinuation(data) };
}

/** The release header: title, year, type and the provider's track count. */
export function parseAlbumMeta(data: unknown): BrowseAlbumMeta {
  const [header] =
    collect(data, "musicResponsiveHeaderRenderer").length > 0
      ? collect(data, "musicResponsiveHeaderRenderer")
      : collect(data, "musicDetailHeaderRenderer");
  if (!header) return { kind: "other" };
  const title = textOf(at(header, ["title"])).trim() || undefined;
  const subtitle = textOf(at(header, ["subtitle"])).trim();
  const { kind, year } = parseReleaseSubtitle(subtitle);
  const second = textOf(at(header, ["secondSubtitle"])).trim();
  const countMatch =
    second.match(/(\d+)\s+(?:tracks?|songs?)/i) ??
    subtitle.match(/(\d+)\s+songs?/i);
  return {
    ...(title ? { title } : {}),
    ...(year ? { year } : {}),
    kind,
    ...(countMatch ? { trackCount: Number(countMatch[1]) } : {}),
  };
}

/**
 * The next-page token, wherever the response put it.
 *
 * Grids and tracklists use different renderers but the same continuation
 * shape; a response with no usable token means the list is genuinely finished.
 */
export function findContinuation(data: unknown): string | null {
  let token: string | null = null;
  visit(data, (node) => {
    if (token) return;
    const next =
      at(node, ["nextContinuationData", "continuation"]) ??
      at(node, ["nextRadioContinuationData", "continuation"]) ??
      at(node, ["continuationEndpoint", "continuationCommand", "token"]);
    if (typeof next === "string" && next) token = next;
  });
  return token;
}

/**
 * Did this response contain an explicit end-of-list message?
 *
 * The release grid's continuation answers with a `messageRenderer` ("You've
 * reached the end") rather than an empty grid. Treating that as "more pages
 * exist" would leave the UI promising releases that will never arrive, so it is
 * detected and reported as completion.
 */
export function isEndMessage(data: unknown): boolean {
  const messages = collect(data, "messageRenderer");
  if (messages.length === 0) return false;
  // Ordering pages also contain informational messages mid-list; only a
  // response with NO list items can be an end marker.
  return (
    collect(data, "musicTwoRowItemRenderer").length === 0 &&
    collect(data, "musicResponsiveListItemRenderer").length === 0
  );
}
