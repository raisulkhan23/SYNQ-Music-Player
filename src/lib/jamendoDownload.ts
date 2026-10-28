// Relative imports: this module is imported by the Convex action and HTTP
// route beside it, and the Convex bundler does not resolve path aliases.
import {
  authorizedFilename,
  refuse,
  refusalFromFailure,
  type DownloadRefusal,
} from "./downloadAuth";
import { networkFailure, notConfiguredFailure, unwrap } from "./jamendo";

/**
 * Resolving a Jamendo release into an ACTUAL downloadable file.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * The download action used to ask Jamendo for `audioformat=audiodownload` and
 * read the `audio` field. That parameter does not exist: the live API answers
 * `Parameter 'audioformat' accept only values in [mp31,mp32,ogg,flac]`, so
 * every single download request was refused before it began — and because
 * Jamendo reports failures inside HTTP 200, the refusal surfaced as the
 * misleading "Jamendo rejected the app's API key".
 *
 * The downloadable file is a SEPARATE FIELD (`audiodownload`) on the ordinary
 * track object, and it is only populated for releases whose artist allowed
 * downloads (`audiodownload_allowed === true`). This module reads that field
 * and nothing else, so the source of a download can never accidentally be the
 * streaming URL.
 *
 * ── Why the URL is validated rather than trusted ───────────────────────────
 *
 * The bytes are streamed by SYNQ's own backend proxy (Jamendo's storage sends
 * no CORS headers, so a browser cannot read them directly). A provider response
 * is still external input: an unexpected host or a path that is not a track
 * download would turn the proxy into an open relay. Both are checked here, and
 * the redirect target is checked again by the proxy.
 */

/** Formats Jamendo names in the download path. */
export type DownloadFormat = "mp31" | "mp32" | "ogg" | "flac";

/** Hosts Jamendo serves downloadable files from. */
const DOWNLOAD_HOST_RE = /^(?:prod-\d+\.)?storage\.jamendo\.com$/i;

/** The path shape of a track download: `/download/track/<id>/<format>/`. */
const DOWNLOAD_PATH_RE = /^\/download\/track\/(\d+)\/(mp31|mp32|ogg|flac)\/?$/i;

const API = "https://api.jamendo.com/v3.0/tracks/";
const REQUEST_TIMEOUT_MS = 15_000;

/** The same-origin endpoint that streams an authorized asset to the browser. */
export const DOWNLOAD_PROXY_PATH = "/download-proxy";

/** Where the browser asks for those bytes. Server re-verifies on every call. */
export function downloadProxyPath(providerId: string): string {
  return `${DOWNLOAD_PROXY_PATH}?track=${encodeURIComponent(providerId)}`;
}

/** A validated downloadable asset. */
export interface AuthorizedAsset {
  providerId: string;
  /** The provider's own file URL. Never sent to the browser as a fetch target. */
  url: string;
  format: DownloadFormat;
  contentType: string;
  /** Filename extension, including the dot. */
  extension: string;
}

/** Media type for each format Jamendo can hand out. */
export function formatDetails(format: DownloadFormat): {
  contentType: string;
  extension: string;
} {
  switch (format) {
    case "ogg":
      return { contentType: "audio/ogg", extension: ".ogg" };
    case "flac":
      return { contentType: "audio/flac", extension: ".flac" };
    default:
      // mp31 = 96 kbps, mp32 = 192 kbps; both are MPEG audio.
      return { contentType: "audio/mpeg", extension: ".mp3" };
  }
}

/**
 * Parse and validate a provider download URL.
 *
 * Returns null for anything that is not exactly an https Jamendo track
 * download: a different host (including lookalikes such as
 * `storage.jamendo.com.evil.test`), another scheme, a traversal-shaped path, or
 * the streaming endpoint (which carries no `download/track` segment).
 */
export function parseDownloadAsset(
  raw: string | null | undefined,
): AuthorizedAsset | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!DOWNLOAD_HOST_RE.test(url.hostname)) return null;
  if (url.username || url.password) return null;
  const match = DOWNLOAD_PATH_RE.exec(url.pathname);
  if (!match) return null;
  const format = match[2].toLowerCase() as DownloadFormat;
  const { contentType, extension } = formatDetails(format);
  return {
    providerId: match[1],
    url: url.toString(),
    format,
    contentType,
    extension,
  };
}

/** The metadata a completed download carries with it into storage. */
export interface DownloadRelease {
  providerId: string;
  title: string;
  artist: string;
  licenseUrl: string;
  attribution: string;
  asset: AuthorizedAsset;
}

export type DownloadResolution =
  | { ok: true; release: DownloadRelease }
  | { ok: false; decision: DownloadRefusal };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Ask Jamendo for one release and return its downloadable asset.
 *
 * The eligibility flag is checked BEFORE the URL is read, and a missing or
 * non-boolean flag is treated as "not allowed" — a streaming URL being present
 * is not permission to keep a copy of it.
 */
export async function resolveJamendoDownload(
  providerId: string,
  clientId: string,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<DownloadResolution> {
  const id = String(providerId ?? "").trim();
  if (!/^\d+$/.test(id)) {
    return { ok: false, decision: refuse("invalid-request") };
  }
  if (!clientId || !clientId.trim()) {
    return { ok: false, decision: refusalFromFailure(notConfiguredFailure()) };
  }

  const url = new URL(API);
  url.searchParams.set("client_id", clientId.trim());
  url.searchParams.set("format", "json");
  url.searchParams.set("id", id);
  url.searchParams.set("limit", "1");
  url.searchParams.set("include", "musicinfo");

  /** One provider call. Separated so an empty page can be retried. */
  const requestPage = async (): Promise<
    | { kind: "ok"; results: RawResult[] }
    | { kind: "refused"; decision: DownloadRefusal }
  > => {
    let response: Response;
    try {
      response = await fetchImpl(url.toString(), {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return { kind: "refused", decision: refusalFromFailure(networkFailure()) };
    }
    if (response.status === 429) {
      return { kind: "refused", decision: refuse("rate-limited") };
    }
    if (!response.ok) {
      // A real HTTP failure (5xx, 403 gateway) is transport, not a licence
      // call.
      return {
        kind: "refused",
        decision: refuse(
          "network",
          `The audio source answered HTTP ${response.status}.`,
        ),
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: "refused", decision: refusalFromFailure(networkFailure()) };
    }

    // This API reports failures inside HTTP 200 — see `jamendo.unwrap`.
    const unwrapped = unwrap(body);
    if (!unwrapped.ok) {
      return {
        kind: "refused",
        decision: refusalFromFailure(unwrapped.failure ?? networkFailure()),
      };
    }
    return {
      kind: "ok",
      results: (unwrapped.results ?? []) as RawResult[],
    };
  };

  // Jamendo intermittently answers a real query with `status: "success"` and
  // no rows — measured live at roughly a third of calls. Taken at face value
  // that is "this track vanished", and a listener who owns the release would
  // be told a lie. So an empty page is asked for once more; a second empty
  // page is a genuine miss. Provider errors are never retried — spending more
  // of a budget that is already exhausted helps nobody.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const page = await requestPage();
    if (page.kind === "refused") {
      return { ok: false, decision: page.decision };
    }
    if (page.results.length === 0) continue;

    const track = page.results[0] as Record<string, unknown>;

    // The response must be the release we asked about. Nothing downstream may
    // disagree with the id the caller authorized.
    if (String(track.id ?? "") !== id) {
      return { ok: false, decision: refuse("not-found") };
    }

    if (track.audiodownload_allowed !== true) {
      return { ok: false, decision: refuse("not-authorized") };
    }

    const asset = parseDownloadAsset(
      typeof track.audiodownload === "string" ? track.audiodownload : null,
    );
    if (!asset) {
      // An allowed flag with no usable file is a broken release. It is NOT a
      // licence to fall back to the streaming URL.
      return { ok: false, decision: refuse("not-found") };
    }

    const title = typeof track.name === "string" ? track.name.trim() : "";
    const artist =
      typeof track.artist_name === "string" ? track.artist_name.trim() : "";
    const licenseUrl =
      typeof track.license_ccurl === "string" ? track.license_ccurl.trim() : "";

    return {
      ok: true,
      release: {
        providerId: id,
        title,
        artist,
        licenseUrl,
        attribution: [artist, title].filter(Boolean).join(" — "),
        asset,
      },
    };
  }

  return { ok: false, decision: refuse("not-found") };
}

/** The provider's track shape, as far as this module reads it. */
type RawResult = Record<string, unknown>;

/** The download name for a release, using the asset's real format. */
export function releaseFilename(release: DownloadRelease): string {
  return authorizedFilename(
    release.providerId,
    release.title,
    release.artist,
    release.asset.extension,
  );
}

/**
 * A short-lived memo of resolved releases, for the proxy.
 *
 * One transfer is several ranged requests, and each one re-verifies the
 * licence server-side. Re-asking the provider for every 1 MiB chunk would burn
 * an API quota meant for browsing. The cached answer still carries the
 * `audiodownload_allowed` decision that was just made, and it expires in two
 * minutes, so a revoked release stops streaming almost immediately while a
 * normal transfer makes exactly one provider call.
 *
 * In-memory on purpose: it is a performance detail, never a source of truth.
 */
export function createResolveCache(
  resolver: (providerId: string) => Promise<DownloadResolution>,
  opts: { ttlMs?: number; now?: () => number; max?: number } = {},
) {
  const ttlMs = opts.ttlMs ?? 120_000;
  const now = opts.now ?? Date.now;
  const max = opts.max ?? 32;
  const entries = new Map<string, { at: number; value: DownloadResolution }>();

  return async (providerId: string): Promise<DownloadResolution> => {
    const at = now();
    const hit = entries.get(providerId);
    if (hit && at - hit.at < ttlMs) return hit.value;
    if (hit) entries.delete(providerId);
    const value = await resolver(providerId);
    // Failures are not cached: a rate limit or a network blip must be able to
    // recover on the next request instead of sticking for two minutes.
    if (value.ok) {
      entries.set(providerId, { at, value });
      if (entries.size > max) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
    }
    return value;
  };
}
