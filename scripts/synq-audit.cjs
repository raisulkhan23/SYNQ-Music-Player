const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const errors = [];

function rel(p) {
  return path.relative(ROOT, p);
}

function checkFile(assertion, description, files) {
  files = Array.isArray(files) ? files : [files];
  for (const file of files) {
    const full = path.join(ROOT, file);
    const exists = fs.existsSync(full);
    const ok = assertion(exists, full);
    console.log(`${ok ? "OK " : "XX "} ${rel(full)} — ${description}`);
    if (!ok) {
      errors.push(`${rel(full)}: ${description}`);
    }
  }
}

function checkGlobal(desc) {
  console.log(`-- ${desc}`);
}

// ---------------------------------------------------------------- Assets
checkGlobal("Public / asset path audit (packaged file:// must not use leading /)");

checkFile(
  (exists) => exists,
  "logo.svg exists so /logo.svg used by Logo.tsx and index.html will 404 from file:// packaged app (needs origin-relative or imported path)",
  "public/logo.svg"
);

checkFile(
  (exists) => exists,
  "show-me-love-cover.svg exists (Landing page uses /show-me-love-cover.svg)",
  "public/show-me-love-cover.svg"
);

checkFile(
  (exists) => exists,
  "icon-192.png exists (PWA / settings dialog use /icons/icon-192.png)",
  "public/icons/icon-192.png"
);

checkFile(
  (exists) => exists,
  "apple-180.png exists (index.html apple-touch-icon link)",
  "public/icons/apple-180.png"
);

checkFile(
  (exists) => exists,
  "manifest.webmanifest exists (index.html link)",
  "public/manifest.webmanifest"
);

checkFile(
  (exists) => exists,
  "sw.js exists at /public root (service worker registration uses /sw.js path)",
  "public/sw.js"
);

checkFile(
  (exists) => exists,
  "hero.png exists (index.html og:image / twitter:image link)",
  "public/hero.png"
);

checkFile(
  (exists) => exists,
  "logo.png exists (tray + electron-builder extraResource + fallback icon)",
  "public/logo.png"
);

checkFile(
  (exists) => exists,
  "logo.ico exists (electron-builder icon + NSIS installer/uninstaller icons)",
  "public/logo.ico"
);

checkFile(
  (exists) => exists,
  "product-icon.png exists (Android Capacitor app icon source likely)",
  "public/product-icon.png"
);

// ---------------------------------------------------------------- Icon integrity
checkGlobal("Icon integrity (logo.ico)");
try {
  const buf = fs.readFileSync(path.join(ROOT, "public/logo.ico"));
  if (buf.length < 6) {
    console.log("XX public/logo.ico — file too small");
    errors.push("public/logo.ico: file too small");
  } else {
    const reserved = buf.readUInt16LE(0);
    const type = buf.readUInt16LE(2);
    const count = buf.readUInt16LE(4);
    console.log(
      `OK public/logo.ico — reserved=${reserved} type=${type} entries=${count} fileSize=${buf.length}`
    );
    if (reserved !== 0) errors.push("public/logo.ico: reserved field nonzero");
    if (type !== 1) errors.push(`public/logo.ico: type=${type} wanted 1`);
    if (count < 1) errors.push("public/logo.ico: no entries");

    let maskFail = 0;
    for (let i = 0; i < count; i++) {
      const o = 6 + i * 16;
      if (o + 16 > buf.length) break;
      const w = buf[o] || 256;
      const h = buf[o + 1] || 256;
      const planes = buf.readUInt16LE(o + 4);
      const bpp = buf.readUInt16LE(o + 6);
      const bytesInRes = buf.readUInt32LE(o + 8);
      const imageOffset = buf.readUInt32LE(o + 12);
      if (imageOffset + bytesInRes > buf.length) {
        console.log(
          `XX public/logo.ico entry ${i}: offset+bytes=${imageOffset}+${bytesInRes} exceeds file=${buf.length}`
        );
        errors.push(`public/logo.ico entry ${i}: truncated image data`);
        continue;
      }
      // 32bpp AND mask is optional per spec, but a "correct" ico that
      // electron-builder / Windows resource compiler expects includes it.
      // Here we report, not fail, so the rest of the checks still run.
      const dibStart = imageOffset;
      if (dibStart + 40 > buf.length) continue;
      const dibHeaderSize = buf.readUInt32LE(dibStart);
      const imgDataSize = buf.readUInt32LE(dibStart + 20);
      // An icon DIB is a 40-byte BITMAPINFOHEADER + the 32bpp XOR bitmap +
      // the 1bpp AND mask (rows padded to 4 bytes).
      const maskStride = ((w + 31) >> 5) * 4;
      const expectedTotal = 40 + w * h * 4 + maskStride * h;
      const hasAndMask = bytesInRes === expectedTotal;
      console.log(
        `  entry ${i}: ${w}x${h} bpp=${bpp} planes=${planes} header=${dibHeaderSize} bytesInRes=${bytesInRes} expected=${expectedTotal} imgSize=${imgDataSize} hasAndMask=${hasAndMask}`
      );
      if (bpp !== 32) errors.push(`public/logo.ico entry ${i}: bpp=${bpp} wanted 32`);
      if (dibHeaderSize !== 40)
        errors.push(`public/logo.ico entry ${i}: BITMAPINFOHEADER size=${dibHeaderSize}`);
      if (!hasAndMask) maskFail++;
    }
    if (maskFail > 0) {
      console.log(
        `  NOTE: ${maskFail} of ${count} icons missing the 1bpp AND bitmask (regenerate with scripts/build-ico5.cjs).`
      );
      errors.push(`public/logo.ico: ${maskFail} entries missing the 1bpp AND bitmask`);
    }
  }
} catch (e) {
  console.log(`XX public/logo.ico — read failed: ${e.message}`);
  errors.push(`public/logo.ico: read failed: ${e.message}`);
}

// ---------------------------------------------------------------- Build output sanity (if present)
checkGlobal("Existing build artifacts (informational)");
const distExists = fs.existsSync(path.join(ROOT, "dist"));
const distWinExists = fs.existsSync(path.join(ROOT, "dist-win"));
const desktopDistExists = fs.existsSync(path.join(ROOT, "desktop-dist"));
const androidApkDebug = fs
  .readdirSync(path.join(ROOT, "android", "app", "build", "outputs", "apk", "debug"))
  .filter((n) => n.endsWith(".apk"))
  .map((n) => path.join(ROOT, "android", "app", "build", "outputs", "apk", "debug", n));
const androidApkRelease = fs
  .readdirSync(path.join(ROOT, "android", "app", "build", "outputs", "apk", "release"))
  .filter((n) => n.endsWith(".apk"))
  .map((n) => path.join(ROOT, "android", "app", "build", "outputs", "apk", "release", n));

console.log(`dist/ exists=${distExists}`);
console.log(`dist-win/ exists=${distWinExists}`);
console.log(`desktop-dist/ exists=${desktopDistExists}`);
console.log(`android debug apks: ${androidApkDebug.length ? androidApkDebug.map(rel).join(", ") : "(none)"}`);
console.log(`android release apks: ${androidApkRelease.length ? androidApkRelease.map(rel).join(", ") : "(none)"}`);

// ---------------------------------------------------------------- Source asset refs
//
// A root-absolute URL to a /public file is invisible in the hosted app and
// broken in the packaged one (`/logo.svg` becomes `file:///logo.svg`). Vite does
// not rewrite these when they are hand-written string literals in JS, which is
// exactly how the SYNQ logo failed to load on the desktop. Any such reference
// must therefore go through `publicAsset()`.
checkGlobal("Hand-written /public references in src (must use publicAsset)");
try {
  const publicFiles = new Set(fs.readdirSync(path.join(ROOT, "public")));
  for (const sub of ["icons"]) {
    for (const f of fs.readdirSync(path.join(ROOT, "public", sub))) {
      publicFiles.add(`${sub}/${f}`);
    }
  }
  const offenders = [];
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      // `publicAsset.ts` is the resolver itself — it documents the very URLs
      // being looked for. `pwa.ts`'s `/sw.js` is served only on http(s): the
      // registration is skipped outright for file:// and for the Android shell.
      if (entry.name === "publicAsset.ts" || entry.name === "pwa.ts") continue;
      const source = fs.readFileSync(full, "utf8");
      for (const match of source.matchAll(/["'`]\/([A-Za-z0-9._/-]+)["'`]/g)) {
        const file = match[1].split("?")[0];
        if (publicFiles.has(file)) {
          offenders.push(`${rel(full)}: "${match[0]}"`);
        }
      }
    }
  };
  scan(path.join(ROOT, "src"));
  // `publicAsset.ts` is the resolver itself and necessarily names its inputs by
  // relative path only, so it cannot appear here.
  if (offenders.length === 0) {
    console.log("OK  no hand-written root-absolute /public references left in src");
  } else {
    for (const o of offenders) console.log(`XX  ${o}`);
    errors.push(
      `src: ${offenders.length} root-absolute /public reference(s) — wrap in publicAsset()`
    );
  }
} catch (e) {
  console.log(`-- source asset scan skipped: ${e.message}`);
}

// ---------------------------------------------------------------- Electron config
checkGlobal("Electron menu / OAuth config");
const mainCjs = fs.readFileSync(path.join(ROOT, "electron/main.cjs"), "utf8");
const oauthModule = fs.readFileSync(
  path.join(ROOT, "electron/oauth-deep-link.cjs"),
  "utf8"
);
const hasSetApplicationMenu = mainCjs.includes("Menu.setApplicationMenu(null)");
// The navigation guard lives in the OAuth module and is installed from main.
const hasWillNavigate =
  oauthModule.includes("will-navigate") &&
  oauthModule.includes("will-attach-webview") &&
  mainCjs.includes("onAuthNavigation");
const hasOpenExternal = oauthModule.includes("openExternal") || mainCjs.includes("shell.openExternal");
const hasSynqProtocol = oauthModule.includes("synq://") || mainCjs.includes("synq://");
const hasRegisterProtocol = oauthModule.includes("setAsDefaultProtocolClient");
console.log(
  `electron/main.cjs + oauth-deep-link.cjs: setApplicationMenu=${hasSetApplicationMenu} will-navigate=${hasWillNavigate} openExternal=${hasOpenExternal} synq://=${hasSynqProtocol} registerProtocol=${hasRegisterProtocol}`
);
if (!hasSetApplicationMenu) errors.push("electron/main.cjs: no setApplicationMenu() call found — default menu likely still shown");
if (!hasWillNavigate)
  errors.push(
    "electron/main.cjs: no will-navigate/will-attach-webview handler found — auth navigation may open embedded"
  );
if (!hasSynqProtocol)
  errors.push("electron/main.cjs: no synq:// deep-link handler found — OAuth return path missing on desktop");

// ---------------------------------------------------------------- OAuth server-side
checkGlobal("Convex Auth server redirect rules");
try {
  const authTs = fs.readFileSync(path.join(ROOT, "src/convex/auth.ts"), "utf8");
  console.log(`src/convex/auth.ts size=${authTs.length} chars`);
  if (!authTs.includes("redirectTo")) {
    errors.push("src/convex/auth.ts: no redirectTo handling found");
  }
  if (!authTs.includes("Google")) {
    errors.push("src/convex/auth.ts: Google provider not referenced");
  }
} catch (e) {
  errors.push(`src/convex/auth.ts: read failed ${e.message}`);
}

// ---------------------------------------------------------------- Renderer desktop awareness
checkGlobal("Renderer desktop detection (useAuth / AuthForm / AuthPromptDialog)");
function hasDesktopBranch(file) {
  try {
    const s = fs.readFileSync(path.join(ROOT, file), "utf8");
    return (
      s.includes("isElectron") ||
      s.includes("window.synq") ||
      s.includes("window.__synqDesktop") ||
      s.includes("synq://") ||
      s.includes("electron")
    );
  } catch {
    return false;
  }
}
console.log(
  `AuthForm.tsx desktop branch present=${hasDesktopBranch("src/components/auth/AuthForm.tsx")}`
);
console.log(
  `AuthPromptDialog.tsx desktop branch present=${hasDesktopBranch("src/components/auth/AuthPromptDialog.tsx")}`
);
console.log(
  `Auth.tsx desktop branch present=${hasDesktopBranch("src/pages/Auth.tsx")}`
);
console.log(
  `main.tsx wired useDesktop=${mainCjs.includes("window.synq")} (renderer side)`
);
// Renderer-side desktop bridge check
let rendererHasDesktopBridge = false;
try {
  // Only the renderer sources count here: the main-process module necessarily
  // mentions these same names, and counting it would make the check vacuous.
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(f);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const s = fs.readFileSync(f, "utf8");
      if (
        s.includes("window.synq") &&
        s.includes("synq://callback") &&
        s.includes("beginOAuth")
      ) {
        rendererHasDesktopBridge = true;
        console.log(`  renderer desktop bridge found in ${rel(f)}`);
      }
    }
  };
  walk(path.join(ROOT, "src"));
} catch {}
if (!rendererHasDesktopBridge) {
  errors.push(
    "renderer: no desktop OAuth bridge (window.synq.desktop + synq:// callback) found in source"
  );
}

// ---------------------------------------------------------------- Preload surface
checkGlobal("Preload surface completeness");
const preload = fs.readFileSync(path.join(ROOT, "electron/preload.cjs"), "utf8");
const hasOpenOAuth =
  preload.includes("beginOAuth") && preload.includes("onAuthResult");
console.log(`electron/preload.cjs exposes desktop OAuth opener=${hasOpenOAuth}`);
if (!hasOpenOAuth) {
  errors.push("electron/preload.cjs: no desktop OAuth opener exposed to renderer");
}

// ---------------------------------------------------------------- electron-builder config
checkGlobal("electron-builder.yml sanity");
const eb = fs.readFileSync(path.join(ROOT, "electron-builder.yml"), "utf8");
console.log(`electron-builder.yml icon=public/logo.ico in config=${eb.includes("public/logo.ico")}`);
console.log(`electron-builder.yml win.target present=${eb.includes("target:")}`);
console.log(`electron-builder.yml nsis installerIcon present=${eb.includes("installerIcon:")}`);
if (!eb.includes("public/logo.ico")) {
  errors.push("electron-builder.yml: icon reference missing");
}
if (!eb.includes("installerIcon:")) {
  errors.push("electron-builder.yml: installerIcon missing");
}

// ---------------------------------------------------------------- Summary
console.log("\n================");
if (errors.length === 0) {
  console.log("No issues flagged by this diagnostic pass.");
} else {
  console.log(`FLAGGED ${errors.length}:`);
  for (const e of errors) console.log(` - ${e}`);
}

// Return a non-zero exit if any hard issue found, so CI can catch it.
process.exit(errors.length ? 1 : 0);
