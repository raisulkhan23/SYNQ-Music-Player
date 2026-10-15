const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const SRC = path.resolve(__dirname, "../public/logo.png");
const OUT = path.resolve(__dirname, "../public/logo.ico");

const TARGET_SIZES = [16, 24, 32, 48, 64, 128, 256];

function readPngRgba(buf) {
  let i = 8;
  let width = 0,
    height = 0,
    bitDepth = 0,
    colorType = 0,
    interlace = 0;
  const idat = [];
  for (; i < buf.length; ) {
    const start = i;
    while (buf[i] !== 0x00) i++;
    const len = buf[start + 3] | (buf[start + 2] << 8) | (buf[start + 1] << 16) | (buf[start] << 24);
    const type = buf.slice(i + 4, i + 8).toString("ascii");
    const data = buf.subarray(i + 8, i + 8 + len);
    i += 12 + len;
    if (type === "IHDR") {
      width = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
      height = data[4] | (data[5] << 8) | (data[6] << 16) | (data[7] << 24);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  if (!width || !height || bitDepth !== 8 || colorType !== 6) throw new Error("only 8-bit RGBA PNG supported");
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const pixels = new Uint8Array(width * height * 4);
  const scanline = 1 + width * 4;
  for (let y = 0; y < height; y++) {
    const sp = y * scanline + 1;
    const dp = (height - 1 - y) * width * 4;
    for (let x = 0; x < width * 4; x++) pixels[dp + x] = raw[sp + x];
  }
  return { width, height, pixels };
}

function resizePixels(pixels, srcW, srcH, dstW, dstH) {
  const out = new Uint8Array(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const sy = (y / dstH) * srcH;
    const syi = Math.min(Math.floor(sy), srcH - 1);
    const syp = sy - Math.floor(sy);
    for (let x = 0; x < dstW; x++) {
      const sx = (x / dstW) * srcW;
      const sxi = Math.min(Math.floor(sx), srcW - 1);
      const sxp = sx - Math.floor(sx);
      const si = (syi * srcW + sxi) * 4;
      const si2 = ((syi + 1 < srcH ? syi + 1 : syi) * srcW + sxi) * 4;
      const di = (y * dstW + x) * 4;
      const top = syi + 1 < srcH && sxp > 0.5 ? si2 : si;
      for (let c = 0; c < 4; c++) {
        const v =
          Math.round(
            (pixels[si + c] * (1 - sxp) + pixels[top + c] * sxp) * (1 - syp) +
              (pixels[si + srcW * 4 + c] * (1 - sxp) + pixels[top + srcW * 4 + c] * sxp) *
                syp,
          );
        out[di + c] = Math.max(0, Math.min(255, v));
      }
    }
  }
  return out;
}

function pngToDib(png, size) {
  const rgba = readPngRgba(png);
  const pixels =
    rgba.width === size && rgba.height === size
      ? rgba.pixels
      : resizePixels(rgba.pixels, rgba.width, rgba.height, size, size);
  const stride = Math.round(((size * 32) / 32)) * 4;
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
    for (let x = 0; x < size * 4; x++) dib[dstRow + x] = pixels[srcRow + x];
  }
  return dib;
}

function buildIco(items) {
  const dirSize = 6 + items.length * 16;
  let totalSize = dirSize;
  for (const it of items) totalSize += it.dib.byteLength;
  const buf = Buffer.allocUnsafe(totalSize);
  buf.writeUInt16LE(0, 0);
  buf.writeUInt16LE(1, 2);
  buf.writeUInt16LE(items.length, 4);
  let off = dirSize;
  for (let i = 0; i < items.length; i++) {
    const { size, dib } = items[i];
    const w = size >= 256 ? 0 : size;
    const h = size >= 256 ? 0 : size;
    const base = 6 + i * 16;
    buf.writeUInt16LE(w, base);
    buf.writeUInt16LE(h, base + 2);
    buf.writeUInt8(0, base + 4);
    buf.writeUInt8(0, base + 5);
    buf.writeUInt16LE(1, base + 6);
    buf.writeUInt16LE(32, base + 8);
    dib.byteLength << 0;
    buf.writeUInt32LE(dib.byteLength, base + 10);
    buf.writeUInt32LE(off, base + 14);
    dib.copy(buf, off);
    off += dib.byteLength;
  }
  return buf;
}

const src = fs.readFileSync(SRC);
const items = TARGET_SIZES.map((size) => ({ size, dib: pngToDib(src, size) }));

// Self-test
const TEST_ITEMS = [
  { size: 16, dib: Buffer.alloc(40 + 16 * 16 * 4) },
  { size: 256, dib: Buffer.alloc(40 + 256 * 256 * 4) },
];
const testIco = buildIco(TEST_ITEMS);
const expectedLen = 6 + 2 * 16 + (40 + 16 * 16 * 4) + (40 + 256 * 256 * 4);
if (testIco.length !== expectedLen) throw new Error("test ico length mismatch");
if (testIco.readUInt32LE(20) !== 6 + 2 * 16) throw new Error("test entry0 off wrong");
if (testIco.readUInt32LE(6 + 1 * 16 + 14) !== 6 + 2 * 16 + (40 + 16 * 16 * 4))
  throw new Error("test entry1 off wrong");
console.log("ico self-test OK");

const ico = buildIco(items);
fs.writeFileSync(OUT, ico);
console.log("wrote", OUT, ico.length, "bytes");
