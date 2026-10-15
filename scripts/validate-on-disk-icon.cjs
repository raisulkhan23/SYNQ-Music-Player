'use strict';
const fs = require('fs');
const path = require('path');

const ICO_PATH = path.resolve(__dirname, '..', 'public', 'logo.ico');
const PNG_PATH = path.resolve(__dirname, '..', 'public', 'logo.png');

exports.ok = false;
exports.reason = '';

function run() {
  if (!fs.existsSync(ICO_PATH)) {
    exports.ok = false;
    exports.reason = 'public/logo.ico does not exist';
    return;
  }

  const buf = fs.readFileSync(ICO_PATH);
  const png = fs.readFileSync(PNG_PATH);

  const pngSize = readPngSize(png);
  console.log('PNG source size:', png.length, 'bytes; declared', pngSize.w, 'x', pngSize.h, 'px');

  const reserved = buf.readUInt16LE(0);
  const icoType = buf.readUInt16LE(2);
  const count = buf.readUInt16LE(4);
  console.log('');
  console.log('ICO file size:', buf.length, 'bytes');
  console.log('reserved:', reserved, '(must be 0)');
  console.log('type:', icoType, '(must be 1)');
  console.log('directory entry count:', count);

  const dirEnd = 6 + count * 16;
  if (dirEnd + 1 > buf.length) {
    exports.ok = false;
    exports.reason = 'directory extends past EOF';
    console.log('directory extends past EOF -> invalid');
    return;
  }

  let lastEnd = dirEnd;
  let ok = true;
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    const w = buf[off];
    const h = buf[off + 1];
    const j = buf[off + 2];
    const r = buf[off + 3];
    const planes = buf.readUInt16LE(off + 4);
    const bpp = buf.readUInt16LE(off + 6);
    const size = buf.readUInt32LE(off + 8);
    const imgOff = buf.readUInt32LE(off + 12);

    console.log('');
    console.log('entry', i, '@ directory byte', off, ':');
    // ICO quirk the spec defines: the 1-byte width/height fields cannot hold
    // 256, so 0 IS 256. Treating 0 literally reported a valid 256x256 entry as
    // malformed — the checker was wrong, not the icon.
    const dirW = w === 0 ? 256 : w;
    const dirH = h === 0 ? 256 : h;
    sizes.push(dirW);
    console.log('  w:', w, ' h:', h, ' j:', j, ' r:', r, w === 0 || h === 0 ? '(0 = 256)' : '');
    console.log('  planes:', planes, ' bpp:', bpp);
    console.log('  sizeOfImageData:', size, ' bytes');
    console.log('  offsetToImageData:', imgOff, ' bytes');

    if (imgOff !== lastEnd) {
      console.log('  image gap or overlap! expected', lastEnd, 'got', imgOff);
      ok = false;
    }

    if (imgOff + 4 > buf.length) {
      console.log('  image header would start past EOF');
      ok = false;
      lastEnd = buf.length;
      continue;
    }

    // Modern ICOs may store each entry as an embedded PNG instead of a raw DIB.
    // Windows Vista+ reads those natively, and it is what this project now
    // emits — the hand-written DIB path stored rows top-down while declaring
    // bottom-up, so the shell drew every icon upside down. A PNG entry has no
    // row-order ambiguity at all, so it is validated as a PNG.
    const isPngEntry =
      buf[imgOff] === 0x89 &&
      buf.toString('ascii', imgOff + 1, imgOff + 4) === 'PNG';

    if (isPngEntry) {
      console.log('  PNG-compressed entry');
      const pngW = buf.readUInt32BE(imgOff + 16);
      const pngH = buf.readUInt32BE(imgOff + 20);
      console.log('  PNG dimensions:', pngW + 'x' + pngH);
      if (pngW !== dirW || pngH !== dirH) {
        console.log(
          '  -> INVALID: PNG size ' + pngW + 'x' + pngH + ' != directory ' + dirW + 'x' + dirH,
        );
        ok = false;
      }
      if (size < 64) {
        console.log('  -> INVALID: PNG entry is implausibly small');
        ok = false;
      }
      lastEnd = imgOff + size;
      continue;
    }

    const dibSize = buf.readUInt32LE(imgOff);
    console.log('  DIB header size field at offset', imgOff, ':', dibSize, '(must be 40, 12, 16, 48, or 52 for ICO)');
    if (dibSize !== 40) {
      console.log('  -> INVALID: DIB header size is not 40');
      ok = false;
    }

    const dibWidth = buf.readInt32LE(imgOff + 4);
    const dibHeight = buf.readInt32LE(imgOff + 8);
    if (dibWidth !== dirW) {
      console.log('  -> INVALID: DIB width', dibWidth, '!= directory width', dirW);
      ok = false;
    }
    if (dibHeight !== dirH) {
      console.log('  -> INVALID: DIB height', dibHeight, '!= directory height', dirH);
      ok = false;
    }

    const dibPlanes = buf.readUInt16LE(imgOff + 12);
    if (dibPlanes !== 1) {
      console.log('  -> INVALID: DIB planes', dibPlanes, '!= 1');
      ok = false;
    }
    const dibBpp = buf.readUInt16LE(imgOff + 14);
    if (dibBpp !== bpp) {
      console.log('  -> INVALID: DIB bpp', dibBpp, '!= directory bpp', bpp);
      ok = false;
    }

    lastEnd = imgOff + size;
  }

  if (lastEnd !== buf.length) {
    console.log('');
    console.log('trailing bytes after last image end:', lastEnd, '->', buf.length, '(should be 0 for tight ICO)');
    ok = false;
  }

  // Exit non-zero on failure when this file IS the command (the build scripts
  // chain it with `&&`). The module stays importable: another script can
  // `require()` it and read `exports.ok` without the process being killed.
  const isMain = require.main === module;

  console.log('');
  console.log('=== RESULT ===');
  // The sizes Windows actually requests from the shell. An icon that only
  // carries 16/24/32 has nothing to draw at 48 (desktop), 256 (large views,
  // installer page) and gets upscaled or replaced by a generic icon — which is
  // exactly the "wrong icon" symptom this check exists to catch.
  const REQUIRED_SIZES = [16, 32, 48, 256];
  const missing = REQUIRED_SIZES.filter((s) => !sizes.includes(s));
  if (missing.length) {
    console.log('missing required Windows sizes:', missing.join(', '));
    console.log('present:', sizes.join(', '));
    ok = false;
  }
  if (reserved !== 0) {
    console.log('reserved field must be 0, got', reserved);
    ok = false;
  }
  if (icoType !== 1) {
    console.log('type field must be 1, got', icoType);
    ok = false;
  }
  if (ok && count >= REQUIRED_SIZES.length && reserved === 0 && icoType === 1) {
    console.log('PASS: structurally valid ICO');
    exports.ok = true;
    exports.reason = '';
  } else {
    console.log('FAIL: invalid or incomplete ICO');
    exports.ok = false;
    exports.reason = 'invalid or incomplete ICO';
  }
  if (isMain) process.exitCode = ok ? 0 : 1;
}

function readPngSize(src) {
  if (src.length < 24 || src[0] !== 0x89 || src[1] !== 0x50 || src[2] !== 0x4e || src[3] !== 0x47) {
    throw new Error('bad png');
  }
  const w = src.readUInt32BE(16);
  const h = src.readUInt32BE(20);
  return { w, h };
}

run();
