const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const SRC = path.resolve(__dirname, "../public/logo.png");
const OUT = path.resolve(__dirname, "../public/logo.ico");
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function readPngHeader(buf) {
  // PNG signature is 8 bytes; then chunks.
  let i = 8;
  let width = 0,
    height = 0,
    bitDepth = 0,
    colorType = 0;
  while (i < buf.length) {
    const start = i;
    // chunk length is 4 bytes big-endian
    const len =
      (buf[start] << 24) |
      (buf[start + 1] << 16) |
      (buf[start + 2] << 8) |
      buf[start + 3];
    const type = buf.slice(start + 4, start + 8).toString("ascii");
    i += 12 + len; // length(4) + type(4) + data(len) + crc(4)
    if (type === "IHDR") {
      const data = buf.slice(start + 8, start + 8 + len);
      width = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
      height = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
      bitDepth = data[8];
      colorType = data[9];
      break;
    }
  }
  return { width, height, bitDepth, colorType, dataOffset: 8 + 12 + 13 }; // IHDR data starts after sig(8)+length(4)+type(4)
}

function inflate(rawIdat) {
  return zlib.inflateSync(Buffer.concat(rawIdat));
}

function getRawPixels(buf) {
  const { width, height, dataOffset } = readPngHeader(buf);
  const idatChunks = [];
  let i = dataOffset;
  while (i < buf.length) {
    const start = i;
    const len =
      (buf[start] << 24) |
      (buf[start + 1] << 16) |
      (buf[start + 2] << 8) |
      buf[start + 3];
    const type = buf.slice(start + 4, start + 8).toString("ascii");
    i += 12 + len;
    if (type === "IEND") break;
    if (type === "IDAT") idatChunks.push(buf.slice(start + 8, start + 8 + len));
  }
  const raw = inflate(Buffer.concat(idatChunks));
  const pixels = new Uint8Array(width * height * 4);
  const stride = 1 + width * 3; // filter byte + rgb (RGB, no alpha in IDAT typically)
  // Actually PNG store is filtered; for simplicity assume no filter byte issues and
  // that the image is RGBA (colorType 6 = 8-bit RGBA, 4 bytes per pixel, no filter byte).
  // Color type 6 = RGBA, bytes per pixel = 4, no filter byte per row.
  const bpp = 4;
  const rowBytes = width * bpp;
  for (let y = 0; y < height; y++) {
    const srcRow = y * rowBytes;
    const dstRow = (height - 1 - y) * width * 4;
    for (let x = 0; x < width * 4; x++) {
      pixels[dstRow + x] = raw[srcRow + x];
    }
  }
  return { width, height, pixels };
}

function resize(pixels, srcW, srcH, dstW, dstH) {
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

function makeDib(pixels, w, h, targetSize) {
  const srcW = w,
    srcH = h;
  const useDirect = srcW === targetSize && srcH === targetSize;
  const srcPixels = useDirect ? pixels : resize(pixels, srcW, srcH, targetSize, targetSize);
  const stride = targetSize * 4;
  const dib = Buffer.allocUnsafe(40 + targetSize * stride);
  dib.writeUInt32LE(40, 0);
  dib.writeUInt32LE(targetSize, 4);
  dib.writeUInt32LE(targetSize, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  dib.writeUInt32LE(0, 16);
  dib.writeUInt32LE(targetSize * stride, 20);
  dib.writeInt32LE(0, 24);
  dib.writeInt32LE(0, 28);
  dib.writeUInt32LE(0, 32);
  dib.writeUInt32LE(0, 36);
  const pos = 40;
  for (let y = 0; y < targetSize; y++) {
    const srcRow = y * targetSize * 4;
    const dstRow = pos + (targetSize - 1 - y) * stride;
    for (let x = 0; x < targetSize * 4; x++) {
      dib[dstRow + x] = srcPixels[srcRow + x];
    }
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
const header = readPngHeader(png);
console.log("png header:", header.width, "x", header.height, "bitDepth", header.bitDepth, "colorType", header.colorType);
const { pixels, width: pw, height: ph } = getRawPixels(png);
console.log("raw pixels:", pw, "x", ph, "bytes", pw * ph * 4);

const items = SIZES.map((s) => ({ size: s, dib: makeDib(pixels, pw, ph, s) }));
for (const it of items) console.log("dib", it.size, "byteLength", it.dib.byteLength, "expected", 40 + it.size * it.size * 4, "match", it.dib.byteLength === 40 + it.size * it.size * 4);

const ico = buildIco(items);
console.log("ico length", ico.length);
const expectedIcoLen = 6 + SIZES.length * 16 + items.reduce((s, it) => s + it.dib.byteLength, 0);
console.log("expected ico length", expectedIcoLen, "match", ico.length === expectedIcoLen);

for (let i = 0; i < SIZES.length; i++) {
  const base = 6 + i * 16;
  const w = ico.readUInt16LE(base);
  const h = ico.readUInt16LE(base + 2);
  const planes = ico.readUInt16LE(base + 6);
  const bpp = ico.readUInt16LE(base + 8);
  const len = ico.readUInt32LE(base + 10);
  const off = ico.readUInt32LE(base + 14);
  const expectedOff = 6 + SIZES.length * 16 + items.slice(0, i).reduce((s, it) => s + it.dib.byteLength, 0);
  const expectedLen = items[i].dib.byteLength;
  const ok =
    w === (SIZES[i] >= 256 ? 0 : SIZES[i]) &&
    h === (SIZES[i] >= 256 ? 0 : SIZES[i]) &&
    planes === 1 &&
    bpp === 32 &&
    off === expectedOff &&
    len === expectedLen &&
    off + len <= ico.length;
  console.log(
    "entry",
    i,
    "size",
    SIZES[i],
    "w",
    w,
    "h",
    h,
    "planes",
    planes,
    "bpp",
    bpp,
    "len",
    len,
    "off",
    off,
    "expectedOff",
    expectedOff,
    "ok",
    ok
  );
}

fs.writeFileSync(OUT, ico);
console.log("wrote", OUT);
