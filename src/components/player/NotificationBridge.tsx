import { useEffect, useRef } from "react";
import { usePlayerStore } from "@/store/player";
import { notificationPermission, notifyTrackChange } from "@/lib/notifications";

/**
 * Fires a Web/PWA notification when the playing track changes and the tab is
 * in the background.
 *
 * Rendered once at the shell level. It renders nothing; its only job is to
 * observe `current` and call the guarded `notifyTrackChange`. The permission
 * prompt is NOT triggered here — `notifyTrackChange` only posts when permission
 * is already granted, and permission is requested from the Settings toggle on a
 * user gesture. `lastNotifiedId` is kept in a ref so a track is announced once.
 */
export function NotificationBridge() {
  const current = usePlayerStore((s) => s.current);
  const enabled = usePlayerStore((s) => s.notificationsEnabled);
  const lastNotifiedId = useRef<string | null>(null);

  useEffect(() => {
    if (!current) return;
    const id = notifyTrackChange(current, {
      enabled,
      permission: notificationPermission(),
      hidden: typeof document !== "undefined" ? document.hidden : true,
      lastNotifiedId: lastNotifiedId.current,
    });
    if (id) lastNotifiedId.current = id;
  }, [current, enabled]);

  return null;
}
