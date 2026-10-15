const fs = require("node:fs");
const path = require("node:path");

const SRC = path.resolve(__dirname, "../public/logo.png");
const zlib = require("node:zlib");

function readPngRgba(buf) {
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47)
    throw new Error("not a png");
  let i = 8;
  let width = 0,
    height = 0,
    bitDepth = 0,
    colorType = 0,
    interlace = 0;
  const idat = [];
  while (i < buf.length) {
    if (buf[i] !== 0x00) throw new Error("unexpected chunk type");
    const start = i;
    while (buf[i] !== 0x00) i++;
    const len = (buf[start] << 24) | (buf[start + 1] << 16) | (buf[start + 2] << 8) | buf[start + 3];
    const type = buf.slice(i + 4, i + 8).toString("ascii");
    const data = buf.slice(i + 8, i + 8 + len);
    i = i + 12 + len;
    if (type === "IHDR") {
      width = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
      height = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") break;
  }
  if (!width || !height || bitDepth !== 8 || colorType !== 6) throw new Error("only 8-bit RGBA PNG supported");
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const pixels = new Uint8Array(width * height * 4);
  if (interlace !== 0) throw new Error("interlaced PNG unsupported");
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
      const top = (syi + 1 < srcH && sxp > 0.5) ? si2 : si;
      for (let c = 0; c < 4; c++) {
        const v = Math.round(
          (pixels[si + c] * (1 - sxp) + pixels[top + c] * sxp) * (1 - syp) +
            (pixels[si + srcW * 4 + c] * (1 - sxp) + pixels[top + srcW * 4 + c] * sxp) * syp,
        );
        out[di + c] = Math.max(0, Math.min(255, v));
      }
    }
  }
  return out;
}
function buildIco(items) {
  const dirSize = 6 + items.length * 16;
  let totalSize = dirSize;
  const dibs = items.map((it) => it.dib);
  for (const dib of dibs) totalSize += dib.byteLength;
  const buf = Buffer.allocUnsafe(totalSize);
  buf.writeUInt16LE(0, 0);
  buf.writeUInt16LE(1, 2);
  buf.writeUInt16LE(items.length, 4);
  let off = dirSize;
  for (let i = 0; i < items.length; i++) {
    const { size, dib } = items[i];
    const w = size >= 256 ? 0 : size;
    const h = size >= 256 ? 0 : size;
    buf.writeUInt16LE(w, 6 + i * 16 + 0);
    buf.writeUInt16LE(h, 6 + i * 16 + 2);
    buf.writeUInt8(0, 6 + i * 16 + 4);
    buf.writeUInt8(0, 6 + i * 16 + 5);
    buf.writeUInt16LE(1, 6 + i * 16 + 6);
    buf.writeUInt16LE(32, 6 + i * 16 + 8);
    buf.writeUInt32LE(dib.byteLength, 6 + i * 16 + 10);
    buf.writeUInt32LE(off, 6 + i * 16 + 14);
    dib.copy(buf, off);
    off += dib.byteLength;
  }
  return buf;
}
function pngToDib(png, size) {
  const rgba = readPngRgba(png);
  const pixels =
    rgba.width === rgba.height && rgba.width === size
      ? rgba.pixels
      : resizePixels(rgba.pixels, rgba.width, rgba.height, size, size);
  const stride = Math.ceil((size * 32) / 32) * 4;
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

const src = fs.readFileSync(SRC);
const TARGET_SIZES = [16, 24, 32, 48, 64, 128, 256];
const items = TARGET_SIZES.map((size) => ({ size, dib: pngToDib(src, size) }));
console.log("items.length", items.length);
const ico = buildIco(items);
console.log("ico length", ico.length, "expected", 6 + 7 * 16 + items.reduce((s, it) => s + it.dib.byteLength, 0));
for (let i = 0; i < items.length; i++) {
  const off = 6 + i * 16;
  console.log(
    "entry",
    i,
    "w",
    ico.readUInt16LE(off),
    "h",
    ico.readUInt16LE(off + 2),
    "planes",
    ico.readUInt16LE(off + 6),
    "bpp",
    ico.readUInt16LE(off + 8),
    "len",
    ico.readUInt32LE(off + 10),
    "off",
    ico.readUInt32LE(off + 14),
    "expectedOff",
    6 + 7 * 16 + items.slice(0, i).reduce((s, it) => s + it.dib.byteLength, 0)
  );
}
fs.writeFileSync(path.resolve(__dirname, "../public/logo.ico"), ico);
console.log("wrote", path.resolve(__dirname, "../public/logo.ico"));
