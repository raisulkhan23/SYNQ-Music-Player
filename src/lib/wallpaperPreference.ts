import {
  IMAGE_WALLPAPER_MARKER,
  LIVE_WALLPAPER_MARKER,
  WALLPAPER_MARKER_PREFIX,
} from "./wallpaperStorage";

/**
 * The persisted wallpaper preference — ONE format, ONE writer, ONE reader.
 *
 * THE BUG THIS FIXES
 * ------------------
 * The wallpaper picker stored a stable REFERENCE as a plain string:
 *
 *   `idb:wallpaper:library-<uuid>`   an uploaded file kept in IndexedDB
 *   `https://…/clip.mp4`             a remote live wallpaper
 *   `blob:…`                         a resolved object URL (session only)
 *
 * …but the store read it back through `JSON.parse`. `JSON.parse` throws for
 * every one of those values, the catch swallowed the error and returned
 * `null`, so the store started with no wallpaper at all and the selection was
 * gone on the next reload. The writer and the reader disagreed about the
 * format; this module is where the format is defined so they cannot.
 *
 * The reference is deliberately NOT a URL for an uploaded file: a blob URL
 * dies with the tab, so the IndexedDB key is what gets persisted and the blob
 * URL is resolved again on every start-up.
 */

/** Where the wallpaper reference lives in local storage. */
export const WALLPAPER_PREF_KEY = "ss.wallpaper";
/** Where the wallpaper kind (image / video) lives in local storage. */
export const WALLPAPER_TYPE_PREF_KEY = "ss.wallpaperType";

/**
 * Parse whatever is in storage into a stable wallpaper reference.
 *
 * Every historical shape is accepted, because an install that predates this
 * module must not lose its wallpaper on upgrade:
 *   - plain reference (the format this app writes today)
 *   - JSON-encoded string (an older build wrote through a JSON encoder)
 *   - JSON object `{ key }` (the oldest build)
 */
export function parseWallpaperReference(
  raw: string | null | undefined,
): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON at all — this is a plain reference (a marker or a URL). It is
    // kept verbatim: the renderer only accepts loadable URLs, so a junk value
    // is inert, and discarding it would destroy the user's saved preference.
    return trimmed;
  }

  if (typeof parsed === "string") return parsed.trim() || null;
  if (parsed && typeof parsed === "object" && "key" in parsed) {
    const key = String((parsed as { key?: unknown }).key ?? "").trim();
    return key || null;
  }
  // A bare number or boolean is not a reference the app can use.
  if (typeof parsed === "number" || typeof parsed === "boolean") return trimmed;
  return null;
}

/**
 * Read the saved wallpaper reference.
 *
 * A storage failure (private mode, blocked cookies, a full disk) is a missing
 * preference, never a crash.
 */
export function readWallpaperReference(): string | null {
  try {
    const raw = window.localStorage.getItem(WALLPAPER_PREF_KEY);
    return parseWallpaperReference(raw);
  } catch {
    return null;
  }
}

/**
 * Persist the wallpaper reference, or clear it when the value is empty.
 *
 * The value is stored verbatim, so the reader above always gets back exactly
 * what was written.
 */
export function writeWallpaperReference(value: string | null): void {
  try {
    const next = value && value.trim() ? value.trim() : null;
    if (next) window.localStorage.setItem(WALLPAPER_PREF_KEY, next);
    else window.localStorage.removeItem(WALLPAPER_PREF_KEY);
  } catch {
    // Storage unavailable or full: keep the session usable. The in-memory
    // selection still applies; only the persistence is lost.
  }
}

/**
 * Is this reference a marker naming a file in IndexedDB rather than something
 * the browser can load directly?
 */
export function isWallpaperMarker(value: string | null | undefined): boolean {
  if (!value) return false;
  return (
    value === LIVE_WALLPAPER_MARKER ||
    value === IMAGE_WALLPAPER_MARKER ||
    value.startsWith(WALLPAPER_MARKER_PREFIX)
  );
}

/**
 * Can this value be handed to `<img src>` / `<video src>`?
 *
 * Markers are NOT loadable: rendering one produced a broken image on every
 * reload until the IndexedDB lookup resolved.
 */
export function isRenderableWallpaper(value: string | null | undefined): boolean {
  if (!value) return false;
  return (
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("blob:") ||
    value.startsWith("data:") ||
    value.startsWith("/")
  );
}
