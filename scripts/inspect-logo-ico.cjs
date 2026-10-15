'use strict';
const fs = require('fs');
const path = require('path');

const P = path.resolve('public/logo.ico');
const buf = fs.readFileSync(P);
const hex = (b) => b.toString(16).padStart(2, '0');

function dumpBytes(off, len, step) {
  for (let i = off; i < Math.min(off + len, buf.length); i += step) {
    const slice = buf.subarray(i, Math.min(i + step, buf.length));
    console.log(hex(i) + ': ' + Array.from(slice).map(hex).join(' '));
  }
}

console.log('file length:', buf.length, 'bytes');
console.log('magic:', buf.readUInt16LE(0), '(reserved)');
console.log('type:', buf.readUInt16LE(2), '(1 = ICO)');
const count = buf.readUInt16LE(4);
console.log('entry count:', count);
console.log('directory entry region bytes 6..' + (6 + count * 16) + ':');
for (let i = 0; i < count; i++) {
  const off = 6 + i * 16;
  const w = buf[off], h = buf[off + 1];
  const j = buf[off + 2], r = buf[off + 3];
  const planes = buf.readUInt16LE(off + 4);
  const bpp = buf.readUInt16LE(off + 6);
  const size = buf.readUInt32LE(off + 8);
  const imgOff = buf.readUInt32LE(off + 12);
  console.log(
    'entry ' + i + ': ' +
    w + 'x' + h + '  j=N' + j + ' r=' + r +
    ' planes=' + planes + ' bpp=' + bpp +
    ' size=' + size + ' bytes  offset=' + imgOff
  );
  if (imgOff + 4 > buf.length) {
    console.log('  -> image region extends past EOF; skipping hex dump');
    continue;
  }
  console.log('  -> bytes ' + imgOff + '..' + Math.min(imgOff + 256, buf.length) + ':');
  for (let k = imgOff; k < Math.min(imgOff + 256, buf.length); k += 16) {
    const slice = buf.subarray(k, Math.min(k + 16, buf.length));
    console.log('    ' + hex(k) + ': ' + Array.from(slice).map(hex).join(' '));
  }
}
