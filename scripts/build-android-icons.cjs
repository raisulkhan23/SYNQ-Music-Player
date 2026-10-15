'use strict';
/**
 * Rebuild the Android launcher icon set from public/logo.png.
 *
 * WHY THIS EXISTS
 * ---------------
 * `android/app/src/main/res/mipmap-*` shipped two mistakes:
 *
 *  1. `ic_launcher_foreground.png` was a byte-for-byte copy of
 *     `ic_launcher.png` — the full-bleed mark scaled to fill the whole canvas.
 *     An adaptive-icon foreground is NOT full bleed: Android paints it inside a
 *     108dp canvas and then applies a launcher-chosen mask to the inner 72dp
 *     safe zone. A mark that already touches all four edges therefore gets its
 *     rounded-square silhouette sliced off by the mask, so the launcher showed a
 *     circle of SYNQ gradient instead of the SYNQ mark.
 *  2. Every density bucket held the SAME 512x512 file, so a 48dp legacy icon
 *     shipped 512px of pixels and the mdpi/hdpi renders were 10x the size they
 *     are ever drawn at.
 *
 * WHAT IT WRITES
 * --------------
 * Legacy icons (`ic_launcher`, `ic_launcher_round`) at the platform 48dp sizes,
 * and the adaptive foreground at the 108dp sizes with the mark inset to exactly
 * the 72dp safe zone (2/3 of the 108dp canvas), so no conforming launcher mask
 * can clip the mark's silhouette.
 *
 * The `mipmap-anydpi-v26/ic_launcher*.xml` files and `values/ic_launcher_background.xml`
 * already reference `@color/ic_launcher_background` (#12141C); this script only
 * replaces the raster bitmaps they point at, so no XML needs to change.
 *
 * RUN: npx electron scripts/build-android-icons.cjs
 */
const fs = require('fs');
const path = require('path');
const { app, nativeImage } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res');
const SRC = path.join(ROOT, 'public', 'logo.png');

/**
 * Android's density buckets and their dpi scale. `mipmap-` folder -> scale.
 * @type {Array<[string, number]>}
 */
const DENSITIES = [
  ['mdpi', 1],
  ['hdpi', 1.5],
  ['xhdpi', 2],
  ['xxhdpi', 3],
  ['xxxhdpi', 4],
];

/** Legacy launcher icon size, in dp. */
const LEGACY_DP = 48;
/** Adaptive-icon layer size, in dp (the mask only guarantees the inner 72dp). */
const ADAPTIVE_DP = 108;
/**
 * Adaptive foreground inset.
 *
 * The adaptive canvas is 108dp and Android guarantees only the inner 72dp is
 * visible, so the foreground mark may occupy at most 72/108 = 2/3 of the layer.
 * Going above this (0.72 was the first attempt) pushes the mark's edge midpoints
 * past the safe square by ~2.5%, which a launcher with an aggressive mask would
 * shave.
 */
const ADAPTIVE_INSET = 2 / 3;
/**
 * Legacy round icon inset. This one is clipped to a circle by this script, so
 * the limit is geometry rather than a launcher contract: a rounded square at
 * 0.72 has its furthest point ~48dp from the centre, comfortably inside the
 * 54dp radius of a full-canvas circle mask.
 */
const ROUND_INSET = 0.72;
/** The app's theme background, matching values/ic_launcher_background.xml. */
const THEME_BG = [0x12, 0x14, 0x1c];

/** Decode the source once; every size is resampled from this. */
function loadMaster() {
  if (!fs.existsSync(SRC)) throw new Error(`missing ${SRC}`);
  const image = nativeImage.createFromPath(SRC);
  if (image.isEmpty()) throw new Error(`could not decode ${SRC}`);
  const { width, height } = image.getSize();
  if (width !== height) {
    throw new Error(`logo.png must be square, got ${width}x${height}`);
  }
  if (width < 192) {
    throw new Error(`logo.png must be at least 192px, got ${width}`);
  }
  return image;
}

/**
 * Resample the mark to `inner` px and centre it on a `canvas` px surface.
 *
 * `background` is null for a transparent pad (the adaptive foreground, where the
 * adaptive background layer supplies the colour) or an [r,g,b] triple to fill
 * the pad (the legacy round icon, which is drawn over the theme colour).
 */
function insetOnCanvas(master, canvas, inner, background) {
  const scaled = master
    .resize({ width: inner, height: inner, quality: 'best' })
    .getBitmap();
  const out = Buffer.alloc(canvas * canvas * 4);
  const offset = Math.round((canvas - inner) / 2);

  if (background) {
    for (let i = 0; i < canvas * canvas; i++) {
      out[i * 4] = background[0];
      out[i * 4 + 1] = background[1];
      out[i * 4 + 2] = background[2];
      out[i * 4 + 3] = 255;
    }
  }

  // Source bitmap is BGRA, same order nativeImage.createFromBitmap expects.
  for (let y = 0; y < inner; y++) {
    for (let x = 0; x < inner; x++) {
      const si = (y * inner + x) * 4;
      const dx = x + offset;
      const dy = y + offset;
      if (dx < 0 || dy < 0 || dx >= canvas || dy >= canvas) continue;
      const di = (dy * canvas + dx) * 4;
      const a = scaled[si + 3] / 255;
      if (background) {
        // Composite the mark over the fill so the pad and the mark agree.
        out[di] = Math.round(scaled[si] * a + out[di] * (1 - a));
        out[di + 1] = Math.round(scaled[si + 1] * a + out[di + 1] * (1 - a));
        out[di + 2] = Math.round(scaled[si + 2] * a + out[di + 2] * (1 - a));
        out[di + 3] = 255;
      } else {
        out[di] = scaled[si];
        out[di + 1] = scaled[si + 1];
        out[di + 2] = scaled[si + 2];
        out[di + 3] = scaled[si + 3];
      }
    }
  }

  return nativeImage
    .createFromBitmap(out, { width: canvas, height: canvas })
    .toPNG();
}

/** Clip an RGBA render to a circle, leaving outside pixels transparent. */
function clipToCircle(pngBuffer, size) {
  const image = nativeImage.createFromBuffer(pngBuffer);
  const px = image.getBitmap();
  const r = size / 2;
  // Supersample the edge so the circle is not visibly jagged at 48-192px.
  const samples = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px0 = x + (sx + 0.5) / samples;
          const py0 = y + (sy + 0.5) / samples;
          const dx = px0 - r;
          const dy = py0 - r;
          if (dx * dx + dy * dy <= r * r) hits++;
        }
      }
      const coverage = hits / (samples * samples);
      const i = (y * size + x) * 4;
      px[i + 3] = Math.round(px[i + 3] * coverage);
    }
  }
  return nativeImage
    .createFromBitmap(px, { width: size, height: size })
    .toPNG();
}

function writeBucket(density, file, buffer) {
  const dir = path.join(RES, `mipmap-${density}`);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, file);
  fs.writeFileSync(target, buffer);
  return { file: `mipmap-${density}/${file}`, bytes: buffer.length };
}

app.disableHardwareAcceleration();
app.whenReady().then(() => {
  try {
    const master = loadMaster();
    const written = [];

    for (const [density, scale] of DENSITIES) {
      const legacy = Math.round(LEGACY_DP * scale);
      const adaptive = Math.round(ADAPTIVE_DP * scale);
      const inner = Math.round(adaptive * ADAPTIVE_INSET);
      const legacyInner = Math.round(legacy * ROUND_INSET);

      // Legacy (API < 26): the mark is the icon, full bleed, its own rounded
      // corners already provide the shape.
      written.push(
        writeBucket(
          density,
          'ic_launcher.png',
          master.resize({ width: legacy, height: legacy, quality: 'best' }).toPNG(),
        ),
      );

      // Legacy round: launchers that ask for a round icon draw this inside a
      // circle, so the mark is inset on the theme colour and clipped to it.
      const roundBase = insetOnCanvas(master, legacy, legacyInner, THEME_BG);
      written.push(
        writeBucket(density, 'ic_launcher_round.png', clipToCircle(roundBase, legacy)),
      );

      // Adaptive foreground: mark inside the 72dp safe zone, transparent pad so
      // the adaptive background layer shows through whatever mask is applied.
      written.push(
        writeBucket(
          density,
          'ic_launcher_foreground.png',
          insetOnCanvas(master, adaptive, inner, null),
        ),
      );
    }

    for (const w of written) {
      console.log(`  wrote ${w.file.padEnd(40)} ${String(w.bytes).padStart(7)} bytes`);
    }
    console.log(`done: ${written.length} files`);
    app.exit(0);
  } catch (err) {
    console.error('FAILED:', err.message);
    app.exit(1);
  }
});
