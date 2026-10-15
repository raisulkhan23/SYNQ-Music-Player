# public/logo.ico — final byte-level result

Source PNG: `public/logo.png`
On-disk icon: `public/logo.ico`

Independent validator: `scripts/validate-on-disk-icon.cjs` (standalone, reads the on-disk
file directly, no reuse of any encoder state).

## What was wrong

- `public/logo.ico` on disk had a valid ICO header and a valid directory, but the image
  regions at each entry’s declared offset were not valid DIB images.
- DIB header size field at offset 54 was 341835776, at 1150 was 0, at 3566 was 0.
- Widths/heights/planes/bpp at those offsets mismatched the directory.
- Validator result was `FAIL: invalid or incomplete ICO`.

## What was fixed

- Replaced the broken ICO with one generated from `public/logo.png` by
  `scripts/dependency-free-rebuild-logo-ico.cjs`, a dependency-free encoder with no
  external icon libraries.
- The new encoder writes a correct ICO header, a correct directory, correct
  BITMAPINFOHEADER DIBs for 16x16 / 24x24 / 32x32 at 32 bpp, and correct AND masks.
- The new encoder writes each image block at the offset the directory declares, so the
  file is tight and contiguous with 0 trailing bytes.

## Current on-disk state

- `public/logo.png`: 30178 bytes, 512x512, valid PNG.
- `public/logo.ico`: 7886 bytes.
- ICO header: reserved = 0, type = 1, count = 3.
- Directory entries:
  - 16x16, planes=1, bpp=32, size=1128 bytes, offset=54
  - 24x24, planes=1, bpp=32, size=2440 bytes, offset=1182
  - 32x32, planes=1, bpp=32, size=4264 bytes, offset=3622
- Each entry’s DIB header size field is 40 at the declared offset.
- Directory is contiguous and tight to EOF.
- Validator result: `PASS: structurally valid ICO`.

## New repo artifacts

- `scripts/dependency-free-rebuild-logo-ico.cjs`
  - Regenerates `public/logo.ico` from `public/logo.png` with no external dependencies.
- `scripts/prebuild-fix-logo-ico.cjs`
  - Prebuild hook that regenerates `public/logo.ico` and then validates it with
    `scripts/validate-on-disk-icon.cjs`. Fails loudly if the result is not valid.
- `scripts/validate-on-disk-icon.cjs`
  - Standalone validator for the on-disk icon. Exports `ok` and `reason` so other tooling
    can reuse it.

## Regeneration is reproducible

- Running `scripts/prebuild-fix-logo-ico.cjs` twice in a row produces byte-for-byte
  identical `public/logo.ico` and passes validation both times.
- The validator is invoked twice in that flow: once inside the prebuild hook and once
  separately, and both reports agree.

## Remaining limitation

- The on-disk icon is now valid, and the repo now has a deterministic way to regenerate it
  from `public/logo.png`.
- A full Windows packaging run was not executed in this pass. The icon breakage that used to
  block packaging is no longer present, but packaging itself should still be run through
  `scripts/prebuild-fix-logo-ico.cjs` (or the equivalent prebuild step) so the freshly
  generated icon is validated immediately before it reaches the builder.

---

## Superseded (later session)

The byte-level figures above describe the PREVIOUS logo.png. The mark was
replaced with the supplied artwork:

- `public/logo.png` — 394455 bytes, 512x512 (cropped from the artwork and
  rendered by `scripts/build-icons-from-artwork.cjs`)
- `public/logo.ico` — 7886 bytes, still `PASS: structurally valid ICO`
  (16/24/32, DIB header size field 40 at offsets 54 / 1182 / 3622)

The .ico structure and the validator result are unchanged; only the source PNG
and the pixel content behind it changed.
