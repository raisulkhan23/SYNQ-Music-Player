/** A YouTube search result (mirrors the shape returned by the Convex action). */
export interface YtItem {
  id: string;
  title: string;
  artist: string;
  duration: number;
  thumbnail: string;
  /**
   * Album as reported by the source, when it actually reports one.
   * Optional on purpose: it is absent for most rows, and the recommendation
   * engine must treat "unknown album" as unknown rather than guessing.
   */
  album?: string;
  /**
   * The Jamendo release this result was discovered from, when the row came
   * from a Jamendo → YouTube resolution. Carried so the download pipeline can
   * authorize against the licensed release. Never used for playback.
   */
  jamendoId?: string;
}

const INVALID_ARTIST_NAMES =
  /^(?:unknown artist|artist|song|video|single|album|ep|music|official|unknown|topic|records?|music video|official video|official audio|lyrics?)$/i;

function normalizeArtistText(value: string): string {
  return value
    .toLocaleLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Normalize artist metadata from music providers. Provider subtitles often
 * contain separators, topic labels, or the song title before the artist; keep
 * the first real artist candidate instead of exposing that raw metadata.
 */
export function cleanArtistName(value: unknown, title?: string): string {
  if (typeof value !== "string") return "Unknown artist";
  const raw = value
    .replace(/\s+/g, " ")
    .replace(
      /(?:\(|\[)(?:official|topic|audio|video|lyrics?|visualizer|hd|hq)[^\])]*(?:\)|\])/gi,
      "",
    )
    .replace(/\s+(?:topic|vevo)$/i, "")
    .trim();
  if (!raw || INVALID_ARTIST_NAMES.test(raw) || !/[\p{L}\p{N}]/u.test(raw)) {
    return "Unknown artist";
  }

  const titleKey = title ? normalizeArtistText(title) : "";
  // InnerTube subtitles commonly use "Artist • Song" or "Artist - Song".
  // Splitting those separators keeps the artist instead of leaking the title
  // into every metadata surface. Spaced dashes avoid breaking names like
  // AC/DC while still handling the provider's "Artist - Topic" format.
  const candidates = raw
    .split(/\s*(?:[•·|]|\s+[-–—]\s+)\s*/i)
    .map((part) => part.replace(/^[\s\-–—|·]+|[\s\-–—|·]+$/g, "").trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    if (
      INVALID_ARTIST_NAMES.test(candidate) ||
      !/[\p{L}\p{N}]/u.test(candidate)
    )
      continue;
    if (titleKey && normalizeArtistText(candidate) === titleKey) continue;
    return candidate.replace(/\s+(?:topic|vevo)$/i, "").trim() || candidate;
  }
  return "Unknown artist";
}

/** Remove upload metadata while preserving the actual song title. */
/**
 * The search query to run when someone taps an artist name.
 *
 * Returns null when the track has no usable artist at all, so callers can
 * render plain text instead of a link. Without this the tap navigated to
 * `/search?q=Unknown+artist` — a dead end that looked like the button was
 * broken rather than like missing metadata.
 */
export function artistSearchQuery(
  artistName: string | undefined | null,
  title?: string,
): string | null {
  const cleaned = cleanArtistName(artistName, title);
  if (cleaned && cleaned !== "Unknown artist") return cleaned;
  // The stored name can be dirtier than the cleaned one (e.g. it still carries
  // the "Official Video" suffix), so fall back to it before giving up.
  const raw = (artistName ?? "").replace(/\s+/g, " ").trim();
  if (raw && raw !== "Unknown artist" && /[\p{L}\p{N}]/u.test(raw)) return raw;
  return null;
}

export function cleanTrackTitle(value: string): string {
  let title = value.replace(/\s+/g, " ").trim();
  const suffixPatterns = [
    /\s+[-–—]\s+music\s+for\s+.*$/i,
    /\s+[-–—|]\s*(?:official\s+)?(?:music\s+video|music\s+audio|audio|lyrics?|visualizer)\s*$/i,
    // "Official Video" was missing from the alternation, so by far the most
    // common YouTube suffix survived onto the displayed title — and then into
    // every search built from it. `cleanArtistName` already stripped the same
    // wording from the artist field, so the two disagreed about the same
    // upload. Both bracketed and trailing forms are handled.
    /\s*(?:\(|\[)\s*(?:official\s+)?(?:music\s+video|music\s+audio|official\s+video|video|audio|lyrics?|visualizer)\s*(?:\)|\])\s*$/i,
  ];
  for (const pattern of suffixPatterns)
    title = title.replace(pattern, "").trim();
  return title || value.trim();
}

// Resolved stream URLs are cached for the session so replaying a track never
// hits the resolver twice.
const streamCache = new Map<string, string>();

export function getCachedStream(videoId: string): string | undefined {
  return streamCache.get(videoId);
}

export function cacheStream(videoId: string, url: string): void {
  streamCache.set(videoId, url);
}
