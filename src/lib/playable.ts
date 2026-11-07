// Relative, not the `@/` alias: the Convex bundler does not resolve it, and
// this module is reachable from `src/convex/` via the recommendation
// discovery path.
import { cleanArtistName, cleanTrackTitle, type YtItem } from "./youtube";

/**
 * A normalized item in the player queue. Every source (YouTube, Jamendo,
 * imports, liked snapshots) becomes a Playable, so the player UI never has to
 * care where the audio came from.
 */
export interface Playable {
  id: string;
  title: string;
  artistName: string;
  albumName: string;
  coverUrl: string;
  audioUrl: string;
  duration: number;
  /**
   * Which engine owns this track.
   *
   * `"youtube"` — the IFrame engine, or the <audio> decks with a resolved
   * stream. Jamendo used to be a second playable source and came back silent
   * for its audience, so it was demoted to a DISCOVERY index on purpose (see
   * `src/lib/jamendoDiscovery.ts`).
   *
   * `"soundcloud"` — a first-class playable source (ported from the melo
   * player). Its progressive MP3s are real byte-range-able HTTP audio, so the
   * decks play them directly; the stream is resolved per play through the
   * Convex action and delivered via /audio-proxy. See `src/convex/soundcloud.ts`.
   */
  source: "youtube" | "soundcloud";
  /** Set when this track plays through the YouTube IFrame engine (by video id). */
  youtubeId?: string;
  /**
   * The numeric SoundCloud track id when this track IS a SoundCloud upload.
   * Never a re-matched substitute: SoundCloud tracks play from SoundCloud.
   */
  soundcloudId?: string;
  /**
   * The web page for this track, when the source has one (SoundCloud).
   * Used for the "open original" affordance and for share links.
   */
  webUrl?: string;
  /**
   * The Jamendo release this track was discovered from, when it was.
   *
   * Playback always happens through the resolved YouTube upload, but the
   * Jamendo release is the one the artist licensed for download — so this id
   * is what the download pipeline authorizes against. It never influences
   * which engine plays the track.
   */
  jamendoId?: string;
  /** Present for YouTube tracks, used for manual source switching. */
  alternatives?: YtItem[];
  /**
   * How this track entered the queue. `undefined` means the listener put it
   * there on purpose — the recommendation engine only ever appends tracks
   * tagged `autoplay`, so an automatically generated suggestion stays
   * distinguishable from a manual pick and can be reported back as a
   * rejection when it is removed.
   */
  queueOrigin?: "autoplay";
}

export function toPlayableYoutube(
  item: YtItem,
  audioUrl: string,
  alternatives: YtItem[] = [],
  jamendoId?: string,
): Playable {
  const artistName = cleanArtistName(item.artist, item.title);
  return {
    id: item.id,
    title: cleanTrackTitle(item.title),
    artistName,
    // The real album when the source supplied one, empty when it did not.
    // This used to be a hardcoded "Single", which is a fabricated value: it
    // made every track look like it belonged to its own album and gave the
    // recommendation engine a fake album axis to diversify on.
    albumName: item.album ?? "",
    coverUrl: item.thumbnail,
    audioUrl,
    duration: item.duration,
    source: "youtube",
    youtubeId: item.id,
    ...(jamendoId ? { jamendoId } : {}),
    alternatives,
  };
}

/**
 * A Jamendo track, described for DISCOVERY — never for playback.
 *
 * Removed: this used to build a queueable `Playable` carrying Jamendo's own
 * stream URL, and every track it produced was silent. What remains of the
 * idea lives in `src/lib/jamendoDiscovery.ts`, which resolves a Jamendo hit
 * to a YouTube upload before anything can be queued.
 */

/**
 * The marker a SoundCloud Playable carries in `audioUrl`.
 *
 * Like the `"stream"` rescue marker for YouTube, this is NOT a URL: it means
 * "resolve this SoundCloud id on play". Resolving every search row up front
 * would burn a network round trip per row; the store resolves lazily, exactly
 * once, and caches the result (see `scResolve` in the player store).
 */
export const SOUNDCLOUD_RESOLVE_MARKER = "sc:resolve";

/** The client-side shape of one SoundCloud search row (from the Convex action). */
export interface SoundCloudItem {
  id: string;
  title: string;
  artist: string;
  durationMs: number;
  artwork: string;
  permalinkUrl: string;
  explicit: boolean;
}

export function toPlayableSoundcloud(item: SoundCloudItem): Playable {
  return {
    // Prefixing the queue id keeps a SoundCloud track from ever colliding
    // with a YouTube id of the same digits.
    id: `sc:${item.id}`,
    title: item.title,
    artistName: item.artist,
    albumName: "",
    coverUrl: item.artwork,
    audioUrl: SOUNDCLOUD_RESOLVE_MARKER,
    duration: Math.round(item.durationMs / 1000),
    source: "soundcloud",
    soundcloudId: item.id,
    ...(item.permalinkUrl ? { webUrl: item.permalinkUrl } : {}),
  };
}
