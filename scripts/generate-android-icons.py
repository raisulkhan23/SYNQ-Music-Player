#!/usr/bin/env python3
"""
Regenerates the Android launcher icon and splash from the CURRENT brand mark.

Why this exists
---------------
`android/app/src/main/res/mipmap-*` shipped the previous artwork (the blue ->
violet gradient tile that predates the flat brand tile) and a `drawable/splash.png`
that was still Capacitor's stock 480x320 template image. An installed APK
therefore showed the OLD logo on the home screen and flashed a template splash on
launch, no matter how new the JavaScript bundle inside it was.

Everything here is DERIVED from what the web app already ships, so the phone's
launcher icon cannot drift from the icon in the browser:

    public/icons/maskable-512.png   the full-bleed brand tile with the mark
                                    re-centred inside the safe zone (built by
                                    scripts/generate-pwa-icons.py)
    public/logo.png                 the same tile with transparent corners, used
                                    to recover the mark itself

Outputs (all inside android/app/src/main/res):

    mipmap-<density>/ic_launcher.png            48dp  legacy launcher icon
    mipmap-<density>/ic_launcher_round.png      48dp  legacy round icon
    mipmap-<density>/ic_launcher_foreground.png 108dp adaptive foreground, glyph
                                                      only, transparent outside it
    drawable/ic_launcher_background.xml         gradient behind that foreground
    drawable/splash.png                         1080x1920 launch image

The adaptive icon is a background + foreground pair that the launcher masks to
whatever shape the device uses (circle, squircle, rounded square). The mark is
therefore drawn alone on a transparent foreground, sized to the inner 66% safe
zone, instead of being baked into a tile that the mask would then crop.

Run with:  python scripts/generate-android-icons.py
"""
import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(ROOT, "public")
RES = os.path.join(ROOT, "android", "app", "src", "main", "res")

MASKABLE = os.path.join(PUBLIC, "icons", "maskable-512.png")
LOGO = os.path.join(PUBLIC, "logo.png")

# Android quantises these; 1x, 1.5x, 2x, 3x, 4x are the five buckets the
# platform actually loads from.
DENSITIES = {"mdpi": 1.0, "hdpi": 1.5, "xhdpi": 2.0, "xxhdpi": 3.0, "xxxhdpi": 4.0}
LEGACY_DP = 48
FOREGROUND_DP = 108

# The glyph is near-white (luminance ~250) on a dark tile whose lighter sheen
# tops out around 240. Thresholding at 170 — as the PWA generator does, where
# the crop is tight anyway — also caught that sheen and left a faint ghost arc
# in the transparent adaptive foreground, so this is deliberately just under the
# glyph's own value.
GLYPH_LUMINANCE = 240
MARK_TINT = (0xF7, 0xF3, 0xFF)

# Fraction of the 108dp adaptive foreground the mark may occupy. The safe zone
# is the inner 72dp (66%), and a mark of 44% of the canvas sits comfortably
# inside it for every launcher mask.
FOREGROUND_MARK_SCALE = 0.44

# Legacy (pre-Android 8) icons are shown unmasked, so they get the full-bleed
# tile with the corners rounded by us.
LEGACY_CORNER_RADIUS = 0.22


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


def cropped_mark() -> Image.Image:
    """The mark alone, tight-cropped, ready to be scaled."""
    mask = glyph_mask(Image.open(LOGO))
    bbox = mask.getbbox()
    if bbox is None:
        raise SystemExit("no glyph found in public/logo.png — refusing to emit icons")
    return mask.crop(bbox)


def rounded(img: Image.Image, radius_fraction: float) -> Image.Image:
    size = img.size[0]
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=round(size * radius_fraction), fill=255
    )
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def circular(img: Image.Image) -> Image.Image:
    size = img.size[0]
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def foreground(mark: Image.Image, px: int) -> Image.Image:
    """Transparent canvas with the mark centred inside the adaptive safe zone."""
    canvas = Image.new("RGBA", (px, px), (0, 0, 0, 0))
    target = max(1, round(px * FOREGROUND_MARK_SCALE))
    scale = target / max(mark.size)
    sized = mark.resize(
        (max(1, round(mark.size[0] * scale)), max(1, round(mark.size[1] * scale))),
        Image.LANCZOS,
    )
    tint = Image.new("RGBA", sized.size, MARK_TINT + (255,))
    tint.putalpha(sized)
    canvas.paste(tint, ((px - sized.size[0]) // 2, (px - sized.size[1]) // 2), tint)
    return canvas


def sample_gradient(tile: Image.Image):
    """The tile's own diagonal gradient, read out of its corners.

    Reusing the shipped pixels (rather than re-listing hex stops) is what keeps
    the adaptive background identical to the legacy icon beside it.
    """
    w, h = tile.size
    top_left = tile.getpixel((round(w * 0.06), round(h * 0.06)))
    bottom_right = tile.getpixel((round(w * 0.94), round(h * 0.94)))
    return top_left[:3], bottom_right[:3]


def write_background_xml(start, end) -> None:
    hexed = lambda c: "#%02X%02X%02X" % c  # noqa: E731 - tiny local helper
    xml = f"""<?xml version="1.0" encoding="utf-8"?>
<!--
  The adaptive icon's background: the same diagonal gradient the web tile uses,
  sampled from public/icons/maskable-512.png by
  scripts/generate-android-icons.py. A flat colour here made the launcher icon
  read as a different, older mark than the one inside the app.
-->
<shape xmlns:android="http://schemas.android.com/apk/res/android"
    android:shape="rectangle">
    <gradient
        android:angle="315"
        android:startColor="{hexed(start)}"
        android:endColor="{hexed(end)}"
        android:type="linear" />
</shape>
"""
    path = os.path.join(RES, "drawable", "ic_launcher_background.xml")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(xml)


def build_splash(tile: Image.Image, mark: Image.Image) -> None:
    """1080x1920 launch image: the brand field with the mark centred."""
    width, height = 1080, 1920
    background = Image.new("RGB", (width, height))
    # Stretch the 512 tile up to the canvas; a soft gradient is unchanged by
    # this, so the launch screen matches the icon rather than the template
    # splash Capacitor shipped.
    background.paste(tile.resize((width, height), Image.LANCZOS), (0, 0))
    target = round(width * 0.34)
    scale = target / max(mark.size)
    sized = mark.resize(
        (max(1, round(mark.size[0] * scale)), max(1, round(mark.size[1] * scale))),
        Image.LANCZOS,
    )
    tint = Image.new("RGBA", sized.size, MARK_TINT + (255,))
    tint.putalpha(sized)
    background_rgba = background.convert("RGBA")
    background_rgba.paste(
        tint,
        ((width - sized.size[0]) // 2, (height - sized.size[1]) // 2),
        tint,
    )
    background_rgba.convert("RGB").save(os.path.join(RES, "drawable", "splash.png"))


def main() -> None:
    tile = Image.open(MASKABLE).convert("RGBA")
    if tile.size[0] != tile.size[1]:
        raise SystemExit("maskable icon must be square")
    mark = cropped_mark()

    start, end = sample_gradient(tile)
    write_background_xml(start, end)

    for name, scale in DENSITIES.items():
        out_dir = os.path.join(RES, f"mipmap-{name}")
        os.makedirs(out_dir, exist_ok=True)

        legacy_px = round(LEGACY_DP * scale)
        legacy = tile.resize((legacy_px, legacy_px), Image.LANCZOS)
        rounded(legacy, LEGACY_CORNER_RADIUS).save(os.path.join(out_dir, "ic_launcher.png"))
        circular(legacy).save(os.path.join(out_dir, "ic_launcher_round.png"))

        foreground_px = round(FOREGROUND_DP * scale)
        foreground(mark, foreground_px).save(
            os.path.join(out_dir, "ic_launcher_foreground.png")
        )

    build_splash(tile, mark)

    print(f"adaptive background: {start} -> {end}")
    for name, scale in DENSITIES.items():
        out_dir = os.path.join(RES, f"mipmap-{name}")
        for file in ("ic_launcher.png", "ic_launcher_round.png", "ic_launcher_foreground.png"):
            with Image.open(os.path.join(out_dir, file)) as im:
                print(f"{name:8} {file:28} {im.size[0]}x{im.size[1]} {im.mode}")


if __name__ == "__main__":
    main()
