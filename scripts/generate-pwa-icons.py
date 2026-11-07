#!/usr/bin/env python3
"""
Generates the PWA icon set from the REAL SYNQ logo.

    public/icons/icon-192.png        any purpose, 192x192
    public/icons/icon-512.png        any purpose, 512x512
    public/icons/maskable-192.png   maskable, 192x192
    public/icons/maskable-512.png   maskable, 512x512
    public/icons/apple-180.png       full-bleed, 180x180 (iOS home screen)

Why this is derived rather than drawn
-------------------------------------
The `any` icons are straight resamples of public/logo.png, so the installed
app carries exactly the mark that is already in the header. Nothing is
redrawn, so the icon can never drift from the logo.

Maskable icons are a DIFFERENT composition and cannot be a plain resample.
Android crops a maskable icon to whatever shape the launcher uses — a circle,
a squircle, a rounded square — and anything outside the safe zone is cut off.
logo.png is a rounded tile: its corners are transparent and its edges sit
right on the boundary, so using it as a maskable icon would have the launcher
crop the mark itself away on a circular mask.

So the maskable build reconstructs the tile as a FULL-BLEED square using the
logo's own gradient (the four stops lifted verbatim from public/logo.svg) and
re-centres the mark's geometry inside the safe zone at 60% of the canvas. The
safe zone is the centre 80% circle; 60% leaves the mark comfortably inside it
for every launcher mask.

The mark itself is recovered from logo.png by thresholding luminance: the
glyph is near-white on a dark indigo tile, so the glyph is exactly the set of
pixels brighter than the tile. That reuses the real artwork instead of a
hand-copied approximation of it.
"""
import os

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(ROOT, "public")
ICON_DIR = os.path.join(PUBLIC, "icons")
SOURCE = os.path.join(PUBLIC, "logo.png")

# --- logo.svg gradient stops, lifted verbatim from the real logo -------------
# The mark runs indigo -> violet -> magenta diagonally. Reused so the maskable
# background is the brand gradient rather than a flat approximation.
STOPS = [
    (0.00, (0x2E, 0x2B, 0xC8)),
    (0.35, (0x4B, 0x3F, 0xE3)),
    (0.70, (0x8B, 0x3A, 0xEF)),
    (1.00, (0xC4, 0x2A, 0xD6)),
]

# The glyph is near-white; the tile is dark indigo. Anything above this
# luminance is mark, anything below is tile.
GLYPH_LUMINANCE = 170

# Fraction of the canvas the mark occupies on a maskable icon. The safe zone
# is the centre 80% circle, so 60% keeps clear margin on the tightest masks.
MASKABLE_MARK_SCALE = 0.60


def gradient_at(t: float):
    """Sample the brand gradient. t is the diagonal position 0..1."""
    t = max(0.0, min(1.0, t))
    for i in range(len(STOPS) - 1):
        t0, c0 = STOPS[i]
        t1, c1 = STOPS[i + 1]
        if t0 <= t <= t1:
            k = 0.0 if t1 == t0 else (t - t0) / (t1 - t0)
            return tuple(round(c0[j] + (c1[j] - c0[j]) * k) for j in range(3))
    return STOPS[-1][1]


def gradient_background(size: int) -> Image.Image:
    """Full-bleed diagonal brand gradient, matching logo.svg's own direction."""
    img = Image.new("RGB", (size, size))
    px = img.load()
    denom = max(1, size - 1)
    for y in range(size):
        base = gradient_at(y / denom)
        # Blend across x so the gradient is diagonal, like the logo's. The
        # highlight is subtle (10%) because the logo's own sheen is subtle.
        for x in range(size):
            k = (x / denom) * 0.10
            px[x, y] = (
                round(base[0] + (255 - base[0]) * k),
                round(base[1] + (255 - base[1]) * k),
                round(base[2] + (255 - base[2]) * k),
            )
    return img


def glyph_mask(logo: Image.Image) -> Image.Image:
    """An 'L' mask covering only the mark's near-white pixels."""
    rgba = logo.convert("RGBA")
    alpha = rgba.getchannel("A")
    grey = rgba.convert("L")
    out = Image.new("L", rgba.size, 0)
    grey_data = grey.load()
    alpha_data = alpha.load()
    out_data = out.load()
    for y in range(rgba.size[1]):
        for x in range(rgba.size[0]):
            if alpha_data[x, y] > 8 and grey_data[x, y] >= GLYPH_LUMINANCE:
                out_data[x, y] = 255
    return out


def build_maskable(logo: Image.Image, size: int) -> Image.Image:
    mask = glyph_mask(logo)
    # Tight-crop the mark so scaling by the canvas fraction is predictable
    # rather than depending on the transparent padding in logo.png.
    bbox = mask.getbbox()
    if bbox is None:
        raise SystemExit("no glyph found in logo.png — refusing to emit icons")
    mark = mask.crop(bbox)
    target = int(size * MASKABLE_MARK_SCALE)
    scale = target / max(mark.size)
    mark = mark.resize(
        (max(1, round(mark.size[0] * scale)), max(1, round(mark.size[1] * scale))),
        Image.LANCZOS,
    )
    canvas = gradient_background(size)
    # The mark is knocked out of the tile (light on dark), so tint it with the
    # same near-white the real logo uses rather than pasting flat white.
    tint = Image.new("RGBA", mark.size, (0xF7, 0xF3, 0xFF, 255))
    tint.putalpha(mark)
    canvas.paste(
        tint,
        ((size - mark.size[0]) // 2, (size - mark.size[1]) // 2),
        tint,
    )
    return canvas


def main() -> None:
    os.makedirs(ICON_DIR, exist_ok=True)
    logo = Image.open(SOURCE)
    if logo.mode != "RGBA":
        logo = logo.convert("RGBA")

    for size in (192, 512):
        # "any": the real logo, resampled. Rounded corners preserved — that is
        # correct here, because "any" icons are shown uncropped.
        logo.resize((size, size), Image.LANCZOS).save(
            os.path.join(ICON_DIR, f"icon-{size}.png")
        )
        build_maskable(logo, size).save(
            os.path.join(ICON_DIR, f"maskable-{size}.png")
        )

    # iOS applies its own rounded mask, so this one must be full-bleed with no
    # transparency — a transparent corner shows as black on iOS.
    build_maskable(logo, 180).save(os.path.join(ICON_DIR, "apple-180.png"))

    for name in sorted(os.listdir(ICON_DIR)):
        path = os.path.join(ICON_DIR, name)
        with Image.open(path) as im:
            print(f"{name:20} {im.size[0]}x{im.size[1]} {im.mode}")


if __name__ == "__main__":
    main()