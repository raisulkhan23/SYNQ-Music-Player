import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { readSource, root } from "./helpers/tailwind-css.js";

/**
 * The desktop shell is the one part of SYNQ that no unit test can exercise end
 * to end: it needs a packaged Electron binary, a window and a display. These
 * tests pin the parts that CAN be proven from the repository — the security
 * settings, the URL scheme, the packaging contract and the icon — so a change
 * that would quietly break the installer or open a hole is caught here instead
 * of by a shipped build.
 *
 * The packaged app was additionally smoke-tested on Windows: the built
 * `SYNQ.exe` renders the Home page and a deep link to `/artist/Hozier` from
 * `app://synq/`. See README "Desktop (Windows)".
 */

const main = readSource("electron/main.cjs");
const preload = readSource("electron/preload.cjs");
const builder = readSource("electron-builder.yml");
const pwa = readSource("src/lib/pwa.ts");
const pkg = JSON.parse(readSource("package.json"));

describe("the desktop entry point is wired into the package", () => {
  test("package.json points Electron at the main process", () => {
    expect(pkg.main).toBe("electron/main.cjs");
    expect(fs.existsSync(path.join(root, "electron/main.cjs"))).toBe(true);
    expect(fs.existsSync(path.join(root, "electron/preload.cjs"))).toBe(true);
  });

  test("installer scripts are declared", () => {
    expect(pkg.scripts["desktop:installer"]).toContain("electron-builder");
    expect(pkg.scripts["desktop:installer"]).toContain("--win nsis");
    expect(pkg.scripts["desktop:start"]).toBeTruthy();
  });

  test("the version is a real release version, not 0.0.0", () => {
    // The installer filename and the update comparison both read this.
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.version).not.toBe("0.0.0");
  });
});

describe("the shell is locked down", () => {
  test("the renderer gets no Node privileges", () => {
    expect(main).toMatch(/contextIsolation: true/);
    expect(main).toMatch(/nodeIntegration: false/);
    expect(main).toMatch(/sandbox: true/);
  });

  test("the preload exposes one frozen flag and nothing else", () => {
    // Any ipcRenderer/require surface here would be a hole in the renderer.
    expect(preload).toMatch(/contextBridge\.exposeInMainWorld/);
    expect(preload).toMatch(/Object\.freeze/);
    expect(preload).not.toMatch(/ipcRenderer/);
    expect(preload).not.toMatch(/exposeInMainWorld\(\s*"require"/);
  });

  test("external links leave the app instead of replacing it", () => {
    expect(main).toMatch(/setWindowOpenHandler/);
    expect(main).toMatch(/shell\.openExternal/);
    expect(main).toMatch(/will-navigate/);
  });

  test("only the app's own origin is treated as internal", () => {
    expect(main).toMatch(/new URL\(target\)\.protocol === "app:"/);
  });

  test("the served path cannot escape the build directory", () => {
    expect(main).toMatch(/candidate\.startsWith\(DIST\)/);
    expect(main).toMatch(/403/);
  });
});

describe("the app is served over a real origin, not file://", () => {
  test("a privileged app:// scheme is registered before ready", () => {
    // Without `standard` + `secure`, BrowserRouter paths break and the page is
    // not a secure context, so media and clipboard behave differently than in
    // the browser build.
    expect(main).toMatch(/registerSchemesAsPrivileged/);
    expect(main).toMatch(/scheme: "app"/);
    expect(main).toMatch(/standard: true/);
    expect(main).toMatch(/secure: true/);
  });

  test("unknown paths fall back to the SPA entry point", () => {
    // This is what makes a deep link like /artist/Hozier work.
    expect(main).toMatch(/index\.html/);
  });

  test("the window loads '/', which is a route", () => {
    // Loading /index.html put the shell on the 404 page: BrowserRouter matches
    // the path, and /index.html is not one.
    expect(main).not.toMatch(/loadURL\(`\$\{APP_ORIGIN\}\/index\.html`\)/);
    expect(main).toMatch(/loadURL\(`\$\{APP_ORIGIN\}/);
  });

  test("a second instance is refused so there is one audio deck", () => {
    expect(main).toMatch(/requestSingleInstanceLock/);
  });
});

describe("updates are configured honestly", () => {
  test("a check exists and is not claimed as verified", () => {
    expect(main).toMatch(/checkForUpdates/);
    expect(main).toMatch(/SYNQ_UPDATE_FEED/);
    // No feed → say so. Inventing "up to date" would be a false claim.
    expect(main).toMatch(/No update feed is configured/);
  });

  test("nothing installs silently", () => {
    expect(main).not.toMatch(/quitAndInstall/);
    expect(main).not.toMatch(/autoUpdater/);
    expect(main).toMatch(/shell\.openExternal\(latest\.url\)/);
  });

  test("an unreachable feed never interrupts playback", () => {
    expect(main).toMatch(/update check failed/);
  });
});

describe("the installer is branded and reproducible", () => {
  test("identity is SYNQ, not the template name", () => {
    expect(builder).toMatch(/appId: com\.synq\.app/);
    expect(builder).toMatch(/productName: SYNQ/);
    expect(pkg.name).toBe("synq");
  });

  test("it targets a Windows NSIS installer", () => {
    expect(builder).toMatch(/target: nsis/);
    expect(builder).toMatch(/artifactName: SYNQ-Setup-\$\{version\}\.\$\{ext\}/);
  });

  test("only the built app and the shell are packaged", () => {
    // node_modules must not ship: the renderer is bundled, and the main
    // process has no runtime dependencies.
    expect(builder).toMatch(/- electron\/\*\*/);
    expect(builder).toMatch(/- dist\/\*\*/);
    expect(builder).not.toMatch(/^\s*-\s*node_modules\/\*\*/m);
  });

  test("the icon exists and is a real multi-image ICO", () => {
    const icon = fs.readFileSync(path.join(root, "build/icon.ico"));
    expect(icon.readUInt16LE(0)).toBe(0); // reserved
    expect(icon.readUInt16LE(2)).toBe(1); // type: icon
    const count = icon.readUInt16LE(4);
    expect(count).toBeGreaterThanOrEqual(2);
    // Every entry must point at a PNG payload, which is what the generator
    // embeds and what Windows Vista+ expects for large sizes.
    for (let i = 0; i < count; i++) {
      const offset = icon.readUInt32LE(6 + i * 16 + 12);
      const length = icon.readUInt32LE(6 + i * 16 + 8);
      expect(offset + length).toBeLessThanOrEqual(icon.length);
      expect(icon.toString("ascii", offset + 1, offset + 4)).toBe("PNG");
    }
    expect(builder).toMatch(/icon: build\/icon\.ico/);
  });
});

describe("browser-only features stay off inside the shell", () => {
  test("the service worker is never registered in the desktop app", () => {
    // A worker in front of app:// can only serve a stale copy of the app.
    expect(pwa).toMatch(/if \(isDesktopShell\(\)\) return null;/);
    expect(pwa).toMatch(/bridge\?\.isDesktop === true/);
  });

  test("the install prompt reports 'unavailable' rather than offering itself", () => {
    expect(pwa).toMatch(/if \(input\.desktop\) return "unavailable";/);
    expect(pwa).toMatch(/desktop: isDesktopShell\(\)/);
  });

  test("the bridge is typed for the renderer", () => {
    const types = readSource("src/types/global.d.ts");
    expect(types).toMatch(/synqDesktop\?:/);
    expect(types).toMatch(/shell: "electron"/);
  });
});
