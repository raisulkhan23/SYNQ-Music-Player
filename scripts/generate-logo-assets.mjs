/**
 * Rebuild every SYNQ icon from the master artwork.
 *
 * The mark lives as one square illustration (the purple squircle with three
 * white bars). Everything that needs an icon — the web favicon, the PWA
 * manifest, the iOS home-screen tile, the Electron/NSIS installer icon, the
 * tray image and the Android launcher — is derived from it here, so no surface
 * can keep showing a previous logo.
 *
 * Usage:
 *   node scripts/generate-logo-assets.mjs [path-to-master.jpg|png]
 *
 * Default source: `assets/logo-master.jpg` next to the repo root (copy the
 * artwork there before running). The tile is located by scanning for the
 * brightly lit region, not by a hardcoded crop, so a re-exported master at a
 * different resolution still works.
 *
 * Requires `sharp` (devDependency). All PNGs are written with filter type 0 so
 * `tests/logo-assets.test.js` can decode them without a full PNG filter
 * implementation.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source =
  process.argv[2] ?? path.join(root, "assets", "logo-master.jpg");

if (!fs.existsSync(source)) {
  console.error(
    `logo master not found: ${source}\n` +
      "Pass the artwork path explicitly, e.g.\n" +
      "  node scripts/generate-logo-assets.mjs C:/path/to/logo.jpg",
  );
  process.exit(1);
}

/** PNG settings used for every output. */
const PNG = { compressionLevel: 9, filter: "none", palette: false };

/** Write a PNG and report the size it was written at. */
async function writePng(pipeline, relPath) {
  const target = path.join(root, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const info = await pipeline.png(PNG).toFile(target);
  console.log(
    `  ${relPath.padEnd(48)} ${info.width}x${info.height} ${Math.round(
      info.size / 1024,
    )} KB`,
  );
}

/** A rounded-rectangle mask as SVG, used with `dest-in` compositing. */
function roundedMask(size, radius) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="#fff"/>` +
      "</svg>",
  );
}

/** A circular mask, for Android's round launcher icon. */
function circleMask(size) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/>` +
      "</svg>",
  );
}

/**
 * Locate the tile in the source artwork.
 *
 * The background is a dark textured photograph and the tile is saturated and
 * much brighter, so a luminance threshold gives a stable bounding box across
 * re-exports. The corner radius is read from the same mask: the diagonal
 * distance at which the tile becomes opaque is `r * (1 - 1/√2)`.
 */
async function locateTile(file) {
  const { data, info } = await sharp(file)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const lum = (x, y) => {
    const i = (y * width + x) * channels;
    return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  };
  const THRESHOLD = 100; // well above the dark backdrop, below the tile body
  const inside = (x, y) =>
    x >= 0 && y >= 0 && x < width && y < height && lum(x, y) > THRESHOLD;

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!inside(x, y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error("could not find the tile in the artwork");

  let diagonal = 0;
  while (diagonal < 400 && !inside(minX + diagonal, minY + diagonal)) {
    diagonal++;
  }

  const size = Math.min(maxX - minX + 1, maxY - minY + 1);
  // A squircle is slightly rounder than a plain rounded rect; the measured
  // diagonal inset is the radius of the corner arc either way.
  const radius = Math.round(diagonal / (1 - Math.SQRT1_2));
  return {
    left: minX,
    top: minY,
    size,
    radiusRatio: Math.min(0.3, Math.max(0.18, radius / size)),
  };
}

const tile = await locateTile(source);
const RADIUS = tile.radiusRatio;
console.log(
  `master ${path.basename(source)} — tile ${tile.size}px at (${tile.left},${tile.top}), corner ${(RADIUS * 100).toFixed(1)}%`,
);

// The master keeps the artwork's own detail (the source tile is ~584px, so
// upscaling it first would only add resampling noise); every smaller asset is a
// single downsample of it so nothing is resampled twice.
const MASTER = tile.size;
const cropped = sharp(source).extract({
  left: tile.left,
  top: tile.top,
  width: tile.size,
  height: tile.size,
});

const roundedMaster = await sharp(
  await cropped.resize(MASTER, MASTER, { kernel: "lanczos3" }).toBuffer(),
)
  .composite([
    { input: roundedMask(MASTER, Math.round(MASTER * RADIUS)), blend: "dest-in" },
  ])
  .png(PNG)
  .toBuffer();

// Rounded, transparent-corner variants (in-app mark, favicons, launcher icons).
function rounded(size) {
  return sharp(roundedMaster).resize(size, size, { kernel: "lanczos3" });
}

/**
 * Launcher icons (maskable PWA icon, iOS home screen, Android adaptive layer).
 *
 * These are NOT crops of the artwork tile, and deliberately so: a launcher
 * applies its own mask, and Android crops a maskable icon to the centre 80%
 * circle. The artwork is a perspective render, so its glyph sits ~5% right of
 * the tile centre and its glass sheen is bright enough to be read as part of
 * the mark — dropping the render in as-is puts the bars off-centre inside the
 * safe circle. So the launcher variants are drawn from the same geometry and
 * palette instead, with the bars mathematically centred and the sheen dimmed
 * enough to stay out of the glyph's luminance range.
 *
 * The bar tips and widths are the artwork's, measured in 512-space.
 */
const BARS = [
  { from: [164, 171], to: [369, 230], width: 40 },
  { from: [142, 249], to: [406, 305], width: 42 },
  { from: [124, 322], to: [434, 367], width: 44 },
];
const BAR_STROKES = BARS.map(
  (b) =>
    `<path d="M${b.from[0]} ${b.from[1]} L${b.to[0]} ${b.to[1]}" stroke-width="${b.width}" />`,
).join("");

// Union bounding box of the round-capped strokes, so the composition can be
// centred on the icon rather than on the tile.
const barBox = BARS.reduce(
  (box, b) => {
    const r = b.width / 2;
    const x0 = Math.min(b.from[0], b.to[0]) - r;
    const x1 = Math.max(b.from[0], b.to[0]) + r;
    const y0 = Math.min(b.from[1], b.to[1]) - r;
    const y1 = Math.max(b.from[1], b.to[1]) + r;
    return {
      x0: Math.min(box.x0, x0),
      x1: Math.max(box.x1, x1),
      y0: Math.min(box.y0, y0),
      y1: Math.max(box.y1, y1),
    };
  },
  { x0: 512, x1: 0, y0: 512, y1: 0 },
);
const barCentre = [
  (barBox.x0 + barBox.x1) / 2,
  (barBox.y0 + barBox.y1) / 2,
];
// 0.86 keeps the glyph's corners inside the 0.4*size maskable safe radius.
const LAUNCHER_SCALE = 0.86;
const BARS_GROUP =
  `<g transform="translate(256 256) scale(${LAUNCHER_SCALE}) ` +
  `translate(${-barCentre[0]} ${-barCentre[1]})" ` +
  `stroke="url(#barGrad)" stroke-linecap="round" fill="none">` +
  BAR_STROKES +
  `</g>`;

const BODY_STOPS = `
  <stop offset="0" stop-color="#2c2e96" />
  <stop offset="0.38" stop-color="#4317bf" />
  <stop offset="0.72" stop-color="#7b23dd" />
  <stop offset="1" stop-color="#ba2df2" />`;

/** Full-bleed launcher tile: brand gradient, dim sheen, centred bars. */
function launcherSvg(size) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
      <defs>
        <linearGradient id="body" x1="0" y1="0" x2="0.8" y2="1">${BODY_STOPS}</linearGradient>
        <radialGradient id="sheen" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stop-color="#f0edff" stop-opacity="0.13" />
          <stop offset="0.7" stop-color="#e3deff" stop-opacity="0.09" />
          <stop offset="1" stop-color="#e3deff" stop-opacity="0" />
        </radialGradient>
        <linearGradient id="barGrad" gradientUnits="userSpaceOnUse" x1="0" y1="160" x2="0" y2="390">
          <stop offset="0" stop-color="#ffffff" />
          <stop offset="0.62" stop-color="#fdfbff" />
          <stop offset="1" stop-color="#e7e0fb" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" fill="url(#body)" />
      <circle cx="0" cy="0" r="300" fill="url(#sheen)" />
      ${BARS_GROUP}
    </svg>`,
  );
}

/** Transparent adaptive foreground containing only the mark. */
function foregroundSvg(size) {
  const scale = LAUNCHER_SCALE * 0.72;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
      <defs>
        <linearGradient id="barGrad" gradientUnits="userSpaceOnUse" x1="0" y1="160" x2="0" y2="390">
          <stop offset="0" stop-color="#ffffff" />
          <stop offset="1" stop-color="#e7e0fb" />
        </linearGradient>
      </defs>
      <g transform="translate(256 256) scale(${scale}) translate(${-barCentre[0]} ${-barCentre[1]})"
         stroke="url(#barGrad)" stroke-linecap="round" fill="none">${BAR_STROKES}</g>
    </svg>`,
  );
}

console.log("web + PWA icons");
const logoPng = await rounded(512).png(PNG).toBuffer();
const target = path.join(root, "public/logo.png");
fs.writeFileSync(target, logoPng);
console.log(`  public/logo.png                                  512x512 ${Math.round(logoPng.length / 1024)} KB`);
await writePng(rounded(180), "public/product-icon.png");
// Derived from the shipped 512 logo so the installed app and the header carry
// the same pixels, never a second render that can drift.
await writePng(sharp(logoPng).resize(192, 192, { kernel: "lanczos3" }), "public/icons/icon-192.png");
await writePng(sharp(logoPng), "public/icons/icon-512.png");
await writePng(rounded(32), "public/favicon-32.png");
await writePng(rounded(16), "public/favicon-16.png");
// Maskable + iOS: full-bleed, no alpha channel (a transparent corner shows as
// black under a launcher mask), and the glyph centred for the 80% safe circle.
for (const [size, file] of [
  [192, "public/icons/maskable-192.png"],
  [512, "public/icons/maskable-512.png"],
  [180, "public/icons/apple-180.png"],
]) {
  await writePng(
    sharp(launcherSvg(size)).removeAlpha().toColourspace("srgb"),
    file,
  );
}

console.log("android launcher");
const ANDROID = [
  ["mdpi", 48, 108],
  ["hdpi", 72, 162],
  ["xhdpi", 96, 216],
  ["xxhdpi", 144, 324],
  ["xxxhdpi", 192, 432],
];
for (const [density, launcher, foreground] of ANDROID) {
  const dir = path.join(root, "android/app/src/main/res", `mipmap-${density}`);
  fs.mkdirSync(dir, { recursive: true });

  const icon = await rounded(launcher).png(PNG).toBuffer();
  fs.writeFileSync(path.join(dir, "ic_launcher.png"), icon);

  const round = await sharp(icon)
    .composite([
      { input: circleMask(launcher), blend: "dest-in" },
    ])
    .png(PNG)
    .toBuffer();
  fs.writeFileSync(path.join(dir, "ic_launcher_round.png"), round);

  // Adaptive foreground: the mark alone, transparent, inside the 66% safe zone.
  const layer = await sharp(foregroundSvg(foreground)).png(PNG).toBuffer();
  fs.writeFileSync(path.join(dir, "ic_launcher_foreground.png"), layer);
  console.log(`  mipmap-${density}/ ic_launcher ${launcher}px, foreground ${foreground}px`);
}

// The Capacitor template shipped a stock blue "X" splash. It has to carry the
// mark as well, or the app opens on someone else's logo.
console.log("android splash");
const SPLASHES = [
  ["drawable", 480, 320],
  ["drawable-land-mdpi", 480, 320],
  ["drawable-land-hdpi", 800, 480],
  ["drawable-land-xhdpi", 1280, 720],
  ["drawable-land-xxhdpi", 1600, 960],
  ["drawable-land-xxxhdpi", 1920, 1280],
  ["drawable-port-mdpi", 320, 480],
  ["drawable-port-hdpi", 480, 800],
  ["drawable-port-xhdpi", 720, 1280],
  ["drawable-port-xxhdpi", 960, 1600],
  ["drawable-port-xxxhdpi", 1280, 1920],
];
for (const [dirName, width, height] of SPLASHES) {
  const glyph = Math.round(Math.min(width, height) * 0.26);
  const mark = await sharp(roundedMaster).resize(glyph, glyph).png(PNG).toBuffer();
  await writePng(
    sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 0x12, g: 0x14, b: 0x1c },
      },
    }).composite([
      {
        input: mark,
        left: Math.round((width - glyph) / 2),
        top: Math.round((height - glyph) / 2),
      },
    ]),
    path.join("android/app/src/main/res", dirName, "splash.png"),
  );
}

console.log("done");
