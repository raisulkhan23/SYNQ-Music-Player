/**
 * Packaging and asset audit.
 *
 * Every check here corresponds to something that actually went wrong in a
 * shipped SYNQ build:
 *
 *  - `public/logo.png` was the wrong image and `public/logo.ico` was generated
 *    from it, so the app, the installer and the tray all showed the wrong mark.
 *  - `electron-builder.yml` pointed the NSIS `installerIcon` / `uninstallerIcon`
 *    at a PNG. Those are ICO-only inputs, so the installer was built with a
 *    placeholder icon instead of SYNQ's.
 *  - The ICO carried only 16/24/32, so Windows had nothing to draw at 48 or 256
 *    and fell back to an upscale (or a generic icon) in the shell.
 *  - The default File/Edit/View menu was visible in the packaged window.
 *
 * These are cheap, deterministic checks against the files on disk — no browser,
 * no Electron, no network. Intentionally remote images (album art, avatars) are
 * NOT referenced here: only assets this repo is responsible for shipping.
 *
 * Run: node --test tests/packaging-assets.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pub = (rel) => path.join(ROOT, "public", rel);

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPngSize(file) {
  const buf = readFileSync(file);
  assert.ok(
    buf.subarray(0, 8).equals(PNG_SIG),
    `${path.basename(file)} does not start with the PNG signature`,
  );
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), bytes: buf.length };
}

/** Parse an ICO directory into its sizes (0 means 256 per the format). */
function readIcoSizes(file) {
  const buf = readFileSync(file);
  assert.equal(buf.readUInt16LE(0), 0, "ICO reserved field must be 0");
  assert.equal(buf.readUInt16LE(2), 1, "ICO type must be 1 (icon)");
  const count = buf.readUInt16LE(4);
  assert.ok(count > 0, "ICO has no directory entries");
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    sizes.push(buf[off] === 0 ? 256 : buf[off]);
  }
  return { sizes, bytes: buf.length };
}

test("the shipped logo assets exist and are the real mark", () => {
  for (const rel of [
    "logo.png",
    "logo.ico",
    "logo.svg",
    "favicon-16.png",
    "favicon-32.png",
    "icons/icon-192.png",
    "icons/icon-512.png",
    "icons/apple-180.png",
    "icons/maskable-192.png",
    "icons/maskable-512.png",
  ]) {
    assert.ok(existsSync(pub(rel)), `missing public/${rel}`);
    assert.ok(statSync(pub(rel)).size > 0, `public/${rel} is empty`);
  }
});

test("logo.png is a square PNG big enough for electron-builder", () => {
  const { w, h, bytes } = readPngSize(pub("logo.png"));
  assert.equal(w, h, `logo.png must be square, got ${w}x${h}`);
  // electron-builder refuses to derive an application icon below 256x256.
  assert.ok(w >= 256, `logo.png must be at least 256x256, got ${w}x${h}`);
  assert.ok(bytes > 1024, "logo.png looks like a stub");
});

test("logo.ico carries every size Windows asks the shell to draw", () => {
  const { sizes } = readIcoSizes(pub("logo.ico"));
  for (const required of [16, 32, 48, 256]) {
    assert.ok(
      sizes.includes(required),
      `logo.ico is missing the ${required}px entry; has [${sizes.join(", ")}]`,
    );
  }
});

test("electron-builder points every icon input at a real .ico", () => {
  const yml = readFileSync(path.join(ROOT, "electron-builder.yml"), "utf8");

  // NSIS installerIcon/uninstallerIcon are ICO-only. A PNG there is silently
  // replaced by a placeholder — the "generic folder icon" in the reports.
  for (const key of ["installerIcon", "uninstallerIcon"]) {
    const match = yml.match(new RegExp(`^\\s*${key}:\\s*(\\S+)\\s*$`, "m"));
    assert.ok(match, `${key} is not configured`);
    assert.match(
      match[1],
      /\.ico$/i,
      `${key} must be an .ico, got ${match[1]}`,
    );
    assert.ok(
      existsSync(path.join(ROOT, match[1])),
      `${key} points at a missing file: ${match[1]}`,
    );
  }

  // The Windows target's own icon, likewise.
  const winIcon = yml.match(/^win:[\s\S]*?^\s*icon:\s*(\S+)\s*$/m);
  assert.ok(winIcon, "win.icon is not configured");
  assert.match(winIcon[1], /\.ico$/i, `win.icon must be an .ico, got ${winIcon[1]}`);

  // Whatever the icon is, it must be shipped to the tray at runtime.
  assert.match(
    yml,
    /extraResources:[\s\S]*logo\.ico/,
    "extraResources must ship logo.ico for the tray",
  );
});

test("the packaged main process clears the default application menu", () => {
  const main = readFileSync(path.join(ROOT, "electron", "main.cjs"), "utf8");
  assert.match(
    main,
    /Menu\.setApplicationMenu\(\s*null\s*\)/,
    "main.cjs must clear the default File/Edit/View menu",
  );
  assert.match(
    main,
    /oauth\.onAuthNavigation|onAuthNavigation\(/,
    "main.cjs must guard navigation (external browser for auth origins)",
  );
  assert.match(
    main,
    /registerDeepLink|onSecondInstance/,
    "main.cjs must register the synq:// deep-link handler",
  );
  // Security posture: none of these may regress.
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /contextIsolation:\s*true/);
});

test("the production build output carries the app assets", (t) => {
  const dist = path.join(ROOT, "dist");
  if (!existsSync(path.join(dist, "index.html"))) {
    t.skip("dist/ not built yet — run `npm run build` first");
    return;
  }
  for (const rel of [
    "index.html",
    "logo.svg",
    "logo.png",
    "favicon-32.png",
    "icons/icon-192.png",
    "icons/icon-512.png",
    "manifest.webmanifest",
  ]) {
    assert.ok(
      existsSync(path.join(dist, rel)),
      `dist/${rel} is missing from the production build`,
    );
  }
  // The Android installer is served by the website, so it must exist as a
  // source asset...
  assert.ok(
    existsSync(pub("downloads/SYNQ-1.0.0.apk")),
    "public/downloads/SYNQ-1.0.0.apk is missing — the website download would 404",
  );
  // ...but its presence in dist/ is NOT guaranteed: `android:sync` runs
  // scripts/strip-downloads-from-dist.cjs so the APK is not embedded inside
  // itself, which leaves dist/ in exactly that state. Asserting it here would
  // fail every time someone builds Android after a web build. So: if it is
  // there it must be intact, and if it is not, that is a known, intentional
  // state rather than a regression.
  const apkInDist = path.join(dist, "downloads", "SYNQ-1.0.0.apk");
  if (existsSync(apkInDist)) {
    assert.ok(
      statSync(apkInDist).size > 1024 * 1024,
      "dist/downloads/SYNQ-1.0.0.apk is present but suspiciously small",
    );
  } else {
    t.diagnostic(
      "dist/downloads is absent — expected after `android:sync` (strip step); the web deploy build recreates it from public/",
    );
  }
});
