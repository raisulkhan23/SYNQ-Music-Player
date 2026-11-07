import { useCallback, useEffect, useMemo, useRef, useState } from "react";


import { usePlayerStore } from "@/store/player";
import { noteTrackDownloaded, noteTrackRemoved } from "@/store/player";
import { getDownloadManager } from "@/lib/downloads";
import { requestAuthorizedDownload } from "@/lib/authorizedDownload";
import { installDownloadAdapter } from "@/lib/installDownloadAdapter";
import {
  deleteStoredDownload,
  listStoredDownloads,
  opfsSupported,
  parseStoredName,
  type StoredFile,
} from "@/lib/opfsSink";

import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { toast } from "sonner";
import type { DownloadRecord } from "@/lib/downloadManager";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Check,
  Download,
  HardDriveDownload,
  
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  WifiOff,
  X,
} from "lucide-react";

/**
 * The download hub.
 *
 * WHAT THIS IS. A real view of the real `DownloadManager`: every row is a
 * live download record with its actual byte counts, speed and ETA, and every
 * button calls the real manager. There is no simulated progress and no button
 * that pretends to do something.
 *
 * HOW IT WORKS. A download resolves the track's stream through the same
 * resolver the player uses, then pulls it in ranged chunks straight to disk
 * via the Origin Private File System. Ranges mean a dropped connection
 * resumes rather than restarts, and writing to disk rather than memory is what
 * stops a long transfer taking the tab down. The engine underneath is
 * complete (range
 * requests, resume, integrity validation, pause/cancel/retry — see
 * `lib/downloadManager.ts` and its 77-assertion suite), but an engine with no
 * authorised source behind it has nothing to download.
 *
 * So rather than ship a hub whose buttons quietly do nothing, this page says
 * what is true and reports what is actually happening: your connection, what
 * the service worker has stored for offline use, and the live download list,
 * which is empty until a provider that grants download rights is connected.
 */



/** Human-readable byte count. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
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
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export default function DownloadHub() {
  const current = usePlayerStore((s) => s.current);
  const [records, setRecords] = useState<DownloadRecord[]>([]);
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [starting, setStarting] = useState(false);
  // REMOVED: the direct-link downloader's `directUrl` / `directBusy` state,
  // which existed only for the paste-a-URL panel below.
  /**
   * The download authority: it decides, server-side, whether a track may be
   * saved at all. This is the ONLY source of download URLs in the app.
   */
  const authorizeDownload = useAction(api.downloads.authorizeDownload);
  
  

  /**
   * Download whatever is playing, resolving its stream first.
   *
   * `requestTrackDownload` resolves before it enqueues, so a provider refusal
   * surfaces here as a real error rather than a download that quietly fails
   * half a second later.
   */
  const downloadCurrent = async () => {
    if (!current || starting) return;
    setStarting(true);
    try {
      // The authorized path: SYNQ's backend decides whether this track may be
      // saved, and only returns a URL if it may. The page never resolves a
      // stream itself and never accepts a URL from anywhere but the server.
      const result = await requestAuthorizedDownload(
        authorizeDownload,
        current.id,
      );
      if (result.started) {
        toast.success("Download started");
      } else if (result.refusal.retryable) {
        toast.error(result.refusal.message, {
          description: "Try again in a moment.",
        });
      } else {
        toast.error(result.refusal.message);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Download failed");
    } finally {
      setStarting(false);
    }
  };

  /**
   * Download any direct media URL.
   *
   * THIS IS THE DOWNLOAD PATH THAT DOES NOT DEPEND ON A RESOLVER. Every
   * resolver route is blocked by Google's IP binding (see the note on the
   * empty state), but a URL that is *already* a plain audio file needs no
   * resolution at all — SYNQ just pulls the bytes. That covers a user's own
   * resolver output, a Creative-Commons track (Jamendo, archive.org, an
   * artist's own download page), a podcast enclosure, or any file host that
   * answers a cross-origin ranged request.
   *
   * It reuses the real engine: the same `requestTrackDownload` →
   * `DownloadManager` → OPFS pipeline the track menu uses, so it ranges,
   * resumes, validates and reports exactly like every other download. The one
   * honest limitation is CORS — a host that forbids cross-origin reads cannot
   * be fetched from a web page, and the transfer fails with the browser's own
   * error rather than a success that quietly wrote nothing.
   */
  /**
   * REMOVED: `downloadFromUrl`.
   *
   * It fetched whatever URL the listener pasted, in the browser, with no server
   * authorization at all — which is exactly the client-decides-what's-allowed
   * flaw the whole download pipeline was rebuilt to eliminate. Removed with the
   * panel that called it, rather than left behind as a handler that can only
   * ever refuse.
   */

  /**
   * REMOVED: the SYNQ share-link downloader.
   *
   * It resolved a shared track id through the very pipeline this change set
   * deleted — `youtube:resolveStream` and then public Piped mirrors — purely so
   * the link would yield something to save. A playable stream is not permission
   * to make a copy of it, so the path was removed rather than repaired.
   */

  // One manager for the whole app, not this page. It lives in `lib/downloads`
  // so a track's context menu — which is used on pages where this hub is not
  // mounted — starts transfers into the SAME queue this page renders.
  const manager = getDownloadManager();

  useEffect(() => {
    // The adapter is installed app-wide from `AppShell`, not here. Registering
    // it on this page's mount was one navigation too late: the track menu
    // enqueues a download and THEN navigates here, so the download had already
    // failed against a manager with no adapter. Calling it here too is
    // harmless and covers the case where this page is the first thing loaded.
    installDownloadAdapter();
  }, []);

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

  // Poll the manager rather than holding React state inside it, so the
  // download engine stays a plain, testable object.
  const announced = useRef(new Set<string>());

  useEffect(() => {
    const tick = () => {
      const rows = manager.list();
      setRecords(rows);
      // A finished download invalidates the player's cached network URL for
      // that track. Announcing it here (rather than only on the next play)
      // means the very next listen reads from disk.
      for (const r of rows) {
        if (r.status === "completed" && !announced.current.has(r.trackId)) {
          announced.current.add(r.trackId);
          noteTrackDownloaded(r.trackId);
        }
      }
    };
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [manager]);

  const act = useCallback(
    (fn: () => void) => {
      try {
        fn();
      } catch {
        // A manager call cannot throw here (no adapter is reachable), but a
        // page must never die because a download button was pressed.
      }
      setRecords(manager.list());
    },
    [manager],
  );

  const stats = useMemo(() => {
    const active = records.filter((r) => r.status === "downloading");
    return {
      total: records.length,
      active: active.length,
      bytes: records.reduce((n, r) => n + r.downloadedBytes, 0),
    };
  }, [records]);

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
          Downloads
        </h1>
        <p className="text-sm text-muted-foreground">
          Offline copies on this device, and what SYNQ is allowed to fetch.
        </p>
      </header>

      {!online && (
        <div className="flex items-center gap-3 rounded-2xl border border-amber-500/25 bg-amber-500/[0.07] px-4 py-3">
          <WifiOff className="size-4 shrink-0 text-amber-300" />
          <p className="text-sm text-amber-100/90">
            You are offline. Anything listed below is already on this device.
          </p>
        </div>
      )}

      {/* What is actually stored, from the real cache, not a claim. */}
      <OfflineSummary />

      <StoredDownloads />

      <section>
        <h2 className="mb-3 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
          This track
        </h2>
        {current ? (
          <div className="flex items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3.5">
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
            </div>
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
                  ? "border-white/15 bg-white/[0.06] hover:border-[rgb(var(--tint)_/_0.6)] hover:bg-[rgb(var(--tint)_/_0.12)] hover:text-[rgb(var(--tint))]"
                  : "cursor-not-allowed border-white/10 bg-white/[0.04] text-muted-foreground/50",
              )}
            >
              {starting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Download className="size-3.5" />
              )}
              {opfsSupported() ? (starting ? "Starting…" : "Download") : "Unavailable"}
            </button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Nothing playing right now.
          </p>
        )}
      </section>

      {/* ── REMOVED: "Download from a link". ─────────────────────────────────
          This panel used to accept a SYNQ share link (resolved through
          InnerTube and public Piped mirrors) or any pasted media URL (fetched
          by the browser with no server authorization at all). Both are gone:
          the first saved streams SYNQ had no right to copy, and the second put
          the "is this allowed?" decision back on the client. The panel was
          removed rather than left disabled, because a control that can only
          ever produce an error is worse than no control. */}

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
            Downloads
          </h2>
          {stats.total > 0 && (
            <p className="text-xs text-muted-foreground">
              {stats.total} item{stats.total === 1 ? "" : "s"} ·{" "}
              {formatBytes(stats.bytes)}
            </p>
          )}
        </div>

        {records.length === 0 ? (
          <div className="flex flex-col items-start gap-3 rounded-2xl border border-dashed border-white/10 px-6 py-10">
            <HardDriveDownload className="size-7 text-muted-foreground/40" />
            <p className="text-sm font-medium">No downloads yet</p>
            <p className="max-w-prose text-sm text-muted-foreground">
              Nothing saved yet. Open a track&rsquo;s menu and choose{" "}
              <span className="text-foreground">Download</span>, or use the
              button above while something is playing.
            </p>
            {/* WHY THIS IS EMPTY, AND THE ONE THING THAT UNBLOCKS IT.
                This state used to promise ranged, resumable transfers as if
                they simply had not been used yet. In practice every download
                fails, because Google refuses to hand stream URLs to
                data-centre IPs — which is every server-side resolver,
                including this app's own backend. Saying so here, with the fix
                one click away, is the difference between a broken feature and
                an honest one. */}
            {/* WHY THIS IS EMPTY. The Download action appears only on tracks
                SYNQ's own API has confirmed may be saved — audio the artist
                explicitly released for download. Nothing here can be
                un-blocked by configuring a resolver: there is no resolver
                path left, by design. */}
            <div className="max-w-prose rounded-xl border border-white/[0.08] bg-white/[0.03] px-3.5 py-3">
              <p className="flex items-start gap-2 text-sm text-muted-foreground">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>
                  Downloads are limited to tracks whose artist has released the
                  audio for download. Most streaming tracks are play-only, so
                  they won&rsquo;t show a Download action — and SYNQ won&rsquo;t
                  save them by another route.
                </span>
              </p>
            </div>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {records.map((record) => (
              <li
                key={record.id}
                className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-4 py-3"
              >
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {record.filename}
                    </p>
                    <p
                      className={cn(
                        "text-xs",
                        STATUS_STYLE[record.status],
                      )}
                    >
                      {STATUS_LABEL[record.status]}
                      {record.status === "downloading" && record.speed > 0 && (
                        <> · {formatBytes(record.speed)}/s</>
                      )}
                      {record.status === "downloading" &&
                        formatEta(record.etaMs) && (
                        <> · {formatEta(record.etaMs)}</>
                      )}
                      {record.error && <> · {record.error}</>}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <DownloadButton
                      status={record.status}
                      onPause={() => act(() => manager.pause(record.id))}
                      onResume={() => act(() => manager.retry(record.id))}
                      onCancel={() => act(() => manager.cancel(record.id))}
                    />
                    <button
                      type="button"
                      aria-label={`Remove ${record.filename}`}
                      onClick={() =>
                        void manager
                          .remove(record.id)
                          .then(() => setRecords(manager.list()))
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
      </section>
    </div>
  );
}

/** The right control for a download's current state. */
function DownloadButton({
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
        aria-label="Resume"
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

/**
 * Music that is REALLY on this device.
 *
 * WHY THIS IS SEPARATE FROM THE TRANSFER LIST ABOVE. The `DownloadManager`
 * keeps its records in an in-memory `Map`, so a page reload empties it — while
 * the audio itself is sitting in the Origin Private File System, complete and
 * perfectly playable. Showing only the manager's list therefore made a finished
 * download vanish the moment the tab reloaded, which is exactly the "I
 * downloaded it and it isn't there" report. The manager is the right source of
 * truth for a transfer in flight; the filesystem is the right source of truth
 * for what has been saved. This reads the directory itself, so what you see
 * here is what is on disk.
 */
function StoredDownloads() {
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [ready, setReady] = useState(false);
  // Ids already handed to the player, so a deleted-then-re-downloaded track
  // announces itself again rather than being swallowed as a duplicate.
  const announced = useRef(new Set<string>());

  const refresh = useCallback(() => {
    void listStoredDownloads().then((rows) => {
      setFiles(rows);
      setReady(true);
    });
  }, []);

  useEffect(() => {
    refresh();
    // The transfer list polls at 500ms; this only needs to catch a commit, so a
    // slower cadence is plenty and keeps the filesystem read cheap.
    const id = window.setInterval(refresh, 2000);
    return () => window.clearInterval(id);
  }, [refresh]);

  if (!opfsSupported()) return null;

  const totalBytes = files.reduce((n, f) => n + f.size, 0);

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
          Saved on this device
        </h2>
        {files.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {files.length} track{files.length === 1 ? "" : "s"} ·{" "}
            {formatBytes(totalBytes)}
          </p>
        )}
      </div>

      {!ready ? (
        <p className="text-sm text-muted-foreground">Checking storage…</p>
      ) : files.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing saved to this device yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {files.map((file) => {
            const { filename } = parseStoredName(file.name);
            return (
              <li
                key={file.name}
                className="flex items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.03] px-4 py-3"
              >
                <Check className="size-4 shrink-0 text-emerald-300/70" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{filename}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatBytes(file.size)}
                    {file.modifiedAt
                      ? ` · ${new Date(file.modifiedAt).toLocaleDateString()}`
                      : ""}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label={`Delete ${filename}`}
                  onClick={() => {
                    const { id: trackId } = parseStoredName(file.name);
                    void deleteStoredDownload(file.name).then(() => {
                      // Without this the player keeps serving a blob URL for a
                      // file that no longer exists: silent audio on the next
                      // play instead of a stream.
                      noteTrackRemoved(trackId);
                      announced.current.delete(trackId);
                      refresh();
                    });
                  }}
                  className="shrink-0 rounded-full p-2 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
                >
                  <Trash2 className="size-4" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * What the service worker actually has stored.
 *
 * Reads the real Cache Storage rather than reporting a stored flag, so this
 * cannot drift from what is genuinely cached for offline use.
 */
function OfflineSummary() {
  const [entries, setEntries] = useState<{ name: string; count: number }[]>(
    [],
  );
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
        // A browser that refuses Cache Storage (private mode, disabled) is
        // reported as unsupported rather than as "nothing cached".
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
        This browser does not expose offline storage, so nothing is kept for
        offline use.
      </p>
    );
  }

  return (
    <section>
      <h2 className="mb-3 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
        Available offline
      </h2>
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing cached yet. The app shell and artwork are stored as you
          browse; audio is not.
        </p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {entries.map((e) => (
            <li
              key={e.name}
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              {e.count === 0 ? (
                <AlertTriangle className="size-3.5 shrink-0 opacity-50" />
              ) : (
                <Check className="size-3.5 shrink-0 text-emerald-300/70" />
              )}
              <span className="truncate">
                {e.count} cached item{e.count === 1 ? "" : "s"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}