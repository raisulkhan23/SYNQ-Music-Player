#!/usr/bin/env node
// Independent rebuild + validation of the SYNQ product logo as a Windows ICO.
// This script is the canonical way to turn public/logo.png into public/logo.ico.
// It is intentionally separate from the legacy build-ico*.cjs and
// fix-logo-ico.cjs files, and the encoder and validator are written
// independently so a shared bug is unlikely to pass both.
//
// Sources of truth:
//   public/logo.png  -> the new product mark
//   public/logo.ico  -> derived packaging convenience for electron-builder + tray
//
// The validator runs against the buffer BEFORE any file is written, and again
// against the file AFTER it is written, so a stale or half-written ICO can never
// be left in place.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const SRC = path.resolve(__dirname, "../public/logo.png");
const OUT = path.resolve(__dirname, "../public/logo.ico");

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// ---------- minimal PNG parsing (used by encoder only) -------------------------

function parsePngChunks(buf) {
  const chunks = [];
  let off = 8;
  while (off + 12 <= buf.length) {
    const length = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const dataStart = off + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > buf.length) break;
    chunks.push({ type, length, data: buf.subarray(dataStart, dataEnd), next: dataEnd + 4 });
    if (type === "IEND") break;
    off = dataEnd + 4;
  }
  return chunks;
}

function parseIhdr(data) {
  return {
    width: data.readUInt32BE(0),
    height: data.readUInt32BE(4),
    bitDepth: data[8],
    colourType: data[9],
    compression: data[10],
    filterMethod: data[11],
    interlace: data[12],
  };
}

function findIdatChunks(chunks) {
  const idat = [];
  for (const c of chunks) {
    if (c.type === "IEND") break;
    if (c.type === "IDAT") idat.push(c);
  }
  return idat;
}

function inflateIdat(idatChunks) {
  return zlib.inflateSync(Buffer.concat(idatChunks.map((c) => c.data)));
}

function decodeRawPixels(ihdr, raw) {
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
      const up = y > 0 ? pixels[op - stride * 4 + x] : 0;
      const upLeft = y > 0 && x > 0 ? pixels[op - stride * 4 + x - 1] : 0;
      let sample;
      switch (filter) {
        case 0:
          sample = cur;
          break;
        case 1:
          sample = cur + left;
          break;
        case 2:
          sample = cur + up;
          break;
        case 3:
          sample = cur + ((left + up) >> 1);
          break;
        case 4:
          sample = cur + (left + up - upLeft);
          break;
        default:
          throw new Error(`unsupported PNG filter byte ${filter} at row ${y}`);
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

// ---------- resample + DIB construction (used by encoder only) ---------------

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
  const bitPlanes = (bpp / 8); // 4 bytes per pixel
  const stride = (bitPlanes * w + 3) & ~3;
  const andRows = (w + 7) >> 3;
  const dataBytes = stride * h + andRows * h;
  const dib = Buffer.allocUnsafe(40 + dataBytes);

  // BITMAPINFOHEADER
  dib.writeUInt32LE(40, 0);          // biSize
  dib.writeInt32LE(w, 4);           // biWidth
  dib.writeInt32LE(h, 8);           // biHeight (positive == bottom-up DIB)
  dib.writeUInt16LE(1, 12);         // biPlanes
  dib.writeUInt16LE(bpp, 14);       // biBitCount
  dib.writeUInt32LE(0, 16);         // biCompression = BI_RGB
  dib.writeInt32LE(dataBytes, 20);  // biSizeImage
  dib.writeInt32LE(0, 24);          // biXPelsPerMeter
  dib.writeInt32LE(0, 28);          // biYPelsPerMeter
  dib.writeUInt32LE(0, 32);         // biClrUsed
  dib.writeUInt32LE(0, 36);         // biClrImportant

  // Pixel data goes immediately after the 40-byte header.
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

  // AND mask for 32bpp is all-zero.
  for (let row = 0; row < h; row++) {
    for (let i = 0; i < andRows; i++) {
      dib[andOff + row * andRows + i] = 0;
    }
  }

  return dib;
}

// ---------- ICO encoder (single canonical form) -------------------------------

function encodeIco(sizes, dibs) {
  const headerSize = 6 + sizes.length * 16;
  const imageSize = dibs.reduce((a, d) => a + d.length, 0);
  const totalSize = headerSize + imageSize;
  const buf = Buffer.allocUnsafe(totalSize);
  buf.writeUInt16LE(0, 0); // reserved
  buf.writeUInt16LE(1, 2); // type = icon
  buf.writeUInt16LE(sizes.length, 4); // image count
  let imageOff = headerSize;
  sizes.forEach((s, i) => {
    const d = dibs[i];
    const eoff = 6 + i * 16;
    buf.writeUInt8(s, eoff); // width
    buf.writeUInt8(s, eoff + 1); // height
    buf.writeUInt8(0, eoff + 2); // colour palette
    buf.writeUInt8(0, eoff + 3); // reserved
    buf.writeUInt16LE(1, eoff + 4); // colour planes
    buf.writeUInt16LE(32, eoff + 6); // bits per pixel
    buf.writeUInt32LE(d.length, eoff + 8); // size of image data
    buf.writeUInt32LE(imageOff, eoff + 12); // offset to image data
    imageOff += d.length;
  });
  dibs.forEach((d) => {
    d.copy(buf, imageOff);
    imageOff += d.length;
  });
  return buf;
}

// ---------- encoder entry point ------------------------------------------------

function encodeLogoIco(srcBuf) {
  const chunks = parsePngChunks(srcBuf);
  const ihdr = parseIhdr(chunks.find((c) => c.type === "IHDR").data);
  if (ihdr.bitDepth !== 8 || ihdr.colourType !== 6) {
    throw new Error(
      `logo.png must be 8-bit RGBA (bitDepth=${ihdr.bitDepth}, colourType=${ihdr.colourType})`,
    );
  }
  const idatChunks = findIdatChunks(chunks);
  if (idatChunks.length === 0) throw new Error("logo.png has no IDAT chunks");
  const raw = inflateIdat(idatChunks);
  const pixels = decodeRawPixels(ihdr, raw);
  const sw = ihdr.width;
  const sh = ihdr.height;
  const MAX_ICON = 256;
  const scale = Math.min(MAX_ICON / sw, MAX_ICON / sh, 1);
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));
  const scaled = resample(pixels, sw, sh, dw, dh);
  const sizes = [16, 24, 32].filter((s) => s <= dw && s <= dh);
  if (sizes.length === 0)
    throw new Error(`logo.png too small to build icon sizes (scaled to ${dw}×${dh})`);
  const dibs = sizes.map((s) => makeDib(resample(scaled, dw, dh, s, s), s, s));
  return {
    buf: encodeIco(sizes, dibs),
    sizes,
    sourceW: sw,
    sourceH: sh,
    iconW: dw,
    iconH: dh,
  };
}

// ---------- validator (structurally separate from encoder) --------------------

// Reads an ICO using only the directory table and explicit offset math, then
// re-reads each DIB header at the exact byte range the directory claims.
function validateIco(buf) {
  if (buf.length < 6 + 16) {
    return { ok: false, reason: "too small to hold even one ICO entry" };
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
      reason: "first image does not start at directory end",
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
      reason: "image data does not end exactly at EOF",
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

  return {
    ok: true,
    reserved,
    type,
    count,
    dirEnd,
    entries,
  };
}

// ---------- main -----------------------------------------------------------------

function main() {
  const src = fs.readFileSync(SRC);

  // Accept the PNG by signature bytes only. Do not rely on string comparisons.
  if (
    src.length < 300 ||
    src.subarray(0, 8).compare(PNG_SIG, 0, 8) !== 0
  ) {
    throw new Error(`logo.png signature invalid or too small (${src.length} bytes)`);
  }

  const encoded = encodeLogoIco(src);
  const buf = encoded.buf;

  // Independently validate the encoded buffer BEFORE writing anything.
  const pre = validateIco(buf);
  if (!pre.ok) {
    console.log("ENCODED ICO DID NOT PASS INDEPENDENT VALIDATION");
    console.log(JSON.stringify(pre, null, 2));
    throw new Error("encoded ico failed independent validation");
  }

  // Write atomically-ish: tmp then rename, so a partial file is never left behind.
  const tmp = OUT + ".tmp";
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, OUT);

  console.log("source:", SRC);
  console.log("source PNG:", encoded.sourceW, "x", encoded.sourceH, "bytes:", src.length);
  console.log("icon canvas:", encoded.iconW, "x", encoded.iconH);
  console.log("ico sizes:", encoded.sizes.join(", "));
  console.log("ico written:", OUT, "bytes:", buf.length);
  console.log(
    "ico header: reserved=" +
      pre.reserved +
      " type=" +
      pre.type +
      " count=" +
      pre.count,
  );
  pre.entries.forEach((e) => {
    console.log(
      "  entry",
      e.width,
      "x",
      e.height,
      "bpp=" +
        e.bitsPerPixel +
        " size=" +
        e.sizeOfImageData +
        " offset=" +
        e.offsetToImageData,
    );
  });

  // Re-validate the exact bytes on disk, so a stale or half-written file is never
  // mistaken for a valid deliverable.
  const onDisk = fs.readFileSync(OUT);
  const onDiskValidation = validateIco(onDisk);
  if (!onDiskValidation.ok) {
    console.log("ONDISK ICO FAILED INDEPENDENT VALIDATION");
    console.log(JSON.stringify(onDiskValidation, null, 2));
    throw new Error("ondisk ico failed independent validation after write");
  }
  console.log("ondisk file", OUT, "bytes:", onDisk.length, "validated OK");
}

main();
