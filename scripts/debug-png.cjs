const fs = require('fs');
const src = fs.readFileSync('synqmusic/public/logo.png');
const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
console.log('size', src.length, 'sig ok', src.subarray(0, 8).compare(sig, 0, 8) === 0);
// first 32 bytes
console.log('first 32 bytes hex:');// print 16-wide lines
for (let line = 0; line < Math.ceil(src.length / 16); line++) {
  const start = line * 16;
  const end = Math.min(start + 16, src.length);
  const hex = Array.from(src.slice(start, end), b => b.toString(16).padStart(2, '0')).join(' ');
  console.log(
    start.toString(16).padStart(4, '0') + ': ' + hex.padEnd(47) + ' | ' + src.slice(start, end).toString('ascii').replace(/[^\x20-\x7e]/g, '.')
  );
}
console.log('\nchunk walk:');
let off = 8;
let chunks = 0;
while (off + 12 <= src.length) {
  const length = src.readUInt32BE(off);
  const type = src.toString('ascii', off + 4, off + 8);
  const dataStart = off + 8;
  const dataEnd = dataStart + length;
  chunks++;
  console.log(
    'chunk ' + chunks + ': type=' + type + ' length=' + length +
    ' dataStart=' + dataStart.toString(16) + ' dataEnd=' + dataEnd.toString(16) +
    ' next=' + (dataEnd + 4).toString(16)
  );
  if (type === 'IEND') break;
  off = dataEnd + 4;
}
console.log('final off', off.toString(16), 'src length', src.length.toString(16));
