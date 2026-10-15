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
   * Only `"youtube"` remains, and that is deliberate. Jamendo used to be a
   * second playable source — a direct Creative Commons stream fed to the
   * `<audio>` element — and every track came back silent, because that stream
   * never made a sound for the listeners it was built for. A second source
   * that cannot play is not a fallback, it is a second way to be silent, so
   * the branch was removed rather than left to fail quietly.
   *
   * Jamendo itself is not gone: it is a DISCOVERY index. It names independent
   * releases for search and recommendations, and each one is resolved to a
   * real YouTube upload before it can be played. See
   * `src/lib/jamendoDiscovery.ts`.
   */
  source: "youtube";
  /** Set when this track plays through the YouTube IFrame engine (by video id). */
  youtubeId?: string;
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
