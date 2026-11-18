/**
 * Native offline downloads for the Electron shell.
 *
 * The renderer never receives filesystem access. It submits a provider-granted
 * request over IPC; this module validates it, downloads the bytes in the main
 * process, validates the actual container from magic bytes, and stores the
 * result in an app-managed directory. Playback is served through the restricted
 * `synq-media://` protocol by track id, never by a renderer-supplied path.
 */

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { Readable } = require("node:stream");

const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_ARTWORK_BYTES = 8 * 1024 * 1024;
const MAX_ACTIVE = 2;
const ALLOWED_PROVIDERS = new Set(["jamendo", "soundcloud"]);
const ALLOWED_FORMATS = new Set(["mp3", "m4a", "aac", "flac", "wav", "ogg"]);

const MIME_BY_FORMAT = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  ogg: "audio/ogg",
};

function cleanStem(value) {
  return String(value ?? "")
    .replace(/\.(mp3|m4a|aac|flac|wav|ogg|opus|mp4|webm)$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "-")
    .replace(/\.{2,}/g, "")
    .replace(/\s+/g, " ")
    .replace(/^[-. ]+|[-. ]+$/g, "")
    .trim()
    .slice(0, 140)
    .replace(/[. ]+$/g, "");
}

function safeFilename(stem, format, fallback) {
  const base =
    cleanStem(stem) || cleanStem(fallback) || `track-${crypto.randomUUID()}`;
  return `${base}.${format}`;
}

function isHttpsUrl(value, maxLength = 4096) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isAllowedContentType(value) {
  if (typeof value !== "string" || value.length > 200) return false;
  const type = value.split(";")[0].trim().toLowerCase();
  return (
    type.startsWith("audio/") ||
    type === "application/ogg" ||
    type === "application/octet-stream"
  );
}

/** Validate everything crossing the renderer -> main boundary. */
function validateDownloadRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid download request");
  }
  const {
    trackId,
    downloadUrl,
    filename,
    contentType,
    provider,
    title,
    artist,
    album,
    artworkUrl,
    durationMs,
    licenseUrl,
    attribution,
  } = input;
  if (
    typeof trackId !== "string" ||
    !/^[A-Za-z0-9:_-]{1,200}$/.test(trackId)
  ) {
    throw new Error("Invalid track id");
  }
  if (!isHttpsUrl(downloadUrl)) {
    throw new Error("Download URL must be HTTPS");
  }
  if (!ALLOWED_PROVIDERS.has(provider)) {
    throw new Error("Unsupported download provider");
  }
  if (!isAllowedContentType(contentType)) {
    throw new Error("The provider did not grant an audio file");
  }
  if (typeof filename !== "string" || filename.length === 0 || filename.length > 260) {
    throw new Error("Invalid filename");
  }
  if (typeof title !== "string" || title.length > 300) {
    throw new Error("Invalid title");
  }
  if (typeof artist !== "string" || artist.length > 300) {
    throw new Error("Invalid artist");
  }
  if (album !== undefined && (typeof album !== "string" || album.length > 300)) {
    throw new Error("Invalid album");
  }
  if (artworkUrl !== undefined && !isHttpsUrl(artworkUrl, 2048)) {
    throw new Error("Invalid artwork URL");
  }
  if (
    durationMs !== undefined &&
    (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 86_400_000)
  ) {
    throw new Error("Invalid duration");
  }
  if (!isHttpsUrl(licenseUrl, 2048)) {
    throw new Error("Invalid license URL");
  }
  if (typeof attribution !== "string" || attribution.length > 500) {
    throw new Error("Invalid attribution");
  }
  return {
    trackId,
    downloadUrl,
    filename,
    contentType,
    provider,
    title: title.trim(),
    artist: artist.trim(),
    ...(typeof album === "string" && album.trim() ? { album: album.trim() } : {}),
    ...(artworkUrl ? { artworkUrl } : {}),
    ...(Number.isFinite(durationMs) ? { durationMs } : {}),
    licenseUrl,
    attribution,
  };
}

/** Detect the real container from its leading bytes. */
function detectAudioFormat(bytes) {
  const buffer = Buffer.from(bytes);
  if (buffer.length >= 12) {
    if (buffer.subarray(0, 3).toString("latin1") === "ID3") return "mp3";
    if (
      buffer[0] === 0xff &&
      (buffer[1] & 0xe0) === 0xe0 &&
      ((buffer[1] & 0xf6) === 0xf0 || (buffer[1] & 0xf6) === 0xf8)
    ) {
      return "aac";
    }
    if (
      buffer[0] === 0xff &&
      (buffer[1] & 0xe0) === 0xe0 &&
      (buffer[1] & 0x06) === 0x02
    ) {
      return "mp3";
    }
    if (
      buffer.subarray(4, 8).toString("latin1") === "ftyp" ||
      buffer.subarray(4, 8).toString("latin1") === "styp"
    ) {
      return "m4a";
    }
    if (buffer.subarray(0, 4).toString("latin1") === "fLaC") return "flac";
    if (
      buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
      buffer.subarray(8, 12).toString("latin1") === "WAVE"
    ) {
      return "wav";
    }
    if (buffer.subarray(0, 4).toString("latin1") === "OggS") return "ogg";
  }
  return null;
}

function detectImageExtension(bytes) {
  const buffer = Buffer.from(bytes);
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpg";
  }
  if (
    buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  ) {
    return "png";
  }
  return null;
}

function progressOf(bytes, total) {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, (bytes / total) * 100));
}

function hashTrackId(trackId) {
  return crypto.createHash("sha256").update(trackId).digest("hex").slice(0, 32);
}

/** Stored names are generated by this module, but the index is still treated as
 * untrusted input: no record may name a path, parent traversal, or another
 * directory. */
function isSafeStoredName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 200 &&
    name === path.basename(name) &&
    !name.includes("..") &&
    /^[A-Za-z0-9._-]+$/.test(name)
  );
}

function contentRangeTotal(header) {
  if (typeof header !== "string") return null;
  const match = /^bytes\s+\d+-\d+\/(\d+|\*)$/i.exec(header.trim());
  if (!match || match[1] === "*") return null;
  const total = Number(match[1]);
  return Number.isFinite(total) ? total : null;
}

class NativeDownloadStore {
  constructor(options) {
    this.root = options.root;
    this.fetch = options.fetch;
    this.appVersion = options.appVersion ?? "1.0.0";
    this.onChanged = options.onChanged ?? (() => {});
    this.records = new Map();
    this.active = new Map();
    this.running = 0;
    this.initialized = null;
    this.writeChain = Promise.resolve();
    this.runs = new Map();
  }

  indexPath() {
    return path.join(this.root, "index.json");
  }

  init() {
    if (!this.initialized) {
      this.initialized = this.#load().catch((error) => {
        console.error("[synq] downloads failed to initialise:", error);
        this.records.clear();
      });
    }
    return this.initialized;
  }

  async #load() {
    await fs.mkdir(this.root, { recursive: true });
    try {
      const raw = JSON.parse(await fs.readFile(this.indexPath(), "utf8"));
      if (raw?.version === 1 && Array.isArray(raw.records)) {
        for (const record of raw.records) {
          if (!record?.id || !record?.trackId) continue;
          if (record.fileName && !isSafeStoredName(record.fileName)) continue;
          if (record.partName && !isSafeStoredName(record.partName)) continue;
          if (record.artworkName && !isSafeStoredName(record.artworkName)) continue;
          this.records.set(record.id, record);
        }
      }
    } catch {
      // A first launch has no index; an unreadable index is not repaired by
      // inventing entries.
    }
    let changed = false;
    for (const record of this.records.values()) {
      if (record.status === "downloading" || record.status === "validating") {
        record.status = "failed";
        record.error = "Download was interrupted when SYNQ closed.";
        record.speed = 0;
        changed = true;
      }
      if (record.status === "completed") {
        const file = path.join(this.root, record.fileName || "");
        try {
          const stat = await fs.stat(file);
          if (!stat.isFile() || stat.size <= 0) throw new Error("missing");
          record.fileSize = stat.size;
        } catch {
          record.status = "failed";
          record.error = "The downloaded file is missing or corrupt.";
          changed = true;
        }
      }
    }
    if (changed) await this.#save();
    setImmediate(() => this.#pump());
  }

  #save() {
    const payload = JSON.stringify(
      { version: 1, records: [...this.records.values()] },
      null,
      2,
    );
    this.writeChain = this.writeChain
      .then(async () => {
        const temp = `${this.indexPath()}.tmp`;
        await fs.writeFile(temp, payload, { encoding: "utf8", mode: 0o600 });
        await fs.rename(temp, this.indexPath());
      })
      .catch((error) => {
        // A transient write failure must not poison every later save.
        console.error("[synq] downloads index write failed:", error);
      });
    return this.writeChain;
  }

  #snapshot(record) {
    const total = record.totalBytes ?? null;
    return {
      id: record.id,
      trackId: record.trackId,
      filename: record.filename,
      status: record.status,
      bytes: record.bytes ?? 0,
      totalBytes: total,
      progress:
        record.status === "completed"
          ? 100
          : progressOf(record.bytes ?? 0, total),
      speed: record.speed ?? 0,
      etaMs:
        record.speed > 0 && total
          ? Math.max(0, Math.round(((total - (record.bytes ?? 0)) / record.speed) * 1000))
          : null,
      ...(record.error ? { error: record.error } : {}),
      ...(record.format ? { format: record.format } : {}),
      ...(record.fileSize ? { fileSize: record.fileSize } : {}),
      ...(record.downloadedAt ? { downloadedAt: record.downloadedAt } : {}),
      metadata: record.metadata ?? {
        title: "",
        artist: "",
        licenseUrl: "",
        attribution: "",
        provider: "jamendo",
      },
    };
  }

  #changed() {
    try {
      this.onChanged();
    } catch {
      // A missing window must never interrupt a download.
    }
  }

  list() {
    const rank = {
      downloading: 0,
      validating: 1,
      queued: 2,
      failed: 3,
      cancelled: 4,
      completed: 5,
    };
    return [...this.records.values()]
      .sort(
        (a, b) =>
          (rank[a.status] ?? 9) - (rank[b.status] ?? 9) ||
          (b.downloadedAt ?? 0) - (a.downloadedAt ?? 0),
      )
      .map((record) => this.#snapshot(record));
  }

  async start(rawRequest) {
    await this.init();
    const request = validateDownloadRequest(rawRequest);
    const duplicate = [...this.records.values()].find(
      (record) => record.trackId === request.trackId,
    );
    if (duplicate) return { record: this.#snapshot(duplicate) };

    const id = crypto.randomUUID();
    const hash = hashTrackId(request.trackId);
    const stem = cleanStem(request.filename);
    const record = {
      id,
      trackId: request.trackId,
      filename: safeFilename(stem, "mp3", `track-${id}`),
      status: "queued",
      bytes: 0,
      totalBytes: null,
      speed: 0,
      error: undefined,
      format: undefined,
      fileSize: 0,
      downloadedAt: undefined,
      metadata: {
        title: request.title,
        artist: request.artist,
        ...(request.album ? { album: request.album } : {}),
        ...(request.artworkUrl ? { artworkUrl: request.artworkUrl } : {}),
        ...(request.durationMs !== undefined
          ? { durationMs: request.durationMs }
          : {}),
        licenseUrl: request.licenseUrl,
        attribution: request.attribution,
        provider: request.provider,
      },
      request,
      hash,
      partName: `${hash}.part`,
      fileName: undefined,
    };
    this.records.set(id, record);
    await this.#save();
    this.#changed();
    void this.#pump();
    return { record: this.#snapshot(record) };
  }

  async cancel(id) {
    await this.init();
    const record = this.records.get(id);
    if (!record) return;
    if (record.status === "completed") return;
    record.status = "cancelled";
    record.error = undefined;
    record.bytes = 0;
    record.speed = 0;
    const controller = this.active.get(id);
    controller?.abort();
    // A running transfer owns its partial file and removes it after the abort
    // unwinds; deleting it here as well races the worker on Windows. Wait for
    // that cleanup before answering so the caller can't observe a half-cancel.
    await this.runs.get(id)?.catch(() => undefined);
    if (!controller && isSafeStoredName(record.partName)) {
      await fs.rm(path.join(this.root, record.partName), { force: true });
    }
    await this.#save();
    this.#changed();
  }

  async retry(id) {
    await this.init();
    const record = this.records.get(id);
    if (!record) return;
    if (record.status !== "failed" && record.status !== "cancelled") return;
    record.status = "queued";
    record.error = undefined;
    record.speed = 0;
    await this.#save();
    this.#changed();
    void this.#pump();
  }

  async remove(id) {
    await this.init();
    const record = this.records.get(id);
    if (!record) return { removed: false };
    this.active.get(id)?.abort();
    this.active.delete(id);
    const paths = [record.fileName, record.partName, record.artworkName]
      .filter((name) => isSafeStoredName(name))
      .map((name) => path.join(this.root, name));
    await Promise.all(paths.map((file) => fs.rm(file, { force: true })));
    this.records.delete(id);
    await this.#save();
    this.#changed();
    return { removed: true };
  }

  async getPlaybackUrl(trackId) {
    await this.init();
    const record = this.#completedByTrack(trackId);
    return {
      url: record
        ? `synq-media://track/${encodeURIComponent(record.trackId)}`
        : null,
    };
  }

  async getArtworkUrl(trackId) {
    await this.init();
    const record = this.#completedByTrack(trackId);
    if (!record?.artworkName) return { url: null };
    try {
      const stat = await fs.stat(path.join(this.root, record.artworkName));
      return {
        url:
          stat.isFile() && stat.size > 0
            ? `synq-media://artwork/${encodeURIComponent(record.trackId)}`
            : null,
      };
    } catch {
      return { url: null };
    }
  }

  async getStorage() {
    await this.init();
    let usedBytes = 0;
    let fileCount = 0;
    for (const record of this.records.values()) {
      if (record.status === "completed" && record.fileSize > 0) {
        usedBytes += record.fileSize;
        fileCount += 1;
      } else if (record.bytes > 0) {
        usedBytes += record.bytes;
      }
    }
    let availableBytes = null;
    try {
      const stat = await fs.statfs(this.root);
      availableBytes = Math.max(0, Number(stat.bavail) * Number(stat.bsize));
    } catch {
      // Older Node/electron builds may not expose statfs; null is honest.
    }
    return { usedBytes, fileCount, availableBytes, directory: this.root };
  }

  #completedByTrack(trackId) {
    return (
      [...this.records.values()].find(
        (record) =>
          record.trackId === trackId &&
          record.status === "completed" &&
          isSafeStoredName(record.fileName),
      ) ?? null
    );
  }

  async #pump() {
    await this.init();
    while (this.running < MAX_ACTIVE) {
      const next = [...this.records.values()].find(
        (record) => record.status === "queued" && !this.active.has(record.id),
      );
      if (!next) return;
      this.running += 1;
      const controller = new AbortController();
      this.active.set(next.id, controller);
      const work = this.#run(next, controller);
      this.runs.set(next.id, work);
      void work
        .catch((error) => {
          console.error("[synq] download worker failed:", error);
        })
        .finally(() => {
          this.running -= 1;
          this.runs.delete(next.id);
          this.active.delete(next.id);
          setImmediate(() => this.#pump());
        });
    }
  }

  async #run(record, controller) {
    const partPath = path.join(this.root, record.partName);
    record.status = "downloading";
    record.error = undefined;
    record.bytes = 0;
    record.speed = 0;
    await this.#save();
    this.#changed();

    try {
      let existing = 0;
      try {
        existing = (await fs.stat(partPath)).size;
      } catch {
        existing = 0;
      }
      const headers = {
        Accept: "audio/*, application/octet-stream;q=0.8",
        "User-Agent": `SYNQ/${this.appVersion} (Electron offline downloads)`,
      };
      if (existing > 0) headers.Range = `bytes=${existing}-`;
      const response = await this.fetch(record.request.downloadUrl, {
        headers,
        redirect: "follow",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`The source returned HTTP ${response.status}.`);
      }
      const finalUrl = response.url || record.request.downloadUrl;
      if (!/^https:\/\//i.test(finalUrl)) {
        throw new Error("The download redirected to a non-HTTPS URL.");
      }
      if (!isAllowedContentType(response.headers.get("content-type") ?? "")) {
        throw new Error("The source did not return an audio file.");
      }

      const isResume = existing > 0 && response.status === 206;
      if (existing > 0 && !isResume) existing = 0;
      const total =
        contentRangeTotal(response.headers.get("content-range")) ??
        (existing + Number(response.headers.get("content-length") ?? 0) ||
          null);
      if (total !== null && total > MAX_FILE_BYTES) {
        throw new Error("The audio file exceeds SYNQ's 512 MB download limit.");
      }
      record.totalBytes = total;
      record.bytes = existing;
      const handle = await fs.open(partPath, isResume ? "a" : "w");
      const reader = response.body?.getReader();
      if (!reader) {
        await handle.close();
        throw new Error("The source returned an empty audio response.");
      }
      let head = Buffer.alloc(0);
      let lastTick = Date.now();
      let lastBytes = existing;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value?.length) continue;
          if (controller.signal.aborted) throw new Error("Download cancelled.");
          const chunk = Buffer.from(value);
          if (head.length < 16) {
            head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
          }
          if (record.bytes + chunk.length > MAX_FILE_BYTES) {
            throw new Error("The audio file exceeds SYNQ's 512 MB download limit.");
          }
          await handle.write(chunk);
          record.bytes += chunk.length;
          const now = Date.now();
          const elapsed = (now - lastTick) / 1000;
          if (elapsed >= 0.35) {
            const sample = (record.bytes - lastBytes) / elapsed;
            record.speed =
              record.speed === 0 ? sample : record.speed * 0.7 + sample * 0.3;
            lastTick = now;
            lastBytes = record.bytes;
            this.#changed();
          }
        }
      } finally {
        await handle.close();
        reader.releaseLock?.();
      }

      if (total !== null && record.bytes !== total) {
        throw new Error(
          `Incomplete download: ${record.bytes} of ${total} bytes received.`,
        );
      }
      if (record.bytes <= 0) {
        throw new Error("The source returned an empty audio file.");
      }
      if (head.length < 12) {
        const fh = await fs.open(partPath, "r");
        try {
          const probe = Buffer.alloc(16);
          await fh.read(probe, 0, 16, 0);
          head = probe;
        } finally {
          await fh.close();
        }
      }

      record.status = "validating";
      record.speed = 0;
      this.#changed();
      const format = detectAudioFormat(head);
      if (!format || !ALLOWED_FORMATS.has(format)) {
        await fs.rm(partPath, { force: true });
        throw new Error("The downloaded file is not a supported audio container.");
      }
      const finalName = `${record.hash}.${format}`;
      const finalPath = path.join(this.root, finalName);
      await fs.rm(finalPath, { force: true });
      await fs.rename(partPath, finalPath);
      record.fileName = finalName;
      record.format = format;
      record.fileSize = record.bytes;
      record.filename = safeFilename(
        cleanStem(record.filename),
        format,
        `track-${record.id}`,
      );
      record.downloadedAt = Date.now();
      record.error = undefined;
      record.speed = 0;
      record.totalBytes = record.bytes;

      if (record.request.artworkUrl) {
        record.artworkName = await this.#downloadArtwork(
          record,
          controller.signal,
        ).catch(() => undefined);
      }
      // Only announce success after optional artwork and the index write have
      // settled: a completed snapshot must always be a restorable download.
      record.status = "completed";
      await this.#save();
      this.#changed();
    } catch (error) {
      record.speed = 0;
      if (record.status === "cancelled" || controller.signal.aborted) {
        record.status = "cancelled";
        record.error = undefined;
        // A cancelled transfer keeps no bytes. `cancel()` already zeroes the
        // counter, but a chunk that was mid-`write()` when the abort landed is
        // added afterwards — and its partial file is deleted below, so a
        // non-zero count would advertise progress that no longer exists.
        record.bytes = 0;
        record.speed = 0;
      } else {
        record.status = "failed";
        record.error =
          error instanceof Error ? error.message : "The download failed.";
      }
      if (record.status === "cancelled") {
        try {
          await fs.rm(partPath, { force: true });
        } catch {
          // Windows can report a transient error if cancellation already
          // removed the partial file; the record itself is still cancelled.
        }
      }
      await this.#save();
      this.#changed();
    }
  }

  async #downloadArtwork(record, signal) {
    if (!/^https:\/\//i.test(record.request.artworkUrl ?? "")) return undefined;
    const response = await this.fetch(record.request.artworkUrl, {
      headers: {
        Accept: "image/jpeg, image/png",
        "User-Agent": `SYNQ/${this.appVersion} (Electron offline downloads)`,
      },
      redirect: "follow",
      signal,
    });
    if (!response.ok) return undefined;
    if (response.url && !/^https:\/\//i.test(response.url)) return undefined;
    const type = (response.headers.get("content-type") ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (type !== "image/jpeg" && type !== "image/png") return undefined;
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_ARTWORK_BYTES) return undefined;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length <= 0 || bytes.length > MAX_ARTWORK_BYTES) return undefined;
    const extension = detectImageExtension(bytes);
    if (!extension) return undefined;
    const name = `${record.hash}.cover.${extension}`;
    await fs.writeFile(path.join(this.root, name), bytes, { mode: 0o600 });
    return name;
  }

  /**
   * Translate a tokenised media URL to a file. Only records already in the
   * completed index can be served; no URL path becomes a filesystem path.
   */
  async resolveMedia(requestUrl) {
    await this.init();
    const url = new URL(requestUrl);
    const kind = url.hostname;
    const trackId = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    const record = this.#completedByTrack(trackId);
    if (!record) return null;
    if (kind === "track") {
      if (!isSafeStoredName(record.fileName)) return null;
      return {
        file: path.join(this.root, record.fileName),
        mime: MIME_BY_FORMAT[record.format] ?? "application/octet-stream",
      };
    }
    if (
      kind === "artwork" &&
      record.artworkName &&
      isSafeStoredName(record.artworkName)
    ) {
      return {
        file: path.join(this.root, record.artworkName),
        mime: record.artworkName.endsWith(".png")
          ? "image/png"
          : "image/jpeg",
      };
    }
    return null;
  }
}

function parseRange(header, size) {
  if (typeof header !== "string") return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : null;
  let end = match[2] ? Number(match[2]) : null;
  if (start === null && end === null) return null;
  if (start === null) {
    const length = end;
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    end = end === null ? size - 1 : Math.min(end, size - 1);
  }
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    start > end ||
    start >= size
  ) {
    return { invalid: true };
  }
  return { start, end };
}

async function respondWithMediaFile(request, resolved) {
  const stat = await fs.stat(resolved.file);
  if (!stat.isFile() || stat.size <= 0) {
    return new Response("Not found", { status: 404 });
  }
  const headers = {
    "Content-Type": resolved.mime,
    "Cache-Control": "no-store",
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": "*",
  };
  const range = parseRange(request.headers.get("range"), stat.size);
  if (range?.invalid) {
    return new Response("Range not satisfiable", {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${stat.size}` },
    });
  }
  if (range) {
    return new Response(
      Readable.toWeb(
        require("node:fs").createReadStream(resolved.file, {
          start: range.start,
          end: range.end,
        }),
      ),
      {
        status: 206,
        headers: {
          ...headers,
          "Content-Length": String(range.end - range.start + 1),
          "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`,
        },
      },
    );
  }
  return new Response(
    Readable.toWeb(require("node:fs").createReadStream(resolved.file)),
    {
      status: 200,
      headers: { ...headers, "Content-Length": String(stat.size) },
    },
  );
}

async function handleMediaRequest(store, request) {
  try {
    const resolved = await store.resolveMedia(request.url);
    if (!resolved) return new Response("Not found", { status: 404 });
    return await respondWithMediaFile(request, resolved);
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

module.exports = {
  NativeDownloadStore,
  validateDownloadRequest,
  detectAudioFormat,
  detectImageExtension,
  safeFilename,
  cleanStem,
  isSafeStoredName,
  parseRange,
  handleMediaRequest,
  MAX_FILE_BYTES,
};
