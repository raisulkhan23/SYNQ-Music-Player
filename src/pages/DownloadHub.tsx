import { useCallback, useEffect, useMemo, useState } from "react";
import { useAction } from "convex/react";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  Download,
  HardDriveDownload,
  Info,
  Loader2,
  Play,
  RefreshCw,
  Smartphone,
  Trash2,
  WifiOff,
  X,
} from "lucide-react";

import { api } from "@/convex/_generated/api";
import { useNativeDownloads } from "@/hooks/useNativeDownloads";
import { requestAuthorizedDownload } from "@/lib/authorizedDownload";
import { downloadAvailability, downloadTargetId } from "@/lib/downloadAuth";
import { formatBytes } from "@/lib/downloadProviders";
import {
  cancelNativeDownload,
  localArtworkUrl,
  localAudioUrl,
  nativeDownloadsPlatformLabel,
  removeNativeDownload,
  retryNativeDownload,
  type NativeDownloadRecord,
} from "@/lib/nativeDownloads";
import {
  noteTrackDownloaded,
  noteTrackRemoved,
  usePlayerStore,
} from "@/store/player";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<NativeDownloadRecord["status"], string> = {
  queued: "Waiting",
  downloading: "Downloading",
  validating: "Validating",
  completed: "Downloaded",
  failed: "Failed",
  cancelled: "Cancelled",
};

const STATUS_STYLE: Record<NativeDownloadRecord["status"], string> = {
  queued: "text-muted-foreground",
  downloading: "text-[rgb(var(--tint))]",
  validating: "text-amber-200",
  completed: "text-emerald-300/80",
  failed: "text-red-300/80",
  cancelled: "text-muted-foreground/70",
};

function formatEta(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || ms <= 0) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s left`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s left`;
}

export default function DownloadHub() {
  const { platform, records, storage, ready, refresh } = useNativeDownloads();
  const [online, setOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [starting, setStarting] = useState(false);
  const [detailsFor, setDetailsFor] = useState<string | null>(null);

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
  const current = usePlayerStore((state) => state.current);
  const playTrack = usePlayerStore((state) => state.playTrack);
  const authorizeDownload = useAction(api.downloads.authorizeDownload);

  const isNative = platform !== "web";
  const currentTarget =
    current &&
    downloadAvailability(
      current.id,
      current.jamendoId,
      current.soundcloudId ?? current.id,
    ).allowed
      ? downloadTargetId(
          current.id,
          current.jamendoId,
          current.soundcloudId ?? current.id,
        )
      : null;
  const currentRecord = current
    ? records.find((record) => record.trackId === current.id)
    : null;

  const totals = useMemo(() => {
    const completed = records.filter((record) => record.status === "completed");
    return {
      count: completed.length,
      bytes: completed.reduce(
        (sum, record) => sum + (record.fileSize ?? record.bytes),
        0,
      ),
    };
  }, [records]);

  const downloadCurrent = async () => {
    if (!current || !currentTarget || starting) return;
    setStarting(true);
    try {
      const result = await requestAuthorizedDownload(
        authorizeDownload,
        currentTarget,
        current.jamendoId ? { storageKey: current.id } : undefined,
      );
      if (result.started) {
        toast.success("Download started", {
          description: "It is saved by the app, not by the browser.",
        });
        await refresh();
      } else {
        toast.error(result.refusal.message, {
          description: result.refusal.retryable
            ? "Try again in a moment."
            : undefined,
        });
      }
    } finally {
      setStarting(false);
    }
  };

  const act = useCallback(
    async (operation: () => Promise<void>) => {
      try {
        await operation();
        await refresh();
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "The download action failed",
        );
      }
    },
    [refresh],
  );

  if (!isNative) {
    return (
      <div className="flex max-w-3xl flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
            Downloads
          </h1>
          <p className="text-sm text-muted-foreground">
            Offline music is part of the installed SYNQ apps.
          </p>
        </header>
        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.03] px-6 py-8">
          <Smartphone className="size-8 text-[rgb(var(--tint))]" />
          <h2 className="mt-4 font-display text-lg font-semibold">
            Downloads live in the SYNQ apps
          </h2>
          <p className="mt-2 max-w-prose text-sm leading-6 text-muted-foreground">
            The website and browser installations stream only. To keep music on
            the device, install the Android application or the Windows desktop
            application. Downloads there are stored by the app and remain
            playable without a connection.
          </p>
          <p className="mt-4 text-xs text-muted-foreground/70">
            No download control is active in this browser session.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
            Downloads
          </h1>
          <span className="rounded-full border border-[rgb(var(--tint)_/_0.35)] bg-[rgb(var(--tint)_/_0.09)] px-2.5 py-1 text-[10px] font-semibold tracking-wider text-[rgb(var(--tint))] uppercase">
            {nativeDownloadsPlatformLabel()}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          Audio stored by the app on this device. These files stay available
          without a connection.
        </p>
      </header>

      {!online && (
        <div className="flex items-center gap-3 rounded-2xl border border-amber-500/25 bg-amber-500/[0.07] px-4 py-3">
          <WifiOff className="size-4 shrink-0 text-amber-300" />
          <p className="text-sm text-amber-100/90">
            You are offline. Downloaded tracks below still play from the device.
          </p>
        </div>
      )}

      <section className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] px-4 py-4">
          <p className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
            Downloaded songs
          </p>
          <p className="mt-1 font-display text-2xl font-bold">{totals.count}</p>
        </div>
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] px-4 py-4">
          <p className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
            Stored audio
          </p>
          <p className="mt-1 font-display text-2xl font-bold">
            {formatBytes(totals.bytes)}
          </p>
        </div>
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] px-4 py-4">
          <p className="text-[10px] font-semibold tracking-widest text-muted-foreground uppercase">
            Available space
          </p>
          <p className="mt-1 font-display text-2xl font-bold">
            {storage?.availableBytes
              ? formatBytes(storage.availableBytes)
              : "Not reported"}
          </p>
        </div>
      </section>

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
            {currentRecord?.status === "completed" ? (
              <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-emerald-400/20 bg-emerald-400/[0.08] px-3 py-1.5 text-xs font-semibold text-emerald-200">
                <Check className="size-3.5" /> Downloaded
              </span>
            ) : currentTarget ? (
              <button
                type="button"
                onClick={() => void downloadCurrent()}
                disabled={starting || currentRecord?.status === "downloading"}
                className="flex shrink-0 cursor-pointer items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-3 py-1.5 text-xs font-semibold transition-colors hover:border-[rgb(var(--tint)_/_0.6)] hover:bg-[rgb(var(--tint)_/_0.12)] hover:text-[rgb(var(--tint))] disabled:cursor-wait disabled:opacity-60"
              >
                {starting || currentRecord?.status === "downloading" ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Download className="size-3.5" />
                )}
                {currentRecord?.status === "downloading"
                  ? "Downloading…"
                  : "Download"}
              </button>
            ) : (
              <span className="shrink-0 text-xs text-muted-foreground">
                Not offered for download
              </span>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Nothing playing right now.
          </p>
        )}
        {current && !currentTarget && !currentRecord ? (
          <p className="mt-2 text-xs leading-5 text-muted-foreground/70">
            This source grants streaming only. SYNQ does not convert a stream
            into a download.
          </p>
        ) : null}
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
            Download queue &amp; library
          </h2>
          {records.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              {records.length} item{records.length === 1 ? "" : "s"}
            </p>
          ) : null}
        </div>

        {!ready ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Reading native storage…
          </div>
        ) : records.length === 0 ? (
          <div className="flex flex-col items-start gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.02] px-6 py-10">
            <HardDriveDownload className="size-7 text-muted-foreground/40" />
            <p className="text-sm font-medium">No downloads yet</p>
            <p className="max-w-prose text-sm leading-6 text-muted-foreground">
              Open a track&rsquo;s menu and choose Download. Only tracks whose
              artist explicitly permits downloading are offered; streaming
              permission is never treated as download permission.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {records.map((record) => {
              const active =
                record.status === "downloading" ||
                record.status === "queued" ||
                record.status === "validating";
              const eta = formatEta(record.etaMs);
              return (
                <li
                  key={record.id}
                  className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {record.metadata.title || record.filename}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {record.metadata.artist || "Unknown artist"}
                        {record.format ? ` · ${record.format.toUpperCase()}` : ""}
                        {record.fileSize ? ` · ${formatBytes(record.fileSize)}` : ""}
                      </p>
                      <p className={cn("mt-1 text-xs", STATUS_STYLE[record.status])}>
                        {STATUS_LABEL[record.status]}
                        {record.status === "downloading" && record.speed > 0
                          ? ` · ${formatBytes(record.speed)}/s`
                          : ""}
                        {record.status === "downloading" && eta ? ` · ${eta}` : ""}
                        {record.error ? ` · ${record.error}` : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {record.status === "completed" ? (
                        <button
                          type="button"
                          aria-label={`Play ${record.filename}`}
                          title="Play downloaded track"
                          onClick={() => {
                            void (async () => {
                              const audioUrl = await localAudioUrl(record.trackId);
                              if (!audioUrl) {
                                toast.error(
                                  "That downloaded file is missing from native storage.",
                                );
                                return;
                              }
                              const coverUrl =
                                (await localArtworkUrl(record.trackId)) ?? "";
                              const playable = {
                                id: record.trackId,
                                title: record.metadata.title || record.filename,
                                artistName: record.metadata.artist || "",
                                albumName: record.metadata.album ?? "",
                                coverUrl,
                                audioUrl,
                                duration: Math.round(
                                  (record.metadata.durationMs ?? 0) / 1000,
                                ),
                                source:
                                  record.metadata.provider === "soundcloud"
                                    ? "soundcloud"
                                    : "youtube",
                                ...(record.metadata.provider === "soundcloud"
                                  ? {
                                      soundcloudId: record.trackId.replace(
                                        /^sc:/,
                                        "",
                                      ),
                                    }
                                  : {}),
                              } as const;
                              noteTrackDownloaded(record.trackId);
                              playTrack(playable, [playable]);
                            })();
                          }}
                          className="cursor-pointer rounded-full p-2 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
                        >
                          <Play className="size-4" />
                        </button>
                      ) : null}
                      {active ? (
                        <button
                          type="button"
                          aria-label={`Cancel ${record.filename}`}
                          title="Cancel download"
                          onClick={() => void act(() => cancelNativeDownload(record.id))}
                          className="cursor-pointer rounded-full p-2 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
                        >
                          <X className="size-4" />
                        </button>
                      ) : null}
                      {record.status === "failed" || record.status === "cancelled" ? (
                        <button
                          type="button"
                          aria-label={`Retry ${record.filename}`}
                          title="Retry download"
                          onClick={() => void act(() => retryNativeDownload(record.id))}
                          className="cursor-pointer rounded-full p-2 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
                        >
                          <RefreshCw className="size-4" />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        aria-label={`Details for ${record.filename}`}
                        title="Download details"
                        onClick={() =>
                          setDetailsFor(detailsFor === record.id ? null : record.id)
                        }
                        className="cursor-pointer rounded-full p-2 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
                      >
                        <Info className="size-4" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${record.filename}`}
                        title="Remove downloaded file"
                        onClick={() => {
                          if (
                            !window.confirm(
                              "Delete this downloaded file? It stays in your playlists and streaming library.",
                            )
                          ) {
                            return;
                          }
                          void act(async () => {
                            await removeNativeDownload(record.id);
                            noteTrackRemoved(record.trackId);
                            toast.success("Downloaded file removed");
                          });
                        }}
                        className="cursor-pointer rounded-full p-2 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-red-200"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  </div>

                  {active ? (
                    <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.07]">
                      <div
                        className="h-full rounded-full bg-[rgb(var(--tint))] transition-[width] duration-300"
                        style={{ width: `${record.progress}%` }}
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(record.progress)}
                      />
                    </div>
                  ) : null}

                  {detailsFor === record.id ? (
                    <dl className="mt-3 grid gap-1.5 border-t border-white/[0.06] pt-3 text-xs text-muted-foreground sm:grid-cols-2">
                      <div>
                        <dt className="text-muted-foreground/60">File</dt>
                        <dd className="break-all">{record.filename}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground/60">Source</dt>
                        <dd className="capitalize">{record.metadata.provider}</dd>
                      </div>
                      {record.metadata.album ? (
                        <div>
                          <dt className="text-muted-foreground/60">Album</dt>
                          <dd>{record.metadata.album}</dd>
                        </div>
                      ) : null}
                      {record.downloadedAt ? (
                        <div>
                          <dt className="text-muted-foreground/60">Downloaded</dt>
                          <dd>{new Date(record.downloadedAt).toLocaleString()}</dd>
                        </div>
                      ) : null}
                      <div>
                        <dt className="text-muted-foreground/60">
                          Authorization
                        </dt>
                        <dd>
                          {record.metadata.attribution || "Provider grant"}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground/60">License</dt>
                        <dd className="break-all">
                          <a
                            href={record.metadata.licenseUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="underline underline-offset-2 hover:text-foreground"
                          >
                            {record.metadata.licenseUrl}
                          </a>
                        </dd>
                      </div>
                    </dl>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground/70">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        Removing a download deletes only the local audio file. The song remains
        in playlists, likes and history and streams normally when online.
      </p>
    </div>
  );
}
