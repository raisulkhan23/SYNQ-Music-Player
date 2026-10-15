'use strict';

/**
 * Build the SYNQ README banner from the existing SYNQ logo.
 *
 * This keeps the banner on-brand without inventing new artwork:
 * - Dark navy/black banner surface.
 * - A subtle lime accent band.
 * - A restrained bright haze behind the centered SYNQ logo.
 *
 * Output: assets/readme/synq-banner.png
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'assets', 'readme', 'synq-banner.png');

const WIDTH = 1200;
const HEIGHT = 630;

const ACCENT = [203, 244, 143, 255];
const BG = [18, 20, 28, 255];
const HAZE_ALPHA = 60;
const ACCENT_BAND_W = Math.round(WIDTH * 0.02);
const LOGO_MAX_W = 220;
const LOGO_MAX_H = 260;
const LOGO_Y_FRAC = 0.32;

/* ---------- minimal PNG parser ---------- */

function readU32(buf, off) {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
  }
  return c ^ 0xffffffff;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const cs = Buffer.alloc(4);
  cs.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
  return Buffer.concat([len, t, data, cs]);
}

function decodePng(buf) {
  if (buf[0] !== 0x89 || buf.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error('Not a PNG');
  }
  let off = 8;
  let width = 0, height = 0, depth = 0, colorType = 0;
  let idat = [];
  while (off + 12 <= buf.length) {
    const len = readU32(buf, off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.slice(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = readU32(data, 0);
      height = readU32(data, 4);
      depth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off = off + 12 + len;
  }
  if (width === 0 || height === 0) {
    throw new Error('No IHDR');
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = colorType === 2 ? 3 : colorType === 6 ? 4 : 1;
  const furst = new Uint8Array(raw);
  const rowsDecoded = [];
  const rowBytes = width * bpp;
  const stride = rowBytes + 1;
  for (let y = 0; y < height; y++) {
    const rowOff = y * stride;
    const filt = furst[rowOff];
    const src = furst.subarray(rowOff + 1, rowOff + 1 + rowBytes);
    const prev = rowsDecoded[y - 1];
    const row = new Uint8Array(rowBytes);
    if (filt === 0) {
      row.set(src);
    } else if (filt === 1) {
      for (let i = 0; i < rowBytes; i++) {
        row[i] = (src[i] + (i >= bpp ? row[i - bpp] : 0)) & 0xff;
      }
    } else if (filt === 2) {
      for (let i = 0; i < rowBytes; i++) {
        row[i] = (src[i] + (y > 0 ? prev[i] : 0)) & 0xff;
      }
    } else if (filt === 3) {
      for (let i = 0; i < rowBytes; i++) {
        const left = i >= bpp ? row[i - bpp] : 0;
        const up = y > 0 ? prev[i] : 0;
        row[i] = (src[i] + ((left + up) >> 1)) & 0xff;
      }
    } else if (filt === 4) {
      for (let i = 0; i < rowBytes; i++) {
        const left = i >= bpp ? row[i - bpp] : 0;
        const up = y > 0 ? prev[i] : 0;
        const upperLeft = (i >= bpp && y > 0) ? prev[i - bpp] : 0;
        row[i] = (src[i] + (((left + up) >> 1) - upperLeft)) & 0xff;
      }
    } else {
      throw new Error('Unsupported PNG filter ' + filt);
    }
    rowsDecoded.push(row);
  }
  return { width, height, depth, colorType, rows: rowsDecoded, bpp };
}

function toRgba(rows, width, height, bpp) {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = rows[y];
    const di = y * width * 4;
    for (let x = 0; x < width; x++) {
      const si = x * bpp;
      const oi = di + x * 4;
      if (bpp === 1) {
        const g = row[si];
        out[oi] = g;
        out[oi + 1] = g;
        out[oi + 2] = g;
        out[oi + 3] = 255;
      } else if (bpp === 3) {
        out[oi] = row[si];
        out[oi + 1] = row[si + 1];
        out[oi + 2] = row[si + 2];
        out[oi + 3] = 255;
      } else {
        out[oi] = row[si];
        out[oi + 1] = row[si + 1];
        out[oi + 2] = row[si + 2];
        out[oi + 3] = row[si + 3];
      }
    }
  }
  return out;
}

function resizeBilinear(src, sw, sh, dw, dh) {
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = ((y / dh) * (sh - 1)) || 0;
    const sy0 = Math.floor(sy);
    const sy1 = Math.min(sy0 + 1, sh - 1);
    const fy = sy - sy0;
    for (let x = 0; x < dw; x++) {
      const sx = ((x / dw) * (sw - 1)) || 0;
      const sx0 = Math.floor(sx);
      const sx1 = Math.min(sx0 + 1, sw - 1);
      const fx = sx - sx0;
      const s00 = (sy0 * sw + sx0) * 4;
      const s10 = (sy0 * sw + sx1) * 4;
      const s01 = (sy1 * sw + sx0) * 4;
      const s11 = (sy1 * sw + sx1) * 4;
      const d = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const top = src[s00 + c] * (1 - fx) + src[s10 + c] * fx;
        const bot = src[s01 + c] * (1 - fx) + src[s11 + c] * fx;
        out[d + c] = Math.round((top * (1 - fy)) + (bot * fy));
      }
    }
  }
  return out;
}

function blend(dst, src, ox, oy, ow, oh) {
  for (let y = 0; y < oh; y++) {
    const dy = (oy + y) * WIDTH * 4;
    const sy = y * ow * 4;
    for (let x = 0; x < ow; x++) {
      const di = dy + (ox + x) * 4;
      const si = sy + x * 4;
      const sa = src[si + 3];
      if (sa === 0) continue;
      const t = sa / 255;
      dst[di] = Math.round(dst[di] * (1 - t) + src[si] * t);
      dst[di + 1] = Math.round(dst[di + 1] * (1 - t) + src[si + 1] * t);
      dst[di + 2] = Math.round(dst[di + 2] * (1 - t) + src[si + 2] * t);
    }
  }
}

/* ---------- build the banner ---------- */

const logoBuf = fs.readFileSync(path.join(PUBLIC, 'logo.png'));
let logoPixels, logoW, logoH;
try {
  const { width, height, rows, bpp } = decodePng(logoBuf);
  logoW = width;
  logoH = height;
  logoPixels = toRgba(rows, width, height, bpp);
} catch (e) {
  throw new Error('Could not decode SYNQ logo PNG: ' + e.message);
}

const banner = new Uint8Array(WIDTH * HEIGHT * 4);
for (let i = 0; i < banner.length; i += 4) {
  banner[i] = BG[0];
  banner[i + 1] = BG[1];
  banner[i + 2] = BG[2];
  banner[i + 3] = BG[3];
}

{
  const hazeW = WIDTH;
  const hazeH = Math.round(HEIGHT * 0.42);
  const haze = new Uint8Array(hazeW * hazeH * 4);
  for (let i = 0; i < haze.length; i += 4) {
    haze[i] = ACCENT[0];
    haze[i + 1] = ACCENT[1];
    haze[i + 2] = ACCENT[2];
    haze[i + 3] = HAZE_ALPHA;
  }
  blend(banner, haze, 0, Math.round(HEIGHT * 0.28), hazeW, hazeH);
}

{
  const band = new Uint8Array(ACCENT_BAND_W * HEIGHT * 4);
  for (let i = 0; i < band.length; i += 4) {
    band[i] = ACCENT[0];
    band[i + 1] = ACCENT[1];
    band[i + 2] = ACCENT[2];
    band[i + 3] = 255;
  }
  blend(banner, band, Math.round(WIDTH * 0.02), 0, ACCENT_BAND_W, HEIGHT);
}

{
  let logoW2 = LOGO_MAX_W;
  let logoH2 = Math.round(logoW2 / (logoW / logoH));
  if (logoH2 > LOGO_MAX_H) {
    logoH2 = LOGO_MAX_H;
    logoW2 = Math.round(logoH2 * (logoW / logoH));
  }
  const logoX = Math.round((WIDTH - logoW2) / 2);
  const logoY = Math.round(HEIGHT * LOGO_Y_FRAC);
  const logo = resizeBilinear(logoPixels, logoW, logoH, logoW2, logoH2);
  blend(banner, logo, logoX, logoY, logoW2, logoH2);
}

function encodePng(rgba, w, h) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = makeChunk('IHDR', Buffer.from([
    (w >> 24) & 0xff, (w >> 16) & 0xff, (w >> 8) & 0xff, w & 0xff,
    (h >> 24) & 0xff, (h >> 16) & 0xff, (h >> 8) & 0xff, h & 0xff,
    8, 6, 0, 0, 0
  ]));
  const raw = zlib.deflateSync(encodeRows(rgba, w, h));
  const idat = makeChunk('IDAT', raw);
  const iend = makeChunk('IEND', Buffer.alloc(0));
  return Buffer.concat([sig, ihdr, idat, iend]);
}

function encodeRows(rgba, w, h) {
  const parts = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 4);
    row.writeUInt8(0, 0);
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4;
      row.writeUInt8(rgba[si], 1 + x * 4);
      row.writeUInt8(rgba[si + 1], 2 + x * 4);
      row.writeUInt8(rgba[si + 2], 3 + x * 4);
      row.writeUInt8(rgba[si + 3], 4 + x * 4);
    }
    parts.push(row);
  }
  return Buffer.concat(parts);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, encodePng(banner, WIDTH, HEIGHT));
console.log('Wrote SYNQ README banner to ' + OUT);
console.log('Banner:', WIDTH + 'x' + HEIGHT);
console.log('File size:', fs.statSync(OUT).length, 'bytes');
console.log('Logo source:', logoW + 'x' + logoH);
