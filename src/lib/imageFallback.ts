// ---------------------------------------------------------------------------
// Graceful fallback for images whose source cannot be loaded.
//
// Album artwork, artist images, avatars and badges come from remote hosts
// (i.ytimg.com, yt3.ggpht.com, Jamendo, GitHub). Those URLs expire, get
// rate-limited, or are simply unreachable — and an <img> with a dead src draws
// the browser's broken-image glyph, which is what makes a library look broken
// even though every control around it still works.
//
// This is deliberately ONE capture-phase listener rather than an `onError`
// prop on every <img> in the app: there are more than a dozen call sites
// (cards, players, queue, admin tables, playlists) and the handler must behave
// identically in all of them. It is a real fallback, not a CSS trick — the
// element's source is replaced with a neutral placeholder that keeps the
// element's own classes, so aspect ratio and object-fit are untouched.
//
// It cannot loop: an image is marked before the placeholder is assigned, and a
// placeholder that itself failed to load would simply be left alone.
// ---------------------------------------------------------------------------

/** Marker set on an element after its fallback has been applied. */
const FALLBACK_ATTR = "data-synq-fallback";

/**
 * Neutral, tiny placeholder. Inline so it never depends on the network or on
 * the asset pipeline, and a fixed grey prevents a themed panel from flashing a
 * wrong colour.
 */
export const FALLBACK_IMAGE_SRC =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" preserveAspectRatio="none"><rect width="1" height="1" fill="#1b1e27"/></svg>`,
  );

/**
 * Decide whether a failed image should get the placeholder.
 *
 * Exported for tests. An image is skipped when it already fell back, when it
 * has no source, or when the source IS the placeholder (the placeholder is
 * served from a data URI and needs no fallback of its own).
 */
export function shouldUseFallback(element: {
  tagName?: string;
  src?: string;
  currentSrc?: string;
  hasAttribute?: (name: string) => boolean;
}): boolean {
  if (!element || element.tagName?.toUpperCase() !== "IMG") return false;
  if (element.hasAttribute?.(FALLBACK_ATTR)) return false;
  const current = element.currentSrc || element.src || "";
  if (!current) return false;
  if (current.startsWith("data:image/svg+xml")) return false;
  return true;
}

/** Apply the placeholder to one image. Safe to call more than once. */
export function applyImageFallback(element: any): boolean {
  if (!shouldUseFallback(element)) return false;
  try {
    element.setAttribute(FALLBACK_ATTR, "1");
    element.src = FALLBACK_IMAGE_SRC;
    return true;
  } catch {
    return false;
  }
}

let installed = false;

/**
 * Install the fallback listener. Idempotent, and a no-op outside a browser.
 *
 * The `error` event does not bubble, hence the capture phase — that is what
 * lets a single listener observe every image in the document.
 */
export function installImageFallback(target?: any): () => void {
  const host: any =
    target ?? (typeof window !== "undefined" ? window : undefined);
  if (!host || typeof host.addEventListener !== "function") return () => {};
  if (installed) return () => {};
  installed = true;

  const onError = (event: Event) => {
    const element = event.target as any;
    applyImageFallback(element);
  };

  host.addEventListener("error", onError, true);
  return () => {
    host.removeEventListener("error", onError, true);
    installed = false;
  };
}
