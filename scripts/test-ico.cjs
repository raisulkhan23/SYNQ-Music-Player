const fs = require("node:fs");
const path = require("node:path");

// Minimal ICO directory builder test
function buildIco(items) {
  const dirSize = 6 + items.length * 16;
  let totalSize = dirSize;
  const dibs = items.map((it) => it.dib);
  for (const dib of dibs) totalSize += dib.byteLength;
  const buf = Buffer.allocUnsafe(totalSize);
  buf.writeUInt16LE(0, 0); // reserved
  buf.writeUInt16LE(1, 2); // icon type
  buf.writeUInt16LE(items.length, 4); // count
  let off = dirSize;
  for (let i = 0; i < items.length; i++) {
    const { size, dib } = items[i];
    const w = size >= 256 ? 0 : size;
    const h = size >= 256 ? 0 : size;
    buf.writeUInt16LE(w, 6 + i * 16 + 0);
    buf.writeUInt16LE(h, 6 + i * 16 + 2);
    buf.writeUInt8(0, 6 + i * 16 + 4);
    buf.writeUInt8(0, 6 + i * 16 + 5);
    buf.writeUInt16LE(1, 6 + i * 16 + 6);
    buf.writeUInt16LE(32, 6 + i * 16 + 8);
    buf.writeUInt32LE(dib.byteLength, 6 + i * 16 + 10);
    buf.writeUInt32LE(off, 6 + i * 16 + 14);
    dib.copy(buf, off);
    off += dib.byteLength;
  }
  return buf;
}

const items = [
  { size: 16, dib: Buffer.alloc(40 + 16 * 16 * 4) },
  { size: 256, dib: Buffer.alloc(40 + 256 * 256 * 4) },
];
const ico = buildIco(items);
const expectedLen = 6 + 2 * 16 + (40 + 1024) + (40 + 65536 * 4);
console.log("ico len", ico.length, "expected", expectedLen, "match", ico.length === expectedLen);
console.log(
  "entry0: off=",
  ico.readUInt32LE(6 + 0 * 16 + 14),
  "len=",
  ico.readUInt32LE(6 + 0 * 16 + 10),
  "w=",
  ico.readUInt16LE(6 + 0 * 16 + 0),
  "planes=",
  ico.readUInt16LE(6 + 0 * 16 + 6),
  "bpp=",
  ico.readUInt16LE(6 + 0 * 16 + 8)
);
console.log(
  "entry1: off=",
  ico.readUInt32LE(6 + 1 * 16 + 14),
  "len=",
  ico.readUInt32LE(6 + 1 * 16 + 10)
);
console.log("entry0 off correct:", ico.readUInt32LE(6 + 0 * 16 + 14) === 6 + 2 * 16);
console.log("entry1 off correct:", ico.readUInt32LE(6 + 1 * 16 + 14) === 6 + 2 * 16 + (40 + 1024));
console.log("entry0 len correct:", ico.readUInt32LE(6 + 0 * 16 + 10) === 40 + 1024);
console.log("entry1 len correct:", ico.readUInt32LE(6 + 1 * 16 + 10) === 40 + 65536 * 4);
