'use strict';
const fs = require('fs');
const path = require('path');

const PATH = path.resolve('public/logo.ico');
const buf = fs.readFileSync(PATH);
const h = (n) => n.toString(16).padStart(2, '0');

function row(off, len) {
  const lines = [];
  for (let i = off; i < Math.min(off + len, buf.length); i += 16) {
    const end = Math.min(i + 16, buf.length);
    const bytes = buf.subarray(i, end);
    lines.push(h(i).padStart(4, '0') + '  ' + Array.from(bytes).map(h).join(' '));
  }
  return lines.join('\n');
}

const reserved = buf.readUInt16LE(0);
const type = buf.readUInt16LE(2);
const count = buf.readUInt16LE(4);
console.log('file size:', buf.length, 'bytes');
console.log('reserved:', reserved, '(should be 0)');
console.log('type:', type, '(should be 1 for ICO)');
console.log('entries:', count);
console.log('');

const dirEnd = 6 + count * 16;
console.log('directory table (offsets 6 through ' + (dirEnd - 1) + '):');
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
  const expected = (i === 0 ? dirEnd : buf.readUInt32LE(6 + (i - 1) * 16 + 8) + buf.readUInt32LE(6 + (i - 1) * 16 + 12));
  const match = imgOff === expected ? 'OK' : 'MISMATCH (expected ' + expected + ')';
  console.log(
    'entry ' + i + ' @ byte ' + off + ':\n' +
    '  w=' + w + ' h=' + h + ' j=' + j + ' r=' + r +
    ' planes=' + planes + ' bpp=' + bpp +
    ' size=' + size + ' imgOffset=' + imgOff +
    '  contiguous=' + match
  );
  if (imgOff + 16 > buf.length) {
    console.log('  -> image region would start past EOF; cannot dump');
    continue;
  }
  console.log('  first 128 bytes at imgOffset ' + imgOff + ':');
  console.log(row(imgOff, Math.min(128, buf.length - imgOff)));
  console.log('');
}
console.log('directory ends at byte ' + (dirEnd - 1) + '; total file ' + buf.length + ' bytes; trailing bytes after last image: ' + (buf.length - (count > 0 ? buf.readUInt32LE(6 + (count - 1) * 16 + 12) + buf.readUInt32LE(6 + (count - 1) * 16 + 8) : dirEnd)) + ' (should be 0 for a tight ICO)');
