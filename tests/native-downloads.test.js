import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  DOWNLOAD_PROVIDERS,
  formatFromContentType,
  isAllowedAudioContentType,
  safeDownloadStem,
} from "../src/lib/downloadProviders.ts";
import {
  nativeDownloadsSupported,
  startNativeDownload,
} from "../src/lib/nativeDownloads.ts";

/**
 * Download exclusivity and provider rules.
 *
 * These run in a plain Bun process: no Capacitor bridge and no Electron bridge,
 * which is exactly how the website/PWA sees the world. The native storage calls
 * must therefore be inert, while the pure provider rules still work.
 */

describe("downloads are native-only", () => {
  test("a browser has no native download capability", () => {
    expect(nativeDownloadsSupported()).toBe(false);
  });

  test("a browser request returns an explicit unsupported-platform result", async () => {
    const result = await startNativeDownload({
      trackId: "jamendo:123",
      downloadUrl: "https://example.com/song.mp3",
      filename: "Song",
      contentType: "audio/mpeg",
      provider: "jamendo",
      title: "Song",
      artist: "Artist",
      licenseUrl: "https://example.com/license",
      attribution: "Artist — Song",
    });
    expect(result.started).toBe(false);
    expect(result.reason).toBe("unsupported-platform");
  });

  test("the UI gates controls on the native bridge, not a viewport", () => {
    const menu = readFileSync("src/components/tracks/useTrackActions.tsx", "utf8");
    const hub = readFileSync("src/pages/DownloadHub.tsx", "utf8");
    expect(menu).toContain("nativeDownloadsSupported()");
    expect(hub).toContain("platform !== \"web\"");
    expect(hub).not.toContain("createObjectURL");
    expect(hub).not.toContain("opfsSupported");
  });

  test("the old browser sink is not reachable from download authorization", () => {
    const authorization = readFileSync("src/lib/authorizedDownload.ts", "utf8");
    expect(authorization).toContain("startNativeDownload");
    expect(authorization).not.toContain("opfs");
    expect(authorization).not.toContain("DownloadManager");
    expect(authorization).toContain("unsupported-platform");
  });

  test("Android registers the plugin before the bridge starts", () => {
    const activity = readFileSync(
      "android/app/src/main/java/com/synq/music/MainActivity.java",
      "utf8",
    );
    const registration = activity.indexOf("registerPlugin(SynqDownloadsPlugin.class)");
    const start = activity.indexOf("super.onCreate(savedInstanceState)");
    expect(registration).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(registration);
  });
});

describe("provider grants", () => {
  test("only the two explicit-grant providers are registered", () => {
    expect(DOWNLOAD_PROVIDERS.map((provider) => provider.id)).toEqual([
      "jamendo",
      "soundcloud",
    ]);
    expect(
      DOWNLOAD_PROVIDERS.every((provider) => provider.grantField.length > 0),
    ).toBe(true);
  });

  test("content types are normalized only when unambiguous", () => {
    expect(formatFromContentType("audio/mpeg")).toBe("mp3");
    expect(formatFromContentType("audio/mp4; codecs=mp4a")).toBe("m4a");
    expect(formatFromContentType("audio/flac")).toBe("flac");
    expect(formatFromContentType("text/html")).toBeNull();
    expect(isAllowedAudioContentType("audio/ogg")).toBe(true);
    expect(isAllowedAudioContentType("application/octet-stream")).toBe(true);
    expect(isAllowedAudioContentType("text/html")).toBe(false);
  });

  test("filenames cannot carry traversal or an untrusted extension", () => {
    const stem = safeDownloadStem("../../Artist/Song.mp3", "", "", "jamendo:1");
    expect(stem).not.toContain("..");
    expect(stem).not.toContain("/");
    expect(stem).not.toContain(".mp3");
    expect(stem).toContain("Artist-Song");
  });

  test("missing metadata generates a stable id-based name, not a fabricated one", () => {
    expect(safeDownloadStem("", "", "", "jamendo:42")).toBe("track-jamendo:42");
  });
});
