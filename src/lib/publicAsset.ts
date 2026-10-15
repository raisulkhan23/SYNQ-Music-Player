// ---------------------------------------------------------------------------
// Resolving files from `public/` in every runtime SYNQ ships in.
//
// The problem this solves: Vite copies `public/` to the root of the build, and
// code refers to those files with root-absolute URLs (`/logo.svg`). That is
// correct on the hosted site, where the app is served from a domain root, and
// it is exactly what breaks inside the packaged desktop app: the renderer is
// loaded from `file:///…/dist/index.html`, so `/logo.svg` resolves to
// `file:///logo.svg` — the root of the drive, not the app bundle. The browser
// shows a broken image, which is what the SYNQ logo did in the installed app.
//
// Why not switch Vite to an absolute base: the package loads from `file://`,
// and a root-absolute base would drop the drive prefix from every chunk URL and
// blank the window. `base: "./"` is right; the handful of hand-written
// `/public-file` URLs are what needed fixing.
//
// Why not `import.meta.env.BASE_URL`: with a relative base that is `"./"`, and
// a relative URL resolves against the *current document URL*. The app uses a
// hash router over `file://`, so the document path never moves and it happens
// to work there — but on the hosted site a deep route like `/playlist/xyz`
// would resolve `./logo.svg` to `/playlist/logo.svg`. Special-casing by
// protocol keeps the hosted behaviour byte-for-byte as it was and only changes
// what was broken.
// ---------------------------------------------------------------------------

/** True when the renderer is running from the packaged app bundle. */
export function isFileProtocol(): boolean {
  return typeof window !== "undefined" && window.location.protocol === "file:";
}

/**
 * Resolve a path inside `public/` (leading slash optional) for this runtime.
 *
 * - hosted site / Android WebView: returns the root-absolute URL unchanged.
 * - packaged desktop (`file://`): resolves it next to the loaded document, so
 *   it points at the file that was actually shipped in the bundle.
 */
export function publicAsset(path: string): string {
  const clean = path.replace(/^\/+/, "");
  if (typeof window === "undefined") return `/${clean}`;
  if (!isFileProtocol()) return `/${clean}`;

  // `?v=2` style cache-busting query strings are part of the reference and are
  // preserved by URL resolution.
  return new URL(clean, document.baseURI).href;
}
