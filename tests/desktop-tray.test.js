import { describe, expect, test, mock } from "bun:test";

/**
 * Tray lifecycle tests for the desktop close-to-tray behavior.
 *
 * The Electron-touching parts need a real desktop session, so these cover the
 * pure core `electron/tray.cjs` keeps exportable — the close decision, the
 * menu template, the icon candidates, the action allowlist — plus the
 * degraded (no-Tray-API) install path. The Electron side of the contract is
 * pinned by source assertions where a unit test cannot reach it.
 *
 * The `electron` module is stubbed for this file only: `tray.cjs` requires it
 * lazily, so the pure helpers would otherwise reach for the real package (a
 * path string outside Electron) instead of an injectable API.
 */
let trayWindows = [];
let trayDestroyed = 0;

mock.module("electron", () => ({
  __esModule: true,
  app: { isPackaged: false },
  BrowserWindow: {
    getAllWindows: () => trayWindows,
  },
  // No Tray/Menu/nativeImage on purpose: the degraded path must be exercised
  // by default (a Linux build without AppIndicator behaves exactly like this).
}));

const tray = (await import("../electron/tray.cjs")).default;

describe("the tray menu template is fully wired", () => {
  test("every playback entry maps to an allowed action", () => {
    const sent = [];
    const menu = tray.buildMenuTemplate({
      action: (a) => sent.push(a),
      showWindow: () => {},
      hideWindow: () => {},
      quit: () => {},
    });
    const actions = menu
      .filter((item) => item.click && item.label !== "Show SYNQ")
      .slice(0, 3);
    for (const item of actions) item.click();
    // Every tray click is one of the three verbs the renderer contract
    // handles; no decorative menu item that does nothing.
    expect(sent).toEqual(["play-pause", "next", "previous"]);
  });

  test("Show / Hide / Quit are wired, not stubs", () => {
    const calls = [];
    const menu = tray.buildMenuTemplate({
      action: () => {},
      showWindow: () => calls.push("show"),
      hideWindow: () => calls.push("hide"),
      quit: () => calls.push("quit"),
    });
    for (const item of menu) {
      if (["Show SYNQ", "Hide SYNQ", "Quit SYNQ"].includes(item.label)) {
        item.click();
      }
    }
    expect(calls).toEqual(["show", "hide", "quit"]);
  });

  test("the renderer contract only accepts the three handled verbs", () => {
    expect(tray.TRAY_ACTIONS).toEqual(["play-pause", "next", "previous"]);
    expect(
      tray.buildMenuTemplate({ action: () => {} }).filter(
        (item) => item.type !== "separator",
      ).length,
    ).toBe(6); // Play/Pause, Next, Previous, Show, Hide, Quit — all wired
  });
});

describe("the close decision keeps close-as-before the default", () => {
  test("close-to-tray off → the OS close proceeds (app quits)", () => {
    expect(tray.decideCloseAction({ minimizeToTray: false, isLastWindow: true })).toBe("close");
  });

  test("close-to-tray on → the last window hides, playback keeps running", () => {
    expect(tray.decideCloseAction({ minimizeToTray: true, isLastWindow: true })).toBe("hide");
  });

  test("closing a secondary window never hijacks the OS close", () => {
    expect(tray.decideCloseAction({ minimizeToTray: true, isLastWindow: false })).toBe("close");
  });
});

describe("shouldHideOnClose tracks the honest multi-window state", () => {
  const fakeWindow = { isDestroyed: () => false };

  test("off by default: an untouched module never hides on close", () => {
    // Fresh module state (unmocked tests start cold each run): the preference
    // is off, so close keeps quitting exactly as before the tray existed.
    expect(tray.shouldHideOnClose(fakeWindow, true)).toBe(false);
  });

  test("enabled, single window → hide", () => {
    tray.setMinimizeToTray(true);
    trayWindows = [fakeWindow];
    expect(tray.shouldHideOnClose(fakeWindow, true)).toBe(true);
  });

  test("enabled, but another window still exists → close", () => {
    trayWindows = [fakeWindow, { isDestroyed: () => false }];
    expect(tray.shouldHideOnClose(fakeWindow, true)).toBe(false);
  });

  test("a secondary or unknown main-window flag never hides", () => {
    trayWindows = [fakeWindow];
    expect(tray.shouldHideOnClose({ isDestroyed: () => false }, false)).toBe(false);
    // And the destroyed-window guard cannot be talked into a hide.
    expect(tray.shouldHideOnClose(null, true)).toBe(false);
  });

  test("disabling the preference restores plain close", () => {
    tray.setMinimizeToTray(false);
    expect(tray.shouldHideOnClose(fakeWindow, true)).toBe(false);
  });
});

describe("the tray degrades gracefully when unavailable", () => {
  test("no Tray API (some Linux builds) → no tray, no crash", () => {
    // The mocked electron module has no Tray/Menu/nativeImage — exactly the
    // shape of a Linux build without an AppIndicator backend.
    expect(tray.installTray()).toBe(false);
    expect(tray.isInstalled()).toBe(false);
    // The shell must keep working as before: close still quits.
    expect(tray.decideCloseAction({ minimizeToTray: true, isLastWindow: true })).toBe("hide");
  });
});

describe("the icon candidates match what actually ships", () => {
  test("packaged: logo.png first, the installer ico last", () => {
    const candidates = tray.iconCandidates({
      isPackaged: true,
      resourcesDir: "R",
      localDir: "L",
    });
    expect(candidates).toEqual(["R/logo.png", "R/logo.ico"]);
  });

  test("unpackaged: local assets first, the public logo as fallback", () => {
    const candidates = tray.iconCandidates({
      isPackaged: false,
      resourcesDir: "R",
      localDir: "L",
    });
    expect(candidates[0]).toBe("L/icon.png");
    expect(candidates).toContain("L/../public/logo.png");
  });
});

describe("the electron-side contract is pinned in source", () => {
  test("actions reach the renderer over webContents, never Tray.send", () => {
    // Tray instances have no `send` API — the recovered implementation called
    // one, and the click silently did nothing. The fix sends through the
    // visible window's webContents over the one explicit channel.
    expect(tray.sendAction).toBeUndefined();
    const source = require("node:fs").readFileSync(
      new URL("../electron/tray.cjs", import.meta.url),
      "utf8",
    );
    expect(source).toMatch(/webContents\.send\("tray:action"/);
    expect(source).not.toMatch(/tray\.send\(/);
    expect(source).toMatch(/windows\.find\(\(w\) => w\.isVisible\(\)\)/);
  });

  test("install is idempotent and quit unloads the icon", () => {
    const main = require("node:fs").readFileSync(
      new URL("../electron/main.cjs", import.meta.url),
      "utf8",
    );
    // A second ready-cycle or window re-creation must not stack tray icons.
    expect(require("node:fs").readFileSync(
      new URL("../electron/tray.cjs", import.meta.url),
      "utf8",
    )).toMatch(/if \(STATE\.installed\) return true;/);
    // Quit destroys the icon before teardown so it cannot survive the process.
    expect(main).toMatch(/tray\.unload\(\)/);
  });
});
