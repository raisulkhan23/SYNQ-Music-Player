import { useCallback, useEffect, useState } from "react";
import {
  downloadsPlatform,
  listNativeDownloads,
  nativeStorageInfo,
  subscribeNativeDownloads,
  type DownloadsPlatform,
  type NativeDownloadRecord,
  type NativeStorageInfo,
} from "@/lib/nativeDownloads";

/**
 * Live view of the native download queue. The queue itself lives in native
 * code, so this only mirrors it; mounting or unmounting a page never owns or
 * cancels a transfer.
 */
export function useNativeDownloads(pollMs = 1000) {
  const platform: DownloadsPlatform = downloadsPlatform();
  const [records, setRecords] = useState<NativeDownloadRecord[]>([]);
  const [storage, setStorage] = useState<NativeStorageInfo | null>(null);
  const [ready, setReady] = useState(platform === "web");

  const refresh = useCallback(async () => {
    if (platform === "web") {
      setRecords([]);
      setStorage(null);
      setReady(true);
      return;
    }
    const [rows, usage] = await Promise.all([
      listNativeDownloads(),
      nativeStorageInfo(),
    ]);
    setRecords(rows);
    setStorage(usage);
    setReady(true);
  }, [platform]);

  useEffect(() => {
    if (platform === "web") return;
    let active = true;
    const run = () => {
      if (active) void refresh();
    };
    run();
    const unsubscribe = subscribeNativeDownloads(run);
    const interval = window.setInterval(run, Math.max(500, pollMs));
    return () => {
      active = false;
      unsubscribe();
      window.clearInterval(interval);
    };
  }, [platform, pollMs, refresh]);

  return { platform, records, storage, ready, refresh };
}

/** The record for one track, for compact surfaces such as the fullscreen player. */
export function useNativeDownloadRecord(trackId: string | undefined) {
  const { platform, records, refresh } = useNativeDownloads(1000);
  return {
    platform,
    record: trackId
      ? records.find((record) => record.trackId === trackId) ?? null
      : null,
    refresh,
  };
}
