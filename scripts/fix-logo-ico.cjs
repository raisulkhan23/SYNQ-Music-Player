const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const SRC = path.resolve(__dirname, "../public/logo.png");
const OUT = path.resolve(__dirname, "../public/logo.ico");

const src = fs.readFileSync(SRC);
const { pixels } = readPngRGBA(src);
const sizes = [16, 24, 32];
const dibs = sizes.map((s) => makeDib(pixels, 256, 256, s));
console.log("regenerated", OUT, "from", SRC);

const headerSize = 6 + sizes.length * 16;
const imageSize = dibs.reduce((a, d) => a + d.length, 0);
const totalSize = headerSize + imageSize;
const out = Buffer.allocUnsafe(totalSize);

// ICO header: reserved=0, type=1, count
out.writeUInt16LE(0, 0);
out.writeUInt16LE(1, 2);
out.writeUInt16LE(sizes.length, 4);

let off = 6;
sizes.forEach((s, i) => {
  const d = dibs[i];
  out.writeUInt8(s, off);
  out.writeUInt8(s, off + 1);
  out.writeUInt8(0, off + 2);
  out.writeUInt8(0, off + 3);
  out.writeUInt16LE(1, off + 4);
  out.writeUInt16LE(32, off + 6);
  out.writeUInt32LE(d.length, off + 8);
  out.writeUInt32LE(headerSize, off + 12);
  off += 16;
});

dibs.forEach((d) => {
  d.copy(out, off);
  off += d.length;
});

fs.writeFileSync(OUT, out);

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
  const w =
    (ihdr.data[0] << 24) | (ihdr.data[1] << 16) | (ihdr.data[2] << 8) | ihdr.data[3];
  const h =
    (ihdr.data[4] << 24) | (ihdr.data[5] << 16) | (ihdr.data[6] << 8) | ihdr.data[7];
  const bd = ihdr.data[8];
  const ct = ihdr.data[9];
  if (!(bd === 8 && ct === 6)) throw new Error(`need 8-bit RGBA; got bd=${bd} ct=${ct}`);
  if (!(w > 0 && h > 0)) throw new Error(`bad size ${w}x${h}`);
  if (!(w === h)) throw new Error(`src must be square; got ${w}x${h}`);

  const idat = chunks.filter((c) => c.type === "IDAT").map((c) => c.data);
  if (idat.length === 0) throw new Error("no IDAT");
  const inflated = zlib.inflateSync(Buffer.concat(idat));

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
        value +=
          pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else if (filterType !== 0) {
        throw new Error(`unsupported PNG filter type ${filterType}`);
      }
      unfiltered[outStart + i] = value & 0xff;
    }
  }

  const pixels = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcRow = y * stride;
    const dstRow = (h - 1 - y) * stride;
    for (let x = 0; x < stride; x++) {
      pixels[dstRow + x] = unfiltered[srcRow + x];
    }
  }

  return { width: w, height: h, pixels, rawLen: inflated.length };
}

function makeDib(pixels, sw, sh, size) {
  const src =
    sw === size && sh === size ? pixels : resample(pixels, sw, sh, size, size);
  const stride = size * 4;
  const maskStride = ((size + 31) >> 5) * 4;
  const maskSize = maskStride * size;
  const dib = Buffer.allocUnsafe(40 + size * stride + maskSize);

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
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 4;
      dib[d] = src[s + 2];
      dib[d + 1] = src[s + 1];
      dib[d + 2] = src[s];
      dib[d + 3] = src[s + 3];
    }
  }

  const maskPos = pos + size * stride;
  for (let y = 0; y < size; y++) {
    const srcRow = y * size * 4;
    const dstRow = maskPos + (size - 1 - y) * maskStride;
    for (let x = 0; x < size; x++) {
      if (src[srcRow + x * 4 + 3] === 0) {
        dib[dstRow + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }

  return dib;
}

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
        const top = sxp > 0.5 ? pixels[s10 + c] : pixels[s00 + c];
        const bot = sxp > 0.5 ? pixels[s11 + c] : pixels[s01 + c];
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
