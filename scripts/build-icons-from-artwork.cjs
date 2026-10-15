'use strict';
/**
 * Rebuild every shipped SYNQ icon from one source artwork.
 *
 * WHY THIS EXISTS
 * `public/logo.png` is the source of truth for the app mark: electron-builder
 * reads it for the frame/taskbar icon and the NSIS installer, and the PWA icon
 * set under `public/icons/` is derived from the same mark. When those files
 * drifted out of sync (or were the wrong image entirely) the desktop app, the
 * tab favicon and the installed mobile app all showed a different logo.
 *
 * The artwork we were given is a single JPEG mockup: the rounded-square SYNQ
 * mark floating on a dark textured backdrop. Only the mark is the icon, so this
 * script finds the mark, cuts it out, makes the backdrop transparent, and
 * renders every size the app references from that one square.
 *
 * WHY ELECTRON: `nativeImage` is already a devDependency of this repo, decodes
 * JPEG/PNG and does high-quality resizing in-process. No sharp, no ImageMagick,
 * no Python — the repo has none of those and this must run on a plain checkout.
 *
 * RUN:  npx electron scripts/build-icons-from-artwork.cjs
 *       (override the source with LOGO_SOURCE=/path/to/art.jpg)
 */
const fs = require('fs');
const path = require('path');
const { app, nativeImage } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const SOURCE =
  process.env.LOGO_SOURCE || path.join(__dirname, 'brand', 'logo-source.jpg');

/** Luminance above which a pixel is part of the bright mark, not the backdrop. */
const MARK_LUMA = 55;
/**
 * Luminance above which a pixel is the near-white GLYPH.
 *
 * Distinct from MARK_LUMA, which finds the mark's full extent including its
 * soft glow. A maskable icon is cropped to the centre 80% circle by the
 * launcher, so what has to be centred and contained is the glyph a person
 * recognises — not the glow around it, which is asymmetric and would drag the
 * framing off-axis.
 */
const GLYPH_LUMA = 170;
/**
 * Fraction of the icon the glyph's bounding box may reach, measured from the
 * centre to the box corner. Android keeps a circle of radius 0.4 * size, so a
 * maskable render lands just inside it; the iOS icon is only rounded, so it can
 * carry a fuller mark.
 */
const MASKABLE_SAFE = 0.38;
const IOS_SAFE = 0.46;
/** Backdrop threshold for the flood fill that makes the corners transparent. */
const BG_LUMA = 46;
/**
 * Canonical master size written to public/logo.png.
 *
 * 512, not 1024: electron-builder asks for at least 256 and recommends 512, the
 * largest icon the PWA set renders is 512, and a 1024 master only meant every
 * deploy shipped a ~1.3 MB PNG that nothing ever displayed at that size.
 */
const MASTER = 512;

/** BGRA: b,g,r,a -> perceptual luminance. */
function luma(b, i) {
  return 0.114 * b[i] + 0.587 * b[i + 1] + 0.299 * b[i + 2];
}

/** Bounding box of everything brighter than MARK_LUMA. */
function findMark(pixels, w, h) {
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (luma(pixels, (y * w + x) * 4) > MARK_LUMA) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error('no mark found in source artwork');
  return { minX, minY, maxX, maxY };
}

/**
 * Copy the mark into a square RGBA buffer and knock out the backdrop.
 *
 * The backdrop is dark and connected to the border, so a flood fill from every
 * border pixel over "dark" pixels selects exactly the backdrop and stops at the
 * bright mark. Those pixels become transparent, which is what turns a screenshot
 * of an icon on a textured background into a usable icon.
 */
function extractSquare(pixels, w, h, box) {
  // Expand the mark's box to a square so the icon is never stretched.
  const side = Math.max(box.maxX - box.minX + 1, box.maxY - box.minY + 1);
  const cx = (box.minX + box.maxX) / 2;
  const cy = (box.minY + box.maxY) / 2;
  let left = Math.round(cx - side / 2);
  let top = Math.round(cy - side / 2);
  left = Math.max(0, Math.min(w - side, left));
  top = Math.max(0, Math.min(h - side, top));

  const out = Buffer.alloc(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const si = ((top + y) * w + (left + x)) * 4;
      const di = (y * side + x) * 4;
      out[di] = pixels[si];
      out[di + 1] = pixels[si + 1];
      out[di + 2] = pixels[si + 2];
      out[di + 3] = 255;
    }
  }

  // Flood fill the dark, border-connected backdrop and clear its alpha.
  const isBg = new Uint8Array(side * side);
  const queue = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= side || y >= side) return;
    const idx = y * side + x;
    if (isBg[idx]) return;
    if (luma(out, idx * 4) >= BG_LUMA) return;
    isBg[idx] = 1;
    queue.push(idx);
  };
  for (let x = 0; x < side; x++) {
    push(x, 0);
    push(x, side - 1);
  }
  for (let y = 0; y < side; y++) {
    push(0, y);
    push(side - 1, y);
  }
  while (queue.length) {
    const idx = queue.pop();
    const x = idx % side;
    const y = (idx / side) | 0;
    push(x - 1, y);
    push(x + 1, y);
    push(x, y - 1);
    push(x, y + 1);
  }
  // A 1px feather hides the JPEG fringe left along the cut edge.
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      if (isBg[y * side + x]) out[(y * side + x) * 4 + 3] = 0;
    }
  }

  return { buffer: out, side };
}

/** Render an RGBA buffer to a PNG at the requested square size. */
function renderPng(rgba, side, size) {
  const image = nativeImage.createFromBitmap(rgba, {
    width: side,
    height: side,
  });
  const resized =
    size === side
      ? image
      : image.resize({ width: size, height: size, quality: 'best' });
  return resized.toPNG();
}

/** Bounding box of the near-white glyph inside a mark buffer. */
function findGlyph(rgba, side) {
  let minX = side;
  let minY = side;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      if (luma(rgba, (y * side + x) * 4) > GLYPH_LUMA) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) throw new Error('no glyph found in the extracted mark');
  return { minX, minY, maxX, maxY };
}

/**
 * Render the mark onto a solid backdrop, CENTRED on its glyph and scaled so the
 * glyph fits the maskable-icon safe zone.
 *
 * The previous version resized the whole tile by a fixed 0.72 and centred the
 * TILE. Measured on the shipped artwork that put the glyph 27px off centre on a
 * 512 icon (so a circular launcher mask visibly clips one side) and pushed its
 * bounding box to 253px from the centre where Android keeps 204.8px. Both come
 * from the same mistake: centring and sizing the glow rather than the glyph.
 *
 * Here the scale is DERIVED from the glyph: the resize factor is chosen so the
 * glyph's bounding-box corner lands on `safeFraction * size` from the centre,
 * and the translation puts the glyph's own centre on the icon's centre. The
 * mark's transparent corners are composited over `background`, which is what
 * makes the result opaque — iOS paints transparency black, and a maskable icon
 * is cropped, so neither may have an alpha channel. `background` is BGRA, like
 * the buffers `nativeImage` hands out.
 */
function renderBadge(rgba, side, size, safeFraction, background) {
  const glyph = findGlyph(rgba, side);
  const gw = glyph.maxX - glyph.minX + 1;
  const gh = glyph.maxY - glyph.minY + 1;
  const gcx = (glyph.minX + glyph.maxX) / 2;
  const gcy = (glyph.minY + glyph.maxY) / 2;

  const scale = (2 * safeFraction * size) / Math.hypot(gw, gh);
  const inner = Math.max(1, Math.round(side * scale));
  const image = nativeImage
    .createFromBitmap(rgba, { width: side, height: side })
    .resize({ width: inner, height: inner, quality: 'best' });
  const bmp = image.getBitmap();
  // Recompute from the ROUNDED size, so the glyph lands where the arithmetic
  // says it does instead of drifting by up to half a pixel.
  const k = inner / side;
  const offsetX = Math.round(size / 2 - gcx * k);
  const offsetY = Math.round(size / 2 - gcy * k);

  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const di = (y * size + x) * 4;
      let b = background[0];
      let g = background[1];
      let r = background[2];
      const sx = x - offsetX;
      const sy = y - offsetY;
      if (sx >= 0 && sy >= 0 && sx < inner && sy < inner) {
        const si = (sy * inner + sx) * 4;
        const a = bmp[si + 3] / 255;
        b = Math.round(bmp[si] * a + b * (1 - a));
        g = Math.round(bmp[si + 1] * a + g * (1 - a));
        r = Math.round(bmp[si + 2] * a + r * (1 - a));
      }
      out[di] = b;
      out[di + 1] = g;
      out[di + 2] = r;
      out[di + 3] = 255;
    }
  }
  return nativeImage
    .createFromBitmap(out, { width: size, height: size })
    .toPNG();
}

function write(file, buffer) {
  const abs = path.join(PUBLIC, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buffer);
  console.log(`wrote public/${file} (${buffer.length} bytes)`);
}

app.disableHardwareAcceleration();
app.whenReady().then(() => {
  try {
    if (!fs.existsSync(SOURCE)) {
      throw new Error(`source artwork not found: ${SOURCE}`);
    }
    const img = nativeImage.createFromPath(SOURCE);
    if (img.isEmpty()) throw new Error(`could not decode ${SOURCE}`);
    const { width: w, height: h } = img.getSize();
    const pixels = img.getBitmap();

    const box = findMark(pixels, w, h);
    const { buffer, side } = extractSquare(pixels, w, h, box);
    console.log(
      `source ${w}x${h}; mark ${box.minX},${box.minY}..${box.maxX},${box.maxY}; crop ${side}x${side}`,
    );

    const master = renderPng(buffer, side, MASTER);
    write('logo.png', master);
    write('favicon-32.png', renderPng(buffer, side, 32));
    write('favicon-16.png', renderPng(buffer, side, 16));
    write('icons/icon-512.png', renderPng(buffer, side, 512));
    write('icons/icon-192.png', renderPng(buffer, side, 192));
    // The app's theme background, BGRA. Opaque on purpose: a maskable icon is
    // cropped by the launcher and iOS paints transparency black.
    const bg = [0x12, 0x14, 0x1c];
    // iOS masks to a rounded rectangle rather than a circle, so it can carry a
    // fuller mark — but it must still be a real PNG with no alpha.
    write('icons/apple-180.png', renderBadge(buffer, side, 180, IOS_SAFE, bg));
    // Android crops to the centre 80% circle, so the glyph is centred and sized
    // to land inside it.
    write('icons/maskable-512.png', renderBadge(buffer, side, 512, MASKABLE_SAFE, bg));
    write('icons/maskable-192.png', renderBadge(buffer, side, 192, MASKABLE_SAFE, bg));
    write('product-icon.png', renderPng(buffer, side, 512));
    console.log('done');
    app.exit(0);
  } catch (err) {
    console.error('FAILED:', err.message);
    app.exit(1);
  }
});
