import type { Album } from "@/lib/catalog";

// ---------------------------------------------------------------------------
// Generative cover art for the demo catalog.
// Each album renders a deterministic, palette-driven SVG (no external
// resources), encoded as a data URI so it can be drawn to a canvas for
// dynamic accent-color extraction.
// ---------------------------------------------------------------------------

const FONT = "'Space Grotesk', 'Inter', sans-serif";

function initials(title: string): string {
  const words = title.replace(/[^a-zA-Z\s]/g, "").trim().split(/\s+/);
  return words
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function variantShapes(variant: number, c1: string, c2: string, c3: string): string {
  switch (variant) {
    case 0: // orb
      return `
        <circle cx="470" cy="140" r="250" fill="${c2}" opacity="0.55"/>
        <circle cx="110" cy="520" r="190" fill="${c3}" opacity="0.45"/>`;
    case 1: // waves
      return Array.from({ length: 6 }, (_, i) => {
        const y = 300 + i * 34 - 85;
        const o = 0.05 + i * 0.035;
        return `<path d="M0 ${y} Q150 ${y - 46} 300 ${y} T600 ${y}" fill="none" stroke="#ffffff" stroke-opacity="${o}" stroke-width="2"/>`;
      }).join("");
    case 2: // meridian grid
      return `
        <g stroke="#ffffff" stroke-opacity="0.13" stroke-width="1.5" fill="none">
          ${Array.from({ length: 9 }, (_, i) => `<line x1="${60 + i * 60}" y1="0" x2="${-150 + i * 120}" y2="600"/>`).join("")}
          ${Array.from({ length: 7 }, (_, i) => `<path d="M0 ${i * 100} Q300 ${i * 100 - 60} 600 ${i * 100}"/>`).join("")}
        </g>`;
    case 3: // rings
      return [90, 165, 240, 320]
        .map((r) => `<circle cx="300" cy="300" r="${r}" fill="none" stroke="#ffffff" stroke-opacity="0.16" stroke-width="2"/>`)
        .join("") + `<circle cx="300" cy="300" r="52" fill="${c3}" opacity="0.5"/>`;
    case 4: // summer stripes
      return `
        <g transform="rotate(-24 300 300)">
          ${Array.from({ length: 7 }, (_, i) => `<rect x="${150 + i * 55}" y="-80" width="26" height="760" fill="#ffffff" opacity="${0.05 + i * 0.02}"/>`).join("")}
        </g>`;
    default: // night stars
      return Array.from({ length: 46 }, (_, i) => {
        const x = seeded(i * 1.7 + 3) * 600;
        const y = seeded(i * 2.3 + 9) * 600;
        const r = 1 + seeded(i * 0.9 + 5) * 3.4;
        const o = 0.15 + seeded(i * 1.1 + 2) * 0.5;
        return `<circle cx="${x}" cy="${y}" r="${r.toFixed(1)}" fill="#ffffff" opacity="${o.toFixed(2)}"/>`;
      }).join("");
  }
}

/** deterministic pseudo-random in [0,1) */
function seeded(n: number): number {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export function coverArt(album: Album): string {
  const [c1, c2, c3] = album.palette;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c1}"/>
      <stop offset="1" stop-color="${c3}"/>
    </linearGradient>
  </defs>
  <rect width="600" height="600" fill="url(#g)"/>
  ${variantShapes(album.variant, c1, c2, c3)}
  <text x="300" y="352" text-anchor="middle" font-family="${FONT}" font-size="92" font-weight="700" fill="#ffffff" fill-opacity="0.94" letter-spacing="8">${initials(album.title)}</text>
  <text x="300" y="404" text-anchor="middle" font-family="${FONT}" font-size="22" font-weight="500" fill="#ffffff" fill-opacity="0.55" letter-spacing="5">${album.title.toUpperCase()}</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// ---------------------------------------------------------------------------
// Dominant-color extraction: sample the rendered cover art and pick the most
// "alive" color (saturated, mid-tone) to tint the whole interface.
// ---------------------------------------------------------------------------

export interface RGB {
  r: number;
  g: number;
  b: number;
}

const rgbKey = (r: number, g: number, b: number) => `${r >> 4},${g >> 4},${b >> 4}`;

export async function dominantColor(src: string): Promise<RGB | null> {
  try {
    const img = new Image();
    img.src = src;
    await img.decode().catch(() => new Promise<void>((resolve) => {
      img.onload = () => resolve();
      img.onerror = () => resolve();
    }));

    const size = 96;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;

    const buckets = new Map<string, { r: number; g: number; b: number; count: number; vivid: number }>();
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      // skip fully transparent pixels and near-black / near-white noise
      if (data[i + 3] < 128) continue;
      if (r < 22 && g < 22 && b < 22) continue;
      if (r > 232 && g > 232 && b > 232) continue;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max === 0) continue;
      const vivid = (max - min) / max;
      const key = rgbKey(r, g, b);
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.r += r;
        bucket.g += g;
        bucket.b += b;
        bucket.count += 1;
        bucket.vivid = Math.max(bucket.vivid, vivid);
      } else {
        buckets.set(key, { r, g, b, count: 1, vivid });
      }
    }

    let best: { r: number; g: number; b: number; score: number } | null = null;
    for (const bucket of buckets.values()) {
      // favor common colors that are still vivid — the "essence" of the artwork
      const score = Math.log(bucket.count + 1) * (0.35 + bucket.vivid);
      if (!best || score > best.score) {
        best = {
          r: Math.round(bucket.r / bucket.count),
          g: Math.round(bucket.g / bucket.count),
          b: Math.round(bucket.b / bucket.count),
          score,
        };
      }
    }
    return best ? { r: best.r, g: best.g, b: best.b } : null;
  } catch {
    return null;
  }
}