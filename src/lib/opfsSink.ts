import type { FileSink } from "@/lib/downloadManager";

/**
 * A `FileSink` backed by the Origin Private File System.
 *
 * WHY OPFS AND NOT MEMORY. A 40-minute track is ~40 MB and a full album is
 * ~600 MB. Holding either in a JS array or an in-memory blob is how a download
 * tab takes the whole tab down with it, and it is exactly what the brief rules
 * out ("avoid downloading entire files into RAM"). OPFS is a real filesystem
 * the browser owns: writes go to disk, `bytesWritten()` asks the file rather
 * than trusting a counter, and a reload does not lose the partial.
 *
 * WHY NOT INDEXEDDB. Blobs there are held in memory by the browser until
 * flushed, and truncating one is awkward. OPFS gives random-access append and
 * truncate, which is what resuming needs.
 *
 * The partial lives under a `.part` name and is only promoted to its final
 * name in `commit()`, so a half-finished download is never mistaken for a
 * finished one — the same rule the engine applies in memory.
 */

const DIR = "synq-downloads";

/**
 * The manifest that turns a directory of opaque files back into a library.
 *
 * OPFS entry names only survive as `<trackId>__<title>`: enough to find a file
 * again, not enough to render a row (artist, album, licence, size) or to play
 * the track after a reload. Keeping the metadata next to the audio is what
 * makes the downloads page a real library instead of a file listing, and it is
 * what offline playback reads when the network — and therefore every metadata
 * lookup — is gone.
 *
 * It lives in the same directory as the audio on purpose: deleting the audio
 * deletes its row, and cache cleanup that clears disposable caches cannot
 * reach it. The manifest holds no audio, so it stays tiny.
 */
export const MANIFEST_NAME = "synq-downloads.json";

export function opfsSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.storage &&
    typeof navigator.storage.getDirectory === "function"
  );
}

async function dir(): Promise<FileSystemDirectoryHandle> {
  if (!opfsSupported()) {
    throw new Error("This browser has no Origin Private File System");
  }
  const base = await navigator.storage.getDirectory();
  return base.getDirectoryHandle(DIR, { create: true });
}

/** A file physically present in the downloads directory. */
export interface StoredFile {
  /** The OPFS entry name, i.e. `<id>__<filename>`. */
  name: string;
  /** Real size on disk, in bytes. */
  size: number;
  /** Epoch millis of the last write, or null when the browser won't say. */
  modifiedAt: number | null;
}

/** Split `<id>__<filename>` back into its parts. */
function parseName(name: string): { id: string; filename: string } {
  const sep = name.indexOf("__");
  if (sep === -1) return { id: "", filename: name };
  return { id: name.slice(0, sep), filename: name.slice(sep + 2) };
}

/**
 * Names that are not a finished track.
 *
 * `.part` is our resumable partial, and `.crswap` is the swap file the browser
 * itself stages writes into while a `createWritable` stream is open. Neither
 * is music, and listing either as a download would over-report what is saved.
 */
function isTransientName(name: string): boolean {
  return /\.(?:part|crswap)$/.test(name) || name === MANIFEST_NAME;
}

/** The finished entry a transient name belongs to, or the name itself. */
function baseNameOf(name: string): string {
  return name.replace(/\.(?:part|crswap)(?:\.crswap)?$/, "");
}

/**
 * Every FINISHED download on this device, read from the real filesystem.
 *
 * WHY THIS EXISTS. `DownloadManager` keeps its records in a `Map`, so a page
 * reload produced an empty list — the bytes were sitting in OPFS the whole
 * time, invisible and unreachable. The manager is the right source of truth
 * for a transfer *in flight*; it cannot be the source of truth for what is
 * already downloaded, because it forgets on reload. The filesystem does not
 * forget, so this is what the hub reads to show saved music.
 *
 * `.part` entries are excluded: they are partial transfers, not downloads, and
 * listing them as saved would over-report what is playable offline.
 */
export async function listStoredDownloads(): Promise<StoredFile[]> {
  if (!opfsSupported()) return [];
  try {
    const directory = await dir();
    const out: StoredFile[] = [];
    // `keys()` on a directory handle is not in every TS lib yet, so the handle
    // is walked through `entries()` with an explicit async iterator type.
    const iterable = directory as unknown as {
      entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
      values?: () => AsyncIterableIterator<FileSystemHandle>;
    };
    const names: string[] = [];
    if (typeof iterable.entries === "function") {
      for await (const [name] of iterable.entries()) names.push(name);
    } else if (typeof iterable.values === "function") {
      for await (const handle of iterable.values()) names.push(handle.name);
    }
    for (const name of names) {
      if (isTransientName(name)) continue;
      try {
        const handle = await directory.getFileHandle(name);
        const file = await handle.getFile();
        out.push({
          name,
          size: file.size,
          modifiedAt: file.lastModified ?? null,
        });
      } catch {
        // A file removed between listing and reading is not an error worth
        // reporting; it simply is not there any more.
      }
    }
    return out.sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
  } catch {
    // OPFS exists but is refusing access (private mode, quota, permissions).
    // Reported as "nothing stored" rather than crashing the page.
    return [];
  }
}

/** Remove one stored download by its OPFS entry name. */
export async function deleteStoredDownload(name: string): Promise<boolean> {
  if (!opfsSupported() || name === MANIFEST_NAME) return false;
  try {
    const directory = await dir();
    await directory.removeEntry(name);
    // The library row goes with the audio, so a deleted file cannot leave a
    // playable-looking entry behind.
    const { id } = parseName(name);
    if (id) await removeManifestEntry(id);
    return true;
  } catch {
    return false;
  }
}

/** One completed download, as the library knows it. */
export interface DownloadedTrack {
  /** The id playback looks the copy up by (a YouTube id or `jamendo:<id>`). */
  id: string;
  /** The human-readable file name, e.g. `Artist - Title.mp3`. */
  filename: string;
  size: number;
  title: string;
  artistName: string;
  albumName: string;
  coverUrl: string;
  duration: number;
  /** The licensed release this file came from. */
  providerId: string;
  licenseUrl: string;
  attribution: string;
  contentType: string;
  completedAt: number;
}

/**
 * Serialised writes.
 *
 * Two transfers can finish at the same moment, and read-modify-write on one
 * JSON file would lose one of them. Every mutation therefore queues behind the
 * previous one.
 */
let manifestQueue: Promise<unknown> = Promise.resolve();

async function readManifest(): Promise<Record<string, DownloadedTrack>> {
  if (!opfsSupported()) return {};
  try {
    const directory = await dir();
    const handle = await directory.getFileHandle(MANIFEST_NAME);
    const text = await (await handle.getFile()).text();
    const parsed = JSON.parse(text) as {
      version?: number;
      tracks?: Record<string, DownloadedTrack>;
    };
    const tracks = parsed?.tracks;
    if (!tracks || typeof tracks !== "object") return {};
    const out: Record<string, DownloadedTrack> = {};
    for (const [id, entry] of Object.entries(tracks)) {
      if (entry && typeof entry === "object" && entry.id === id) out[id] = entry;
    }
    return out;
  } catch {
    // Missing, unreadable or corrupt: the audio still exists, so the library
    // reports nothing rather than inventing rows.
    return {};
  }
}

async function writeManifest(
  tracks: Record<string, DownloadedTrack>,
): Promise<void> {
  if (!opfsSupported()) return;
  try {
    const directory = await dir();
    const handle = await directory.getFileHandle(MANIFEST_NAME, {
      create: true,
    });
    const writer = await handle.createWritable();
    await writer.write(JSON.stringify({ version: 1, tracks }));
    await writer.close();
  } catch {
    // A manifest that cannot be written must not fail a finished download:
    // the audio is already on disk and `listStoredDownloads` will still show
    // it, just without metadata.
  }
}

function enqueueManifest(task: () => Promise<void>): Promise<void> {
  const next = manifestQueue.then(task, task);
  manifestQueue = next.catch(() => undefined);
  return next.catch(() => undefined);
}

/** Record a completed transfer. Called only after the bytes are committed. */
export async function recordDownloadedTrack(
  entry: DownloadedTrack,
): Promise<void> {
  if (!opfsSupported() || !entry.id) return;
  await enqueueManifest(async () => {
    const tracks = await readManifest();
    tracks[entry.id] = entry;
    await writeManifest(tracks);
  });
}

/** Every completed download the library knows about, newest first. */
export async function readDownloadedTracks(): Promise<DownloadedTrack[]> {
  const tracks = await readManifest();
  return Object.values(tracks).sort((a, b) => b.completedAt - a.completedAt);
}

async function removeManifestEntry(id: string): Promise<void> {
  await enqueueManifest(async () => {
    const tracks = await readManifest();
    if (!(id in tracks)) return;
    delete tracks[id];
    await writeManifest(tracks);
  });
}

/**
 * Remove a track's saved copy: audio, any partial, and its library row.
 *
 * Deliberately keyed by TRACK id, because that is what the player, the hub and
 * the manifest all identify a track by. Deleting by manager id used to leave
 * the real file in place — the row vanished and the song kept playing offline.
 */
export async function removeDownloadedTrack(trackId: string): Promise<boolean> {
  if (!opfsSupported() || !trackId) return false;
  let removed = false;
  try {
    const directory = await dir();
    const names: string[] = [];
    const iterable = directory as unknown as {
      entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
    };
    if (typeof iterable.entries === "function") {
      for await (const [name] of iterable.entries()) names.push(name);
    }
    for (const name of names) {
      if (name === MANIFEST_NAME) continue;
      if (parseName(baseNameOf(name)).id !== trackId) continue;
      try {
        await directory.removeEntry(name);
        removed = true;
      } catch {
        /* already gone */
      }
    }
  } catch {
    return false;
  }
  await removeManifestEntry(trackId);
  return removed;
}

export { parseName as parseStoredName };

/** OPFS names are path segments, so separators and traversal must go. */
function safeName(filename: string, id: string): string {
  const cleaned = filename
    // `\p{C}` matches control/format characters without putting literal
    // control bytes in the pattern.
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\p{C}/gu, "")
    .slice(0, 120);
  return `${id}__${cleaned || "download"}`;
}

export class OpfsSink implements FileSink {
  private handle: FileSystemFileHandle | null = null;
  private writer: FileSystemWritableFileStream | null = null;
  private knownBytes = 0;
  private readonly filename: string;
  private readonly id: string;

  // Parameter properties are not used: this project compiles with
  // `erasableSyntaxOnly`, which forbids them.
  private constructor(filename: string, id: string) {
    this.filename = filename;
    this.id = id;
  }

  static async open(filename: string, id: string): Promise<OpfsSink> {
    const sink = new OpfsSink(filename, id);
    const directory = await dir();
    sink.handle = await directory.getFileHandle(
      `${safeName(filename, id)}.part`,
      { create: true },
    );
    // An existing `.part` file is the resume point. Reading its real size from
    // the filesystem is what keeps resume honest across a reload.
    sink.knownBytes = (await sink.handle.getFile()).size;
    return sink;
  }

  async bytesWritten(): Promise<number> {
    // WHILE A WRITER IS OPEN the file's reported size is NOT what has been
    // written: `createWritable` stages the data in a `.crswap` side file and
    // the real entry stays at its last closed size until `close()`. Reading the
    // file here therefore returned 0 for a fresh download, the engine asked for
    // the same first range again and again, and the swap file grew without
    // bound instead of finishing. The in-memory count is exact while the
    // writer is open; the file is authoritative only once it has been closed
    // (which is also the crash-recovery path, where it may legitimately be
    // shorter than what was in flight).
    if (this.writer) return this.knownBytes;
    if (this.handle) {
      try {
        this.knownBytes = (await this.handle.getFile()).size;
      } catch {
        // The entry is gone: it was promoted to its final name by `commit()`
        // or removed by `cancel()`. The last known count is all that is left,
        // and throwing here turned a finished download into a failed one.
      }
    }
    return this.knownBytes;
  }

  private async ensureWriter(): Promise<FileSystemWritableFileStream> {
    if (this.writer) return this.writer;
    if (!this.handle) throw new Error("Sink is closed");
    const file = await this.handle.getFile();
    // `keepExistingData` preserves the partial, but the writer still starts at
    // position 0 — `seek` is what makes appending to a resumed file correct.
    this.writer = await this.handle.createWritable({ keepExistingData: true });
    await this.writer.seek(file.size);
    return this.writer;
  }

  async append(chunk: Uint8Array): Promise<void> {
    const writer = await this.ensureWriter();
    // Copied into a fresh ArrayBuffer-backed view: the engine's chunks come
    // off a stream and may be backed by a SharedArrayBuffer, which the OPFS
    // write signature does not accept.
    await writer.write(new Uint8Array(chunk));
    this.knownBytes += chunk.length;
  }

  async truncate(to: number): Promise<void> {
    // An open writer cannot shrink the file it is writing, so the partial is
    // closed and reopened. Only reached when a range came back short, where
    // the bytes BEFORE the segment must survive: `keepExistingData` is what
    // preserves them. Dropping it produced a file of the right LENGTH full of
    // zeros — worse than a short one, because it looks complete.
    await this.closeWriter();
    if (!this.handle) throw new Error("Sink is closed");
    const writer = await this.handle.createWritable({ keepExistingData: true });
    await writer.truncate(to);
    await writer.close();
    this.knownBytes = to;
  }

  async commit(): Promise<void> {
    await this.closeWriter();
    if (!this.handle) throw new Error("Sink is closed");
    const directory = await dir();
    const name = safeName(this.filename, this.id);
    const partName = `${name}.part`;
    // Downloading a track again has to REPLACE its previous copy. The old code
    // only copied when the final name was absent, so a re-download quietly
    // kept the stale audio and left a `.part` file behind for ever.
    await directory.removeEntry(name).catch(() => undefined);
    // Absent on the normal path: copy the verified `.part` across, then drop
    // it. Only reached after the engine confirmed the full length.
    const from = await directory.getFileHandle(partName, { create: false });
    const file = await from.getFile();
    const to = await directory.getFileHandle(name, { create: true });
    const writer = await to.createWritable();
    // Copied in bounded chunks, not as one `arrayBuffer()`: a long track is
    // tens of megabytes and holding it all in memory is the exact cost OPFS
    // exists to avoid.
    const CHUNK = 4 * 1024 * 1024;
    try {
      for (let at = 0; at < file.size; at += CHUNK) {
        const slice = file.slice(at, Math.min(file.size, at + CHUNK));
        await writer.write(new Uint8Array(await slice.arrayBuffer()));
      }
    } finally {
      await writer.close();
    }
    await directory.removeEntry(partName).catch(() => undefined);
    this.knownBytes = file.size;
  }

  async discardIncomplete(): Promise<void> {
    await this.closeWriter();
    if (!this.handle) return;
    const directory = await dir();
    await directory
      .removeEntry(`${safeName(this.filename, this.id)}.part`)
      .catch(() => undefined);
  }

  private async closeWriter(): Promise<void> {
    const writer = this.writer;
    if (!writer) return;
    this.writer = null;
    try {
      await writer.close();
    } catch {
      // Aborting mid-write is expected on pause/cancel. Whatever landed is
      // still valid — resume uses the file's real size, not a counter.
      try {
        await writer.abort();
      } catch {
        /* already closed */
      }
    }
  }
}
/**
 * The stored file for a track, or null when it is not downloaded.
 *
 * WHY THE FILE IS NAMED BY TRACK ID. Entries used to be keyed by the manager's
 * `download.id` (`dl_<time>_<seq>`), which is unique per transfer and therefore
 * useless for finding "the copy of THIS track". An offline player looks a track
 * up by its own id, so the storage key has to be the track id. That also makes
 * re-downloading the same track overwrite its own copy instead of accumulating
 * near-duplicates under a fresh key.
 */
export async function openStoredTrack(trackId: string): Promise<File | null> {
  if (!opfsSupported() || !trackId) return null;
  try {
    const directory = await dir();
    const names: string[] = [];
    const iterable = directory as unknown as {
      entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
    };
    if (typeof iterable.entries === "function") {
      for await (const [name] of iterable.entries()) names.push(name);
    }
    // The filename half varies (it is the human-readable title), so the track
    // id prefix is what identifies the file.
    const match = names.find(
      (n) => !isTransientName(n) && parseName(n).id === trackId,
    );
    if (!match) return null;
    const handle = await directory.getFileHandle(match);
    const file = await handle.getFile();
    return file.size > 0 ? file : null;
  } catch {
    return null;
  }
}

/**
 * A playable `blob:` URL for a downloaded track, or null when there isn't one.
 *
 * WHY AN OBJECT URL AND NOT A FILE PATH. The `<audio>` element cannot read an
 * OPFS path; it needs a URL it can fetch. `URL.createObjectURL(file)` hands it
 * one that the browser resolves from the file it already holds, with no copy
 * into JavaScript memory — the audio is streamed from disk by the media engine,
 * not buffered as an ArrayBuffer.
 *
 * Object URLs pin their blob in memory until revoked, so they are cached per
 * track and revoked when evicted. Without that, every play of a downloaded
 * track would leak a blob for the life of the tab.
 */
const objectUrlCache = new Map<string, string>();

export async function localAudioUrl(trackId: string): Promise<string | null> {
  if (!opfsSupported() || !trackId) return null;
  const cached = objectUrlCache.get(trackId);
  if (cached) return cached;
  const file = await openStoredTrack(trackId);
  if (!file) return null;
  const url = URL.createObjectURL(file);
  // One cached URL per track keeps seeking and gapless cheap; anything past a
  // small handful is revoked rather than held, so a long session cannot
  // accumulate blobs for every track ever played.
  if (objectUrlCache.size >= 8) {
    const oldest = objectUrlCache.keys().next().value;
    if (oldest !== undefined) {
      URL.revokeObjectURL(objectUrlCache.get(oldest) as string);
      objectUrlCache.delete(oldest);
    }
  }
  objectUrlCache.set(trackId, url);
  return url;
}

/** True when this track has a complete copy on the device. */
export async function isDownloaded(trackId: string): Promise<boolean> {
  return (await openStoredTrack(trackId)) !== null;
}
