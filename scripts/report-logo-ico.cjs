'use strict';
const fs = require('fs');
const path = require('path');

const FILE = path.resolve('public/logo.ico');
const buf = fs.readFileSync(FILE);

const hex16 = (n) => n.toString(16).padStart(4, '0');
const hex8 = (n) => n.toString(16).padStart(2, '0');

function row(off, len) {
  const lines = [];
  for (let i = off; i < Math.min(off + len, buf.length); i += 16) {
    const end = Math.min(i + 16, buf.length);
    const bytes = buf.subarray(i, end);
    const addr = hex16(i).padStart(4, '0');
    const body = Array.from(bytes).map(hex8).join(' ');
    lines.push(addr + ': ' + body);
  }
  return lines.join('\n');
}

console.log('=== public/logo.ico (standalone read, no encoder state) ===');
console.log('file size:', buf.length, 'bytes');
console.log('header[0..3]:', hex8(buf[0]), hex8(buf[1]), hex8(buf[2]), hex8(buf[3]));
console.log('  reserved =', buf.readUInt16LE(0), '(must be 0)');
console.log('  type     =', buf.readUInt16LE(2), '(must be 1 for ICO)');
const count = buf.readUInt16LE(4);
console.log('  count    =', count);
console.log('');

const dirEnd = 6 + count * 16;
if (dirEnd + 1 > buf.length) {
  console.log('directory extends past EOF -> aborting');
  process.exit(1);
}

console.log('directory table region 6..' + (dirEnd - 1) + ' (each entry 16 bytes):');
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

  const expectedPrevEnd = i === 0 ? dirEnd : buf.readUInt32LE(6 + (i - 1) * 16 + 8) + buf.readUInt32LE(6 + (i - 1) * 16 + 12);
  const contiguous = imgOff === expectedPrevEnd ? 'YES' : 'NO (expected ' + expectedPrevEnd + ')';

  console.log('entry', i, '(directory bytes', off, '..', off + 15, '):');
  console.log('  w=', w, ' h=', h, ' j=', j, ' r=', r);
  console.log('  planes=', planes, ' bpp=', bpp);
  console.log('  sizeOfImageData=', size, ' bytes');
  console.log('  offsetToImageData=', imgOff, ' bytes');
  console.log('  contiguous with previous image end:', contiguous);

  if (imgOff + 4 > buf.length) {
    console.log('  -> image header would start past EOF; cannot dump DIB header');
    console.log('');
    continue;
  }

  console.log('  first 16 bytes at offsetToImageData', imgOff, ':');
  console.log(row(imgOff, Math.min(16, buf.length - imgOff)));
  console.log('  (little-endian interpretation of first 4 bytes as uint32LE:', buf.readUInt32LE(imgOff), ')');
  console.log('  (first 4 bytes as individual int8 LE: size=', buf.readInt32LE(imgOff), ', width LE bytes', buf[imgOff], buf[imgOff+1], buf[imgOff+2], buf[imgOff+3], ')');
  console.log('');
}

const lastImgEnd = count > 0
  ? buf.readUInt32LE(6 + (count - 1) * 16 + 12) + buf.readUInt32LE(6 + (count - 1) * 16 + 8)
  : dirEnd;
console.log('directory ends at byte', (dirEnd - 1), '; last image ends at byte', lastImgEnd - 1, '; file size', buf.length);
console.log('trailing bytes after last image:', buf.length - lastImgEnd, '(should be 0 for a tight ICO)');
