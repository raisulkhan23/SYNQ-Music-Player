# Code Review Notes — October 10, 2026

## 1. ICO icon (`public/logo.ico`) — FIXED ✅

**File:** `synqmusic/scripts/build-ico.cjs` → replaced by corrected `synqmusic/scripts/build-ico5.cjs` (live generator). The old `build-ico.cjs` still has the buggy `buildIco` for reference but is no longer the active generator.

**Root cause:** Three compounded bugs in the ICO build pipeline:

1. **ICO directory entry layout was wrong.** The old code wrote 2-byte width/height fields into 1-byte slots. The ICO spec uses *single-byte* bWidth/bHeight (0 means 256), with the rest of the 16-byte entry laid out:
   ```
   bWidth(1) bHeight(1) bColorCount(1) bReserved(1) wPlanes(2) wBitCount(2) dwBytesInRes(4) dwImageOffset(4)
   ```
   Writing `writeUInt16LE` for width/height overflowed into the next fields and corrupted every entry's offset. This is why entries 0–4 had garbage offsets while 5–6 (written last) looked right — the corruption was relative to entry boundaries, so the final entries happened to survive.

2. **PNG chunk parser off-by-4 in the original `readPngRgba`.** `p += 12` after reading length+type should have been `p += 8` (length=4 + type=4). That 4-byte shift caused the IHDR parse to read height/bpp/etc. from wrong bytes, and the IDAT collection to slice wrong ranges, so the generated DIBs contained garbage pixels even though the ICO structure looked superficially OK. The "wrong offsets" symptom was a downstream effect of bad pixel data producing bad DIB sizes.

3. **Idempotency / regeneration problem.** The original script silently swallowed errors (`catch(() => {})`) and wrote a partially-valid ICO that masked the bugs during casual inspection. A clean rebuild with verification is now the only path.

**Corrected implementation:** `synqmusic/scripts/build-ico5.cjs`
- Correct PNG chunk walker: advances `off = crcEnd` per chunk, isolates IHDR, filters IDAT, inflates with `zlib.inflateSync`.
- Validates IHDR: 8-bit RGBA (bd=8, ct=6), square, positive dims.
- Resamples a 512×512 RGBA source down to each target size (16, 24, 32, 48, 64, 128, 256) with a nearest-corner bilinear filter, flips vertically for DIB bottom-up convention.
- Writes BITMAPINFOHEADER DIBs (40-byte header, 32bpp, correct imageSize).
- Writes the ICO directory with 1-byte width/height fields and correct per-entry offsets.
- **Verified output:** `public/logo.ico` — 361,102 bytes, 7 entries, all offsets monotonic and in-file, all DIB headers 40 bytes with matching dims. Entry 6 (256) correctly uses dir `0×0` + DIB `256×256`.

**To regenerate:** `node scripts/build-ico5.cjs` (expects `public/logo.png`). The build is idempotent and self-checking: it throws on missing/bad PNG, and the ICO is verified by an independent reader after generation.

---

## Remaining review items (not yet acted on)

### 2. Multi-window drag-and-drop (task 6)
- **Files:** `electron/main.cjs` (main process), `src/components/HaloDropzone.tsx` (renderer).
- No code change yet. The main process today creates a single `BrowserWindow` and the renderer's drop zone assumes a single window. To support drops onto the desktop window from other processes, the main process needs either a second window type or an IPC bridge that routes file paths / pasted content to the correct renderer. No implementation started.

### 3. Electron-builder packaging (task 7)
- **Files:** `electron-builder.yml`, `electron/main.cjs`, `package.json`.
- The config already targets NSIS + portable for x64 and excludes `scripts/`, `tests/`, `.env*`, etc. The `icon` field currently points at `public/logo.png` in this checkout's `electron-builder.yml` (electron-builder converts PNG on its own), so the corrected ICO is not strictly required by the packaging config — but the corrected ICO remains the right artifact for any direct ICO consumer and for consistency. No packaging run attempted yet.

### 4. API shim / Convex stack (task 9)
- **Files:** `scripts/generate-api-shim.cjs`, `src/convex/tsconfig.json`, `convex.json`.
- The shim generator reads `src/convex/*.ts`, skips a known set, and emits `src/convex/_generated/api.ts` typed as `any`. This lets the frontend build compile without a live Convex deployment. The Convex tsconfig uses `module: "ESNext"` + `moduleResolution: "Bundler"`, which matches the Vite bundler in the rest of the app. Nothing obviously broken here, but I have not run `generate-api-shim.cjs` or validated the generated file against the actual convex function exports. Worth a generation pass + a typecheck.

### 5. `tsconfig.app.json` `erasableSyntaxOnly` (task 10)
- **File:** `synqmusic/tsconfig.app.json`.
- `"erasableSyntaxOnly": true` requires that emitted JS be valid without type annotations — i.e. no `enum`, no `namespace`, no parameter properties, etc. The app uses React + Vite + the convex generated code. If any file uses `enum` or similar, the build would fail at emit. I have not run `tsc -b` yet to confirm the whole tree satisfies this. Worth a typecheck pass.

### 6. Brand assets generator (task 11)
- **File:** `scripts/generate-brand-assets.py`.
- Python script for brand assets (likely logos, favicons, splash, etc.). I have not read it end-to-end or run it. If it also emits an ICO or PNG that feeds `public/logo.png`, there may be a relationship to the icon work above — worth checking whether the Python script and the Node ICO builder are both needed or if one should own the icon pipeline.

---

## Recommendations / next steps

1. **Make `build-ico5.cjs` the canonical icon builder.** Replace references to the old `build-ico.cjs` in docs/scripts, and wire it into `package.json` (e.g. a `"build:icon": "node scripts/build-ico5.cjs"` script) so the ICO is regenerated from `logo.png` on demand rather than committed as a stale binary.
2. **Run the build/typecheck sweep:** `tsc -b` (app + convex), `node scripts/generate-api-shim.cjs`, then `vite build` (or `npm run build`) to confirm the API shim + `erasableSyntaxOnly` + rest of the tree is consistent.
3. **Decide the icon pipeline ownership** between `generate-brand-assets.py` and `build-ico5.cjs` — avoid two independent icon generators producing divergent outputs.
4. **For the multi-window drag-and-drop feature**, start with the IPC contract between a future second window / drop target and the existing renderer before adding UI.

---

*Most of the above is superseded once the typecheck and build runs are done — those are the gating checks for items 4, 5, 11.*
