/**
 * Recognising playlists that live in another music service.
 *
 * Users arrive from Spotify, Apple Music, SoundCloud, Deezer, Tidal and
 * Bandcamp with a share link and reasonably expect the same one-tap import
 * they get everywhere else. Only some of those can actually be read without
 * the user's API keys: YouTube and YouTube Music expose their playlist
 * contents through the same public InnerTube endpoint the player already
 * uses, so SYNQ can fetch the track list itself. Every other service needs an
 * OAuth app registered in their name, which a music client cannot ship, so
 * those links are recognised and routed to the export flow with instructions
 * for that specific service rather than a generic "export a CSV" message.
 *
 * Everything here is pure and side-effect free so it can be unit tested and
 * reused by the settings importer and the playlist page.
 */

export type PlaylistService =
  | "youtube"
  | "youtube-music"
  | "spotify"
  | "apple-music"
  | "soundcloud"
  | "deezer"
  | "tidal"
  | "bandcamp"
  | "unknown";

export type SourceKind = "playlist" | "album" | "track" | "unknown";

export interface DetectedSource {
  service: PlaylistService;
  /** Provider-native collection id, when the link exposes one. */
  id: string | null;
  kind: SourceKind;
  /**
   * True when SYNQ can fetch the track list itself. Only YouTube playlists
   * qualify; everything else needs the user to export a file first.
   */
  direct: boolean;
  /** Human label for toasts and hints ("YouTube Music", "Spotify", …). */
  label: string;
}

export const SERVICE_LABELS: Record<PlaylistService, string> = {
  youtube: "YouTube",
  "youtube-music": "YouTube Music",
  spotify: "Spotify",
  "apple-music": "Apple Music",
  soundcloud: "SoundCloud",
  deezer: "Deezer",
  tidal: "Tidal",
  bandcamp: "Bandcamp",
  unknown: "That service",
};

/** A playlist id is 10–64 chars of the InnerTube alphabet. */
const YT_ID_RE = /^PL[A-Za-z0-9_-]{8,}$|^[A-Za-z0-9_-]{10,}$/;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

function label(service: PlaylistService): string {
  return SERVICE_LABELS[service] ?? "That service";
}

/**
 * Pull the first http(s) URL out of arbitrary pasted text.
 *
 * Users paste share text ("Check out this playlist: https://…") far more
 * often than a bare URL, so the detector has to cope with surrounding prose.
 */
export function extractUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  if (match) return match[0].replace(/[),.;]+$/, "");
  // Bare "youtube.com/playlist?list=…" with no scheme is common in DMs.
  const bare = text.match(
    /\b(?:[a-z0-9-]+\.)*(?:youtube|spotify|apple|soundcloud|deezer|tidal|bandcamp)\.(?:com|be|fm|music|co)\/[^\s<>"']+/i,
  );
  if (bare) return `https://${bare[0].replace(/[),.;]+$/, "")}`;
  return null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}?${u.search}`.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

/**
 * Derive a playlist name from a link when the provider bakes it into the URL.
 * Apple Music ("…/playlist/road-trip/pl.u-xyz") and Bandcamp both do; Spotify
 * and Tidal do not, so those fall back to the label.
 */
export function nameFromUrl(url: string): string | null {
  const service = detectServiceUrl(url)?.service;
  if (service === "apple-music") {
    const m = pathOf(url).match(/\/playlist\/([^/]+)\/pl\./i);
    if (m) return humanizeSlug(m[1]);
  }
  if (service === "bandcamp") {
    const m = pathOf(url).match(/\/playlist\/(\d+)/i);
    if (m) return `Bandcamp playlist #${m[1]}`;
  }
  if (service === "soundcloud") {
    const m = pathOf(url).match(/\/sets\/([^/?]+)/i);
    if (m) return humanizeSlug(m[1]);
  }
  return null;
}

/** "road-trip" → "Road Trip". */
function humanizeSlug(slug: string): string {
  return decodeURIComponent(slug)
    .replace(/[-_+]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Identify a playlist/album/track link from any supported service.
 * Returns null when the text holds no recognisable link at all.
 */
export function detectServiceUrl(input: string): DetectedSource | null {
  const url = extractUrl(input);
  if (!url) return null;
  const host = hostOf(url);
  if (!host) return null;
  const path = pathOf(url);

  // --- YouTube / YouTube Music -------------------------------------------
  if (
    host === "youtube.com" ||
    host === "m.youtube.com" ||
    host === "youtu.be"
  ) {
    return youtubeSource(host === "youtu.be" ? "" : path, "youtube", path);
  }
  if (host === "music.youtube.com") {
    return youtubeSource(path, "youtube-music", path);
  }

  // --- Spotify -------------------------------------------------------------
  if (host === "open.spotify.com" || host === "spotify.link") {
    const m = path.match(/^\/(playlist|album|track)\/([A-Za-z0-9]+)/i);
    if (m) {
      const kind = m[1].toLowerCase() as SourceKind;
      return {
        service: "spotify",
        id: m[2],
        kind,
        direct: false,
        label: label("spotify"),
      };
    }
    return null;
  }

  // --- Apple Music ---------------------------------------------------------
  if (host === "music.apple.com" || host === "itunes.apple.com") {
    // Real Apple ids look like "pl.u-abc123"; a class without "-" truncated
    // them to "pl.u" and every playlist link came back unusable.
    const pl = path.match(/\/playlist\/[^/]+\/(pl\.[A-Za-z0-9-]+)/i);
    if (pl)
      return {
        service: "apple-music",
        id: pl[1],
        kind: "playlist",
        direct: false,
        label: label("apple-music"),
      };
    const album = path.match(/\/album\/[^/]+\/([A-Za-z0-9]+)/i);
    if (album)
      return {
        service: "apple-music",
        id: album[1],
        kind: "album",
        direct: false,
        label: label("apple-music"),
      };
    const track = path.match(/\/song\/[^/]+\/([A-Za-z0-9]+)/i);
    if (track)
      return {
        service: "apple-music",
        id: track[1],
        kind: "track",
        direct: false,
        label: label("apple-music"),
      };
    return null;
  }

  // --- SoundCloud ----------------------------------------------------------
  if (host === "soundcloud.com" || host === "snd.sc") {
    const m = path.match(/\/sets\/([^/?]+)/i);
    if (m)
      return {
        service: "soundcloud",
        id: m[1],
        kind: "playlist",
        direct: false,
        label: label("soundcloud"),
      };
    return null;
  }

  // --- Deezer --------------------------------------------------------------
  if (host === "deezer.com") {
    const m = path.match(/\/playlist\/(\d+)/i);
    if (m)
      return {
        service: "deezer",
        id: m[1],
        kind: "playlist",
        direct: false,
        label: label("deezer"),
      };
    return null;
  }

  // --- Tidal ---------------------------------------------------------------
  if (host === "tidal.com" || host === "listen.tidal.com") {
    const m = path.match(/\/playlist\/([A-Za-z0-9-]+)/i);
    if (m)
      return {
        service: "tidal",
        id: m[1],
        kind: "playlist",
        // Tidal's v2 API serves catalog reads over a server-to-server
        // client-credentials token, so this link imports directly with no
        // per-listener authorisation. It was `false`, which is why the Tidal
        // importer existed but was unreachable from the link box.
        direct: true,
        label: label("tidal"),
      };
    return null;
  }

  // --- Bandcamp ------------------------------------------------------------
  if (host.endsWith("bandcamp.com")) {
    const m = path.match(/\/playlist\/(\d+)/i);
    if (m)
      return {
        service: "bandcamp",
        id: m[1],
        kind: "playlist",
        direct: false,
        label: label("bandcamp"),
      };
    return null;
  }

  return null;
}

function youtubeSource(
  searchPart: string,
  service: PlaylistService,
  fullPath: string,
): DetectedSource {
  const list =
    /[?&]list=([A-Za-z0-9_-]+)/.exec(searchPart)?.[1] ??
    /[?&]list=([A-Za-z0-9_-]+)/.exec(fullPath)?.[1] ??
    null;
  // The video id can arrive as `?v=`, as a `youtu.be/<id>` path, or as a
  // leading path segment. All three have to be checked: passing only the
  // query half made every short link come back as "no video".
  const video =
    /[?&]v=([A-Za-z0-9_-]{11})/.exec(searchPart)?.[1] ??
    /[?&]v=([A-Za-z0-9_-]{11})/.exec(fullPath)?.[1] ??
    /^\/([A-Za-z0-9_-]{11})/.exec(searchPart)?.[1] ??
    /^\/([A-Za-z0-9_-]{11})/.exec(fullPath)?.[1] ??
    null;

  if (list && YT_ID_RE.test(list)) {
    return {
      service,
      // A "watch?v=…&list=RD…" mix is a radio seed, not a real playlist; the
      // id pattern above already rejects most of those, and anything left is
      // still resolvable, so keep it.
      id: list,
      kind: "playlist",
      direct: true,
      label: label(service),
    };
  }
  if (video && VIDEO_ID_RE.test(video)) {
    return {
      service,
      id: video,
      kind: "track",
      direct: false,
      label: label(service),
    };
  }
  return {
    service,
    id: null,
    kind: "unknown",
    direct: false,
    label: label(service),
  };
}

/** True when a detected link can be pulled without an export file. */
export function canDirectImport(source: DetectedSource | null): boolean {
  return !!source && source.direct && source.kind === "playlist" && !!source.id;
}

/**
 * What the UI should do with a pasted link: import it now, or explain how to
 * get it out of that service. Returning a single decision object (instead of
 * branching at the call site) keeps the wording and the routing in one place.
 */
export interface ImportPlan {
  mode: "direct" | "export" | "unsupported";
  /** Sentence shown to the user when `mode` is not "direct". */
  message: string;
  source: DetectedSource | null;
}

export function planImport(input: string): ImportPlan {
  const source = detectServiceUrl(input);
  if (!source) {
    return {
      mode: "unsupported",
      message:
        "That doesn't look like a playlist link. Paste the share URL, or drop an exported CSV below.",
      source: null,
    };
  }
  if (canDirectImport(source)) {
    return { mode: "direct", message: "", source };
  }
  if (source.kind === "track") {
    return {
      mode: "export",
      message: `That's a single ${source.label} track. Paste the link into search to play it, or share the playlist link to import the whole list.`,
      source,
    };
  }
  return {
    mode: "export",
    message: exportHint(source.service),
    source,
  };
}

/**
 * Per-service export instructions. Spotify deliberately avoids naming a
 * third-party extension: they are frequently broken, and the Takeout/CSV
 * route is the one that keeps working.
 */
export function exportHint(service: PlaylistService): string {
  switch (service) {
    case "youtube":
      return "YouTube playlists import directly from the link above.";
    case "youtube-music":
      return "YouTube Music playlists import directly from the link above.";
    case "spotify":
      return "Spotify has no public read API, so it can't be linked. Open the playlist in Spotify, choose Share → Copy link to check the format, then export it as CSV and drop the file below — the songs are matched by artist and title.";
    case "apple-music":
      return "Apple Music can't be linked without a developer account. Export the playlist as CSV (or copy the song list) and drop it below.";
    case "soundcloud":
      return "SoundCloud playlists need an export file. Save the set as text or CSV and drop it below.";
    case "deezer":
      return "Deezer playlists need an export file — copy the track list as text and drop it below.";
    case "tidal":
      return "Tidal playlists import directly from the link above.";
    case "bandcamp":
      return "Bandcamp collections need an export file — copy the track list and drop it below.";
    default:
      return "That service can't be linked. Export the playlist as CSV or a plain text list and drop it below.";
  }
}
