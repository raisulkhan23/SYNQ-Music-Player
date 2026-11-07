#!/usr/bin/env python3
"""
Generates the brand assets the publish form asks for:

  public/product-icon.png   512x512   product icon
  public/hero.png          1200x630   hero / social share image
  public/logo.png           512x512   raster copy of public/logo.svg

The mark is redrawn from public/logo.svg's exact geometry (rounded gradient
tile + knocked-out eighth note) rather than shipped as a separate design, so the
icon and the in-app logo can never drift apart.
"""
import math
import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(ROOT, "public")
FONT_DIR = "/tmp"

# --- logo.svg palette (kept byte-identical to the in-app mark) ---------------
STOPS = [(0.00, (0x38, 0xbd, 0xf8)), (0.50, (0x3b, 0x82, 0xf6)), (1.00, (0xa8, 0x55, 0xf7))]
INK = (0x0A, 0x0B, 0x10)          # the knocked-out note
TILE_RADIUS = 110                 # rx on the 512 tile

# --- app theme (index.css) ---------------------------------------------------
APP_BG = (0x12, 0x14, 0x1C)
APP_FG = (0xF4, 0xF5, 0xF7)
APP_MUTED = (0x8A, 0x90, 0xA6)
APP_LIME = (0xCB, 0xF4, 0x8F)     # the "brand" lime used across the UI


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient_at(t):
    t = max(0.0, min(1.0, t))
    for i in range(len(STOPS) - 1):
        t0, c0 = STOPS[i]
        t1, c1 = STOPS[i + 1]
        if t0 <= t <= t1:
            return lerp(c0, c1, (t - t0) / (t1 - t0) if t1 > t0 else 0.0)
    return STOPS[-1][1]


def flatten_cubic(p0, p1, p2, p3, steps=48):
    pts = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        x = u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0]
        y = u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1]
        pts.append((x, y))
    return pts


def note_polygon():
    """The eighth-note flag, flattened from the two relative cubics in the SVG."""
    p = [(278.0, 128.0)]
    p += flatten_cubic(p[-1], (324, 138), (360, 162), (360, 210))
    p += flatten_cubic(p[-1], (360, 236), (348, 256), (330, 270))
    p += flatten_cubic(p[-1], (324, 228), (306, 204), (278, 192))
    return p


def render_mark(size):
    """Draw the logo at `size` px square, supersampled 4x for clean edges."""
    s = 4
    n = size * s
    k = n / 512.0  # scale factor from the SVG's 512 coordinate space

    # gradient tile (diagonal, x1/y1 -> x2/y2 as in the SVG)
    tile = Image.new("RGB", (n, n))
    px = tile.load()
    for y in range(n):
        for x in range(n):
            px[x, y] = gradient_at((x + y) / (2.0 * n))

    mask = Image.new("L", (n, n), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, n - 1, n - 1], radius=TILE_RADIUS * k, fill=255)

    out = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    out.paste(tile, (0, 0), mask)

    # the knocked-out note
    ink = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    idr = ImageDraw.Draw(ink)
    idr.ellipse([164 * k, 328 * k, 268 * k, 408 * k], fill=INK + (255,))
    idr.rounded_rectangle(
        [252 * k, 128 * k, 278 * k, 372 * k], radius=13 * k, fill=INK + (255,)
    )
    idr.polygon([(x * k, y * k) for x, y in note_polygon()], fill=INK + (255,))

    out.alpha_composite(ink)
    return out.resize((size, size), Image.LANCZOS)


def radial_glow(size, center, radius, color, peak=0.20):
    """Soft circular glow used to lift the hero background off flat black."""
    w, h = size
    g = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(g)
    steps = 48
    for i in range(steps, 0, -1):
        r = radius * i / steps
        a = int(255 * peak * (1 - i / steps) ** 2)
        d.ellipse(
            [center[0] - r, center[1] - r, center[0] + r, center[1] + r], fill=a
        )
    g = g.filter(ImageFilter.GaussianBlur(radius * 0.12))
    layer = Image.new("RGB", (w, h), color)
    return layer, g


def font(name, size):
    return ImageFont.truetype(os.path.join(FONT_DIR, name), size)


def build_hero(mark):
    W, H = 1200, 630
    hero = Image.new("RGB", (W, H), APP_BG)
    d = ImageDraw.Draw(hero)

    # faint grid, same motif as the app's .ambient-grid
    for x in range(0, W, 56):
        d.line([(x, 0), (x, H)], fill=(0x16, 0x18, 0x21), width=1)
    for y in range(0, H, 56):
        d.line([(0, y), (W, y)], fill=(0x16, 0x18, 0x21), width=1)

    # lime glow, top-right
    layer, mask = radial_glow((W, H), (980, 120), 620, APP_LIME, peak=0.16)
    hero = Image.composite(layer, hero, mask)
    # a cooler secondary glow, bottom-left
    layer2, mask2 = radial_glow((W, H), (140, 560), 520, (0x38, 0xBD, 0xF8), peak=0.10)
    hero = Image.composite(layer2, hero, mask2)

    d = ImageDraw.Draw(hero)

    # logo mark
    m = 132
    hero.paste(mark.resize((m, m), Image.LANCZOS), (84, 96), mark.resize((m, m), Image.LANCZOS))

    # wordmark
    d.text((84, 262), "SYNQ", font=font("SpaceGrotesk-700.ttf", 128), fill=APP_FG)

    # lime rule
    d.rounded_rectangle([88, 404, 268, 410], radius=3, fill=APP_LIME)

    # tagline
    d.text((84, 438), "Your music, uninterrupted.", font=font("Inter-700.ttf", 40), fill=APP_FG)

    # supporting line
    d.text(
        (86, 498),
        "Music-only discovery  ·  No ads  ·  No noise",
        font=font("Inter-700.ttf", 23),
        fill=APP_MUTED,
    )

    # equalizer bars along the bottom-right
    heights = [30, 62, 44, 86, 54, 74, 38, 68, 48, 92, 56, 34, 70, 44, 60, 26]
    bx, by, gap, bw = 640, 470, 16, 10
    for i, hgt in enumerate(heights):
        x = bx + i * (bw + gap)
        a = 0.35 + 0.65 * (hgt / 92.0)
        col = lerp(APP_MUTED, APP_LIME, a)
        d.rounded_rectangle([x, by - hgt, x + bw, by], radius=bw // 2, fill=col)

    d.text((640, 500), "SYNQMUSIC", font=font("Inter-700.ttf", 20), fill=(0x5A, 0x60, 0x74))

    return hero


def main():
    mark = render_mark(512)

    mark.save(os.path.join(PUBLIC, "logo.png"))
    mark.save(os.path.join(PUBLIC, "product-icon.png"))
    print("product-icon.png  512x512")

    hero = build_hero(mark)
    hero.save(os.path.join(PUBLIC, "hero.png"))
    print("hero.png          1200x630")


if __name__ == "__main__":
    main()
