/**
 * Offline playback wiring.
 *
 * A file sitting in OPFS proves nothing; what makes it MUSIC is the path from
 * that file to the audio element, and the reason it used to fail is structural:
 * with no crossover, no EQ and no gapless, a track with a YouTube id played
 * through the IFrame — which needs the network and never looks at the saved
 * copy. These checks pin the routing rule, the library record, and the promise
 * that downloads live outside disposable caches.
 *
 * Source-shape on purpose: the runtime path needs OPFS, a media element and a
 * real click. The claims here are structural, and they are the ones that
 * regress silently.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (relative) => readFileSync(join(root, relative), "utf8");

function sliceBetween(code, from, to) {
  const start = code.indexOf(from);
  if (start === -1) throw new Error(`missing: ${from}`);
  const end = code.indexOf(to, start);
  if (end === -1) throw new Error(`missing: ${to}`);
  return code.slice(start, end);
}

describe("a downloaded track plays from disk, not from YouTube", () => {
  const player = read("src/store/player.ts");

  test("the engine choice counts a local copy", () => {
    const branch = sliceBetween(
      player,
      "const wantDeckEngine =",
      "if (wantDeckEngine) ensureGraph();",
    );
    expect(branch).toContain("downloadedIds.has(track.youtubeId)");
  });

  test("the local library is read before the first click", () => {
    expect(player).toContain("export async function hydrateDownloadedTracks");
    expect(player).toContain("listStoredDownloads()");
    const shell = read("src/components/layout/AppShell.tsx");
    expect(shell).toContain("hydrateDownloadedTracks()");
  });

  test("completing and deleting a download update that knowledge", () => {
    const downloaded = sliceBetween(
      player,
      "export function noteTrackDownloaded",
      "/** Called when a download is deleted",
    );
    expect(downloaded).toContain("downloadedIds.add(videoId)");
    const removed = sliceBetween(
      player,
      "export function noteTrackRemoved",
      "/** Resolve once per track",
    );
    expect(removed).toContain("downloadedIds.delete(videoId)");
  });

  test("the resolver still prefers the stored copy over the network", () => {
    // `ytResolve` checks the blob URL cache before it resolves anything
    // online; that ordering is what offline playback depends on.
    const resolve = sliceBetween(player, "const ytResolve =", "export function prewarmYoutubeStream");
    expect(resolve.indexOf("localAudioUrls.get(videoId)")).toBeLessThan(
      resolve.indexOf("resolveYoutubeStream(videoId)"),
    );
  });
});

describe("the library is a real record, not a filename guess", () => {
  const sink = read("src/lib/opfsSink.ts");

  test("metadata is stored next to the audio", () => {
    expect(sink).toContain("export const MANIFEST_NAME");
    expect(sink).toContain("export async function recordDownloadedTrack");
    expect(sink).toContain("export async function readDownloadedTracks");
    // The manifest itself must never be listed as a track.
    expect(sink).toContain("if (name === MANIFEST_NAME) continue;");
  });

  test("a row is written only after the bytes are committed", () => {
    const source = read("src/lib/trackSource.ts");
    const commit = sliceBetween(source, "commit: async () =>", "discardIncomplete:");
    expect(commit.indexOf("await sink.commit()")).toBeLessThan(
      commit.indexOf("recordDownloadedTrack"),
    );
  });

  test("removal deletes audio, partial and row together", () => {
    expect(sink).toContain("export async function removeDownloadedTrack");
    const fn = sliceBetween(
      sink,
      "export async function removeDownloadedTrack",
      "export class OpfsSink",
    );
    // Matching goes through the shared name helper, so a `.part` AND the
    // browser's own `.crswap` staging file are both swept up.
    expect(fn).toContain("baseNameOf(name)");
    expect(fn).toContain("removeEntry");
    expect(fn).toContain("removeManifestEntry(trackId)");
  });

  test("re-downloading replaces the previous copy", () => {
    const commit = sliceBetween(sink, "async commit()", "async discardIncomplete()");
    // The old behaviour only copied when the final name was absent, which kept
    // stale audio forever on a second download.
    expect(commit).toContain("removeEntry(name)");
    expect(commit).toContain("removeEntry(partName)");
  });

  test("downloads are stored apart from disposable caches", () => {
    // OPFS, not Cache Storage: a cache clear must not delete someone's music.
    expect(sink).toContain('const DIR = "synq-downloads"');
    const sw = read("public/sw.js");
    expect(sw).not.toContain("synq-downloads");
  });
});

describe("the hub plays the file it lists", () => {
  const hub = read("src/pages/DownloadHub.tsx");

  test("playing resolves the stored copy first", () => {
    const play = sliceBetween(hub, "const playStored = async", "const removeStored = async");
    expect(play).toContain("localAudioUrl(entry.id)");
    expect(play).toContain("noteTrackDownloaded(entry.id)");
    expect(play).toContain("playTrack(");
    // No remote URL may be constructed here.
    expect(play).not.toContain("https://");
    expect(play).not.toContain("youtu.be");
  });

  test("a missing file is reported, not played", () => {
    const play = sliceBetween(hub, "const playStored = async", "const removeStored = async");
    expect(play).toContain("missing from this device");
    expect(play).toContain("removeDownloadedTrack(entry.id)");
  });

  test("the hub keeps the live manager view and real storage numbers", () => {
    expect(hub).toContain("getDownloadManager().list()");
    expect(hub).toContain("navigator.storage?.estimate?.()");
    expect(hub).toContain("record.progress");
    expect(hub).toContain("onlySaved");
  });

  test("the current-track button authorizes the right release", () => {
    const download = sliceBetween(hub, "const downloadCurrent = async", "const playStored = async");
    expect(download).toContain("downloadTargetId(current.id, current.jamendoId)");
    expect(download).toContain("storageKey: current.id");
  });
});

describe("the transfer source is generated, never supplied", () => {
  const bridge = read("src/lib/authorizedDownload.ts");

  test("the URL comes from the authorized provider id", () => {
    expect(bridge).toContain("downloadProxyUrl(decision.providerId)");
    expect(bridge).not.toContain("decision.downloadUrl");
  });

  test("no resolver or YouTube path is involved in a download", () => {
    // Comments explain what was removed; imports and calls are what actually
    // run. Only the latter are asserted.
    const source = read("src/lib/trackSource.ts");
    expect(source).not.toMatch(/from\s+["'][^"']*(youtube|piped)[^"']*["']/i);
    expect(source).not.toContain("ytEngine.");
    expect(source).not.toContain("resolveViaPiped(");
    expect(source).not.toMatch(/from\s+["'][^"']*customResolver[^"']*["']/i);
  });
});
