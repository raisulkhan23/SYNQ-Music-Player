const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

// Independent re-encode of the new product logo PNG as a valid Windows ICO.
// This file is deliberately separate from the legacy fix-logo-ico.cjs so we can
// replace the product mark without touching the old "fix the broken ico" story
// or any of the abandoned build-ico*.cjs experiments.
//
// Source of truth for the product logo is public/logo.png. The ICO here is only
// a packaging convenience for the native title-bar / taskbar / tray / installer
// icon paths electron-builder and the tray code ask for. It is derived, never
// edited by hand, and can be regenerated at any time from the PNG.

const SRC = path.resolve(__dirname, "../public/logo.png");
const OUT = path.resolve(__dirname, "../public/logo.ico");

const SRC_BUF = fs.readFileSync(SRC);

// Byte-level PNG signature check. Do NOT use Buffer#toString here — the bytes
// are binary and the string interpretation is platform/encoding dependent.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
if (SRC_BUF.length < 200 || Buffer.compare(SRC_BUF.slice(0, 8), PNG_SIG) !== 0) {
  throw new Error(
    `logo.png is not a usable PNG at ${SRC} (${SRC_BUF.length} bytes). ` +
      "Put the new product logo there and rerun this script.",
  );
}

// --- minimal PNG tooling -----------------------------------------------------

function parseChunk(buf, off) {
  const length = buf.readUInt32BE(off);
  const type = buf.toString("ascii", off + 4, off + 8);
  const data = buf.subarray(off + 8, off + 8 + length);
  return { length, type, data, next: off + 12 + length };
}

function parseIhdr(data) {
  return {
    width: data.readUInt32BE(0),
    height: data.readUInt32BE(4),
    bitDepth: data[8],
    colourType: data[9],
  };
}

function findIdat(buf) {
  const chunks = [];
  let off = 8;
  while (off < buf.length) {
    const { length, type, next } = parseChunk(buf, off);
    if (type === "IEND") break;
    if (type === "IDAT") chunks.push({ length, data: buf.subarray(off + 8, off + 8 + length), next });
    off = next;
  }
  return chunks;
}

function decompressIdat(idatChunks) {
  const compressed = Buffer.concat(idatChunks.map((c) => c.data));
  return zlib.inflateSync(compressed);
}

function reconstructPng(ihdr, raw, idatChunks) {
  const out = Buffer.allocUnsafe(8 + 13 + raw.length + idatChunks.length * 2);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let off = 8;

  const ihdrChunk = Buffer.allocUnsafe(13);
  ihdrChunk.writeUInt32BE(ihdr.width, 0);
  ihdrChunk.writeUInt32BE(ihdr.height, 4);
  ihdrChunk[8] = ihdr.bitDepth;
  ihdrChunk[9] = 6; // RGBA
  ihdrChunk[10] = 0;
  ihdrChunk[11] = 0;
  ihdrChunk[12] = 0;
  writeChunk(out, "IHDR", ihdrChunk, off);
  off += 12 + 13;

  for (let i = 0; i < idatChunks.length; i++) {
    writeChunk(out, "IDAT", idatChunks[i].data, off);
    off += 12 + idatChunks[i].length;
  }

  writeChunk(out, "IEND", Buffer.allocUnsafe(0), off);
  return out;
}

function writeChunk(out, type, data, off) {
  out.writeUInt32BE(data.length, off);
  out.write(type, off + 4, 4, "ascii");
  out.set(data, off + 8);
  // CRC is computed over type + data; we fill it last.
  const crc = crc32(out.subarray(off + 4, off + 8 + data.length));
  out.writeUInt32BE(crc >>> 0, off + 8 + data.length);
}

function crc32(buf) {
  let c = 0xffffffff;
  const table = crcTable;
  for (let i = 0; i < buf.length; i++) {
    c = (c >>> 8) ^ table[(c ^ buf[i]) & 0xff];
  }
  return c ^ 0xffffffff;
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

// --- ICO encoder -------------------------------------------------------------

function toDib(pixels, w, h, bpp) {
  const line = w * 4; // we only emit 32bpp here
  const stride = (line + 3) & ~3;
  const raw = Buffer.allocUnsafe(stride * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (y * w + x) * 4;
      const dst = (h - 1 - y) * stride + x * 4;
      // BITMAPINFOHEADER DIBs are bottom-up; premultiplied alpha makes Windows
      // blit this icon correctly with a transparent background on the taskbar.
      const r = pixels[src];
      const g = pixels[src + 1];
      const b = pixels[src + 2];
      const a = pixels[src + 3];
      raw.writeUInt8((r * a) >> 8, dst);
      raw.writeUInt8((g * a) >> 8, dst + 1);
      raw.writeUInt8((b * a) >> 8, dst + 2);
      raw.writeUInt8(a, dst + 3);
    }
  }
  // XOR mask for 32bpp is all zeros.
  const xor = raw;
  const and = Buffer.alloc(Math.ceil(w / 8) * h);
  const header = Buffer.allocUnsafe(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(w, 4);
  header.writeInt32LE(h, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  header.writeInt32LE(stride * h, 20);
  header.writeInt32LE(0, 24);
  header.writeUInt32LE(w * h * 4, 28);
  header.writeUInt32LE(0, 32);
  header.writeInt32LE(0, 36);
  return Buffer.concat([header, xor, and]);
}

function resample(pixels, sw, sh, dw, dh) {
  const out = Buffer.allocUnsafe(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      // nearest-neighbour is fine for these tiny icon sizes.
      const sx = (x / dw) * sw;
      const sy = (y / dh) * sh;
      const ix = Math.min(sw - 1, Math.max(0, Math.round(sx)));
      const iy = Math.min(sh - 1, Math.max(0, Math.round(sy)));
      const si = (iy * sw + ix) * 4;
      const di = (y * dw + x) * 4;
      out[di] = pixels[si];
      out[di + 1] = pixels[si + 1];
      out[di + 2] = pixels[si + 2];
      out[di + 3] = pixels[si + 3];
    }
  }
  return out;
}

// ---------------- main -------------------------------------------------------

const idatChunks = findIdat(SRC_BUF);
const { width: sw, height: sh, bitDepth: bd, colourType: ct } = parseIhdr(
  parseChunk(SRC_BUF, 8).data,
);
if (bd !== 8 || ct !== 6) {
  throw new Error(
    `logo.png must be an 8-bit RGBA PNG (got bitDepth=${bd}, colourType=${ct}).`,
  );
}

const raw = decompressIdat(idatChunks);
const ihdr = parseIhdr(parseChunk(SRC_BUF, 8).data);

// Regenerate the source PNG from scratch so we are pixel-perfect and guarantee
// the ICO gets a normal, non-premultiplied, full-alpha RGBA image.
const rebuiltSrc = reconstructPng(ihdr, raw, idatChunks);
const { pixels } = parsePngPixels(rebuiltSrc);

const MAX_ICON = 256;
const scale = Math.min(MAX_ICON / sw, MAX_ICON / sh, 1);
const dw = Math.max(1, Math.round(sw * scale));
const dh = Math.max(1, Math.round(sh * scale));
const scaled = resample(pixels, sw, sh, dw, dh);

const sizes = [16, 24, 32].filter((s) => s <= dw && s <= dh);
if (sizes.length === 0) {
  throw new Error(
    `logo.png is too small to build any icon size (scaled to ${dw}x${dh}).`,
  );
}

const dibs = sizes.map((s) =>
  toDib(
    resample(scaled, dw, dh, s, s),
    s,
    s,
    32,
  ),
);

const headerSize = 6 + sizes.length * 16;
const imageSize = dibs.reduce((a, d) => a + d.length, 0);
const totalSize = headerSize + imageSize;
const out = Buffer.allocUnsafe(totalSize);

// ICO header: reserved=0, type=1 (icon), image count
out.writeUInt16LE(0, 0);
out.writeUInt16LE(1, 2);
out.writeUInt16LE(sizes.length, 4);

const dataStart = 6 + sizes.length * 16;
let cursor = dataStart;
sizes.forEach((s, i) => {
  const d = dibs[i];
  out.writeUInt8(s, 6 + i * 16); // width
  out.writeUInt8(s, 6 + i * 16 + 1); // height
  out.writeUInt8(0, 6 + i * 16 + 2); // colour palette
  out.writeUInt8(0, 6 + i * 16 + 3); // reserved
  out.writeUInt16LE(1, 6 + i * 16 + 4); // colour planes
  out.writeUInt16LE(32, 6 + i * 16 + 6); // bits per pixel
  out.writeUInt32LE(d.length, 6 + i * 16 + 8); // size of image data
  out.writeUInt32LE(cursor, 6 + i * 16 + 12); // offset to image data
  cursor += d.length;
});

dibs.forEach((d) => {
  d.copy(out, cursor);
  cursor += d.length;
});

// Write via a temp file + rename so a half-written ico can never be left behind
// if this run is interrupted after the file opens.
const tmp = OUT + ".tmp";
fs.writeFileSync(tmp, out.slice(0, cursor));
fs.renameSync(tmp, OUT);

console.log(
  `logo.ico regenerated: ${cursor} bytes, sizes=[${sizes.join(",")}], ` +
    `from ${SRC_BUF.length} byte logo.png (${sw}×${sh}).`,
);
console.log(`  output: ${OUT}`);

// --- PNG pixel parser (reconstruct-then-read, so we trust only the IHDR) ----

function parsePngPixels(buf) {
  const ihdr = parseIhdr(parseChunk(buf, 8).data);
  const idatChunks = findIdat(buf);
  const raw = decompressIdat(idatChunks);
  const w = ihdr.width;
  const h = ihdr.height;
  const stride = w * 4;
  const pixels = Buffer.allocUnsafe(w * h * 4);
  let rp = 0;
  let op = 0;
  for (let y = 0; y < h; y++) {
    // skip filter byte
    const filter = raw[rp++];
    for (let x = 0; x < stride; x++) {
      const cur = raw[rp++];
      const left = x > 0 ? pixels[op - 4 + x - 1] : 0;
      const up = y > 0 ? pixels[op - stride * 4 + x] : 0;
      const upLeft = y > 0 && x > 0 ? pixels[op - stride * 4 + x - 1] : 0;
      let sample;
      switch (filter) {
        case 0:
          sample = cur;
          break; // None
        case 1:
          sample = cur + left;
          break; // Sub
        case 2:
          sample = cur + up;
          break; // Up
        case 3:
          sample = cur + ((left + up) >> 1);
          break; // Average
        case 4:
          sample = cur + (left + up - upLeft);
          break; // Paeth
        default:
          throw new Error(`unsupported PNG filter byte ${filter} at row ${y}`);
      }
      pixels[op++] = sample & 0xff;
    }
    // Tighten to 0-255; Paeth math can produce negatives in JS bitwise ops.
    for (let i = 0; i < stride; i++) {
      const v = pixels[op - stride + i];
      pixels[op - stride + i] =
        v < 0 ? (v & 0xff) : v > 255 ? 255 : v;
    }
  }
  return { pixels, width: w, height: h };
}

module.exports = { parsePngPixels, toDib, resample };
