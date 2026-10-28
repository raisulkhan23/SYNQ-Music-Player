import sharp from 'sharp';
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import { join, basename } from 'path';

const ROOT = process.argv[2] ? join(process.argv[2], '..') : process.cwd();
const SRC = join(ROOT, 'public/logo-master.png');
if (!existsSync(SRC)) {
  // Try the CWD-relative path directly (when run from repo root)
  const alt = join(process.cwd(), 'public/logo-master.png');
  if (existsSync(alt)) {
    // override ROOT + SRC for this run
    process.chdir(process.cwd());
    SRC = alt;
    ROOT = process.cwd();
  }
}

if (!existsSync(SRC)) {
  console.error('logo-master.png not found at', SRC);
  process.exit(1);
}

const SVG = join(ROOT, 'public/logo.svg');
const SVG_SRC = readFileSync(SVG, 'utf8');

// The SVG already carries the correct mark; the only thing that must change is
// the favicon/mask-icon href inside index.html (it is the SVG itself). The
// raster pipeline below makes everything else from the attached master.

// ---------------------------------------------------------------------------
// 512x512 rounded master (squircle, rx ~ 122/512 ≈ 24%)
// ---------------------------------------------------------------------------
const SQ = 512;
const RADIUS = 122 / 512; // match the SVG squircle

const masterPng = sharp(SRC).resize(SQ, SQ, { kernel: 'lanczos3' });

// rounded corners via a generated mask
function roundedMask(size, radiusPx) {
  // Precompute once; the mask is identical for every size.
  const mask = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = Math.min(x, size - 1 - x);
      const dy = Math.min(y, size - 1 - y);
      const inside = dx >= radiusPx && dy >= radiusPx
        || (dx * dx + dy * dy) <= radiusPx * radiusPx;
      // fill with white where the pixel is inside the squircle
      mask[i] = 255;
      mask[i + 1] = 255;
      mask[i + 2] = 255;
      mask[i + 3] = inside ? 255 : 0;
    }
  }
  return mask;
}

const maskBuf = roundedMask(SQ, Math.round(SQ * RADIUS));

const roundedMaster = await sharp(
  await masterPng.png().toBuffer(),
)
  .composite([{ input: maskBuf, blend: 'dest-in' }])
  .png()
  .toBuffer();

// ---------------------------------------------------------------------------
// Web + PWA icons
// ---------------------------------------------------------------------------
function rounded(size) {
  return sharp(roundedMaster).resize(size, size, { kernel: 'lanczos3' });
}

async function writePng(img, file) {
  const dir = join(file, '..');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, await img.png().toBuffer());
  console.log(`  ${file}`);
}

await writePng(rounded(512), join(ROOT, 'public/logo.png'));
await writePng(rounded(180), join(ROOT, 'public/product-icon.png'));
await writePng(rounded(192), join(ROOT, 'public/icons/icon-192.png'));
await writePng(rounded(512), join(ROOT, 'public/icons/icon-512.png'));
await writePng(rounded(32), join(ROOT, 'public/favicon-32.png'));
await writePng(rounded(16), join(ROOT, 'public/favicon-16.png'));
await writePng(rounded(180), join(ROOT, 'public/icons/apple-180.png'));
await writePng(
  await sharp({ create: { width: 192, height: 192, channels: 4, background: { r: 0x53, g: 0x24, b: 0xc9, alpha: 1 } } })
    .composite([{ input: await sharp(roundedMaster).resize(192, 192).png().toBuffer(), blend: 'over' }]),
  join(ROOT, 'public/icons/maskable-192.png'),
);
await writePng(
  await sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 0x53, g: 0x24, b: 0xc9, alpha: 1 } } })
    .composite([{ input: await sharp(roundedMaster).resize(512, 512).png().toBuffer(), blend: 'over' }]),
  join(ROOT, 'public/icons/maskable-512.png'),
);

// ---------------------------------------------------------------------------
// Electron installer icon: 256x256 ICO
// ---------------------------------------------------------------------------
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const ico = require('@electron/ico');

const ICO_OUT = join(ROOT, 'build/icon.ico');
if (!existsSync(join(ROOT, 'build'))) mkdirSync(join(ROOT, 'build'), { recursive: true });

// The ICO needs a clean 256x256 version. The ICO writer embeds multiple
// sizes; supply 256 and let it downsample for the smaller slots.
const icoSrc = await sharp(roundedMaster)
  .resize(256, 256, { kernel: 'lanczos3' })
  .png()
  .toBuffer();

await new Promise((resolve, reject) => {
  ico.getIconData(icoSrc, (err, icoData) => {
    if (err) return reject(err);
    icoData.writeFile(ICO_OUT, (writeErr) => {
      if (writeErr) return reject(writeErr);
      resolve();
    });
  });
});
console.log(`  build/icon.ico`);

// ---------------------------------------------------------------------------
// Android launcher icons (adaptive + legacy mipmaps)
// ---------------------------------------------------------------------------
const ANDROID = [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192],
];

for (const [density, launcher] of ANDROID) {
  const dir = join(ROOT, `android/app/src/main/res/mipmap-${density}`);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const icon = await sharp(roundedMaster)
    .resize(launcher, launcher, { kernel: 'lanczos3' })
    .png()
    .toBuffer();
  writeFileSync(join(dir, 'ic_launcher.png'), icon);

  // Round variant
  const round = await sharp(icon)
    .composite([{ input: Buffer.alloc(launcher * launcher * 4, 0), blend: 'dest-in' }])
    .png()
    .toBuffer();
  // Instead of the complex round mask, use the same squircle mask scaled down.
  const roundMask = roundedMask(launcher, Math.round(launcher * RADIUS));
  const round2 = await sharp(icon)
    .composite([{ input: roundMask, blend: 'dest-in' }])
    .png()
    .toBuffer();
  writeFileSync(join(dir, 'ic_launcher_round.png'), round2);

  // Adaptive foreground
  const foreground = Math.round(launcher * 1.67); // 108 grid / 66 px
  const inset = Math.round(foreground * 0.17);
  const glyphSize = foreground - inset * 2;
  const glyph = await sharp(roundedMaster)
    .resize(glyphSize, glyphSize, { kernel: 'lanczos3' })
    .png()
    .toBuffer();
  const layer = await sharp({ create: { width: foreground, height: foreground, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: glyph, left: inset, top: inset }])
    .png()
    .toBuffer();
  writeFileSync(join(dir, 'ic_launcher_foreground.png'), layer);
  console.log(`  mipmap-${density}/ ic_launcher ${launcher}px, foreground ${foreground}px`);
}

// Update the adaptive XML to keep the background color (it's fine, matches #12141c)
// No change needed; the foreground is the new artwork.

console.log('done');
