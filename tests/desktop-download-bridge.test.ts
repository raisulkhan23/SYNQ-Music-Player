// ---------------------------------------------------------------------------
// Desktop download bridge tests (renderer).
//
// This file previously could not be parsed at all: it declared
// `ReturnType<typeof bun:sinon.spy>`, which is not valid TypeScript and is not
// a Bun namespace either, so no runner ever executed these assertions. It also
// replaced `globalThis.abortDesktopDownload` and expected `createDesktopAdapter`
// to notice — but the adapter calls its own module-scope import, not a global,
// so that assertion could never pass.
//
// Both are fixed here by testing the real contract: the bridge surface at
// `window.synqDesktop.download` is what gets addressed, and an adapter abort
// reaches it.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it } from "bun:test";
import {
  startDesktopDownload,
  abortDesktopDownload,
  createDesktopAdapter,
  isDesktop,
  desktopApi,
  downloadBridge,
} from "../src/lib/desktop-download-bridge";

const RELAY = "https://example.invalid/relay?track=1";

function installWindow(value: unknown) {
  Object.defineProperty(globalThis, "window", {
    value,
    writable: true,
    configurable: true,
  });
}

/** A stand-in for `electron/preload-download.cjs`'s frozen bridge. */
function installBridge() {
  const events = new Map<string, Array<(detail: unknown) => void>>();
  const started: Array<[string, string, string]> = [];
  const aborted: string[] = [];
  installWindow({
    synqDesktop: {
      isDesktop: true,
      platform: "win32",
      shell: "electron",
      download: {
        isDesktopDownloadBridge: true,
        onEvent: (type: string, handler: (detail: unknown) => void) => {
          const list = events.get(type) ?? [];
          list.push(handler);
          events.set(type, list);
          return () => {
            const current = events.get(type) ?? [];
            const index = current.indexOf(handler);
            if (index >= 0) current.splice(index, 1);
          };
        },
        startDownload: (trackId: string, relayUrl: string, filename: string) => {
          started.push([trackId, relayUrl, filename]);
          return true;
        },
        abortDownload: (trackId: string) => {
          aborted.push(trackId);
          return true;
        },
      },
    },
  });
  return {
    started,
    aborted,
    emit: (type: string, detail: unknown) => {
      for (const handler of events.get(type) ?? []) handler(detail);
    },
    listenerCount: (type: string) => (events.get(type) ?? []).length,
  };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("desktop download bridge", () => {
  it("returns not-available on non-desktop", async () => {
    installWindow({ synqDesktop: undefined });
    const result = await startDesktopDownload(RELAY, "track-1", "Track.mp3", undefined);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("not-available");
  });

  it("aborts are no-ops on non-desktop", () => {
    installWindow({ synqDesktop: undefined });
    expect(abortDesktopDownload("track-1")).toBe(false);
  });

  it("addresses the download surface, not the root bridge object", () => {
    // The OAuth and tray surfaces share `window.synqDesktop`; the download
    // channel lives under `.download`. Reading it from the root is what made
    // every call here throw `onEvent is not a function`.
    installWindow({
      synqDesktop: {
        isDesktop: true,
        shell: "electron",
        beginOAuth: () => {},
        onAuthResult: () => () => {},
      },
    });
    expect(isDesktop()).toBe(true);
    expect(desktopApi()).toBeTruthy();
    expect(downloadBridge()).toBeNull();
  });

  it("resolves with the completed file and stops listening", async () => {
    const bridge = installBridge();
    const promise = startDesktopDownload(RELAY, "track-1", "Track.mp3", undefined);

    expect(bridge.started).toEqual([["track-1", RELAY, "Track.mp3"]]);
    bridge.emit("done", {
      trackId: "track-1",
      localPath: "C:/Music/SYNQ/Track.mp3",
      size: 4096,
      contentType: "audio/mpeg",
      filename: "Track.mp3",
    });

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.localPath).toBe("C:/Music/SYNQ/Track.mp3");
    expect(result.size).toBe(4096);
    // The watchdog and both listeners are released on settle.
    expect(bridge.listenerCount("done")).toBe(0);
    expect(bridge.listenerCount("error")).toBe(0);
  });

  it("ignores events for a different track", async () => {
    const bridge = installBridge();
    const promise = startDesktopDownload(RELAY, "track-1", "Track.mp3", undefined);
    bridge.emit("done", { trackId: "someone-else", localPath: "/x.mp3" });
    bridge.emit("error", { trackId: "track-1", message: "boom" });
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("extraction-failed");
    expect(result.error?.message).toBe("boom");
  });

  it("createDesktopAdapter has the right shape", () => {
    const adapter = createDesktopAdapter(RELAY, "Track.mp3", "track-1", {
      title: "Track",
      artistName: "Artist",
      providerId: "jamendo:1",
    });
    expect(typeof adapter.probe).toBe("function");
    expect(typeof adapter.readRange).toBe("function");
    expect(typeof adapter.openStream).toBe("function");
    expect(typeof adapter.sink).toBe("function");
    expect(typeof adapter.abort).toBe("function");
  });

  it("createDesktopAdapter.abort reaches the bridge", async () => {
    const bridge = installBridge();
    const adapter = createDesktopAdapter(RELAY, "Track.mp3", "track-1", undefined);
    await adapter.abort();
    expect(bridge.aborted).toEqual(["track-1"]);
  });
});
