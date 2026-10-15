/**
 * Shareable deep links for a single track.
 *
 * The share button used to produce `/search?q=<title> <artist>`, which dumped
 * the recipient on a search box with the query pre-filled: they still had to
 * press search and pick the right row, and a badly tagged track came back as
 * the wrong song entirely. A link to a song should just play that song.
 *
 *   /t/<trackId>
 *
 * The id alone identifies the song, so nothing else goes in the URL. An
 * earlier version also carried `?n=&a=&c=&d=` (title, artist, cover,
 * duration) so the landing page could render without a lookup, but that put
 * a long pile of duplicated metadata in everyone's clipboard — it was long
 * enough to be truncated by chat apps, it leaked the full raw artist string,
 * and anyone editing the link could hand the recipient a different song
 * entirely. The trade is one cheap metadata lookup on open
 * (`api.youtube.trackMeta`), which is worth a clean `/t/dQw4w9WgXcQ`.
 */

import type { Playable } from "@/lib/playable";
import { cleanArtistName, cleanTrackTitle } from "@/lib/youtube";

export const TRACK_PATH = "/t";

/** Metadata for a track resolved from its id by the backend. */
export type TrackMeta = {
  id: string;
  title: string;
  artist: string;
  coverUrl: string;
  duration: number;
};

/**
 * The id to put in a link. `youtubeId` is preferred because it is the id
 * playback actually needs; a liked-remote track's own `id` can be a database
 * row id that means nothing to the player.
 */
export function shareableId(track: Playable): string {
  return track.youtubeId || track.id;
}

/** A YouTube video id is exactly 11 URL-safe base64 characters. */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** True when a path segment is a well-formed video id. */
export function isTrackId(value: string | undefined | null): boolean {
  return typeof value === "string" && VIDEO_ID_RE.test(value);
}

/** The absolute URL to share for a track — path only, no query string. */
export function buildTrackShareUrl(origin: string, track: Playable): string {
  const id = shareableId(track);
  return `${origin.replace(/\/$/, "")}${TRACK_PATH}/${encodeURIComponent(id)}`;
}

/** The bare path segment SYNQ share links use, without the leading slash. */
const TRACK_SEGMENT = TRACK_PATH.replace(/^\//, "");

/**
 * Pull the track id out of a SYNQ share link (`/t/<id>`).
 *
 * This is the inverse of {@link buildTrackShareUrl}, and it exists so a pasted
 * share link can be turned back into something playable or downloadable. It
 * accepts ANY origin — a preview deployment, a custom domain, localhost —
 * because the id is the only part of the URL that identifies the song; that is
 * precisely why the link carries nothing else.
 *
 * Returns null for anything that is not a well-formed share link, so a caller
 * can fall back to treating the pasted text as a plain URL.
 */
export function trackIdFromShareUrl(value: string): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const segments = url.pathname.split("/").filter(Boolean);
  // Exactly `/t/<id>` — a bare id, no extra path. Query and hash are ignored.
  if (segments.length !== 2 || segments[0] !== TRACK_SEGMENT) return null;
  return isTrackId(segments[1]) ? segments[1]! : null;
}

/**
 * Rebuild a playable from metadata resolved off the id.
 *
 * Title and artist go through the same cleaners as every other YouTube result
 * in the app, because the raw values off a video id are the raw video title —
 * "(Official Video)", "- Topic" suffixes and all — and a shared link should
 * not be the one place in the UI that shows them.
 */
export function trackMetaToPlayable(meta: TrackMeta): Playable {
  const title = cleanTrackTitle(meta.title) || meta.title;
  const artist = cleanArtistName(meta.artist, title) || meta.artist;
  return {
    id: meta.id,
    title,
    artistName: artist,
    albumName: "Single",
    coverUrl: meta.coverUrl,
    // The engine resolves the stream from the id, so this is a placeholder
    // that is only used when the direct stream path is unavailable.
    audioUrl: `https://youtu.be/${meta.id}`,
    duration: Number.isFinite(meta.duration) ? meta.duration : 0,
    source: "youtube",
    youtubeId: meta.id,
  };
}
