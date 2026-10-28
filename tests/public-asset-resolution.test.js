import { describe, expect, test } from "bun:test";

/**
 * `publicAsset()` decides where a /public file lives in each runtime SYNQ
 * ships in. It is the recovered fix for the packaged desktop app showing a
 * broken SYNQ logo: the hand-written URL `/logo.svg` resolved to
 * `file:///logo.svg` (the root of the drive) instead of the file inside the
 * app bundle. The module reads its runtime lazily, so swapping
 * `globalThis.window` / `globalThis.document` between scenarios is enough to
 * test every shell with one import.
 */

import {
  publicAsset,
  isFileProtocol,
} from "../src/lib/publicAsset.ts";
import {
  isNativeShell,
  isAndroidShell,
} from "../src/lib/nativeShell.ts";

/** Point the module at a simulated runtime. Returns a restore function. */
function runtime({ protocol, baseURI }) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  if (protocol === undefined) {
    // Server-side rendering: no window at all.
    delete globalThis.window;
    delete globalThis.document;
  } else {
    globalThis.window = { location: { protocol } };
    globalThis.document = { baseURI };
  }
  return () => {
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
  };
}

describe("packaged desktop (file://) resolution", () => {
  test("resolves next to the loaded document, including inside an asar bundle", () => {
    const restore = runtime({
      protocol: "file:",
      baseURI:
        "file:///D:/synq67/synqmusic/desktop-dist/win-unpacked/resources/app.asar/dist/index.html",
    });
    try {
      expect(publicAsset("logo.svg?v=2")).toBe(
        "file:///D:/synq67/synqmusic/desktop-dist/win-unpacked/resources/app.asar/dist/logo.svg?v=2",
      );
      expect(publicAsset("/icons/icon-192.png")).toBe(
        "file:///D:/synq67/synqmusic/desktop-dist/win-unpacked/resources/app.asar/dist/icons/icon-192.png",
      );
      expect(publicAsset("show-me-love-cover.svg")).toBe(
        "file:///D:/synq67/synqmusic/desktop-dist/win-unpacked/resources/app.asar/dist/show-me-love-cover.svg",
      );
      expect(isFileProtocol()).toBe(true);
    } finally {
      restore();
    }
  });

  test("the query string survives resolution (cache-busting is an origin of its own)", () => {
    const restore = runtime({
      protocol: "file:",
      baseURI: "file:///C:/app/dist/index.html",
    });
    try {
      expect(publicAsset("logo.svg?v=2")).toBe(
        "file:///C:/app/dist/logo.svg?v=2",
      );
    } finally {
      restore();
    }
  });
});

describe("hosted site and Android WebView (http(s))", () => {
  test("deep routes keep root-absolute URLs untouched", () => {
    const restore = runtime({
      protocol: "https:",
      baseURI: "https://synqmusic.freebuff.app/playlist/abc",
    });
    try {
      expect(publicAsset("logo.svg?v=2")).toBe("/logo.svg?v=2");
      expect(publicAsset("/icons/icon-192.png")).toBe("/icons/icon-192.png");
      expect(isFileProtocol()).toBe(false);
    } finally {
      restore();
    }
  });

  test("a Capacitor shell served over https://localhost is unchanged too", () => {
    const restore = runtime({
      protocol: "https:",
      baseURI: "https://localhost/index.html",
    });
    try {
      expect(publicAsset("logo.svg?v=2")).toBe("/logo.svg?v=2");
    } finally {
      restore();
    }
  });
});

describe("server-side rendering and malformed inputs", () => {
  test("no window: returns the root-absolute URL", () => {
    const restore = runtime({ protocol: undefined, baseURI: undefined });
    try {
      expect(publicAsset("logo.svg")).toBe("/logo.svg");
    } finally {
      restore();
    }
  });

  test("empty or slash-only input gets a deterministic answer", () => {
    const restore = runtime({ protocol: undefined, baseURI: undefined });
    try {
      expect(publicAsset("")).toBe("/");
      expect(publicAsset("///")).toBe("/");
    } finally {
      restore();
    }
  });

  test("duplicate leading slashes collapse; the reference is preserved", () => {
    const restore = runtime({ protocol: undefined, baseURI: undefined });
    try {
      expect(publicAsset("//logo.svg?v=2")).toBe("/logo.svg?v=2");
      expect(publicAsset("//icons/icon-192.png")).toBe("/icons/icon-192.png");
    } finally {
      restore();
    }
  });

  test("complete URLs and data/blob references pass through untouched", () => {
    const restore = runtime({ protocol: undefined, baseURI: undefined });
    try {
      expect(publicAsset("https://i.ytimg.com/vi/abc/hqdefault.jpg")).toBe(
        "https://i.ytimg.com/vi/abc/hqdefault.jpg",
      );
      expect(publicAsset("data:image/svg+xml;utf8,<svg/>")).toBe(
        "data:image/svg+xml;utf8,<svg/>",
      );
      expect(publicAsset("blob:https://example.test/9f0c")).toBe(
        "blob:https://example.test/9f0c",
      );
    } finally {
      restore();
    }
  });
});

describe("nativeShell detection", () => {
  test("no window: false", () => {
    const restore = runtime({ protocol: undefined, baseURI: undefined });
    try {
      expect(isNativeShell()).toBe(false);
      expect(isAndroidShell()).toBe(false);
    } finally {
      restore();
    }
  });

  test("a plain browser (or Electron, which injects nothing): false", () => {
    const restore = runtime({
      protocol: "https:",
      baseURI: "https://synqmusic.freebuff.app/",
    });
    try {
      expect(isNativeShell()).toBe(false);
      expect(isAndroidShell()).toBe(false);
    } finally {
      restore();
    }
  });

  test("a Capacitor shell: true, with the platform distinguished", () => {
    const restore = runtime({ protocol: "https:", baseURI: "https://localhost/" });
    try {
      globalThis.window.Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => "ios",
      };
      expect(isNativeShell()).toBe(true);
      expect(isAndroidShell()).toBe(false);

      globalThis.window.Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => "android",
      };
      expect(isNativeShell()).toBe(true);
      expect(isAndroidShell()).toBe(true);

      // A half-configured bridge must not crash the check.
      globalThis.window.Capacitor = { isNativePlatform: () => true };
      expect(isNativeShell()).toBe(true);
      expect(isAndroidShell()).toBe(false);
    } finally {
      delete globalThis.window.Capacitor;
      restore();
    }
  });
});
