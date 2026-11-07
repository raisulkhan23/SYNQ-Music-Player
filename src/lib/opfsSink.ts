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
      if (name.endsWith(".part")) continue;
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
  if (!opfsSupported()) return false;
  try {
    const directory = await dir();
    await directory.removeEntry(name);
    return true;
  } catch {
    return false;
  }
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
    if (this.handle) {
      // Authoritative, not a counter: this survives a crash mid-write.
      this.knownBytes = (await this.handle.getFile()).size;
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
    // An open writer cannot shrink a file, so the partial is rewritten.
    // Only reached when a range came back short.
    await this.closeWriter();
    if (!this.handle) throw new Error("Sink is closed");
    const empty = await this.handle.createWritable({ keepExistingData: false });
    await empty.truncate(to);
    await empty.close();
    this.knownBytes = to;
  }

  async commit(): Promise<void> {
    await this.closeWriter();
    if (!this.handle) throw new Error("Sink is closed");
    const directory = await dir();
    const name = safeName(this.filename, this.id);
    await directory.getFileHandle(name, { create: false }).catch(async () => {
      // Absent on the normal path: copy the verified `.part` across, then drop
      // it. Only reached after the engine confirmed the full length.
      const from = await directory.getFileHandle(`${name}.part`, {
        create: false,
      });
      const file = await from.getFile();
      const to = await directory.getFileHandle(name, { create: true });
      const writer = await to.createWritable();
      await writer.write(await file.arrayBuffer());
      await writer.close();
      await directory.removeEntry(`${name}.part`);
    });
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
      (n) => !n.endsWith(".part") && parseName(n).id === trackId,
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

/**
 * Prepend bytes (an ID3 tag) to a FINISHED download, in place, streamed.
 *
 * Runs AFTER the engine has committed a verified file — the tag is decoration
 * on a complete download, never part of the transfer, so resume math and
 * integrity checks never see it. The replacement is written to a sibling
 * name first and only swapped in when complete: a crash mid-tag leaves the
 * original file intact rather than a half-tagged one.
 *
 * Returns true when the file now starts with the given bytes, false when the
 * tag could not be applied (no OPFS, entry gone mid-run). Failure must never
 * cost the listener their download.
 */
export async function prependToStoredDownload(
  trackId: string,
  prefix: Uint8Array,
): Promise<boolean> {
  if (!opfsSupported() || !trackId || prefix.length === 0) return false;
  try {
    const directory = await dir();
    const names: string[] = [];
    const iterable = directory as unknown as {
      entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
    };
    if (typeof iterable.entries === "function") {
      for await (const [name] of iterable.entries()) names.push(name);
    }
    const target = names.find(
      (n) => !n.endsWith(".part") && !n.endsWith(".tagging") && parseName(n).id === trackId,
    );
    if (!target) return false;

    const sourceHandle = await directory.getFileHandle(target);
    const source = await sourceHandle.getFile();
    // Already tagged? A re-download that overwrote its own copy could be run
    // through this twice; a file starting with "ID3" is left alone.
    const head = new Uint8Array(await source.slice(0, 3).arrayBuffer());
    if (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33) return true;

    const stagingName = `${target}.tagging`;
    const staging = await directory.getFileHandle(stagingName, { create: true });
    const writer = await staging.createWritable();
    await writer.write(new Uint8Array(prefix));
    // Stream the original through: disk-to-disk, never a full-size buffer.
    const reader = source.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) await writer.write(value);
    }
    await writer.close();

    // Swap: drop the original, then move the staged copy into its name.
    await directory.removeEntry(target);
    const stagedHandle = await directory.getFileHandle(stagingName);
    type MovableHandle = FileSystemFileHandle & {
      move?: (name: string) => Promise<void>;
    };
    const movable = stagedHandle as MovableHandle;
    if (typeof movable.move === "function") {
      // Chromium: a native same-directory rename — no second pass, no copy.
      await movable.move(target);
    } else {
      // Fallback: byte-copy through memory. The staged copy already exists,
      // so the worst case is a large transient buffer, not data loss.
      const stagedFile = await stagedHandle.getFile();
      const finalHandle = await directory.getFileHandle(target, { create: true });
      const finalWriter = await finalHandle.createWritable();
      await finalWriter.write(await stagedFile.arrayBuffer());
      await finalWriter.close();
      await directory.removeEntry(stagingName);
    }
    return true;
  } catch {
    return false;
  }
}
