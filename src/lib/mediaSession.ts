/**
 * The ONE place SYNQ talks to the operating system about "what is playing".
 *
 * On the web (and in the installed PWA) this is the W3C Media Session API:
 * Chrome for Android shows the lock-screen card and keeps audio alive with the
 * screen off. In the packaged Android app it is
 * `@capgo/capacitor-media-session`, which drives the same metadata through a
 * native `MediaSessionCompat` **and starts a `mediaPlayback` foreground
 * service**. That service is not a nicety — it is the only thing that keeps the
 * app's process (and therefore the WebView that owns the `<audio>` elements)
 * alive once the Activity is stopped:
 *
 * - Android 17 "background audio hardening" requires a visible activity *or* a
 *   non-SHORT foreground service for any audio playback, "whether or not the
 *   app targets API level 37". Without one, playback APIs fail silently and the
 *   app may be frozen mid-song.
 * - Android's own guidance is that music playback is foreground-service work,
 *   and that the notification is how the user stays in control.
 *
 * Everything here is deliberately fire-and-forget: a media session is an
 * accessory to playback, never a precondition for it. A missing `navigator`
 * API, an unsupported action, or a rejected bridge call must cost the lock-screen
 * card — never a note of the music. That is why every call site below ends in a
 * swallowed rejection instead of a `throw`.
 */
import { MediaSession } from "@capgo/capacitor-media-session";
import { isNativeShell } from "@/lib/nativeShell";

/** Artwork sizes the notification / lock screen may ask for. */
const ARTWORK_SIZES = [96, 256, 512];

/** What the OS needs to draw a now-playing entry. */
export type MediaSessionTrack = {
  title: string;
  artistName: string;
  albumName?: string | null;
  coverUrl?: string | null;
};

export type MediaSessionPlaybackState = "none" | "paused" | "playing";

/**
 * True when SOMETHING can show a media session: the Capacitor shell always
 * (the plugin is native there), a browser when it exposes the API.
 */
function mediaSessionUsable(): boolean {
  if (isNativeShell()) return true;
  return typeof navigator !== "undefined" && "mediaSession" in navigator;
}

/** Swallow a plugin rejection — an accessory must never take playback down. */
function ignore(): void {
  /* no-op: this is the .catch() body for every bridge call */
}

// --- metadata -----------------------------------------------------------------

/**
 * The last track we published. Kept so a later metadata publish (or a repeat
 * call for the same track) does not have to re-send the whole payload, and so
 * artwork that failed to resolve cannot silently blank the notification on the
 * next call.
 */
let publishedTrackKey: string | null = null;

function trackKey(track: MediaSessionTrack): string {
  return `${track.title}\u0000${track.artistName}\u0000${track.albumName ?? ""}\u0000${track.coverUrl ?? ""}`;
}

/**
 * Publish (or clear) the now-playing metadata.
 *
 * Re-published on every track change rather than throttled: this is what makes
 * the notification follow the queue, and it runs once per song, not per tick.
 */
export function publishTrackMetadata(track: MediaSessionTrack | null): void {
  if (!mediaSessionUsable()) return;

  if (!track) {
    publishedTrackKey = null;
    // Empty metadata rather than `null`: the plugin's API has no "clear", and
    // an entry with no title draws nothing. The session is taken down by
    // `publishPlaybackState("none")` below, which is what actually removes the
    // notification on Android (STATE_NONE stops the foreground service).
    void MediaSession.setMetadata({
      title: "",
      artist: "",
      album: "",
      artwork: [],
    }).catch(ignore);
    return;
  }

  const key = trackKey(track);
  if (key === publishedTrackKey) return;
  publishedTrackKey = key;

  const artwork = track.coverUrl
    ? ARTWORK_SIZES.map((size) => ({
        src: track.coverUrl as string,
        sizes: `${size}x${size}`,
      }))
    : [];

  void MediaSession.setMetadata({
    title: track.title,
    artist: track.artistName,
    album: track.albumName ?? "SYNQ",
    artwork,
  }).catch(ignore);
}

// --- playback state -----------------------------------------------------------

let publishedState: MediaSessionPlaybackState | null = null;

/**
 * Publish the transport state.
 *
 * On Android this call is also what starts and stops the foreground service:
 * the plugin starts it the first time the state becomes `playing` while SYNQ is
 * visible (Android 12+ refuses a foreground-service start from the background,
 * so the start has to ride the user's own play gesture) and stops it when the
 * state goes back to `none`.
 */
export function publishPlaybackState(state: MediaSessionPlaybackState): void {
  if (!mediaSessionUsable()) return;
  if (state === publishedState) return;
  publishedState = state;
  void MediaSession.setPlaybackState({ playbackState: state }).catch(ignore);
}

// --- position -----------------------------------------------------------------

/** At most one position publish per second; the lock screen interpolates. */
const POSITION_MIN_INTERVAL_MS = 1000;
let lastPositionAt = 0;
let lastPositionDuration = -1;

/**
 * Publish the scrubber position.
 *
 * Throttled HARD, unlike the browser-only version this replaces: each call is a
 * bridge hop into native code that rebuilds the notification, and
 * `timeupdate` fires about four times a second. Android's media notification
 * interpolates between updates, so a second apart is indistinguishable to the
 * user and costs a quarter of the battery and jank.
 *
 * A duration change is always published immediately — that is a new track, and
 * the scrubber must not keep showing the previous song's length.
 */
export function publishPosition(input: {
  duration: number;
  position: number;
  rate: number;
}): void {
  if (!mediaSessionUsable()) return;
  const duration = Number.isFinite(input.duration) ? input.duration : 0;
  if (duration <= 0) return; // the OS cannot show progress without a length
  const now = Date.now();
  const durationChanged = duration !== lastPositionDuration;
  if (!durationChanged && now - lastPositionAt < POSITION_MIN_INTERVAL_MS) {
    return;
  }
  lastPositionAt = now;
  lastPositionDuration = duration;
  const position = Math.min(duration, Math.max(0, input.position || 0));
  const rate = Number.isFinite(input.rate) && input.rate > 0 ? input.rate : 1;
  void MediaSession.setPositionState({ duration, position, playbackRate: rate }).catch(
    ignore,
  );
}

// --- remote controls ----------------------------------------------------------

export type MediaSessionHandlers = {
  /** Resume. Must be a no-op when there is nothing to resume. */
  play: () => void;
  /** Pause. */
  pause: () => void;
  nexttrack: () => void;
  previoustrack: () => void;
  /** Relative rewind, in seconds. */
  seekbackward: (offsetSeconds: number) => void;
  /** Relative fast-forward, in seconds. */
  seekforward: (offsetSeconds: number) => void;
  /** Absolute seek, in seconds. */
  seekto: (timeSeconds: number) => void;
  /** The user ended playback from the notification. Nothing may auto-resume. */
  stop: () => void;
};

let actionsRegistered = false;

/**
 * Register the remote-control handlers ONCE for the life of the page.
 *
 * Registered once, and the handlers reach into the store lazily, because that
 * is the only shape that survives both platforms. On Android the plugin turns
 * each registration into a retained bridge call that fires on EVERY media
 * button press, so re-registering on each render would stack duplicate
 * callbacks — the classic cause of one "next" press skipping two tracks. The
 * handlers take no state of their own; they read the live store when the button
 * is actually pressed, which is what keeps the lock screen and the transport
 * bar from ever disagreeing.
 */
export function registerMediaSessionActions(handlers: MediaSessionHandlers): void {
  if (actionsRegistered) return;
  if (!mediaSessionUsable()) return;
  actionsRegistered = true;

  const register = (
    action:
      | "play"
      | "pause"
      | "nexttrack"
      | "previoustrack"
      | "seekbackward"
      | "seekforward"
      | "seekto"
      | "stop",
    handler: (details: { seekTime?: number | null }) => void,
  ) => {
    try {
      void MediaSession.setActionHandler({ action }, (details) => {
        try {
          handler(details ?? {});
        } catch {
          /* a remote control must never be able to break playback */
        }
      }).catch(ignore);
    } catch {
      // Older WebViews reject individual actions while still exposing the
      // session. Losing one button is fine; losing playback is not.
    }
  };

  register("play", () => handlers.play());
  register("pause", () => handlers.pause());
  register("nexttrack", () => handlers.nexttrack());
  register("previoustrack", () => handlers.previoustrack());
  register("seekbackward", () => handlers.seekbackward(10));
  register("seekforward", () => handlers.seekforward(10));
  register("seekto", (details) => {
    const time = details.seekTime;
    if (typeof time === "number" && Number.isFinite(time)) handlers.seekto(time);
  });
  register("stop", () => handlers.stop());
}

/** Test seam: forget the registration so a test can register again. */
export function __resetMediaSessionForTests(): void {
  actionsRegistered = false;
  routeLossRegistered = false;
  publishedState = null;
  publishedTrackKey = null;
  lastPositionAt = 0;
  lastPositionDuration = -1;
}

// --- audio route loss (headphones unplugged) ----------------------------------

/**
 * The DOM event the Android shell fires when the audio route disappears.
 * Emitted by `AudioRouteLossReceiver` through the Capacitor bridge, because
 * `AudioManager.ACTION_AUDIO_BECOMING_NOISY` is a system broadcast that no web
 * API exposes and no web app can observe.
 */
export const AUDIO_ROUTE_LOST_EVENT = "synqAudioRouteLost";

let routeLossRegistered = false;

/**
 * Pause when the wired or Bluetooth route vanishes.
 *
 * Android's contract for `AUDIO_BECOMING_NOISY` is unambiguous: pause. Playing
 * on through the phone's own speaker after somebody unplugs their headphones is
 * the failure everyone remembers.
 *
 * It is registered once and only ever calls the callback — the arrangement is
 * deliberately one-way. Nothing in this path can resume anything, which is what
 * keeps "headphones unplugged" from turning into "music restarted on its own"
 * later, and it is why the handler is a pause-only callback rather than the
 * full set of transport handlers above.
 */
export function registerAudioRouteLossHandler(onRouteLost: () => void): void {
  if (routeLossRegistered || typeof window === "undefined") return;
  routeLossRegistered = true;
  window.addEventListener(AUDIO_ROUTE_LOST_EVENT, () => {
    try {
      onRouteLost();
    } catch {
      /* an unplug must never be able to break the player it is protecting */
    }
  });
}
