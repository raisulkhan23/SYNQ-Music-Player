import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * The selected wallpaper survives a reload.
 *
 * The wallpaper picker stores a stable REFERENCE (an `idb:wallpaper:<key>`
 * marker for an uploaded file, or a URL for a remote one) in `ss.wallpaper`.
 * The app used to write that reference as a plain string and read it back
 * through `JSON.parse`, which throws for every real value — so the catch
 * turned the selection into `null` and the wallpaper silently reset to the
 * default on every reload.
 *
 * These tests run against the REAL store and the REAL storage helpers, because
 * the bug lived in the disagreement between the writer and the reader.
 */

// MODULE SCOPE: the store reads localStorage and wires an Audio element while
// it is being evaluated, so every DOM global it touches must exist first.
const win = new Window({ url: "https://example.test/" });
globalThis.window = win;
globalThis.document = win.document;
globalThis.localStorage = win.localStorage;
globalThis.navigator = win.navigator;
globalThis.HTMLElement = win.HTMLElement;
globalThis.Element = win.Element;
globalThis.Node = win.Node;
globalThis.Event = win.Event;
globalThis.Audio = win.Audio;
// The Storage class itself. happy-dom keeps it on the window, but the
// "storage failure" tests below patch its prototype, so the global has to
// exist or they fail before they can assert anything.
globalThis.Storage = win.Storage;

// Seed the storage BEFORE the store module is evaluated: the store reads the
// wallpaper during module evaluation, exactly as it does on a real page load.
const LIBRARY_MARKER = "idb:wallpaper:library-abc-123";
localStorage.setItem("ss.wallpaper", LIBRARY_MARKER);
localStorage.setItem("ss.wallpaperType", "video");

// A FRESH instance of the store module. The store reads the saved wallpaper
// while the module is being evaluated, so the module has to be loaded AFTER
// the storage above is seeded. Other files in this suite import the same
// module first, and a cached module is never evaluated again — it would keep
// the empty wallpaper it was created with. The query string busts the module
// cache so this import really is a first evaluation, with the seeded
// storage already in place.
const { usePlayerStore } = await import("../src/store/player.ts?fresh=1");
const { readWallpaperReference, writeWallpaperReference } = await import(
  "../src/lib/wallpaperPreference.ts"
);

/**
 * Swap in a localStorage that really throws, and hand back a function that
 * puts the original back.
 *
 * happy-dom's `Storage` is a Proxy whose methods are bound onto the
 * instance, so patching `Storage.prototype` never reaches an instance that
 * already exists — the "throwing storage" would silently not throw and the
 * test would prove nothing. Replacing the object itself is the only
 * faithful simulation of blocked or full storage.
 *
 * Both bindings are replaced: the helpers read `window.localStorage`, while
 * the store's own writer uses the bare `localStorage` global.
 */
function withThrowingStorage(run) {
  const originalWindowStorage = win.localStorage;
  const originalGlobalStorage = globalThis.localStorage;
  const throwing = {
    getItem() {
      throw new Error("SecurityError");
    },
    setItem() {
      throw new Error("QuotaExceededError");
    },
    removeItem() {
      throw new Error("QuotaExceededError");
    },
    clear() {
      throw new Error("QuotaExceededError");
    },
    key() {
      throw new Error("SecurityError");
    },
    get length() {
      throw new Error("SecurityError");
    },
  };
  Object.defineProperty(win, "localStorage", {
    get: () => throwing,
    configurable: true,
  });
  globalThis.localStorage = throwing;
  try {
    run();
  } finally {
    Object.defineProperty(win, "localStorage", {
      get: () => originalWindowStorage,
      configurable: true,
    });
    globalThis.localStorage = originalGlobalStorage;
  }
}

describe("the store restores the saved wallpaper on start-up", () => {
  test("a stored wallpaper marker survives the reload", () => {
    // The whole bug: this used to be `null` because the reader parsed the
    // marker as JSON, threw, and swallowed the failure.
    expect(usePlayerStore.getState().wallpaperRef).toBe(LIBRARY_MARKER);
  });

  test("the stored wallpaper type survives the reload", () => {
    expect(usePlayerStore.getState().wallpaperType).toBe("video");
  });

  test("the marker is never mistaken for a loadable asset URL", () => {
    // The store holds the REFERENCE. The runtime value is resolved from it
    // (IndexedDB for a marker, the URL itself otherwise).
    expect(usePlayerStore.getState().wallpaper).not.toBe(LIBRARY_MARKER);
  });
});

describe("the persisted reference is read and written in one format", () => {
  test("a marker written raw is read back unchanged", () => {
    writeWallpaperReference("idb:wallpaper:library-xyz");
    expect(readWallpaperReference()).toBe("idb:wallpaper:library-xyz");
  });

  test("a remote URL written raw is read back unchanged", () => {
    writeWallpaperReference("https://cdn.example.com/clip.mp4");
    expect(readWallpaperReference()).toBe("https://cdn.example.com/clip.mp4");
  });

  test("a blob URL written raw is read back unchanged", () => {
    writeWallpaperReference("blob:https://example.test/9f0c");
    expect(readWallpaperReference()).toBe("blob:https://example.test/9f0c");
  });

  test("a legacy JSON-encoded string still restores", () => {
    // Older builds wrote the value through a JSON encoder. Those installs
    // must not lose their wallpaper on the next upgrade.
    localStorage.setItem("ss.wallpaper", '"blob:https://example.test/aa"');
    expect(readWallpaperReference()).toBe("blob:https://example.test/aa");
  });

  test("a legacy JSON object still restores", () => {
    localStorage.setItem("ss.wallpaper", '{"key":"library-legacy"}');
    expect(readWallpaperReference()).toBe("library-legacy");
  });

  test("an empty or absent value is simply no wallpaper", () => {
    localStorage.setItem("ss.wallpaper", "");
    expect(readWallpaperReference()).toBeNull();
    localStorage.removeItem("ss.wallpaper");
    expect(readWallpaperReference()).toBeNull();
  });

  test("corrupt storage does not throw and does not invent a wallpaper", () => {
    localStorage.setItem("ss.wallpaper", "{not json");
    expect(() => readWallpaperReference()).not.toThrow();
    // A corrupt value must not become a bogus reference that the shell then
    // tries to load as an asset.
    expect(readWallpaperReference()).toBe("{not json");
  });
});

describe("choosing a wallpaper persists it immediately", () => {
  test("setting a wallpaper writes the reference to storage", () => {
    const store = usePlayerStore.getState();
    store.setWallpaper("blob:https://example.test/live", "video", "idb:wallpaper:library-new");
    expect(readWallpaperReference()).toBe("idb:wallpaper:library-new");
    expect(usePlayerStore.getState().wallpaperRef).toBe("idb:wallpaper:library-new");
    expect(usePlayerStore.getState().wallpaper).toBe("blob:https://example.test/live");
  });

  test("a remote live wallpaper persists its URL", () => {
    usePlayerStore.getState().setWallpaper("https://cdn.example.com/live.mp4", "video");
    expect(readWallpaperReference()).toBe("https://cdn.example.com/live.mp4");
  });

  test("clearing the wallpaper removes the saved preference", () => {
    usePlayerStore.getState().setWallpaper(null, "video");
    expect(readWallpaperReference()).toBeNull();
    expect(usePlayerStore.getState().wallpaperRef).toBeNull();
  });

  test("a session-only update does not destroy the saved preference", () => {
    // The start-up restore resolves a marker into a blob URL. Writing that
    // back through the normal setter would persist a dead blob URL and break
    // the NEXT reload, and writing `null` would erase the selection outright.
    usePlayerStore.getState().setWallpaper("blob:https://example.test/a", "video", "idb:wallpaper:keep-me");
    usePlayerStore.getState().setWallpaperSessionOnly(null, "video");
    expect(readWallpaperReference()).toBe("idb:wallpaper:keep-me");
    expect(usePlayerStore.getState().wallpaperRef).toBe("idb:wallpaper:keep-me");
  });
});

describe("a storage failure cannot break the wallpaper control", () => {
  test("writing survives a throwing localStorage", () => {
    withThrowingStorage(() => {
      expect(() => writeWallpaperReference("idb:wallpaper:library-x")).not.toThrow();
      expect(() =>
        usePlayerStore.getState().setWallpaper("blob:x", "image", "idb:wallpaper:library-x"),
      ).not.toThrow();
    });
  });

  test("reading survives a throwing localStorage", () => {
    withThrowingStorage(() => {
      expect(readWallpaperReference()).toBeNull();
    });
  });
});

describe("unrelated settings never disturb the wallpaper", () => {
  test("changing the theme leaves the wallpaper alone", () => {
    const store = usePlayerStore.getState();
    store.setWallpaper("blob:https://example.test/keep", "image", "idb:wallpaper:library-keep");
    usePlayerStore.getState().setThemeMode("light");
    expect(readWallpaperReference()).toBe("idb:wallpaper:library-keep");
    expect(usePlayerStore.getState().wallpaperRef).toBe("idb:wallpaper:library-keep");
    usePlayerStore.getState().setThemeMode("dark");
  });

  test("changing the accent theme leaves the wallpaper alone", () => {
    usePlayerStore.getState().setWallpaper("blob:https://example.test/keep2", "image", "idb:wallpaper:library-keep2");
    usePlayerStore.getState().setAccentTheme("lime");
    expect(readWallpaperReference()).toBe("idb:wallpaper:library-keep2");
    expect(usePlayerStore.getState().wallpaperRef).toBe("idb:wallpaper:library-keep2");
    usePlayerStore.getState().setAccentTheme("auto");
  });
});
