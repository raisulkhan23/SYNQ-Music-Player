/**
 * The contract every playlist importer speaks.
 *
 * SYNQ used to have exactly one importer (YouTube) wired straight into the UI.
 * Adding a second meant copying its fetch, its error handling and its progress
 * reporting. This module is the seam that stops that: a service is detected, an
 * importer is resolved for it, and whatever comes back is normalised into one
 * shape before it ever reaches the UI or the database.
 *
 *   detectPlatform(url)        -> Platform
 *   resolveImporter(platform)  -> Importer
 *   importer.fetch(...)        -> ImportOutcome   (normalised, partial-aware)
 *   toStoredTracks(outcome)    -> the playlist rows Convex stores
 *
 * Pure and import-free so it can be unit tested without a DOM, a network or a
 * Convex client. The service-specific fetching lives in Convex actions; this
 * file only describes what comes back.
 */

import type { PlaylistService, SourceKind } from "./sources";

/**
 * One track, however the service described it.
 *
 * `title` and `artist` are the only fields SYNQ genuinely needs to find and play
 * a song — everything else is metadata that makes the import feel real. They
 * are required, so an importer cannot quietly produce a nameless row.
 */
export interface NormalizedTrack {
  title: string;
  artist: string;
  album?: string;
  artwork?: string;
  /** Seconds. Omitted when the service does not report a duration. */
  duration?: number;
  /** Which service this came from, e.g. "spotify". */
  source: PlaylistService;
  /** Provider-native id, when there is one. */
  sourceId?: string;
  /** The service's own page for this track, for "open in <service>". */
  sourceUrl?: string;
}

/** What a section is for, when the link points at an album rather than a
 *  playlist. Importers treat both the same way; the label just differs. */
export interface ImportRequest {
  platform: PlaylistService;
  id: string;
  kind: SourceKind;
  /** The URL the user pasted, kept for error messages and de-duplication. */
  url: string;
  /**
   * A user OAuth access token, for the services that require one. Never
   * persisted by SYNQ and never held in component state longer than the import
   * itself.
   */
  accessToken?: string;
}

/** Why an import could not finish. Drives the wording in the UI. */
export type ImportErrorCode =
  | "invalid-url"
  | "unsupported"
  | "not-found"
  | "private"
  | "auth-required"
  | "auth-expired"
  | "rate-limited"
  | "network"
  | "empty"
  | "too-large"
  | "not-configured"
  | "unknown";

/** A failure the UI can explain, rather than a raw provider string. */
export interface ImportFailure {
  code: ImportErrorCode;
  /** One sentence, written for the listener rather than the developer. */
  message: string;
  /** True when trying the exact same import again could plausibly work. */
  retryable: boolean;
  /** What the user can actually do about it, when there is something. */
  hint?: string;
}

/** A finished import, including everything that did NOT make it in. */
export interface ImportOutcome {
  /** Playlist name as the service reports it. */
  name: string;
  /** Human label of the service, e.g. "Spotify". */
  origin: string;
  tracks: NormalizedTrack[];
  /**
   * Tracks the service listed but SYNQ could not import — removed, region
   * locked, or relinked to nothing. Reported rather than dropped silently.
   */
  skipped: number;
  /**
   * True when `tracks` is a prefix of a longer list (a capped page, or a
   * playlist past the service's own track limit).
   */
  partial: boolean;
  /** Anything worth telling the user about beyond the counts. */
  warnings: string[];
}

export const IMPORT_ERRORS: Record<ImportErrorCode, ImportFailure> = {
  "invalid-url": {
    code: "invalid-url",
    message: "That doesn't look like a playlist link.",
    retryable: false,
    hint: "Paste the share URL exactly as your music service copied it.",
  },
  unsupported: {
    code: "unsupported",
    message: "SYNQ can't read playlists from that service yet.",
    retryable: false,
    hint: "Export the playlist as CSV or a plain text list and drop the file below instead.",
  },
  "not-found": {
    code: "not-found",
    message: "That playlist doesn't exist, or it was deleted.",
    retryable: false,
  },
  private: {
    code: "private",
    message: "That playlist is private.",
    retryable: false,
    hint: "Make it public in the music service, or connect your account.",
  },
  "auth-required": {
    code: "auth-required",
    message: "This service needs you to connect your account first.",
    retryable: true,
    hint: "Nothing is imported until you authorise SYNQ. We only ask for read access to your playlists.",
  },
  "auth-expired": {
    code: "auth-expired",
    message: "Your connection to that service has expired.",
    retryable: true,
    hint: "Reconnect the account and try the import again.",
  },
  "rate-limited": {
    code: "rate-limited",
    message: "That service is rate-limiting us right now.",
    retryable: true,
    hint: "Wait a minute, then try again.",
  },
  network: {
    code: "network",
    message: "Couldn't reach that service.",
    retryable: true,
    hint: "Check your connection and try again.",
  },
  empty: {
    code: "empty",
    message: "That playlist is empty.",
    retryable: false,
  },
  "too-large": {
    code: "too-large",
    message: "That playlist is too large to import in one go.",
    retryable: false,
  },
  "not-configured": {
    code: "not-configured",
    message: "That importer hasn't been set up on this deployment yet.",
    retryable: false,
    hint: "An admin needs to add the API credentials for this service.",
  },
  unknown: {
    code: "unknown",
    message: "Something went wrong importing that playlist.",
    retryable: true,
  },
};

/** A failure is just an error with a code attached. */
export class ImportError extends Error {
  readonly code: ImportErrorCode;
  readonly retryable: boolean;
  readonly hint?: string;

  constructor(code: ImportErrorCode, message?: string) {
    const known = IMPORT_ERRORS[code];
    super(message ?? known.message);
    this.name = "ImportError";
    this.code = code;
    this.retryable = known.retryable;
    this.hint = known.hint;
  }
}

export const importFailure = (
  code: ImportErrorCode,
  message?: string,
): ImportFailure => new ImportError(code, message);

/** Trim, collapse inner whitespace, and drop anything with no title or artist. */
export function cleanField(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Turn a provider's loose payload into a track SYNQ can store — or null when
 * the payload names no song, which is how unavailable entries are detected
 * rather than imported as blank rows.
 */
export function normalizeTrack(input: {
  title?: unknown;
  artist?: unknown;
  album?: unknown;
  artwork?: unknown;
  durationMs?: unknown;
  durationSeconds?: unknown;
  source: PlaylistService;
  sourceId?: string | null;
  sourceUrl?: string | null;
}): NormalizedTrack | null {
  const title = cleanField(input.title);
  const artist = cleanField(input.artist);
  if (!title || !artist) return null;

  const album = cleanField(input.album);
  const artwork = cleanField(input.artwork);
  const sourceId = cleanField(input.sourceId);
  const sourceUrl = cleanField(input.sourceUrl);

  // Providers disagree on the unit: Spotify and Apple report milliseconds,
  // Deezer and friends report seconds. Accept either rather than storing a
  // 200,000-second song.
  const ms = Number(input.durationMs);
  const seconds = Number(input.durationSeconds);
  let duration: number | undefined;
  if (Number.isFinite(ms) && ms > 0) duration = Math.round(ms / 1000);
  else if (Number.isFinite(seconds) && seconds > 0)
    duration = Math.round(seconds);

  const track: NormalizedTrack = { title, artist, source: input.source };
  if (album) track.album = album;
  if (artwork) track.artwork = artwork;
  if (duration !== undefined) track.duration = duration;
  if (sourceId) track.sourceId = sourceId;
  if (sourceUrl) track.sourceUrl = sourceUrl;
  return track;
}

/** "Artist - Title", lowercased. The identity used for de-duplication. */
function identityOf(track: NormalizedTrack): string {
  // Case and inner spacing are folded, because the same song arrives spelled
  // two ways from two services ("Marconi Union" and "  marconi   union  ")
  // and both would otherwise sit in the queue.
  return `${track.artist} ${track.title}`
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Drop repeats and the unusable rows, reporting how many went.
 *
 * Playlist exports and service APIs both contain duplicates (the same song
 * added twice, a "clean version" next to the original). Keeping both would
 * put the same track in the queue twice, so the first occurrence wins and the
 * order the user arranged is preserved.
 */
export function dedupeTracks(tracks: NormalizedTrack[]): {
  tracks: NormalizedTrack[];
  skipped: number;
} {
  const seen = new Set<string>();
  const kept: NormalizedTrack[] = [];
  let skipped = 0;
  for (const track of tracks) {
    const key = identityOf(track);
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    kept.push(track);
  }
  return { tracks: kept, skipped };
}

/**
 * The shape `playlists.saveImported` stores.
 *
 * `artwork` used to be dropped here. Every importer had already normalised a
 * real cover URL out of the provider payload, and this function threw it away
 * on the way to the database — which is why every imported playlist rendered
 * a grid of empty black boxes with no way for the detail screen to tell the
 * difference between "no artwork available" and "artwork was thrown away".
 */
export interface StoredTrack {
  title: string;
  artist: string;
  album?: string;
  artwork?: string;
  duration?: number;
}

export function toStoredTracks(tracks: NormalizedTrack[]): StoredTrack[] {
  return tracks.map((track) => {
    const row: StoredTrack = { title: track.title, artist: track.artist };
    if (track.album !== undefined) row.album = track.album;
    if (track.artwork !== undefined) row.artwork = track.artwork;
    if (track.duration !== undefined) row.duration = track.duration;
    return row;
  });
}

/**
 * Turn a finished import into everything the UI needs to describe it honestly.
 * An outcome with no usable tracks is a failure, not a silent success.
 */
export function describeOutcome(
  outcome: ImportOutcome,
):
  | { ok: true; outcome: ImportOutcome }
  | { ok: false; failure: ImportFailure } {
  if (outcome.tracks.length === 0) {
    return {
      ok: false,
      failure: IMPORT_ERRORS[outcome.skipped > 0 ? "not-found" : "empty"],
    };
  }
  return { ok: true, outcome };
}

/** "Imported 40 tracks • 2 unavailable" */
export function summarizeOutcome(outcome: ImportOutcome): string {
  const imported = outcome.tracks.length;
  const base = `Imported ${imported} ${imported === 1 ? "track" : "tracks"}`;
  if (outcome.skipped > 0) {
    return `${base} • ${outcome.skipped} unavailable`;
  }
  return base;
}
