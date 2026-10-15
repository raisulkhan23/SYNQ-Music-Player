'use strict';
/**
 * Rebuild public/logo.ico from public/logo.png — high quality, no hand-rolled
 * bitmap encoder.
 *
 * WHY THIS REPLACED THE PREVIOUS ENCODER
 * --------------------------------------
 * The old builder wrote each icon size as a raw 32-bit DIB (BITMAPINFOHEADER +
 * XOR pixels + AND mask). It declared a positive `biHeight`, which is the ICO/
 * BMP convention for **bottom-up** row order, but the pixels were written
 * top-down. Windows therefore displayed every entry vertically mirrored: the
 * SYNQ bars (which sit low in the mark) appeared along the top and the icon read
 * as a different, "zoomed" logo in the taskbar, Explorer and the installer.
 * Averages measured against the correct image: 49.9 as declared vs 3.3 read the
 * other way round — a flip, not a crop or a scale.
 *
 * Rather than fix one row-order bug and keep every other footgun (manual
 * bilinear resampling, AND masks, 4-byte row padding), this emits each size as
 * an embedded **PNG** entry. Windows Vista and later read PNG entries in an ICO
 * natively — it is what most modern icon tooling ships — and the pixels are
 * then byte-identical to the PNG renders the app already uses, so the .ico can
 * never disagree with the rest of the branding.
 *
 * The directory entries for 256px icons must record width/height as 0 (the
 * 1-byte field cannot hold 256).
 *
 * RUN: npx electron scripts/build-logo-ico-from-png.cjs
 */
const fs = require('fs');
const path = require('path');
const { app, nativeImage } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'public', 'logo.png');
const OUT = path.join(ROOT, 'public', 'logo.ico');

/** Sizes Windows actually asks the shell to draw, plus the in-between steps. */
const SIZES = [16, 24, 32, 48, 64, 128, 256];

app.disableHardwareAcceleration();
app.whenReady().then(() => {
  try {
    if (!fs.existsSync(SRC)) throw new Error(`missing ${SRC}`);
    const master = nativeImage.createFromPath(SRC);
    if (master.isEmpty()) throw new Error(`could not decode ${SRC}`);
    const size = master.getSize();
    if (size.width !== size.height) {
      throw new Error(`logo.png must be square, got ${size.width}x${size.height}`);
    }
    if (size.width < 256) {
      throw new Error(
        `logo.png must be at least 256px for Windows icons, got ${size.width}`,
      );
    }

    // Render every size once, with Chromium's high-quality resampler.
    const images = SIZES.map((target) => ({
      target,
      png: master.resize({ width: target, height: target, quality: 'best' }).toPNG(),
    }));

    const headerSize = 6 + images.length * 16;
    const totalSize =
      headerSize + images.reduce((n, img) => n + img.png.length, 0);
    const out = Buffer.alloc(totalSize);

    // ICONDIR: reserved, type (1 = icon), count.
    out.writeUInt16LE(0, 0);
    out.writeUInt16LE(1, 2);
    out.writeUInt16LE(images.length, 4);

    let entryOff = 6;
    let dataOff = headerSize;
    for (const { target, png } of images) {
      const field = target >= 256 ? 0 : target; // 0 means 256 in this directory
      out.writeUInt8(field, entryOff); // bWidth
      out.writeUInt8(field, entryOff + 1); // bHeight
      out.writeUInt8(0, entryOff + 2); // bColorCount (0 = truecolour)
      out.writeUInt8(0, entryOff + 3); // bReserved
      out.writeUInt16LE(1, entryOff + 4); // wPlanes
      out.writeUInt16LE(32, entryOff + 6); // wBitCount
      out.writeUInt32LE(png.length, entryOff + 8); // dwBytesInRes
      out.writeUInt32LE(dataOff, entryOff + 12); // dwImageOffset
      entryOff += 16;

      png.copy(out, dataOff);
      dataOff += png.length;
    }

    if (dataOff !== totalSize) {
      throw new Error(`packing mismatch: ${dataOff} != ${totalSize}`);
    }

    fs.writeFileSync(OUT, out);
    console.log(
      `logo.ico written: ${out.length} bytes, ${images.length} entries [${SIZES.join(
        ', ',
      )}] (PNG-compressed)`,
    );
    app.exit(0);
  } catch (err) {
    console.error('FAILED:', err.message);
    app.exit(1);
  }
});
