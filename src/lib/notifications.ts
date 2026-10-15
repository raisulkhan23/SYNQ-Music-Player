/**
 * SYNQ Web/PWA Notifications.
 *
 * When the tab is in the background and the track changes, a small OS
 * notification keeps the listener oriented without forcing them back to the
 * app. Three properties this module insists on:
 *
 *  1. OFF until the listener turns it ON. The setting defaults to off, and the
 *     permission prompt is only ever triggered by an explicit click in
 *     Settings — never a popup on load, which browsers and users both hate.
 *  2. It never throws. Notifications are unsupported in some webviews, denied
 *     by the user, or disabled at the OS level. Every failure is swallowed and
 *     reported as a boolean, because a missing toast must never break playback.
 *  3. Same-track dedupe. Notification spam is worse than no notification, so a
 *     track is only announced once per session while the setting is on.
 *
 * The pure part — `notificationCopy` and `shouldNotify` — is exported so the
 * decision and the wording can be tested without a browser.
 */

export const NOTIFICATIONS_KEY = "ss.notifications";

/** Titles are the most useful thing to show when they are short. */
export interface NotifiableTrack {
  id: string;
  title: string;
  artistName: string;
  albumName?: string;
  coverUrl?: string;
}

export const NOTIFICATIONS_APP_TAG = "synq-now-playing";

/** Whether the Notification API exists in this runtime. */
export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/** Current permission, or "unsupported" where the API is absent. */
export function notificationPermission(): NotificationPermission | "unsupported" {
  if (!notificationsSupported()) return "unsupported";
  return Notification.permission;
}

export function readNotificationsEnabled(): boolean {
  try {
    return localStorage.getItem(NOTIFICATIONS_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeNotificationsEnabled(enabled: boolean): boolean {
  try {
    localStorage.setItem(NOTIFICATIONS_KEY, enabled ? "1" : "0");
  } catch {
    // Ignore — see the module header.
  }
  return enabled;
}

/**
 * Ask for permission. Resolves to the resulting permission, and never rejects.
 * Only call this from a user gesture (the Settings toggle).
 */
export async function requestNotificationPermission(): Promise<
  NotificationPermission | "unsupported"
> {
  if (!notificationsSupported()) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/**
 * Should a track change produce a notification right now?
 *
 * All four conditions are required: the feature is on, permission is granted,
 * the document is hidden (the listener is in another tab/app), and this is a
 * genuinely different track from the one last announced.
 */
export function shouldNotify(
  track: NotifiableTrack | null | undefined,
  options: {
    enabled: boolean;
    permission: NotificationPermission | "unsupported";
    hidden: boolean;
    lastNotifiedId: string | null;
  },
): boolean {
  if (!track || !track.id || !track.title) return false;
  if (!options.enabled) return false;
  if (options.permission !== "granted") return false;
  if (!options.hidden) return false;
  if (options.lastNotifiedId === track.id) return false;
  return true;
}

/** The title/body/tag for a track notification. */
export function notificationCopy(track: NotifiableTrack): {
  title: string;
  body: string;
  tag: string;
} {
  const title = track.title || "Now playing";
  const body = track.artistName
    ? track.albumName
      ? `${track.artistName} — ${track.albumName}`
      : track.artistName
    : "Playing on SYNQ";
  return { title, body, tag: NOTIFICATIONS_APP_TAG };
}

/** Options for the underlying Notification constructor. */
export interface NotifyOptions {
  enabled: boolean;
  permission: NotificationPermission | "unsupported";
  hidden: boolean;
  lastNotifiedId: string | null;
}

/**
 * Try to show a notification for `track`. Returns the track id that was
 * announced (so the caller can remember it), or null when nothing was shown.
 * Never throws.
 */
export function notifyTrackChange(
  track: NotifiableTrack | null | undefined,
  options: NotifyOptions,
): string | null {
  if (!track) return null;
  if (!shouldNotify(track, options)) return null;
  try {
    const copy = notificationCopy(track);
    const notification = new Notification(copy.title, {
      body: copy.body,
      tag: copy.tag,
      // Replacing rather than stacking: a shared `tag` makes a track change
      // supersede the previous "now playing" notice instead of piling up.
      silent: true,
      icon: track.coverUrl || undefined,
    });
    // Clicking focuses the app and dismisses the notice.
    notification.onclick = () => {
      try {
        window.focus();
      } catch {
        // Ignore.
      }
      notification.close();
    };
    return track.id;
  } catch {
    return null;
  }
}
