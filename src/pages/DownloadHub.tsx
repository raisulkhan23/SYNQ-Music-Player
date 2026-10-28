import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Download,
  HardDriveDownload,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  Trash2,
  WifiOff,
  X,
} from "lucide-react";
import { useAction } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { cn } from "@/lib/utils";

import { usePlayerStore } from "@/store/player";
import { noteTrackDownloaded, noteTrackRemoved } from "@/store/player";
import { getDownloadManager } from "@/lib/downloads";
import { requestAuthorizedDownload } from "@/lib/authorizedDownload";
import { installDownloadAdapter } from "@/lib/installDownloadAdapter";
import { downloadAvailability, downloadTargetId } from "@/lib/downloadAuth";
import {
  listStoredDownloads,
  localAudioUrl,
  opfsSupported,
  readDownloadedTracks,
  removeDownloadedTrack,
  type DownloadedTrack,
  type StoredFile,
} from "@/lib/opfsSink";
import type { Playable } from "@/lib/playable";
import type { DownloadRecord } from "@/lib/downloadManager";

// The card owns its own "not the desktop shell" check and returns null on web
// and Android, so the hub does not need to duplicate that decision here (it
// used to gate on the download bridge in two different places, with slightly
// different conditions).
import { DesktopDownloadStatusCard } from "@/components/download-hub";

/** Human-readable byte count. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatEta(ms: number | null): string {
  if (ms === null) return "";
  if (ms <= 0) return "done";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s left`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s left`;
}

const STATUS_STYLE: Record<DownloadRecord["status"], string> = {
  queued: "text-muted-foreground",
  downloading: "text-[rgb(var(--tint))]",
  paused: "text-amber-300/80",
  completed: "text-emerald-300/80",
  failed: "text-red-300/80",
  cancelled: "text-muted-foreground/60",
};

const STATUS_LABEL: Record<DownloadRecord["status"], string> = {
  queued: "Queued",
  downloading: "Downloading",
  paused: "Paused",
  completed: "On this device",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** A YouTube id is 11 URL-safe base64 characters; anything else is opaque. */
function isVideoId(id: string): boolean {
  return /^[A-Za-z0-9_-]{11}$/.test(id);
}

export default function DownloadHub() {
  const current = usePlayerStore((s) => s.current);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const isDesktop = window.synqDesktop?.isDesktop === true;
  const [records, setRecords] = useState<DownloadRecord[]>([]);
  const [stored, setStored] = useState<DownloadedTrack[]>([]);
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [quota, setQuota] = useState<{ usage: number; quota: number } | null>(
    null,
  );
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [starting, setStarting] = useState(false);
  const [onlySaved, setOnlySaved] = useState(false);

  const authorizeDownload = useAction(api.downloads.authorizeDownload);

  useEffect(() => {
    installDownloadAdapter();
  }, []);

  const refresh = useCallback(async () => {
    setRecords(getDownloadManager().list());
    if (!opfsSupported()) return;
    const [library, entries] = await Promise.all([
      readDownloadedTracks(),
      listStoredDownloads(),
    ]);
    setStored(library);
    setFiles(entries);
    // Real bytes the browser can see, not a sum we invented. `estimate()` is
    // not available everywhere, so a null reading is reported as unavailable
    // rather than as zero.
    try {
      const estimate = await navigator.storage?.estimate?.();
      if (
        estimate &&
        typeof estimate.usage === "number" &&
        typeof estimate.quota === "number"
      ) {
        setQuota({ usage: estimate.usage, quota: estimate.quota });
      }
    } catch {
      setQuota(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 1_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);

  // A finished transfer only announces itself once, and only after its
  // manifest row exists (the adapter writes it as part of commit).
  const announced = useRef(new Set<string>());
  useEffect(() => {
    for (const record of records) {
      if (record.status === "completed" && !announced.current.has(record.id)) {
        announced.current.add(record.id);
        noteTrackDownloaded(record.trackId);
      }
    }
  }, [records]);

  const savedTrackIds = useMemo(() => new Set(stored.map((t) => t.id)), [stored]);

  const downloadCurrent = async () => {
    if (!current || starting) return;
    const target = downloadTargetId(current.id, current.jamendoId);
    if (!target) {
      toast.error("Downloads aren't available for this track.");
      return;
    }
    setStarting(true);
    try {
      const result = await requestAuthorizedDownload(authorizeDownload, target, {
        // Stored under the playable's id, so playback finds it again.
        storageKey: current.id,
        meta: {
          title: current.title,
          artistName: current.artistName,
          albumName: current.albumName,
          coverUrl: current.coverUrl,
          duration: current.duration,
        },
      });
      if (result.started) {
        toast.success("Download started", {
          description: "It'll appear here when the file is complete.",
        });
      } else if (result.refusal.retryable) {
        toast.error(result.refusal.message, {
          description: "Try again in a moment.",
        });
      } else {
        toast.error(result.refusal.message);
      }
      void refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Download failed");
    } finally {
      setStarting(false);
    }
  };

  const playStored = async (entry: DownloadedTrack) => {
    const url = await localAudioUrl(entry.id);
    if (!url) {
      // The row survived but the file did not (cleared storage, a crash
      // mid-delete). Say so and drop the row instead of failing silently.
      toast.error("That file is missing from this device", {
        description: "Download it again to listen offline.",
      });
      await removeDownloadedTrack(entry.id);
      noteTrackRemoved(entry.id);
      void refresh();
      return;
    }
    noteTrackDownloaded(entry.id);
    const toPlayable = (item: DownloadedTrack, audioUrl: string): Playable => ({
      id: item.id,
      title: item.title || item.filename,
      artistName: item.artistName || "Unknown artist",
      albumName: item.albumName || "",
      coverUrl: item.coverUrl || "",
      audioUrl,
      duration: item.duration || 0,
      source: "youtube",
      // Kept when the id really is a video id: it is what the queue's resume
      // key and the local-file lookup both use. A `jamendo:` id has no video,
      // and its `audioUrl` above is the file itself.
      ...(isVideoId(item.id) ? { youtubeId: item.id } : {}),
    });
    const order = [
      entry,
      ...stored.filter((item) => item.id !== entry.id && isVideoId(item.id)),
    ];
    playTrack(
      toPlayable(entry, url),
      order.map((item) => toPlayable(item, item.id === entry.id ? url : "")),
    );
  };

  const removeStored = async (entry: DownloadedTrack) => {
    const managerRecord = records.find((r) => r.trackId === entry.id);
    if (managerRecord) {
      await getDownloadManager().remove(managerRecord.id);
    } else {
      await removeDownloadedTrack(entry.id);
    }
    noteTrackRemoved(entry.id);
    if (managerRecord) announced.current.delete(managerRecord.id);
    void refresh();
  };

  const act = (fn: () => void) => {
    try {
      fn();
    } catch {
      /* manager calls cannot throw here */
    }
    setRecords(getDownloadManager().list());
  };

  const stats = useMemo(() => {
    const savedBytes = stored.reduce((n, entry) => n + entry.size, 0);
    return {
      total: records.length,
      active: records.filter((r) => r.status === "downloading").length,
      bytes: records.reduce((n, r) => n + r.downloadedBytes, 0),
      savedBytes,
    };
  }, [records, stored]);

  const eligibility = current
    ? downloadAvailability(current.id, current.jamendoId)
    : null;
  const visibleRecords = onlySaved
    ? records.filter((r) => savedTrackIds.has(r.trackId))
    : records;

  return (
    <section className="flex flex-col gap-8">
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
          Downloads
        </h1>
        <p className="text-sm text-muted-foreground">
          Music saved to this device, and what SYNQ is allowed to save.
        </p>
      </header>

      {!online && (
        <div className="flex items-center gap-3 rounded-2xl border border-amber-500/25 bg-amber-500/[0.07] px-4 py-3">
          <WifiOff className="size-4 shrink-0 text-amber-300" />
          <p className="text-sm text-amber-100/90">
            You are offline. Everything under “On this device” still plays;
            nothing else can be downloaded right now.
          </p>
        </div>
      )}

      <StorageSummary
        quota={quota}
        savedBytes={stats.savedBytes}
        tracks={stored.length}
        supported={opfsSupported()}
      />

      <DesktopDownloadStatusCard />

      <section>
        <h2 className="mb-3 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
          Now playing
        </h2>
        {current ? (
          <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3.5">
            {current.coverUrl ? (
              <img
                src={current.coverUrl}
                alt=""
                className="size-12 shrink-0 rounded-lg object-cover ring-1 ring-white/10"
              />
            ) : null}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{current.title}</p>
              <p className="truncate text-xs text-muted-foreground">
                {current.artistName}
              </p>
              <p className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                {eligibility?.allowed ? (
                  <>
                    <ShieldCheck className="size-3 text-emerald-300/80" />
                    Licensed for download
                  </>
                ) : (
                  <>
                    <WifiOff className="size-3" />
                    Streaming only — the artist hasn&rsquo;t released this for
                    download
                  </>
                )}
              </p>
            </div>
            {eligibility?.allowed ? (
              <button
                type="button"
                onClick={() => void downloadCurrent()}
                disabled={!opfsSupported() || starting}
                title={
                  opfsSupported()
                    ? "Save this track to this device"
                    : "This browser has no filesystem for downloads"
                }
                className={cn(
                  "flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
                  opfsSupported()
                    ? "border-white/15 bg-white/[0.06] hover:border-[rgb(var(--tint)/0.6)] hover:bg-[rgb(var(--tint)/0.12)] hover:text-[rgb(var(--tint))]"
                    : "cursor-not-allowed border-white/10 bg-white/[0.04] text-muted-foreground/50",
                )}
              >
                {starting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Download className="size-3.5" />
                )}
                {opfsSupported()
                  ? starting
                    ? "Starting…"
                    : "Download"
                  : "Unavailable"}
              </button>
            ) : null}

            {isDesktop && !opfsSupported() && (
              <p className="mt-2 text-xs text-muted-foreground">
                Desktop downloads use a separate shell service and do not rely on this browser&rsquo;s filesystem.
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Nothing playing right now.
          </p>
        )}
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
            On this device
          </h2>
          {stored.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {stored.length} track{stored.length === 1 ? "" : "s"} ·{" "}
              {formatBytes(stats.savedBytes)}
            </p>
          )}
        </div>

        {!opfsSupported() ? (
          <p className="rounded-2xl border border-dashed border-white/10 px-4 py-5 text-sm text-muted-foreground">
            This browser has no private filesystem, so SYNQ can&rsquo;t keep
            music offline here. Installed Chrome, Edge, Firefox and Safari all
            support it; a private window usually does not.
          </p>
        ) : stored.length === 0 ? (
          <div className="flex flex-col items-start gap-3 rounded-2xl border border-dashed border-white/10 px-6 py-8">
            <HardDriveDownload className="size-7 text-muted-foreground/40" />
            <p className="text-sm font-medium">No music saved yet</p>
            <p className="max-w-prose text-sm text-muted-foreground">
              Downloads are limited to tracks whose artist released the audio
              for download — Creative Commons releases found under “Independent
              &amp; Creative Commons” in search. Open a track and choose{" "}
              <span className="text-foreground">Download</span>, or use the
              button above while one is playing.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {stored.map((entry) => (
              <li
                key={entry.id}
                className="flex items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.03] px-4 py-3"
              >
                {entry.coverUrl ? (
                  <img
                    src={entry.coverUrl}
                    alt=""
                    className="size-10 shrink-0 rounded-md object-cover ring-1 ring-white/10"
                    loading="lazy"
                  />
                ) : (
                  <span className="grid size-10 shrink-0 place-items-center rounded-md bg-white/[0.05]">
                    <Check className="size-4 text-emerald-300/70" />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {entry.title || entry.filename}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {entry.artistName || "Unknown artist"}
                    {entry.size ? ` · ${formatBytes(entry.size)}` : ""}
                    {entry.completedAt
                      ? ` · ${new Date(entry.completedAt).toLocaleDateString()}`
                      : ""}
                  </p>
                  {entry.licenseUrl ? (
                    <a
                      href={entry.licenseUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="text-[10px] text-muted-foreground/80 underline-offset-2 hover:text-foreground hover:underline"
                      title={entry.attribution}
                    >
                      Licence&nbsp;·&nbsp;{entry.attribution || "Creative Commons"}
                    </a>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    aria-label={`Play ${entry.title || entry.filename} from this device`}
                    onClick={() => void playStored(entry)}
                    className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
                  >
                    <Play className="size-4" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${entry.title || entry.filename}`}
                    onClick={() => void removeStored(entry)}
                    className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {stored.length === 0 && files.length > 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {files.length} file{files.length === 1 ? "" : "s"} from an older
            version {files.length === 1 ? "is" : "are"} on disk without saved
            details, so {files.length === 1 ? "it is" : "they are"} not listed
            above. Download the track again to restore it.
          </p>
        ) : null}
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
            Transfers
          </h2>
          <div className="flex items-center gap-2">
            {records.length > 0 ? (
              <div className="flex rounded-full border border-white/10 p-0.5 text-[11px]">
                {[
                  { id: false, label: "All" },
                  { id: true, label: "On this device" },
                ].map((option) => (
                  <button
                    key={String(option.id)}
                    type="button"
                    onClick={() => setOnlySaved(option.id)}
                    aria-pressed={onlySaved === option.id}
                    className={cn(
                      "rounded-full px-2.5 py-1 font-medium transition-colors",
                      onlySaved === option.id
                        ? "bg-white/[0.12] text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : null}
            {stats.active > 0 ? (
              <p className="text-xs text-[rgb(var(--tint))]">
                {stats.active} active
              </p>
            ) : null}
          </div>
        </div>

        {visibleRecords.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {onlySaved
              ? "No transfers have finished on this device yet."
              : "No transfers yet. Start one from a licensed track."}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {visibleRecords.map((record) => (
              <li
                key={record.id}
                className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {savedTrackIds.has(record.trackId)
                        ? record.filename.replace(/\.[a-z0-9]+$/i, "")
                        : record.filename}
                    </p>
                    <p className={cn("text-xs", STATUS_STYLE[record.status])}>
                      {STATUS_LABEL[record.status]}
                      {record.status === "downloading" && record.speed > 0 && (
                        <> · {formatBytes(record.speed)}/s</>
                      )}
                      {record.status === "downloading" &&
                        formatEta(record.etaMs) && (
                          <> · {formatEta(record.etaMs)}</>
                        )}
                      {record.totalSize
                        ? ` · ${formatBytes(record.downloadedBytes)} of ${formatBytes(record.totalSize)}`
                        : ""}
                      {record.error && <> · {record.error}</>}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <TransferButton
                      status={record.status}
                      onPause={() => act(() => getDownloadManager().pause(record.id))}
                      onResume={() => act(() => getDownloadManager().retry(record.id))}
                      onCancel={() => act(() => getDownloadManager().cancel(record.id))}
                    />
                    <button
                      type="button"
                      aria-label={`Remove ${record.filename}`}
                      onClick={() =>
                        void getDownloadManager()
                          .remove(record.id)
                          .then(() => {
                            announced.current.delete(record.id);
                            noteTrackRemoved(record.trackId);
                            return refresh();
                          })
                      }
                      className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </div>
                <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.07]">
                  <div
                    className="h-full rounded-full bg-[rgb(var(--tint))] transition-[width] duration-300"
                    style={{ width: `${record.progress}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}

        {records.some((r) => r.status === "failed") ? (
          <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            A failed transfer keeps nothing on disk. Retry it, or start it
            again from the track — a partial file is never reported as a
            download.
          </p>
        ) : null}
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
            Cached for offline
          </h2>
        </div>
        <CachedSummary />
        <p className="mt-2 text-xs text-muted-foreground">
          Downloads are kept in their own storage and are never removed by
          cache cleanup. What&rsquo;s listed here is disposable app shell and
          artwork cache.
        </p>
      </section>
    </section>
  );
}

function StorageSummary({
  quota,
  savedBytes,
  tracks,
  supported,
}: {
  quota: { usage: number; quota: number } | null;
  savedBytes: number;
  tracks: number;
  supported: boolean;
}) {
  if (!supported) return null;
  return (
    <section className="rounded-2xl border border-white/[0.07] bg-white/[0.03] px-4 py-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
          Storage
        </h2>
        <p className="text-xs text-muted-foreground">
          Music · {formatBytes(savedBytes)} in {tracks} track
          {tracks === 1 ? "" : "s"}
        </p>
      </div>
      {quota ? (
        <>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
            <div
              className="h-full rounded-full bg-[rgb(var(--tint))]"
              style={{
                width: `${Math.min(
                  100,
                  Math.max(1, (quota.usage / Math.max(1, quota.quota)) * 100),
                )}%`,
              }}
            />
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {formatBytes(quota.usage)} used of {formatBytes(quota.quota)} the
            browser allows this site.
          </p>
        </>
      ) : (
        <p className="mt-1.5 text-xs text-muted-foreground">
          This browser doesn&rsquo;t report its storage quota.
        </p>
      )}
    </section>
  );
}

function TransferButton({
  status,
  onPause,
  onResume,
  onCancel,
}: {
  status: DownloadRecord["status"];
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
}) {
  const cls =
    "rounded-full p-2 transition-colors hover:bg-white/[0.06] hover:text-foreground";
  if (status === "downloading") {
    return (
      <button type="button" aria-label="Pause" onClick={onPause} className={cls}>
        <Pause className="size-4" />
      </button>
    );
  }
  if (status === "paused" || status === "failed") {
    return (
      <button
        type="button"
        aria-label={status === "failed" ? "Retry" : "Resume"}
        onClick={onResume}
        className={cls}
      >
        {status === "failed" ? (
          <RefreshCw className="size-4" />
        ) : (
          <Play className="size-4" />
        )}
      </button>
    );
  }
  if (status === "queued") {
    return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  }
  if (status === "completed") {
    return <Check className="size-4 text-emerald-300/80" />;
  }
  return (
    <button type="button" aria-label="Cancel" onClick={onCancel} className={cls}>
      <X className="size-4" />
    </button>
  );
}

/** What the service worker cache actually holds — disposable by design. */
function CachedSummary() {
  const [entries, setEntries] = useState<{ name: string; count: number }[]>([]);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const read = async () => {
      if (typeof caches === "undefined") return;
      setSupported(true);
      try {
        const names = await caches.keys();
        const rows = await Promise.all(
          names.map(async (name) => ({
            name,
            count: (await (await caches.open(name)).keys()).length,
          })),
        );
        if (!cancelled) setEntries(rows);
      } catch {
        /* storage refused → unsupported */
      }
    };
    void read();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!supported) {
    return (
      <p className="text-sm text-muted-foreground">
        Couldn&rsquo;t read cached content for this page.
      </p>
    );
  }

  if (entries.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing cached for offline use yet.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {entries.map((entry) => (
        <li
          key={entry.name}
          className="flex items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.03] px-4 py-3"
        >
          <Check className="size-4 shrink-0 text-emerald-300/70" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{entry.name}</p>
            <p className="text-xs text-muted-foreground">
              {entry.count} request{entry.count === 1 ? "" : "s"}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
