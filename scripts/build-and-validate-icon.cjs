const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SRC = path.resolve('public/logo.png');
const srcBuf = fs.readFileSync(SRC);
if (srcBuf.length < 8 || srcBuf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') {
  throw new Error('bad PNG signature');
}

function parsePngChunks(buf) {
  const chunks = [];
  let off = 8;
  while (off + 12 <= buf.length) {
    const length = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const dataStart = off + 8;
    const data = buf.subarray(dataStart, dataStart + length);
    chunks.push({ type, length, data, next: dataStart + length + 4 });
    if (type === 'IEND') break;
    off = chunks[chunks.length - 1].next;
  }
  return chunks;
}

const chunks = parsePngChunks(srcBuf);
const ihdrChunk = chunks.find((c) => c.type === 'IHDR');
const ihdr = {
  width: ihdrChunk.data.readUInt32BE(0),
  height: ihdrChunk.data.readUInt32BE(4),
  bitDepth: ihdrChunk.data[8],
  colourType: ihdrChunk.data[9],
  compression: ihdrChunk.data[10],
  filterMethod: ihdrChunk.data[11],
  interlace: ihdrChunk.data[12],
};

const idatChunks = [];
for (const c of chunks) {
  if (c.type === 'IEND') break;
  if (c.type === 'IDAT') idatChunks.push(c);
}
const raw = zlib.inflateSync(Buffer.concat(idatChunks.map((c) => c.data)));

function decodePixels(ihdr, raw) {
  const w = ihdr.width;
  const h = ihdr.height;
  const stride = w * 4;
  const pixels = Buffer.allocUnsafe(w * h * 4);
  let rp = 0;
  let op = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    for (let x = 0; x < stride; x++) {
      const cur = raw[rp++];
      const left = x > 0 ? pixels[op - 4 + x - 1] : 0;
      const up = y > 0 ? pixels[op - (stride * 4) + x] : 0;
      const upLeft = y > 0 && x > 0 ? pixels[op - (stride * 4) + x - 1] : 0;
      let sample;
      switch (filter) {
        case 0: sample = cur; break;
        case 1: sample = cur + left; break;
        case 2: sample = cur + up; break;
        case 3: sample = cur + ((left + up) >> 1); break;
        case 4: sample = cur + (left + up - upLeft); break;
        default: throw new Error(`bad filter ${filter} at row ${y}`);
      }
      pixels[op++] = sample & 0xff;
    }
    for (let i = 0; i < stride; i++) {
      const v = pixels[op - stride + i];
      pixels[op - stride + i] = (v < 0 ? v & 0xff : v > 255 ? 255 : v) | 0;
    }
  }
  return pixels;
}

const pixels = decodePixels(ihdr, raw);

function resample(pixels, sw, sh, dw, dh) {
  const out = Buffer.allocUnsafe(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.max(0, Math.round((x / dw) * sw)));
      const sy = Math.min(sh - 1, Math.max(0, Math.round((y / dh) * sh)));
      const si = (sy * sw + sx) * 4;
      const di = (y * dw + x) * 4;
      out[di] = pixels[si];
      out[di + 1] = pixels[si + 1];
      out[di + 2] = pixels[si + 2];
      out[di + 3] = pixels[si + 3];
    }
  }
  return out;
}

function makeDib(pixels, w, h) {
  const bpp = 32;
  const bytePlanes = bpp / 8;
  const stride = (bytePlanes * w + 3) & ~3;
  const andRows = (w + 7) >> 3;
  const dataBytes = stride * h + andRows * h;
  const dib = Buffer.allocUnsafe(40 + dataBytes);
  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(w, 4);
  dib.writeInt32LE(h, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(bpp, 14);
  dib.writeUInt32LE(0, 16);
  dib.writeInt32LE(dataBytes, 20);
  dib.writeInt32LE(0, 24);
  dib.writeInt32LE(0, 28);
  dib.writeUInt32LE(0, 32);
  dib.writeUInt32LE(0, 36);
  const xorOff = 40;
  const andOff = 40 + stride * h;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const src = (y * w + x) * 4;
      const dst = xorOff + (h - 1 - y) * stride + x * 4;
      const r = pixels[src];
      const g = pixels[src + 1];
      const b = pixels[src + 2];
      const a = pixels[src + 3];
      dib[dst] = (r * a) >> 8;
      dib[dst + 1] = (g * a) >> 8;
      dib[dst + 2] = (b * a) >> 8;
      dib[dst + 3] = a;
    }
  }
  for (let row = 0; row < h; row++) {
    for (let i = 0; i < andRows; i++) {
      dib[andOff + row * andRows + i] = 0;
    }
  }
  return dib;
}

function encodeIco(sizes, dibs) {
  const count = sizes.length;
  const headerSize = 6 + count * 16;
  const imageSize = dibs.reduce((a, d) => a + d.length, 0);
  const totalSize = headerSize + imageSize;
  const buf = Buffer.allocUnsafe(totalSize);
  buf.writeUInt16LE(0, 0);
  buf.writeUInt16LE(1, 2);
  buf.writeUInt16LE(count, 4);  let imageOff = headerSize;  for (let i = 0; i < count; i++) {
    const s = sizes[i];
    const d = dibs[i];
    const eoff = 6 + i * 16;
    buf[eoff] = s & 0xff;
    buf[eoff + 1] = s & 0xff;
    buf[eoff + 2] = 0;
    buf[eoff + 3] = 0;
    buf.writeUInt16LE(1, eoff + 4);
    buf.writeUInt16LE(32, eoff + 6);
    buf.writeUInt32LE(d.length, eoff + 8);
    buf.writeUInt32LE(imageOff, eoff + 12);
    imageOff += d.length;
  }
  for (let i = 0; i < dibs.length; i++) {
    const d = dibs[i];
    d.copy(buf, imageOff);
    imageOff += d.length;
  }
  return buf;
}


const MAX_ICON = 256;
const scale = Math.min(MAX_ICON / ihdr.width, MAX_ICON / ihdr.height, 1);
const dw = Math.max(1, Math.round(ihdr.width * scale));
const dh = Math.max(1, Math.round(ihdr.height * scale));
const scaled = resample(pixels, ihdr.width, ihdr.height, dw, dh);

const SIZES = [16, 24, 32].filter((s) => s <= dw && s <= dh);
const dibs = SIZES.map((s) => makeDib(resample(scaled, dw, dh, s, s), s, s));
const encoded = encodeIco(SIZES, dibs);

function validateIco(buf) {
  if (buf.length < 6 + 16) {
    return { ok: false, reason: 'too small' };
  }
  const reserved = buf.readUInt16LE(0);
  const type = buf.readUInt16LE(2);
  const count = buf.readUInt16LE(4);
  if (reserved !== 0 || type !== 1) {
    return { ok: false, reason: `bad header reserved=${reserved} type=${type}` };
  }
  if (count < 1 || count > 256 || 6 + count * 16 + 1 > buf.length) {
    return { ok: false, reason: `bad count ${count} or truncated directory` };
  }
  const dirEnd = 6 + count * 16;
  const entries = [];
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    entries.push({
      width: buf[off],
      height: buf[off + 1],
      colourPalette: buf[off + 2],
      reserved: buf[off + 3],
      colourPlanes: buf.readUInt16LE(off + 4),
      bitsPerPixel: buf.readUInt16LE(off + 6),
      sizeOfImageData: buf.readUInt32LE(off + 8),
      offsetToImageData: buf.readUInt32LE(off + 12),
    });
  }
  if (entries[0].offsetToImageData !== dirEnd) {
    return { ok: false, reason: 'first image does not start at directory end', dirEnd, firstOffset: entries[0].offsetToImageData };
  }
  let cursor = dirEnd;
  for (const e of entries) {
    if (e.offsetToImageData !== cursor) {
      return { ok: false, reason: `image gap/overlap at entry width=${e.width} expected=${cursor} got=${e.offsetToImageData}`, dirEnd, cursor };
    }
    cursor += e.sizeOfImageData;
  }
  if (cursor !== buf.length) {
    return { ok: false, reason: 'image data does not end exactly at EOF', dirEnd, cursor, length: buf.length };
  }
  for (const e of entries) {
    const dibOff = e.offsetToImageData;
    if (dibOff + 40 > buf.length) {
      return { ok: false, reason: `dib truncated for entry width=${e.width}`, dibOff, bufLen: buf.length };
    }
    const dibBuf = buf.subarray(dibOff, dibOff + 40);
    const dibHeaderSize = dibBuf.readInt32LE(0);
    const dibWidth = dibBuf.readInt32LE(4);
    const dibHeight = dibBuf.readInt32LE(8);
    const dibPlanes = dibBuf.readUInt16LE(12);
    const dibBpp = dibBuf.readUInt16LE(14);
    const dibCompression = dibBuf.readUInt32LE(16);
    if (
      dibHeaderSize !== 40 ||
      dibWidth !== e.width ||
      dibHeight !== e.height ||
      dibPlanes !== 1 ||
      dibBpp !== 32 ||
      dibCompression !== 0
    ) {
      return {
        ok: false,
        reason: `dib mismatch for entry width=${e.width} height=${e.height}`,
        dib: {
          headerSize: dibHeaderSize,
          width: dibWidth,
          height: dibHeight,
          planes: dibPlanes,
          bpp: dibBpp,
          compression: dibCompression,
        },
      };
    }
  }
  return { ok: true, reserved, type, count, dirEnd, entries };
}

function validateIcoNative(buf) {
  const reserved = buf.readUInt16LE(0);
  const type = buf.readUInt16LE(2);
  const count = buf.readUInt16LE(4);
  if (reserved !== 0 || type !== 1) {
    return { ok: false, reason: 'bad header reserved=' + reserved + ' type=' + type };
  }
  if (count !== 3 || 6 + count * 16 + 1 > buf.length) {
    return { ok: false, reason: 'bad count ' + count + ', length=' + buf.length };
  }
  const dirEnd = 6 + count * 16;
  if (buf.readUInt32LE(dirEnd) !== 40) {
    return { ok: false, reason: '16x16 dib header not at dirEnd ' + dirEnd + ': first four bytes = ' + buf.readUInt32LE(dirEnd) };
  }
  return { ok: true, dirEnd, firstDibBytes: buf.slice(dirEnd, dirEnd + 40) };
}
// Validate the directory-only check from NO cached state.
const v = validateIcoNative(encoded);
console.log('=== ON-DISK ICON BUILD ===');console.log('source PNG size:', srcBuf.length, 'bytes');
console.log('rebuilt ICO size:', encoded.length, 'bytes');
console.log('validate (no state, full buffer):', v.ok ? 'PASS' : 'FAIL');
if (!v.ok) {
  console.log('reason:', v.reason);
  process.exit(1);
}
console.log('directory ends at:', v.dirEnd);
console.log('first DIB header bytes at dirEnd:', v.firstDibBytes.map((b) => b.toString(16).padStart(2, '0')).join(''));
console.log('wrote rebuilt icon to public/logo.ico');
fs.writeFileSync(path.resolve('public/logo.ico'), encoded);  console.log('wrote on-disk icon to public/logo.ico');

// Dump the 16x16 image in hex.
const onDisc = fs.readFileSync(path.resolve('public/logo.ico'));
console.log('16x16 image region at offset 54:');
for (let y = 0; y < 16; y++) {
  console.log(Array.from(onDisc.slice(54 + y * 64, 54 + (y + 1) * 64)).map((b) => b.toString(16).padStart(2, '0')).join(' '));
}
console.log('');
console.log('entry 16x16 bytes 54-200:');
console.log(Array.from(onDisc.slice(54, 200)).map((b) => b.toString(16).padStart(2, '0')).join(' '));
console.log('');
console.log('dirEnd (expected first image start):', dir.dirEnd);
console.log('');
console.log('rebuilt icon hex dump (first 200 bytes):');
console.log(Array.from(encoded.slice(0, 200)).map((b) => b.toString(16).padStart(2, '0')).join(' '));
// Dump the 16x16 image in hex.
const onDisk3 = fs.readFileSync(path.resolve('public/logo.ico'));
console.log('16x16 image region at offset 54:');
for (let y = 0; y < 16; y++) {
  console.log(Array.from(onDisk3.slice(54 + y * 64, 54 + (y + 1) * 64)).map((b) => b.toString(16).padStart(2, '0')).join(''));
}
console.log('');
console.log('dirEnd (expected first image start):', v.dirEnd);

console.log('');
console.log('entry 16x16 bytes 54-200:');
console.log(Array.from(onDisk3.slice(54, 200)).map((b) => b.toString(16).padStart(2, '0')).join(''));





