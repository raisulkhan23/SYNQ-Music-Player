#!/usr/bin/env node
// Independent ICO validator.
// Re-parses the directory table, checks packed image data, and re-reads each
// DIB BITMAPINFOHEADER at the exact byte range the directory claims.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ICO = process.argv[2] || path.resolve(__dirname, '../public/logo.ico');
const buf = fs.readFileSync(ICO);

function validateIco(buf) {
  if (buf.length < 6 + 16) {
    return { ok: false, reason: 'too small to hold even one ICO entry' };
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

  const entries = [];
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    entries.push({
      index: i,
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

  const dirEnd = 6 + count * 16;

  // Image data must start immediately after the directory table.
  if (entries[0].offsetToImageData !== dirEnd) {
    return {
      ok: false,
      reason: 'first image does not start at directory end',
      dirEnd,
      firstOffset: entries[0].offsetToImageData,
    };
  }

  // Image entries must be packed consecutively.
  let cursor = dirEnd;
  for (const e of entries) {
    if (e.offsetToImageData !== cursor) {
      return {
        ok: false,
        reason: `image gap/overlap at entry width=${e.width} expected=${cursor} got=${e.offsetToImageData}`,
        dirEnd,
        cursor,
      };
    }
    cursor += e.sizeOfImageData;
  }
  if (cursor !== buf.length) {
    return {
      ok: false,
      reason: 'image data does not end exactly at EOF',
      dirEnd,
      cursor,
      length: buf.length,
    };
  }

  // For each entry, pull the DIB header out of the exact offset the directory
  // claims and validate it independently of the directory values.
  for (const e of entries) {
    const dibOff = e.offsetToImageData;
    if (dibOff + 40 > buf.length) {
      return {
        ok: false,
        reason: `dib truncated for entry width=${e.width}`,
        dibOff,
        bufLen: buf.length,
      };
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
        entry: e,
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

    // Plausibility: the DIB header's declared image size must match the actual
    // bytes remaining before the next entry (or EOF).
    const dibExpectedSize =
      40 + Math.abs(dibHeight) * ((((e.width * dibBpp) / 8) + 3) & ~3) +
      Math.ceil((e.width + 7) >> 3) * Math.abs(dibHeight);
    if (dibExpectedSize !== e.sizeOfImageData) {
      return {
        ok: false,
        reason: `dib declared size mismatch for entry width=${e.width}: header says ${e.sizeOfImageData} derived ${dibExpectedSize}`,
        entry: e,
      };
    }
  }

  return { ok: true, reserved, type, count, dirEnd, entries };
}

const v = validateIco(buf);
if (!v.ok) {
  console.error('ICO VALIDATION FAILED for', ICO);
  console.error(JSON.stringify(v, null, 2));
  process.exit(1);
}

console.log('ICO VALIDATION PASSED for', ICO);
console.log('file:', ICO);
console.log('file bytes:', buf.length.toString().padStart(7));
console.log('header: reserved=0000 type=0001 (icon) count=' + String(v.count).padStart(3));
console.log('dirEnd offset:', v.dirEnd, '(directory + image data packed at offsets', v.dirEnd, '..', buf.length - 1, ')');
console.log('entries:');
v.entries.forEach((e) => {
  console.log(
    '  ' +
      String(e.width).padStart(3) +
      'x' +
      String(e.height).padStart(3) +
      ' px  bpp=' +
      e.bitsPerPixel +
      ' planes=' +
      e.colourPlanes +
      ' imgBytes=' +
      e.sizeOfImageData.toLocaleString().padStart(7) +
      ' offset=' +
      e.offsetToImageData.toLocaleString()
  );
});

// Independent re-decode of each DIB as raw bits: verify every size is
// square, every entry is 32bpp/XRGB, and the actual byte ranges line up.
console.log('independent DIB re-read:');
for (const e of v.entries) {
  const dibOff = e.offsetToImageData;
  const dib = buf.subarray(dibOff, dibOff + 40);
  const w = dib.readInt32LE(4);
  const h = dib.readInt32LE(8);
  const planes = dib.readUInt16LE(12);
  const bpp = dib.readUInt16LE(14);
  const compression = dib.readUInt32LE(16);
  const imageSize = dib.readUInt32LE(20);
  const coloursUsed = dib.readUInt32LE(32);
  console.log(
    '  entry ' +
      w +
      'x' +
      Math.abs(h) +
      ' hSigned=' +
      h +
      ' bpp=' +
      bpp +
      ' planes=' +
      planes +
      ' compression=' +
      compression +
      ' imageSize=' +
      imageSize +
      ' coloursUsed=' +
      coloursUsed
  );
}
console.log('done.');
