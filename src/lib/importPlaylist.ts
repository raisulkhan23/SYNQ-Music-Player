import { cleanArtistName, cleanTrackTitle } from "@/lib/youtube";

/**
 * Parse a playlist export from another music service.
 *
 * Supports the common text formats users get when exporting:
 * - Google Takeout / YouTube Music CSV (headers like "Video Title","Artist")
 * - Spotify CSV exports (Track Name, Artist Name(s), Duration)
 * - Plain text lists: "Artist - Title", "Title - Artist", or "Title,Artist"
 *
 * The parser is deliberately provider-agnostic — it never needs OAuth or
 * provider APIs, just the exported file the user already has.
 */

export interface ParsedTrack {
  title: string;
  artist: string;
  duration?: number;
}

export interface ParsedPlaylist {
  name: string;
  origin: string;
  tracks: ParsedTrack[];
}

/** Split a CSV line honoring quoted fields. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

/** Parse "H:MM:SS" / "MM:SS" / seconds into seconds (undefined if unknown). */
function parseDuration(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n > 0 ? n : undefined;
  }
  const parts = s.split(":").map((p) => Number(p) || 0);
  if (parts.length === 3) {
    const n = parts[0] * 3600 + parts[1] * 60 + parts[2];
    return n > 0 ? n : undefined;
  }
  if (parts.length === 2) {
    const n = parts[0] * 60 + parts[1];
    return n > 0 ? n : undefined;
  }
  return undefined;
}

const CLEAN_DURATION = /\s*[[(]\s*\d{1,2}:\d{2}(?::\d{2})?\s*[)\]]\s*/g;
const CLEAN_PARENS = /\((?:feat|ft|with)\.?[^)]*\)/gi;

function cleanTitle(raw: string): string {
  return raw.replace(CLEAN_DURATION, " ").replace(/\s+/g, " ").trim();
}

function cleanArtist(raw: string): string {
  // Strip section prefixes YouTube Music sometimes leaves ("Artist: X, Y")
  const stripped = raw.replace(/^artist[s]?\s*[:=]\s*/i, "");
  // Primary artist only (before commas/semicolons) reads best in queries
  const primary = stripped.split(/[,;]+/)[0]?.trim() ?? "";
  return primary || stripped.trim();
}

const SKIP_RE =
  /^(track|title|song|video|no\.?|#|artist|duration|time|index|position)$/i;

/**
 * Strip upload noise from an imported title/artist.
 *
 * Reuses the SAME normalisation the player applies to every other track, which
 * the importer previously skipped. An imported row kept its raw text, so a
 * YouTube export landed as "Inferno Clash - Music for FlameFrags" and then
 * searched YouTube with that whole string later — which is precisely the
 * shape the player strips everywhere else. Normalising here means an imported
 * playlist behaves like a native one.
 */
function normalizeImportedTitle(raw: string): string {
  return cleanTrackTitle(raw);
}

function normalizeImportedArtist(raw: string): string {
  // cleanArtistName needs a title to disambiguate "Artist • Song" subtitles;
  // the title is already cleaned by the time it is called.
  return cleanArtistName(raw);
}

/** Guess the origin service from file content. */
function guessOrigin(text: string): string {
  const head = text.slice(0, 2000).toLowerCase();
  if (
    head.includes("video id") ||
    head.includes("videotitle") ||
    head.includes("channel")
  ) {
    return "YouTube Music";
  }
  if (
    head.includes("spotify") ||
    head.includes("track name") ||
    head.includes("artist name")
  ) {
    return "Spotify";
  }
  return "Other";
}

/**
 * Parse exported playlist text (CSV or plain text list) into tracks.
 * Returns an empty list when nothing usable is found.
 */
export function parsePlaylistImport(
  text: string,
  providedName?: string,
): ParsedPlaylist | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return null;

  const origin = guessOrigin(text);
  const tracks: ParsedTrack[] = [];
  /**
   * The header row's column NAMES, once one is found. Column roles are read
   * from here — never from the data. The previous version tested each DATA
   * value against /title|track|song|video/, so a Spotify row whose artist was
   * called "Video Games" had that column promoted to the title, importing the
   * wrong song under the wrong name.
   */
  let headerCols: string[] | null = null;

  for (const line of lines) {
    // Header detection: contains column-like keywords and no duration
    const lower = line.toLowerCase();
    const isHeader =
      headerCols === null &&
      (lower.startsWith('"track') ||
        lower.startsWith('"video') ||
        lower.startsWith('"song') ||
        lower.startsWith("track,") ||
        lower.startsWith("video,") ||
        lower.startsWith("song,") ||
        lower.startsWith("name,") ||
        ((lower.includes("artist") || lower.includes("channel")) &&
          (lower.includes("title") ||
            lower.includes("track") ||
            lower.includes("name"))));
    if (isHeader) {
      headerCols = splitCsvLine(line).map((c) => c.toLowerCase());
      continue;
    }

    const cols = splitCsvLine(line);
    let title = "";
    let artist = "";
    let duration: number | undefined;

    if (cols.length >= 2) {
      // CSV-ish: find the best title/artist column pair. When a header was
      // read, the column NAMES decide the roles; otherwise fall back to shape
      // heuristics on the data itself.
      let tIdx = -1;
      let aIdx = -1;
      if (headerCols) {
        tIdx = headerCols.findIndex((h) =>
          /title|track name|song|video/i.test(h),
        );
        aIdx = headerCols.findIndex((h) =>
          /artist|channel|album artist/i.test(h),
        );
        // A header that names no usable columns (or names more columns than
        // the row has) tells us nothing, so fall through to the heuristics.
        if (tIdx >= cols.length) tIdx = -1;
        if (aIdx >= cols.length) aIdx = -1;
      }
      if (tIdx < 0 && !headerCols) {
        tIdx = cols.findIndex((c, i) => i === 0 && cols.length === 2);
      }
      if (tIdx < 0) {
        // First non-numeric, non-duration column as title.
        tIdx = cols.findIndex((c) => c.length > 0 && !/^\d+[:\d.]*$/.test(c));
      }
      if (tIdx < 0) continue;
      title = cols[tIdx];

      // Artist: the column the header named, else the nearest following column
      // that isn't a duration/url/id.
      if (aIdx > tIdx && cols[aIdx]) {
        artist = cols[aIdx];
      } else {
        for (let j = tIdx + 1; j < cols.length; j++) {
          const c = cols[j];
          if (
            !c ||
            /^\d+[:\d.]*$/.test(c) ||
            /^https?:/.test(c) ||
            /^[A-Za-z0-9_-]{11}$/.test(c)
          ) {
            if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(c)) duration = parseDuration(c);
            continue;
          }
          artist = c;
          break;
        }
      }
      // A duration is worth picking up wherever it sits when the header named
      // the artist, since that loop above is skipped.
      if (duration === undefined) {
        for (const c of cols) {
          if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(c)) {
            duration = parseDuration(c);
            break;
          }
        }
      }
    } else {
      // Plain text: "Artist - Title" / "Title - Artist" / "Title, Artist"
      const plain = line.replace(CLEAN_DURATION, " ").trim();
      const dash = plain.split(/\s[-–—]\s/);
      if (dash.length >= 2) {
        artist = dash[0].trim();
        title = dash.slice(1).join(" - ").trim();
      } else {
        const comma = plain.split(/,\s*/);
        if (comma.length >= 2) {
          title = comma[0].trim();
          artist = comma[1].trim();
        } else {
          title = plain;
        }
      }
    }

    title = cleanTitle(title);
    artist = cleanArtist(artist);
    // Then the shared player-side normalisation, so imported rows look and
    // search exactly like native ones.
    title = normalizeImportedTitle(title);
    artist = normalizeImportedArtist(artist);
    duration =
      duration ?? parseDuration(line.match(/(\d{1,2}:\d{2}(?::\d{2})?)/)?.[1]);

    if (!title || title.length < 2) continue;
    // A header row that slipped past detection imports as a phantom track.
    // It is only safe to drop a row when the WHOLE row reads like a header —
    // a title of "Song" alongside an artist of "Artist" — because a song
    // genuinely titled "Song" must survive. Detection above already catches
    // the common shapes, so this is the backstop, not the main guard.
    if (SKIP_RE.test(title) && SKIP_RE.test(artist)) continue;
    // Skip obvious non-track rows (urls, ids)
    if (/^https?:/i.test(title) || /^[A-Za-z0-9_-]{11}$/.test(title)) continue;

    tracks.push({
      title: title.replace(CLEAN_PARENS, "").trim() || title,
      artist,
      duration,
    });
    if (tracks.length >= 500) break;
  }

  if (tracks.length === 0) return null;

  return {
    name: providedName?.trim() || "Imported playlist",
    origin,
    tracks,
  };
}
