const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const SRC = path.resolve(__dirname, "../public/logo.png");
const OUT = path.resolve(__dirname, "../public/logo.ico");
const TARGET_SIZES = [16, 24, 32, 48, 64, 128, 256];


// ---------------------------------------------------------------------------
// PNG reading — correct, byte-level chunk parser.
// ---------------------------------------------------------------------------

function readPngRGBA(buf) {
  let off = 8;
  const chunks = [];
  while (off < buf.length) {
    if (off + 12 > buf.length) break;
    const len =
      (buf[off] << 24) |
      (buf[off + 1] << 16) |
      (buf[off + 2] << 8) |
      buf[off + 3];
    const type = buf.slice(off + 4, off + 8).toString("ascii");
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    const crcEnd = dataEnd + 4;
    if (dataEnd > buf.length || crcEnd > buf.length) break;
    chunks.push({ type, data: buf.slice(dataStart, dataEnd) });
    off = crcEnd;
  }

  const ihdr = chunks.find((c) => c.type === "IHDR");
  if (!ihdr) throw new Error("no IHDR");
  const w = (ihdr.data[0] << 24) | (ihdr.data[1] << 16) | (ihdr.data[2] << 8) | ihdr.data[3];
  const h = (ihdr.data[4] << 24) | (ihdr.data[5] << 16) | (ihdr.data[6] << 8) | ihdr.data[7];
  const bd = ihdr.data[8];
  const ct = ihdr.data[9];
  if (!(bd === 8 && ct === 6)) throw new Error(`need 8-bit RGBA; got bd=${bd} ct=${ct}`);
  if (!(w > 0 && h > 0)) throw new Error(`bad size ${w}x${h}`);
  if (!(w === h)) throw new Error(`src must be square; got ${w}x${h}`);

  const idat = chunks.filter((c) => c.type === "IDAT").map((c) => c.data);
  if (idat.length === 0) throw new Error("no IDAT");
  const inflated = zlib.inflateSync(Buffer.concat(idat));

  // PNG rows are filter-compressed: every row is preceded by a one-byte filter
  // type and each byte is a delta against the pixel to the left (Sub), the
  // pixel above (Up), or a Paeth predictor. Reading the stream as if it were
  // plain pixel data — which is what this did — produces a plausible-looking
  // but wrong image, and that is why the packaged executable shipped an icon
  // that was not the SYNQ mark.
  const bpp = 4;
  const stride = w * bpp;
  const unfiltered = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const filterType = inflated[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    const outStart = y * stride;
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? unfiltered[outStart + i - bpp] : 0;
      const up = y > 0 ? unfiltered[outStart - stride + i] : 0;
      const upLeft =
        i >= bpp && y > 0 ? unfiltered[outStart - stride + i - bpp] : 0;
      let value = inflated[rowStart + i];
      if (filterType === 1) value += left;
      else if (filterType === 2) value += up;
      else if (filterType === 3) value += (left + up) >> 1;
      else if (filterType === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else if (filterType !== 0) {
        throw new Error(`unsupported PNG filter type ${filterType}`);
      }
      unfiltered[outStart + i] = value & 0xff;
    }
  }

  // Kept bottom-up here: makeDib() writes its rows bottom-up as the DIB format
  // requires, so the two flips cancel and the icon ends up upright.
  const pixels = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcRow = y * stride;
    const dstRow = (h - 1 - y) * stride;
    for (let x = 0; x < stride; x++) pixels[dstRow + x] = unfiltered[srcRow + x];
  }
  return {
    width: w,
    height: h,
    pixels,
    rawLen: inflated.length,
  };
}

// ---------------------------------------------------------------------------
// Resampling — nearest-corner bilinear, from a square RGBA source.
// ---------------------------------------------------------------------------

function resample(pixels, sw, sh, dw, dh) {
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const fy = (y / dh) * sh;
    const sy = Math.floor(fy);
    const syp = fy - sy;
    const ny = Math.min(sy + 1, sh - 1);
    for (let x = 0; x < dw; x++) {
      const fx = (x / dw) * sw;
      const sx = Math.floor(fx);
      const sxp = fx - sx;
      const nx = Math.min(sx + 1, sw - 1);
      const di = (y * dw + x) * 4;
      const s00 = (sy * sw + sx) * 4;
      const s10 = (sy * sw + nx) * 4;
      const s01 = (ny * sw + sx) * 4;
      const s11 = (ny * sw + nx) * 4;
      for (let c = 0; c < 4; c++) {
        const top =
          sxp > 0.5 ? pixels[s10 + c] : pixels[s00 + c];
        const bot =
          sxp > 0.5 ? pixels[s11 + c] : pixels[s01 + c];
        let v =
          (pixels[s00 + c] * (1 - sxp) + top * sxp) * (1 - syp) +
          (pixels[s01 + c] * (1 - sxp) + bot * sxp) * syp;
        if (v < 0) v = 0;
        if (v > 255) v = 255;
        out[di + c] = Math.round(v);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// DIB (BITMAPINFOHEADER) writer for an ICO entry.
// ---------------------------------------------------------------------------

function makeDib(pixels, w, h, size) {
  const src =
    w === size && h === size ? pixels : resample(pixels, w, h, size, size);
  const stride = size * 4;

  // The AND mask: 1 bit per pixel, rows padded to a 4-byte boundary, listed
  // bottom-up like the colour data. A set bit means "transparent". Modern
  // 32bpp icons carry an alpha channel and Windows prefers it, but the mask is
  // still part of the format: rcedit (which embeds the icon into the .exe) and
  // some Explorer icon paths read a DIB that assumes it is present. Omitting it
  // produces an .ico that is structurally short — the previous logo.ico was
  // exactly that, and the packaged executable ended up showing the default
  // Electron icon instead of the SYNQ mark.
  const maskStride = ((size + 31) >> 5) * 4;
  const maskSize = maskStride * size;

  const dib = Buffer.allocUnsafe(40 + size * stride + maskSize);
  dib.writeUInt32LE(40, 0); // header size
  dib.writeUInt32LE(size, 4); // width
  dib.writeUInt32LE(size, 8); // height (= bitmap height; ICO dir stores size)
  dib.writeUInt16LE(1, 12); // planes
  dib.writeUInt16LE(32, 14); // bpp
  dib.writeUInt32LE(0, 16); // compression
  dib.writeUInt32LE(size * stride, 20); // image size (colour bitmap)
  dib.writeInt32LE(0, 24); // x pixels per meter
  dib.writeInt32LE(0, 28); // y pixels per meter
  dib.writeUInt32LE(0, 32); // colors used
  dib.writeUInt32LE(0, 36); // important colors
  const pos = 40;
  for (let y = 0; y < size; y++) {
    const srcRow = y * size * 4;
    const dstRow = pos + (size - 1 - y) * stride;
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 4;
      // A Windows DIB stores pixels as B, G, R, A. The PNG we read is R, G, B,
      // A, so the channels are reordered here rather than copied across. Copying
      // them verbatim is why the packaged icon rendered in the wrong colours:
      // red and blue were swapped, turning the purple SYNQ mark pink.
      dib[d] = src[s + 2]; // blue
      dib[d + 1] = src[s + 1]; // green
      dib[d + 2] = src[s]; // red
      dib[d + 3] = src[s + 3]; // alpha
    }
  }

  const maskPos = pos + size * stride;
  for (let y = 0; y < size; y++) {
    const srcRow = y * size * 4;
    const dstRow = maskPos + (size - 1 - y) * maskStride;
    for (let x = 0; x < size; x++) {
      // Fully transparent pixels set the mask bit; anything with alpha keeps a
      // zero bit so the alpha channel decides the blend.
      if (src[srcRow + x * 4 + 3] === 0) {
        dib[dstRow + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }

  return dib;
}

// ---------------------------------------------------------------------------
// ICO writer.
// ---------------------------------------------------------------------------

function buildIco(items) {
  const count = items.length;
  const dirSize = 6 + count * 16;
  let totalSize = dirSize;
  for (const it of items) totalSize += it.dib.byteLength;
  const buf = Buffer.allocUnsafe(totalSize);
  buf.writeUInt16LE(0, 0); // reserved
  buf.writeUInt16LE(1, 2); // icon type (1 = icon)
  buf.writeUInt16LE(count, 4); // entry count
  let off = dirSize;
  // ICO directory entry is 16 bytes with 1-byte width/height:
  // bWidth(bH) bColorCount bReserved wPlanes(wBitCount) dwBytesInRes dwImageOffset
  // 1+1+1+1+2+2+4+4 = 16 bytes.
  for (let i = 0; i < count; i++) {
    const { size, dib } = items[i];
    const bWidth = size >= 256 ? 0 : size;
    const bHeight = size >= 256 ? 0 : size;
    const base = 6 + i * 16;
    buf.writeUInt8(bWidth, base + 0); // bWidth (1 byte)
    buf.writeUInt8(bHeight, base + 1); // bHeight (1 byte)
    buf.writeUInt8(0, base + 2); // bColorCount
    buf.writeUInt8(0, base + 3); // bReserved
    buf.writeUInt16LE(1, base + 4); // wPlanes
    buf.writeUInt16LE(32, base + 6); // wBitCount
    buf.writeUInt32LE(dib.byteLength, base + 8); // dwBytesInRes
    buf.writeUInt32LE(off, base + 12); // dwImageOffset
    dib.copy(buf, off);
    off += dib.byteLength;
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

(async () => {
  try {
    if (!fs.existsSync(SRC)) {
      console.warn("logo.png not found; skipping ico build");
      return;
    }
    const src = fs.readFileSync(SRC);
  const { width, height, pixels, rawLen } = readPngRGBA(src);
  console.log(`png: ${width}x${height} rawLen=${rawLen}`);
  const items = TARGET_SIZES.map((size) => {
    // Always resample from the native 512x512 source to the target ico size.
    return {
      size,
      dib: makeDib(pixels, width, height, size),
    };
  });
  fs.writeFileSync(OUT, buildIco(items));
  console.log("wrote", OUT);
  } catch (err) {
    console.error("ico build failed:", err.message);
    const errPath = path.resolve(__dirname, "../public/.ico-build-fail.log");
    fs.writeFileSync(errPath, err.stack || err.message);
    console.warn("stack written to", errPath);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
