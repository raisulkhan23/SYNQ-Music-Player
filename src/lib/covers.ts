// ---------------------------------------------------------------------------
// Color extraction helpers for artwork-driven theming.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dominant-color extraction: sample the rendered cover art and pick the most
// "alive" color (saturated, mid-tone) to tint the whole interface.
// ---------------------------------------------------------------------------

export interface RGB {
  r: number;
  g: number;
  b: number;
}

const rgbKey = (r: number, g: number, b: number) =>
  `${r >> 4},${g >> 4},${b >> 4}`;

/** Deterministic accent derived from a string (used for remote/YouTube art). */
export function accentFromString(input: string): RGB {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return hslToRgb(hue, 0.68, 0.55);
}

function hslToRgb(h: number, s: number, l: number): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

export async function dominantColor(src: string): Promise<RGB | null> {
  try {
    const img = new Image();
    img.src = src;
    await img.decode().catch(
      () =>
        new Promise<void>((resolve) => {
          img.onload = () => resolve();
          img.onerror = () => resolve();
        }),
    );

    const size = 96;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;

    const buckets = new Map<
      string,
      { r: number; g: number; b: number; count: number; vivid: number }
    >();
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
