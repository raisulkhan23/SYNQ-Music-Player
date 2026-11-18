import Hls from "hls.js";

/**
 * Attach a source to one of the player store's existing audio decks.
 *
 * SoundCloud now serves most public uploads as HLS AAC. Some Chromium builds —
 * including the Capacitor WebView and Electron — cannot play an `.m3u8` URL
 * natively, and `canPlayType` is not reliable enough to ask. HLS.js feeds the
 * same element through Media Source Extensions, which keeps playback on the
 * deck: seeking, the Web Audio graph, crossfade and the media session all
 * continue to see an ordinary media element.
 *
 * This module owns the per-element Hls instance. Destroying the previous one
 * before a new source is essential: an orphaned instance keeps fetching
 * segments and can overwrite the new source's buffer.
 */

const hlsByElement = new WeakMap<HTMLAudioElement, Hls>();

export class AudioSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioSourceError";
  }
}

/** True for an HTTPS HLS manifest, checked without downloading it. */
export function isHlsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      /\.m3u8$/i.test(url.pathname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function destroyHls(audio: HTMLAudioElement): void {
  const hls = hlsByElement.get(audio);
  if (!hls) return;
  hlsByElement.delete(audio);
  try {
    hls.destroy();
  } catch {
    /* already torn down */
  }
}

/**
 * Load `source` into `audio`.
 *
 * The returned promise resolves once a direct source has been handed to the
 * element, or once an HLS manifest is parsed. It rejects with an
 * `AudioSourceError` for a format/HLS failure so the caller can show a specific
 * retry message.
 */
export async function loadAudioSource(
  audio: HTMLAudioElement,
  source: string,
): Promise<void> {
  destroyHls(audio);

  if (!isHlsUrl(source)) {
    audio.src = source;
    audio.load();
    return;
  }

  // Prefer HLS.js whenever Media Source Extensions exist. `canPlayType()`
  // answers "maybe" for the HLS MIME type in Chromium even when the element
  // cannot demux it, so trusting it skipped HLS.js and handed the manifest to
  // a native pipeline that could not parse it. Native is the fallback for iOS
  // Safari, where MSE and therefore HLS.js are unavailable.
  if (!Hls.isSupported()) {
    const nativeHls =
      audio.canPlayType("application/vnd.apple.mpegurl") !== "" ||
      audio.canPlayType("application/x-mpegURL") !== "";
    if (!nativeHls) {
      throw new AudioSourceError(
        "This device's audio engine cannot play SoundCloud's HLS stream.",
      );
    }
    audio.src = source;
    audio.load();
    return;
  }

  const hls = new Hls({
    // Audio playlists parse cheaply on the main thread, and skipping the blob
    // worker avoids an extra moving part in Android WebViews.
    enableWorker: false,
    backBufferLength: 30,
  });
  hlsByElement.set(audio, hls);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (failure?: AudioSourceError) => {
      if (settled) return;
      settled = true;
      if (failure) {
        destroyHls(audio);
        reject(failure);
      } else {
        resolve();
      }
    };

    hls.on(Hls.Events.MANIFEST_PARSED, () => finish());
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      if (!settled) {
        finish(
          new AudioSourceError(
            data.type === Hls.ErrorTypes.NETWORK_ERROR
              ? "Couldn't reach SoundCloud's stream."
              : data.type === Hls.ErrorTypes.MEDIA_ERROR
                ? "SoundCloud's audio format could not be played."
                : "SoundCloud's stream manifest could not be read.",
          ),
        );
        return;
      }
      // A fatal failure after playback started is reported through the
      // element's normal error path; the store then retries with a freshly
      // resolved URL rather than leaving a silently frozen player.
      destroyHls(audio);
      try {
        audio.dispatchEvent(new Event("error"));
      } catch {
        /* element already detached */
      }
    });

    hls.attachMedia(audio);
    hls.loadSource(source);
  });
}

/** Detach an HLS loader before the caller assigns a different `src` itself. */
export function detachHls(audio: HTMLAudioElement): void {
  destroyHls(audio);
}

/** Re-request an HLS manifest/buffer after a stall, without rebuilding it. */
export function reloadAudioSource(audio: HTMLAudioElement): boolean {
  const hls = hlsByElement.get(audio);
  if (!hls) return false;
  try {
    hls.startLoad();
    return true;
  } catch {
    return false;
  }
}

/** Stop a deck's source and release any HLS loader attached to it. */
export function releaseAudioSource(audio: HTMLAudioElement): void {
  destroyHls(audio);
  try {
    audio.removeAttribute("src");
    audio.load();
  } catch {
    /* element already detached */
  }
}
