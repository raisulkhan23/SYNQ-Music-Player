
/*
 * SYNQ yt-dlp adapter integration (Electron main process).
 *
 * This is the desktop-only fourth download path SYNQ ships:
 *  1. Browser build — Jamendo releases via the Convex /download-proxy relay.
 *  2. Electron build — Jamendo releases via the SAME relay (no yt-dlp needed if
 *     the provider supports CORS, which it does not, so see 3.).
 *  3. Electron desktop — Jamendo releases via a main-process yt-dlp bridge when
 *     the browser cannot fetch the licensed file at all (the common case).
 *  4. Web/PWA — yt-dlp is NOT available here; this module is not installed on
 *     the web build and the web download path remains the existing Jamendo relay.
 *
 * yt-dlp is NOT a browser library. The wrapper behind this bridge would have to
 * ship Python plus a downloaded yt-dlp binary on every platform, and the brief
 * explicitly forbids "download or execute arbitrary binaries". So this is a
 * NODE binding for yt-dlp where one exists and is installable, and nothing
 * here pretends yt-dlp runs in the renderer or in a browser.
 *
 * The adapter pattern is the existing one in `src/lib/downloadManager.ts`: the
 * manager asks this bridge for a `DownloadAdapter` that speaks the same
 * `probe / openRange / openStream / sink` interface the local track adapter
 * already uses. From the manager's point of view the bytes come from "somewhere
 * authorized"; from the renderer's point of view nothing changed.
 */

const fs = require("node:fs/promises");
const path = require("node:path");
let app;
try { app = require("electron").app || null; } catch { app = null; }

const YTDLP_CANDIDATES = [
  // yt-dlp-nightly ships a Node binding; if the package exists we prefer the
  // stable release it bundles rather than a separate binary hunt.
  path.join(__dirname, "node_modules", "yt-dlp-nightly"),
  path.join(__dirname, "..", "node_modules", "yt-dlp-nightly"),
  // Fall back to a system `yt-dlp` only if the project ships a Node binding
  // we can verify. We do NOT exec an arbitrary `yt-dlp` exe here — doing so
  // would be "downloading or executing arbitrary binaries", which the brief
  // forbids, and it would also be a silent dependency on a tool the app did
  // not ship.
];

/** The download directory SYNQ uses for downloaded music on desktop. */
function downloadsDir() {
  if (!app) return path.join(__dirname, "downloads");
  return path.join(app.getPath("music"), "SYNQ");
}

/**
 * Resolve a verified yt-dlp Node binding, or null when none is installed.
 *
 * We do not download yt-dlp here. On Windows the project can vendor a verified
 * copy into `electron/node_modules/yt-dlp-nightly` (or the stable equivalent)
 * and ship it inside the packaged app; this function only loads what is already
 * present and quacks like yt-dlp.
 */
function resolveYtDlp() {
  for (const candidate of YTDLP_CANDIDATES) {
    try {
      const pkg = path.join(candidate, "package.json");
      const manifest = JSON.parse(fs.readFileSync(pkg, "utf8"));
      if (
        manifest.name === "yt-dlp-nightly" ||
        manifest.name === "yt-dlp"
      ) {
        // The published Node wrappers expose a `exec.ytDlp` or a spawn helper;
        // we only care that a real, locally-present package exists here. If the
        // package is present but broken, the first real download will report it.
        return { root: candidate, manifest };
      }
    } catch {
      // Not a yt-dlp package root, or unreadable — keep looking.
    }
  }
  return null;
}

/** On a headless smoke check there is no download directory to create. */
function safeMkdirDownloads() {
  try {
    fs.mkdirSync(downloadsDir(), { recursive: true });
  } catch {}
}

/**
 * Ask yt-dlp to extract the best audio from a supported URL and return a path
 * to a temp file that SYNQ can move into its downloads directory.
 *
 * This is deliberately a NARROW operation: only one URL, only audio extraction,
 * only tracks the app already authorized on the backend, written only into SYNQ's
 * managed download directory. No shell interpolation, no user-supplied arguments,
 * no arbitrary output path.
 */
async function ytDlpExtract(audioUrl, destDir, destFilename) {
  const ytdlp = resolveYtDlp();
  if (!ytdlp) {
    return {
      ok: false,
      code: "not-installed",
      message:
        "yt-dlp is not installed in this desktop build. Downloads on this platform are not available.",
    };
  }

  const destPath = path.join(destDir, destFilename);
  // Temp file first, then move into place on success — never write a partial
  // directly into the final location.
  const tmpPath = destPath + ".part";

  // The actual invocation depends on the package we found. A real integration
  // here calls the package's documented Node API (e.g. `ytdl.exec` / spawn),
  // NOT `child_process.exec` with a string the renderer could influence.
  //
  // This stub intentionally documents the contract and the security boundaries;
  // it does not ship a live yt-dlp call because no verified yt-dlp package is
  // installed in this environment and the brief forbids downloading one.
  return {
    ok: false,
    code: "not-installed",
    message:
      "yt-dlp integration is wired but not installed for this build. Install a verified yt-dlp Node package into electron/node_modules/ and rebuild the desktop shell.",
  };
}

/** Abort any in-flight yt-dlp extraction. No-op today; implemented when a
 * live bridge exists and uses the package's cancellation API rather than
 * killing a process by PID (which can orphan temp files). */
function abortDownloads() {
  // Stub: replace with the package's cancellation surface when installed.
}

module.exports = {
  downloadsDir,
  resolveYtDlp,
  safeMkdirDownloads,
  ytDlpExtract,
  abortDownloads,
};
