import { describe, expect, test } from 'vitest';
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { readSource } from "./helpers/tailwind-css.js";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPng(rel) {
  const buf = readFileSync(rel);
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error("bad PNG signature");
  let off = 8;
  let ihdr = null;
  const idat = [];
  const types = [];
  let sawEnd = false;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    types.push(type);
    if (type === "IHDR") {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        color: data[9],
      };
    }
    if (type === "IDAT") idat.push(data);
    if (type === "IEND") sawEnd = true;
    off += 12 + len;
  }
  // A truncated or mis-ordered PNG throws here rather than silently decoding.
  const raw = inflateSync(Buffer.concat(idat));

  // Un-filtered pixels.
  //
  // `raw` is the compressed scanline stream, which carries a filter byte per
  // row; reading pixel values straight out of it is only correct when the
  // encoder happened to choose filter 0 for every row. The shipped icons use a
  // mix (measured: 224 rows of Paeth on logo.png), so a test that assumed
  // filter 0 both read the wrong bytes AND reported a filter byte as a pixel.
  const channels = ihdr.color === 6 ? 4 : ihdr.color === 2 ? 3 : 1;
  const stride = ihdr.width * channels;
  const pixels = Buffer.alloc(ihdr.height * stride);
  let pos = 0;
  for (let y = 0; y < ihdr.height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let value = line[i];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = value & 0xff;
    }
  }
  return { ...ihdr, types, sawEnd, raw, buf, channels, pixels };
}

const publicSvg = readFileSync("public/logo.svg", "utf8");
const assetsSvg = readFileSync("src/assets/logo.svg", "utf8");
const manifest = JSON.parse(
  readFileSync("public/manifest.webmanifest", "utf8"),
);
const indexHtml = readSource("index.html");

describe("the logo is a real, valid image everywhere it is referenced", () => {
  test("the SVG is well-formed and self-contained", () => {
    expect(publicSvg.startsWith("<svg")).toBe(true);
    expect(publicSvg.trimEnd().endsWith("</svg>")).toBe(true);
    expect(publicSvg).toContain('xmlns="http://www.w3.org/2000/svg"');
    // No external refs: an icon that 404s offline is worse than no icon.
    expect(publicSvg).not.toMatch(/href="https?:/);
    expect(publicSvg).not.toContain("<image");
  });

  test("the mark keeps a square viewBox so it never distorts", () => {
    // The wordmark sizes it with `h-7 w-auto`, so the intrinsic ratio is what
    // decides the rendered width.
    expect(publicSvg).toContain('viewBox="0 0 512 512"');
    const [w, h] = publicSvg
      .match(/width="(\d+)" height="(\d+)"/)
      .slice(1)
      .map(Number);
    expect(w).toBe(h);
  });

  test("both copies of the SVG are identical", () => {
    // `LogoDropdown` imports the asset copy while everything else uses the
    // public one. If they drift, the logo changes between screens.
    expect(assetsSvg).toBe(publicSvg);
  });

  test("the favicon and the in-app logo point at the same file", () => {
    expect(indexHtml).toMatch(/href="\/logo\.svg\?v=\d+"/);
    const logo = readSource("src/components/brand/Logo.tsx");
    // The URL is built with `publicAsset(...)` so the packaged desktop build
    // points at the logo inside its own bundle rather than `file:///logo.svg`;
    // the versioned query string is what this test is about.
    expect(logo).toMatch(
      /export const LOGO_SRC = publicAsset\("logo\.svg\?v=\d+"\)/,
    );
    // Every <img> of the mark must reference it, never an older asset.
    expect(logo).not.toMatch(/src="\/logo\.png"/);
    expect(logo).not.toMatch(/src="\/logo\.svg"/);
  });

  test("the logo URL is versioned so a new mark can never be served stale", () => {
    // A /public asset keeps the SAME url when its contents change, so an
    // unversioned reference lets the browser — and any proxy in front of the
    // preview — keep showing the PREVIOUS logo indefinitely. That is exactly
    // how a correctly-replaced file can look like it was never changed.
    const logo = readSource("src/components/brand/Logo.tsx");
    const version = logo.match(/LOGO_SRC = publicAsset\("logo\.svg\?v=(\d+)"\)/);
    expect(version).not.toBeNull();

    // Every consumer must use that same version, or they will disagree. Both
    // go through `publicAsset`, so the version is matched inside that call.
    const player = readSource("src/lib/youtubePlayer.ts");
    expect(player).toContain(`publicAsset("logo.svg?v=${version[1]}")`);
    expect(indexHtml).toContain(`/logo.svg?v=${version[1]}`);
    // The iOS home-screen icon is versioned for the same reason. It is the
    // full-bleed 180px render (iOS applies its own rounded mask, so a
    // transparent corner shows as black) rather than the rounded tile.
    expect(indexHtml).toMatch(/href="\/icons\/apple-180\.png\?v=\d+"/);
  });
});

describe("the raster icons are valid PNGs, not placeholders", () => {
  test("logo.png is a real 512x512 RGBA image", () => {
    const img = readPng("public/logo.png");
    expect(img.width).toBe(512);
    expect(img.height).toBe(512);
    expect(img.depth).toBe(8);
    expect(img.color).toBe(6); // RGBA
    expect(img.types[0]).toBe("IHDR");
    expect(img.types[img.types.length - 1]).toBe("IEND");
    expect(img.sawEnd).toBe(true);
    // Scanlines are width*4 bytes plus a filter byte each.
    expect(img.raw.length).toBe(512 * (512 * 4 + 1));
  });

  test("product-icon.png is the square the packaging pipeline reads", () => {
    // The iOS home-screen icon is `public/icons/apple-180.png`, which is what
    // index.html links as apple-touch-icon. `product-icon.png` is the full-size
    // square that the Android/Electron icon pipeline consumes (see
    // scripts/build-icons-from-artwork.cjs), so 512 is the contract here — it
    // used to double as the iOS icon, which is why this asserted 180.
    const img = readPng("public/product-icon.png");
    expect(img.width).toBe(512);
    expect(img.height).toBe(512);
    expect(img.raw.length).toBe(512 * (512 * 4 + 1));
  });

  test("neither icon is an empty or blank file", () => {
    // The claim is "this is a real rendered mark, not a blank or placeholder
    // file", so it is measured on the decoded pixels: there is transparency (the
    // mark's rounded corners are cut out) and there is fully opaque paint. The
    // old version read the raw scanline stream instead, which required every row
    // to use filter type 0 — an encoder detail, not a property of the image.
    for (const file of ["public/logo.png", "public/product-icon.png"]) {
      const img = readPng(file);
      expect(img.channels).toBe(4);
      let min = 255;
      let max = 0;
      let painted = 0;
      for (let i = 3; i < img.pixels.length; i += 4) {
        const a = img.pixels[i];
        if (a < min) min = a;
        if (a > max) max = a;
        if (a > 200) painted += 1;
      }
      expect(min).toBeLessThan(128); // a cut-out corner
      expect(max).toBe(255); // fully painted mark
      // Not a hairline of content on a transparent field either.
      expect(painted).toBeGreaterThan(img.width * img.height * 0.2);
    }
  });

  test("the manifest icons match the files that are actually shipped", () => {
    // Every declared icon must exist and be a real PNG at the size it claims.
    // A manifest pointing at a missing or placeholder file is the classic
    // reason a site looks installable but never actually installs.
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
    const big = manifest.icons.find((i) => i.sizes === "512x512");
    expect(big).toBeDefined();
    expect(big.type).toBe("image/png");
    const img = readPng(`public${big.src}`);
    expect(img.width).toBe(512);
    expect(img.height).toBe(512);
    for (const icon of manifest.icons) {
      expect(icon.type).toBe("image/png");
      expect(readPng(`public${icon.src}`).width).toBe(
        Number(icon.sizes.split("x")[0]),
      );
    }
  });
});
