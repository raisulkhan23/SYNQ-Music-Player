/**
 * Build `build/icon.ico` from the PNG icons the web app already ships.
 *
 * Electron and NSIS both want an .ico, and this repository has no image
 * toolchain (no Python/Pillow, no ImageMagick). An ICO is a small container
 * format though: a header, one directory entry per image, then the image bytes.
 * Since Windows Vista, entries may be PNG-compressed, so the existing
 * `public/icons/icon-*.png` files can be embedded as-is — no resampling, no
 * second copy of the artwork to drift out of sync.
 *
 * Run with `npm run build:icon`; `npm run desktop:installer` depends on it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "build");
const sources = [
  // Largest first: Windows picks the best match per context (taskbar, Alt+Tab,
  // Explorer). 256 is the shell's practical maximum; 512 is kept for the
  // installer and for high-DPI taskbars.
  path.join(root, "public/icons/icon-512.png"),
  path.join(root, "public/icons/icon-192.png"),
];

const images = sources.map((file) => {
  const data = fs.readFileSync(file);
  // PNG dimensions live in the IHDR chunk, bytes 16..24 (big endian).
  if (data.toString("ascii", 1, 4) !== "PNG") {
    throw new Error(`${file} is not a PNG`);
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  return { file, data, width, height };
});

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4); // image count

const entries = [];
let offset = 6 + images.length * 16;

for (const image of images) {
  const entry = Buffer.alloc(16);
  // 256 is encoded as 0 in this field; larger PNG entries keep 0 as well and
  // rely on the PNG's own header for the true size.
  entry.writeUInt8(image.width >= 256 ? 0 : image.width, 0);
  entry.writeUInt8(image.height >= 256 ? 0 : image.height, 1);
  entry.writeUInt8(0, 2); // palette size
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(image.data.length, 8);
  entry.writeUInt32LE(offset, 12);
  entries.push(entry);
  offset += image.data.length;
}

fs.mkdirSync(outDir, { recursive: true });
const target = path.join(outDir, "icon.ico");
fs.writeFileSync(
  target,
  Buffer.concat([header, ...entries, ...images.map((image) => image.data)]),
);
console.log(
  `wrote ${path.relative(root, target)} (${images
    .map((image) => `${image.width}x${image.height}`)
    .join(", ")})`,
);
