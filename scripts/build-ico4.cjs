const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const SRC = path.resolve(__dirname, "../public/logo.png");
const OUT = path.resolve(__dirname, "../public/logo.ico");
const SIZES = [16, 24, 32, 48, 64, 128, 256];

// Read PNG, extract raw RGBA pixels (color type 6 = 8-bit RGBA, 4 bytes/pixel, no filter byte).
function readPngRGBA(buf) {
  let p = 8;
  // IHDR
  const len =
    (buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3];
  const type = buf.slice(p + 4, p + 8).toString("ascii");
  if (type !== "IHDR") throw new Error("expected IHDR");
  p += 12;
  const w = (buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3];
  const h = (buf[p + 4] << 24) | (buf[p + 5] << 16) | (buf[p + 6] << 8) | buf[p + 7];
  const bd = buf[p + 8];
  const ct = buf[p + 9];
  if (bd !== 8 || ct !== 6) throw new Error("need 8-bit RGBA");
  p += 13;
  // collect IDAT
  const idat = [];
  while (p < buf.length) {
    const clen =
      (buf[p] << 24) | (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3];
    const ctype = buf.slice(p + 4, p + 8).toString("ascii");
    p += 12;
    if (ctype === "IDAT") idat.push(buf.slice(p, p + clen));
    p += clen + 4; // data + crc
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  // colorType 6 = RGBA, 4 bytes/pixel, no filter byte per row
  const pixels = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcRow = y * w * 4;
    const dstRow = (h - 1 - y) * w * 4;
    for (let x = 0; x < w * 4; x++) pixels[dstRow + x] = raw[srcRow + x];
  }
  return { w, h, pixels };
}

function resample(pixels, sw, sh, dw, dh) {
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = (y / dh) * sh;
    const syi = Math.min(Math.floor(sy), sh - 1);
    const syp = sy - Math.floor(sy);
    for (let x = 0; x < dw; x++) {
      const sx = (x / dw) * sw;
      const sxi = Math.min(Math.floor(sx), sw - 1);
      const sxp = sx - Math.floor(sx);
      const si = (syi * sw + sxi) * 4;
      const si2 = ((syi + 1 < sh ? syi + 1 : syi) * sw + sxi) * 4;
      const di = (y * dw + x) * 4;
      const top = syi + 1 < sh && sxp > 0.5 ? si2 : si;
      for (let c = 0; c < 4; c++) {
        const v =
          Math.round(
            (pixels[si + c] * (1 - sxp) + pixels[top + c] * sxp) * (1 - syp) +
              (pixels[si + sw * 4 + c] * (1 - sxp) + pixels[top + sw * 4 + c] * sxp) * syp,
          );
        out[di + c] = Math.max(0, Math.min(255, v));
      }
    }
  }
  return out;
}

function makeDib(pixels, w, h, size) {
  const useDirect = w === size && h === size;
  const src = useDirect ? pixels : resample(pixels, w, h, size, size);
  const stride = size * 4;
  const dib = Buffer.allocUnsafe(40 + size * stride);
  dib.writeUInt32LE(40, 0);
  dib.writeUInt32LE(size, 4);
  dib.writeUInt32LE(size, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  dib.writeUInt32LE(0, 16);
  dib.writeUInt32LE(size * stride, 20);
  dib.writeInt32LE(0, 24);
  dib.writeInt32LE(0, 28);
  dib.writeUInt32LE(0, 32);
  dib.writeUInt32LE(0, 36);
  const pos = 40;
  for (let y = 0; y < size; y++) {
    const srcRow = y * size * 4;
    const dstRow = pos + (size - 1 - y) * stride;
    for (let x = 0; x < size * 4; x++) dib[dstRow + x] = src[srcRow + x];
  }
  return dib;
}

function buildIco(items) {
  const count = items.length;
  const dirSize = 6 + count * 16;
  let total = dirSize;
  for (const it of items) total += it.dib.byteLength;
  const buf = Buffer.allocUnsafe(total);
  buf.writeUInt16LE(0, 0);
  buf.writeUInt16LE(1, 2);
  buf.writeUInt16LE(count, 4);
  let off = dirSize;
  for (let i = 0; i < count; i++) {
    const { dib, size } = items[i];
    const w = size >= 256 ? 0 : size;
    const h = size >= 256 ? 0 : size;
    const base = 6 + i * 16;
    buf.writeUInt16LE(w, base);
    buf.writeUInt16LE(h, base + 2);
    buf.writeUInt8(0, base + 4);
    buf.writeUInt8(0, base + 5);
    buf.writeUInt16LE(1, base + 6);
    buf.writeUInt16LE(32, base + 8);
    buf.writeUInt32LE(dib.byteLength, base + 10);
    buf.writeUInt32LE(off, base + 14);
    dib.copy(buf, off);
    off += dib.byteLength;
  }
  return buf;
}

const png = fs.readFileSync(SRC);
const { w, h, pixels } = readPngRGBA(png);
console.log("png", w, "x", h);

const items = SIZES.map((s) => ({ size: s, dib: makeDib(pixels, w, h, s) }));
for (const it of items) {
  const expected = 40 + it.size * it.size * 4;
  if (it.dib.byteLength !== expected) console.log("BAD dib", it.size, it.dib.byteLength, expected);
}
const ico = buildIco(items);

// verify
const count = ico.readUInt16LE(4);
console.log("ico count", count, "size", ico.length);
let ok = true;
let off = 6 + count * 16;
for (let i = 0; i < count; i++) {
  const base = 6 + i * 16;
  const w = ico.readUInt16LE(base);
  const h = ico.readUInt16LE(base + 2);
  const planes = ico.readUInt16LE(base + 6);
  const bpp = ico.readUInt16LE(base + 8);
  const len = ico.readUInt32LE(base + 10);
  const imgOff = ico.readUInt32LE(base + 14);
  const expW = SIZES[i] >= 256 ? 0 : SIZES[i];
  const expH = SIZES[i] >= 256 ? 0 : SIZES[i];
  const expLen = 40 + SIZES[i] * SIZES[i] * 4;
  const expOff = 6 + count * 16 + items.slice(0, i).reduce((s, it) => s + it.dib.byteLength, 0);
  const good =
    w === expW && h === expH && planes === 1 && bpp === 32 && len === expLen && imgOff === expOff && imgOff + len <= ico.length;
  if (!good) {
    ok = false;
    console.log("BAD entry", i, "w", w, "h", h, "planes", planes, "bpp", bpp, "len", len, "off", imgOff, "expOff", expOff);
  }
}
if (!ok) throw new Error("ico invalid");
fs.writeFileSync(OUT, ico);
console.log("wrote", OUT, ico.length, "bytes — OK");
