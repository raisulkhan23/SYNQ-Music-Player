import { describe, expect, test } from 'vitest';
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {
  INSTALL_DISMISSED_KEY,
  SERVICE_WORKER_PATH,
  getPwaUpdateId,
  getPwaUpdateIdServerSnapshot,
  getPwaUpdateServerSnapshot,
  getPwaUpdateSnapshot,
  installBlockedReason,
  isStandalone,
  manualInstallHint,
  planInstallBlock,
  resolveInstallState,
  subscribePwaUpdate,
} from "../src/lib/pwa.ts";
import { readSource } from "./helpers/tailwind-css.js";

/**
 * Strip comments before asserting on class names.
 *
 * The comment that explains WHY the install card is no longer `fixed` right
 * next to it necessarily contains the words `fixed` and `right-4`. Asserting
 * on raw source text therefore "fails" on the explanation of the fix — which
 * is how a source-text assertion quietly stops testing anything.
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * SYNQ's PWA layer.
 *
 * The rules worth pinning are the ones where being wrong is invisible until it
 * is expensive: the service worker must never serve one listener's cached
 * response to another, must never cache audio, must never reload a page that is
 * playing music, and must not claim a capability the browser does not have.
 */

// `import.meta.dirname`, not Bun's `import.meta.dir`: under vitest the latter is
// `undefined`, so every path join below threw "The \"paths[0]\" argument must be
// of type string" before a single assertion ran.
const root = path.resolve(import.meta.dirname, "..");
const swSource = fs.readFileSync(path.join(root, "public/sw.js"), "utf8");
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "public/manifest.webmanifest"), "utf8"),
);
const html = readSource("index.html");
const playerSource = readSource("src/store/player.ts");

/**
 * Minimal PNG reader for 8-bit truecolour images — enough to inspect the
 * generated icons without adding a dependency to the project just for a test.
 *
 * Implements the five PNG scanline filters, which is the only non-obvious part
 * of the format; everything else is IHDR + concatenated IDAT + inflate.
 */
function decodePng(buf) {
  let offset = 8; // signature
  let width = 0;
  let height = 0;
  let colourType = 0;
  const idat = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error("expected 8-bit PNG");
      colourType = data[9];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  if (colourType !== 2 && colourType !== 6) {
    throw new Error(`unsupported colour type ${colourType}`);
  }
  const channels = colourType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = value & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

describe("web app manifest", () => {
  test("is real JSON with the fields installability depends on", () => {
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBe("SYNQ");
    expect(manifest.start_url).toBeTruthy();
    expect(manifest.scope).toBeTruthy();
    expect(manifest.display).toBe("standalone");
  });

  test("declares an id so the app keeps its identity across releases", () => {
    // Without `id`, a launch URL change makes the browser treat a new install
    // as a different app and strand the old one's storage.
    expect(manifest.id).toBe("/");
  });

  test("scope covers every route the app serves", () => {
    expect(manifest.scope).toBe("/");
  });

  test("theme and background agree with the document's theme-color", () => {
    // A mismatch between the manifest and <meta theme-color> is what paints
    // the wrong colour into the installed app's title bar.
    const metaTheme = /name="theme-color" content="([^"]+)"/.exec(html)?.[1];
    expect(metaTheme).toBeTruthy();
    expect(manifest.theme_color).toBe(metaTheme);
    expect(manifest.background_color).toBe(metaTheme);
  });

  test("the theme colour is a dark hex, not a browser default", () => {
    expect(manifest.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    const r = parseInt(manifest.theme_color.slice(1, 3), 16);
    const g = parseInt(manifest.theme_color.slice(3, 5), 16);
    const b = parseInt(manifest.theme_color.slice(5, 7), 16);
    // SYNQ is a dark app; a light splash would flash on every cold start.
    expect(0.299 * r + 0.587 * g + 0.114 * b).toBeLessThan(90);
  });

  test("carries both an any and a maskable icon at 192 and 512", () => {
    // Chrome refuses to install without a 192 and a 512, and Android launchers
    // crop maskable icons — a single "any maskable" entry cannot satisfy both.
    for (const size of ["192x192", "512x512"]) {
      expect(
        manifest.icons.some((i) => i.sizes === size && i.purpose === "any"),
      ).toBe(true);
      expect(
        manifest.icons.some(
          (i) => i.sizes === size && i.purpose === "maskable",
        ),
      ).toBe(true);
    }
  });

  test("every declared icon file exists on disk", () => {
    for (const icon of manifest.icons) {
      const file = path.join(root, "public", icon.src.replace(/^\//, ""));
      expect(fs.existsSync(file)).toBe(true);
    }
  });

  test("every icon is a real PNG of the size it claims", () => {
    for (const icon of manifest.icons) {
      const file = path.join(root, "public", icon.src.replace(/^\//, ""));
      const buf = fs.readFileSync(file);
      // PNG magic
      expect(buf.subarray(1, 4).toString()).toBe("PNG");
      const [w, h] = [buf.readUInt32BE(16), buf.readUInt32BE(20)];
      const [want] = icon.sizes.split("x");
      expect(`${w}x${h}`).toBe(icon.sizes);
      expect(w).toBe(Number(want));
    }
  });

  test("every shortcut points at a route the router actually serves", () => {
    const router = readSource("src/main.tsx");
    for (const shortcut of manifest.shortcuts) {
      const route = shortcut.url.split("?")[0];
      const expected = `path="${route}"`;
      expect(router).toContain(expected);
    }
  });

  test("declares music categories", () => {
    expect(manifest.categories).toContain("music");
  });
});

describe("maskable icons survive cropping", () => {
  const readPng = (rel) =>
    fs.readFileSync(path.join(root, "public", rel.replace(/^\//, "")));

  test("a maskable icon is fully opaque", () => {
    // Android applies its own mask; a transparent corner shows as black.
    for (const rel of ["/icons/maskable-192.png", "/icons/apple-180.png"]) {
      // RGB (no alpha channel) rather than RGBA proves there is no transparency.
      const colourType = readPng(rel)[25];
      expect(colourType).toBe(2);
    }
  });

  test("the mark sits inside the centre 80% safe zone", () => {
    // A maskable icon is cropped to the centre 80% circle on a circular mask.
    // Anything outside that circle is cut away, so the mark must fit inside it.
    const img = decodePng(readPng("/icons/maskable-512.png"));
    const size = img.width;
    const ch = img.channels;
    let minX = size;
    let maxX = -1;
    let minY = size;
    let maxY = -1;
    // The mark is the near-white glyph on the brand gradient.
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (x + y * size) * ch;
        const lum =
          0.299 * img.data[i] +
          0.587 * img.data[i + 1] +
          0.114 * img.data[i + 2];
        if (lum > 170) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    expect(maxX).toBeGreaterThan(minX);
    const cx = size / 2;
    const cy = size / 2;
    // Farthest glyph corner from the centre, vs the 0.4*size safe radius.
    const far = Math.max(
      Math.hypot(maxX - cx, maxY - cy),
      Math.hypot(minX - cx, minY - cy),
      Math.hypot(maxX - cx, minY - cy),
      Math.hypot(minX - cx, maxY - cy),
    );
    expect(far).toBeLessThan(size * 0.4);
  });

  test("the mark is centred by its bounding box", () => {
    // An off-centre maskable mark looks broken on a squircle mask.
    //
    // Measured on the bounding box, NOT the pixel centroid: the SYNQ mark is
    // deliberately rotated -6 degrees, so a rotated shape's area centroid
    // sits off-axis even when it is perfectly centred. De-rotating it to make
    // the centroid land on the middle would mean redrawing the logo, which is
    // exactly what this icon set exists to avoid. What matters to a launcher
    // is that the mark's extent is centred.
    const img = decodePng(readPng("/icons/maskable-512.png"));
    const size = img.width;
    const ch = img.channels;
    let minX = size;
    let maxX = -1;
    let minY = size;
    let maxY = -1;
    let n = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (x + y * size) * ch;
        const lum =
          0.299 * img.data[i] +
          0.587 * img.data[i + 1] +
          0.114 * img.data[i + 2];
        if (lum > 170) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          n += 1;
        }
      }
    }
    expect(n).toBeGreaterThan(1000);
    expect(Math.abs((minX + maxX) / 2 - size / 2)).toBeLessThan(2);
    expect(Math.abs((minY + maxY) / 2 - size / 2)).toBeLessThan(2);
  });

  test("the any-purpose icon is the real logo, not a redraw", () => {
    // The installed app must carry the same mark as the header, so icon-192 is
    // a resample of logo.png rather than a separate drawing that can drift.
    // Compared with a tolerance. The centre pixel of a RESAMPLE is not
    // bit-identical to the source: icon-192 is logo.png at a different size, so
    // anti-aliasing and gradient interpolation land a few levels apart (7/255
    // measured). Exact equality was asserting the resampler's rounding, not
    // "the same mark"; a redrawn icon differs by far more than this.
    const a = decodePng(readPng("/icons/icon-192.png"));
    const b = decodePng(readPng("/logo.png"));
    // Compare the centre pixel of each, where both are the glyph.
    const centre = (img) => {
      const i =
        ((img.width >> 1) + (img.height >> 1) * img.width) * img.channels;
      return [img.data[i], img.data[i + 1], img.data[i + 2]];
    };
    const [ar, ag, ab] = centre(a);
    const [br, bg, bb] = centre(b);
    for (const [got, want] of [
      [ar, br],
      [ag, bg],
      [ab, bb],
    ]) {
      expect(Math.abs(got - want)).toBeLessThanOrEqual(16);
    }
  });
});

describe("service worker registration", () => {
  test("is registered at the root scope", () => {
    expect(SERVICE_WORKER_PATH).toBe("/sw.js");
    expect(playerSource).not.toContain("serviceWorker");
    expect(readSource("src/lib/pwa.ts")).toContain('scope: "/"');
  });

  test("never registers outside production", () => {
    // In dev, Vite re-generates module URLs on every dependency
    // re-optimisation; caching those is precisely what makes a stale bundle
    // that never updates.
    expect(readSource("src/lib/pwa.ts")).toContain("import.meta.env.PROD");
  });

  test("bails out safely where service workers cannot work", () => {
    const pwa = readSource("src/lib/pwa.ts");
    expect(pwa).toContain('"serviceWorker" in navigator');
    expect(pwa).toContain("window.isSecureContext");
  });

  test("a registration failure cannot break the app", () => {
    const pwa = readSource("src/lib/pwa.ts");
    // registerServiceWorker returns null rather than rejecting.
    expect(pwa).toMatch(/catch\s*\{\s*return null;\s*\}/);
  });
});

describe("cache strategies", () => {
  test("versioned cache names", () => {
    expect(swSource).toMatch(/const VERSION = "v\d+"/);
    expect(swSource).toMatch(/synq-shell-\$\{VERSION\}/);
    expect(swSource).toMatch(/synq-assets-\$\{VERSION\}/);
    expect(swSource).toMatch(/synq-images-\$\{VERSION\}/);
  });

  test("old caches are deleted on activate", () => {
    // Without this, every deploy leaves a stale app shell behind and the cache
    // grows forever.
    expect(swSource).toMatch(/n\.startsWith\("synq-"\)/);
    expect(swSource).toMatch(/caches\.delete\(n\)/);
  });

  test("caches are capped so they cannot grow without bound", () => {
    expect(swSource).toMatch(/MAX_IMAGE_ENTRIES = \d+/);
    expect(swSource).toMatch(/MAX_ASSET_ENTRIES = \d+/);
    expect(swSource).toMatch(/function trimCache/);
  });

  test("navigations are network-first with the cached shell as fallback", () => {
    // This is what stops a deep link like /playlist/123 refreshing into a
    // browser error page in the installed app.
    expect(swSource).toMatch(/request\.mode === "navigate"/);
    expect(swSource).toMatch(/async function handleNavigation/);
    expect(swSource).toMatch(/cache\.match\("\/"\)/);
  });

  test("a 404 on a deep link falls back to the shell, not an error page", () => {
    // SYNQ routes entirely client-side, so a host with no SPA rewrite answers
    // /playlist/123 with 404. Serving the cached shell is the only thing that
    // makes refreshing a route work in the installed app.
    expect(swSource).toMatch(/res\.status === 404 \|\| res\.status >= 500/);
  });

  test("a genuinely offline first launch gets a readable message", () => {
    expect(swSource).toMatch(/You're offline/);
    expect(swSource).toMatch(/Reconnect and try again/);
  });

  test("hashed build assets are cache-first", () => {
    expect(swSource).toMatch(/function isHashedAsset/);
    expect(swSource).toMatch(/cacheFirst\(request, ASSET_CACHE/);
  });

  test("images are stale-while-revalidate", () => {
    expect(swSource).toMatch(/staleWhileRevalidate\(request, IMAGE_CACHE/);
  });

  test("opaque responses are never stored", () => {
    // An opaque response's size is unknowable, so it cannot be trimmed and
    // would grow the cache silently.
    expect(swSource).toMatch(/res\.type === "basic"/);
  });

  test("the precache list stays small", () => {
    // Eagerly downloading a large JS bundle on install is how a PWA makes an
    // app feel slower.
    const list = /const PRECACHE_URLS = \[([\s\S]*?)\];/.exec(swSource)[1];
    const entries = list.match(/"/g).length / 2;
    expect(entries).toBeLessThanOrEqual(6);
  });

  test("install adds entries individually, not with an atomic addAll", () => {
    // addAll is all-or-nothing: one 404 rejects the install and leaves the
    // worker permanently uninstalled, i.e. no offline support at all.
    expect(swSource).not.toMatch(/cache\.addAll/);
    expect(swSource).toMatch(/PRECACHE_URLS\.map/);
  });
});

describe("private data is never cached", () => {
  test("only same-origin GETs are cacheable", () => {
    expect(swSource).toMatch(/if \(url\.origin !== origin\) return false;/);
    expect(swSource).toMatch(/request\.method !== "GET"\) return false;/);
  });

  test("Convex is never cached", () => {
    // The entire backend — playlists, history, likes, recommendations — is
    // Convex. Caching any of it would serve one listener's data to whoever
    // opened the app next.
    expect(swSource).toMatch(/"convex\.cloud"/);
    expect(swSource).toMatch(/"convex\.site"/);
  });

  test("the cross-origin fast path is used in the fetch handler too", () => {
    // Not just isCacheable(): the handler must bail before respondWith.
    expect(swSource).toMatch(
      /if \(url\.origin !== origin \|\| isBypassedHost\(url\.hostname\)\) return;/,
    );
  });

  test("the audio proxy and API paths are bypassed", () => {
    expect(swSource).toMatch(/"\/audio-proxy"/);
    expect(swSource).toMatch(/"\/api\/"/);
  });

  test("audio range requests are never cached", () => {
    // Streaming seeks with `Range`; replaying a partial response as a full one
    // produces broken playback.
    expect(swSource).toMatch(/request\.headers\.has\("range"\)/);
  });

  test("YouTube and artwork CDNs are bypassed", () => {
    for (const host of ["youtube.com", "googlevideo.com", "ytimg.com"]) {
      expect(swSource).toContain(`"${host}"`);
    }
  });

  test("the worker never claims to cache audio", () => {
    // SYNQ streams music and has no offline-audio rights. Anything that stored
    // audio would be the "secret download system" the app must not have.
    expect(swSource).not.toMatch(/\.(mp3|m4a|opus|webm|mp4)\$/);
  });
});

describe("the update path never interrupts playback", () => {
  test("install does not call skipWaiting", () => {
    // Activating on install would swap the running code under a listener who
    // is mid-song. The comment in that handler deliberately NAMES the method,
    // so this matches the CALL rather than the word.
    const install = swSource.slice(
      swSource.indexOf('self.addEventListener("install"'),
      swSource.indexOf('self.addEventListener("activate"'),
    );
    expect(install).not.toMatch(/[^.\w]self\.skipWaiting\(/);
  });

  test("the worker only skips waiting when the page asks", () => {
    expect(swSource).toMatch(/data\.type === "SKIP_WAITING"/);
    expect(swSource).toMatch(/void self\.skipWaiting\(\)/);
  });

  test("the page defers the reload while something is playing", () => {
    const pwa = readSource("src/lib/pwa.ts");
    expect(pwa).toMatch(
      /if \(options\.isPlaying\) \{[\s\S]*?onBlocked\(\);[\s\S]*?return;/,
    );
  });

  test("a deferred update resumes when the track ends", () => {
    const mgr = readSource("src/components/pwa/PwaManager.tsx");
    expect(mgr).toMatch(/deferredWhilePlaying && !isPlaying/);
  });

  test("the pending reload survives a tab being killed", () => {
    // A mobile browser killing a background tab mid-swap must not pin the
    // listener to the old version forever.
    expect(readSource("src/lib/pwa.ts")).toMatch(
      /sessionStorage\.setItem\(UPDATE_RELOAD_KEY, "1"\)/,
    );
  });
});

describe("update state is an external store", () => {
  test("subscribers are notified and can unsubscribe", () => {
    let calls = 0;
    const unsubscribe = subscribePwaUpdate(() => {
      calls += 1;
    });
    // The current snapshot is stable, so a store that never changes must not
    // force a re-render loop.
    const before = getPwaUpdateSnapshot();
    expect(getPwaUpdateSnapshot()).toBe(before);
    expect(getPwaUpdateServerSnapshot()).toBe(false);
    unsubscribe();
    expect(calls).toBe(0);
  });

  test("update ids are monotonic and have a stable server snapshot", () => {
    const first = getPwaUpdateId();
    expect(getPwaUpdateId()).toBe(first);
    expect(getPwaUpdateIdServerSnapshot()).toBe(0);
  });
});

describe("installed-app detection", () => {
  test("recognises every display mode that counts as installed", () => {
    expect(isStandalone("standalone")).toBe(true);
    expect(isStandalone("minimal-ui")).toBe(true);
    expect(isStandalone("window-controls-overlay")).toBe(true);
  });

  test("a plain browser tab is not installed", () => {
    expect(isStandalone("browser", false)).toBe(false);
    expect(isStandalone("", false)).toBe(false);
  });

  test("the legacy iOS standalone flag is honoured", () => {
    // iOS Safari reports installation only through navigator.standalone.
    expect(isStandalone("browser", true)).toBe(true);
  });
});

describe("install prompt", () => {
  test("an installed app is never offered installation", () => {
    // Precedence matters most here: an installed app showing "Install SYNQ"
    // is the most obvious tell that the detection is broken.
    expect(
      resolveInstallState({
        installed: true,
        promptCaptured: true,
        dismissed: false,
        ios: true,
      }),
    ).toBe("installed");
    expect(
      resolveInstallState({
        installed: true,
        promptCaptured: false,
        dismissed: false,
        ios: false,
      }),
    ).toBe("installed");
  });

  test("a captured prompt wins over dismissal only if not dismissed", () => {
    expect(
      resolveInstallState({
        installed: false,
        promptCaptured: true,
        dismissed: false,
        ios: false,
      }),
    ).toBe("ready");
    expect(
      resolveInstallState({
        installed: false,
        promptCaptured: true,
        dismissed: true,
        ios: false,
      }),
    ).toBe("dismissed");
  });

  test("iOS gets manual instructions instead of a dead button", () => {
    // iOS Safari fires no install event and exposes no API, so a button there
    // would do nothing at all.
    const state = resolveInstallState({
      installed: false,
      promptCaptured: false,
      dismissed: false,
      ios: true,
    });
    expect(state).toBe("manual");
    expect(manualInstallHint(true)).toMatch(/Add to Home Screen/);
  });

  test("a browser with no install support is left alone", () => {
    expect(
      resolveInstallState({
        installed: false,
        promptCaptured: false,
        dismissed: false,
        ios: false,
      }),
    ).toBe("unavailable");
  });

  test("dismissal uses the existing ss.* storage convention", () => {
    expect(INSTALL_DISMISSED_KEY).toBe("ss.pwaInstallDismissed");
    expect(readSource("src/lib/pwa.ts")).toContain(
      'localStorage.setItem(INSTALL_DISMISSED_KEY, "1")',
    );
  });

  test("the install prompt is dismissible and re-openable from Settings", () => {
    const settings = readSource("src/components/settings/SettingsDialog.tsx");
    expect(settings).toMatch(/function InstallAppRow/);
    expect(settings).toMatch(/Show again/);
  });
});

describe("head metadata for the installed app", () => {
  test("iOS home-screen hints are present", () => {
    expect(html).toMatch(/rel="apple-touch-icon"/);
    expect(html).toMatch(/name="apple-mobile-web-app-capable"/);
    expect(html).toMatch(/name="apple-mobile-web-app-title" content="SYNQ"/);
  });

  test("the apple touch icon is the full-bleed render", () => {
    // A transparent corner renders black on iOS, so the icon must be opaque.
    const href = /rel="apple-touch-icon" href="([^"]+)"/.exec(html)[1];
    expect(href).toContain("apple-180.png");
  });

  test("the viewport still opts into safe areas", () => {
    // Without viewport-fit=cover the env(safe-area-inset-*) values the bottom
    // nav and fullscreen player rely on are silently zero on notched devices.
    expect(html).toMatch(/viewport-fit=cover/);
  });

  test("the viewport is not user-scalable-locked", () => {
    expect(html).not.toMatch(/user-scalable=no/);
  });
});

describe("existing playback is untouched", () => {
  test("no push notification permission is requested", () => {
    expect(swSource).not.toMatch(/push|notificationclick|showNotification/);
    expect(readSource("src/lib/pwa.ts")).not.toMatch(
      /Notification\.requestPermission/,
    );
  });

  test("the media session integration is unchanged", () => {
    // The PWA must inherit SYNQ's existing Media Session wiring, not replace
    // it. The platform calls live in ONE module (`src/lib/mediaSession.ts`),
    // which speaks to the browser's `navigator.mediaSession` and to the
    // Android bridge alike; the store supplies the values and the button
    // behaviour through `registerMediaSessionActions`. Both halves are pinned
    // here, plus the "not replaced" half: the service worker never touches the
    // session itself.
    const media = readSource("src/lib/mediaSession.ts");
    expect(media).toContain('"mediaSession" in navigator');
    for (const action of ["nexttrack", "seekforward", "play", "pause"]) {
      expect(media).toContain(`register("${action}"`);
    }
    expect(playerSource).toContain("registerMediaSessionActions");
    expect(swSource).not.toMatch(/setActionHandler|mediaSession/);
  });

  test("the crossfade system still exists", () => {
    expect(readSource("src/lib/transition.ts")).toContain("planTransition");
    expect(playerSource).toContain("cancelTransition");
  });

  test("only one service worker and one manifest exist", () => {
    // A duplicate worker is the classic cause of an app that updates forever.
    //
    // Scan the SOURCE tree only. `dist/` and any other copy of the built output
    // legitimately contain the very same `sw.js` that `public/` ships, so
    // walking the whole repo root counted build artifacts as a second worker
    // and failed for a build having happened, not for a real duplicate.
    const swFiles = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Never descend into generated output.
          if (["dist", "build", "isolate", ".freebuff"].includes(entry.name)) {
            continue;
          }
          walk(full);
        } else if (/^sw\.js$|service-worker/.test(entry.name)) {
          swFiles.push(path.relative(root, full));
        }
      }
    };
    walk(path.join(root, "src"));
    walk(path.join(root, "public"));
    expect(swFiles).toEqual([path.join("public", "sw.js")]);

    const manifests = fs
      .readdirSync(path.join(root, "public"))
      .filter((f) => /manifest.*\.webmanifest$/.test(f));
    expect(manifests).toEqual(["manifest.webmanifest"]);
  });
});

describe("the install prompt never covers the right-hand surface", () => {
  // The Queue panel is a `side="right"` sheet; the install card used to be a
  // `fixed right-4 bottom-... z-40` panel pinned over exactly the pixels that
  // sheet slides across — and it was there on every single launch, with no way
  // to move it. It is an in-flow strip now.
  const manager = stripComments(
    readSource("src/components/pwa/PwaManager.tsx"),
  );

  test("nothing in PwaManager is fixed-positioned any more", () => {
    expect(manager).not.toMatch(/\bfixed\b/);
    expect(manager).not.toMatch(/right-4/);
    expect(manager).not.toMatch(/bottom-\[/);
  });

  test("it renders as an in-flow strip, not an overlay", () => {
    expect(manager).toMatch(/border-b border-white\/\[0\.06\]/);
  });

  test("the install card carries no z-index or positioning of its own", () => {
    // Scoped to the install card alone: the UPDATE banner above it is
    // legitimately `z-50` and sits in flow beside the offline banner, so a
    // blanket "no z-index anywhere" assertion would be wrong.
    const start = manager.indexOf("showInstall &&");
    expect(start).toBeGreaterThan(-1);
    const card = manager.slice(start);
    expect(card).not.toMatch(/\bz-\[/);
    expect(card).not.toMatch(/\bz-\d/);
    expect(card).not.toMatch(/\bfixed\b/);
    expect(card).not.toMatch(/\babsolute\b/);
  });
});

describe("the app says WHY it cannot be installed", () => {
  // `registerServiceWorker` is gated behind `import.meta.env.PROD`, and Chrome
  // will not even offer to install an app with no registered service worker.
  // A preview build is therefore never installable, and without this the only
  // message was "This browser hasn't offered installation yet" — which reads
  // as a broken PWA when nothing is broken.

  test("a production build over HTTPS with worker support is NOT blocked", () => {
    expect(
      planInstallBlock({
        hasServiceWorker: true,
        isProd: true,
        isSecureContext: true,
      }),
    ).toBeNull();
  });

  test("a dev/preview build is blocked, and says why", () => {
    const reason = planInstallBlock({
      hasServiceWorker: true,
      isProd: false,
      isSecureContext: true,
    });
    expect(reason).toBeTypeOf("string");
    expect(reason).toMatch(/published build/i);
    expect(reason).toMatch(/dev server/i);
  });

  test("a browser with no service worker support is called out first", () => {
    // This is the criterion Chrome actually enforces, so it must be named.
    const reason = planInstallBlock({
      hasServiceWorker: false,
      isProd: true,
      isSecureContext: true,
    });
    expect(reason).toMatch(/service worker/i);
  });

  test("a published build on plain http says it needs HTTPS", () => {
    const reason = planInstallBlock({
      hasServiceWorker: true,
      isProd: true,
      isSecureContext: false,
    });
    expect(reason).toMatch(/HTTPS|localhost/i);
  });

  test("Settings uses the reason instead of the vague fallback", () => {
    const dialog = readSource("src/components/settings/SettingsDialog.tsx");
    expect(dialog).toMatch(/installBlockedReason\(\)/);
    expect(dialog).toMatch(
      /installBlockedReason\(\)\s*\?\?\s*"This browser hasn't offered installation yet\."/,
    );
  });

  test("the worker really is production-only, which is what makes it true", () => {
    const pwa = readSource("src/lib/pwa.ts");
    expect(pwa).toMatch(/if \(!import\.meta\.env\.PROD\) return null;/);
  });
});

describe("no placeholder assets are left behind", () => {
  test("every shipped icon is a real PNG, not a stub", () => {
    const dir = path.join(root, "public/icons");
    const files = fs.readdirSync(dir);
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const file of files) {
      const buf = fs.readFileSync(path.join(dir, file));
      expect(buf.length).toBeGreaterThan(1000);
      expect(buf.subarray(1, 4).toString()).toBe("PNG");
    }
  });
});
