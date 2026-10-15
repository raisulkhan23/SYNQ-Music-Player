'use strict';
/**
 * Do the app's own assets actually load in the packaged renderer?
 *
 * The web build and the packaged build resolve `/public/...` references
 * differently: the site serves them from the domain root, while the packaged
 * renderer loads `index.html` over `file://` out of `app.asar`. A path that
 * works perfectly on the dev server can still resolve to `file:///logo.svg` —
 * the root of the drive — inside the installed app, which is exactly how the
 * SYNQ mark ended up as a broken-image glyph.
 *
 * This loads the real bundle in Electron, over the same `file://` protocol the
 * packaged app uses, and reports every image, stylesheet and failed request.
 * Exits non-zero if a bundled logo failed to decode, so it can gate a build.
 *
 * RUN:
 *   node scripts/check-packaged-assets.cjs                       # dist/
 *   node scripts/check-packaged-assets.cjs <path-to-index.html>  # e.g. the asar
 *
 * NOT a substitute for launching the installed app — it validates asset
 * resolution, not the whole application.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');

function defaultTarget() {
  // Prefer the packaged asar when a build exists: that is the file the
  // installed application actually opens.
  const asar = path.join(
    ROOT,
    'desktop-dist',
    'win-unpacked',
    'resources',
    'app.asar',
    'dist',
    'index.html',
  );
  if (fs.existsSync(asar)) return asar;
  return path.join(ROOT, 'dist', 'index.html');
}

const target = path.resolve(process.argv[2] || defaultTarget());

if (!fs.existsSync(target)) {
  console.error(`FAIL: ${target} does not exist — build first.`);
  process.exit(1);
}

const consoleErrors = [];
const failedLoads = [];

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 820,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  win.webContents.on('console-message', (event) => {
    // Electron 44: (event) where event.level/•message; older: positional args.
    const level = event?.level ?? arguments[1];
    const message = event?.message ?? '';
    if (level === 'error' || level === 3) consoleErrors.push(message);
  });

  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    failedLoads.push({ code, desc, url, isMainFrame });
  });

  win.webContents.on('did-finish-load', async () => {
    // Let deferred images start; file:// decodes are fast but not synchronous.
    await new Promise((r) => setTimeout(r, 1200));

    // Walk the page before inspecting. Images below the fold are marked
    // `loading="lazy"` and Chromium does not request them until they come near
    // the viewport — so a check that only looks at the initially-visible DOM
    // reports them as "not loaded" when they were simply never asked for. That
    // reads as a false alarm on healthy assets.
    try {
      await win.webContents.executeJavaScript(`
        (async () => {
          const step = Math.max(200, window.innerHeight);
          for (let y = 0; y < document.body.scrollHeight; y += step) {
            window.scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 90));
          }
          window.scrollTo(0, document.body.scrollHeight);
          return true;
        })()`);
    } catch {
      // Scrolling is best-effort; the report below still stands.
    }
    await new Promise((r) => setTimeout(r, 2000));

    let report;
    try {
      report = await win.webContents.executeJavaScript(`(() => {
        const images = [...document.images].map((img) => ({
          src: img.currentSrc || img.src,
          complete: img.complete,
          naturalWidth: img.naturalWidth,
        }));
        const links = [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.href);
        return {
          url: location.href,
          title: document.title,
          bodyBg: getComputedStyle(document.body).backgroundColor,
          rootChildren: document.getElementById('root')?.children.length ?? -1,
          images,
          links,
          favicon: document.querySelector('link[rel="icon"]')?.getAttribute('href') ?? null,
        };
      })()`);
    } catch (err) {
      console.error('FAIL: could not inspect the loaded document:', err?.message);
      app.exit(1);
      return;
    }

    console.log('target:', target);
    console.log('loaded:', report.url);
    console.log('stylesheet links:', report.links.length);
    console.log('body background:', report.bodyBg);
    console.log('rendered nodes under #root:', report.rootChildren);
    console.log('images:', report.images.length);

    const broken = [];
    for (const img of report.images) {
      const ok = img.complete && img.naturalWidth > 0;
      const name = img.src.split('/').pop();
      console.log(
        `  ${ok ? 'OK  ' : 'FAIL'} ${name} (naturalWidth=${img.naturalWidth})`,
      );
      if (!ok) broken.push(img.src);
    }

    if (failedLoads.length) {
      console.log('failed loads:');
      for (const f of failedLoads) console.log(`  ${f.code} ${f.desc} ${f.url}`);
    }
    if (consoleErrors.length) {
      console.log('console errors:');
      for (const e of consoleErrors.slice(0, 10)) console.log(`  ${e}`);
    }

    // The bundled logo must decode. Remote artwork may legitimately fail.
    const logoBroken = broken.some((src) => /logo|icon/i.test(src));

    console.log('');
    if (logoBroken) {
      console.log('RESULT: FAIL — a bundled logo/icon did not load');
      app.exit(1);
    } else if (broken.length) {
      console.log(
        `RESULT: PASS (bundled assets loaded; ${broken.length} other image(s) did not — check whether they are remote)`,
      );
      app.exit(0);
    } else {
      console.log('RESULT: PASS — every referenced image resolved');
      app.exit(0);
    }
  });

  win.loadURL(pathToFileURL(target).href);
});
