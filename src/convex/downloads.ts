import { v } from "convex/values";
import { action } from "./_generated/server";
import {
  refuse,
  refusalFromFailure,
  authorizedFilename,
  authorizedProviderId,
  AUTHORIZED_CONTENT_TYPE,
  type DownloadRefusal,
} from "../lib/downloadAuth";
import { unwrap, networkFailure, notConfiguredFailure } from "../lib/jamendo";

/**
 * SYNQ's download API — the authority on what may be downloaded.
 *
 * ── What this is and is not ────────────────────────────────────────────────
 *
 * It authorizes ONE thing: Creative Commons audio that the artist has
 * explicitly released for download on Jamendo. It is deliberately incapable of
 * authorizing anything else — a request for a YouTube video id is refused
 * before any network call, because SYNQ holds a right to STREAM that upload and
 * no right to make a copy of it. This replaces the previous pipeline, which
 * resolved InnerTube streams and public Piped mirrors in order to save them.
 * That pipeline was not a bug to be tuned; it was the wrong source, so it was
 * removed rather than made more reliable.
 *
 * ── Why the client is never trusted ────────────────────────────────────────
 *
 * `requestTrackDownload` previously took a fully-formed URL from the browser
 * and fetched it. That made authorization a client-side concern, and a client
 * is not a place authorization can live. Here the client sends only a SYNQ
 * track id; the provider id is parsed out server-side, the provider is asked
 * whether that release may be downloaded, and the resulting URL never passes
 * through the browser's hands on the way to a decision.
 *
 * The provider key stays in the server environment (`JAMENDO_CLIENT_ID`) and is
 * never returned to the caller.
 */

const API = "https://api.jamendo.com/v3.0/tracks/";
const REQUEST_TIMEOUT_MS = 15_000;
/** One provider call per request: a download is a user action, not a crawl. */
const MAX_LIMIT = 1;

/** Read the provider key, or explain precisely what is missing. */
function clientId(): string | null {
  const id = process.env.JAMENDO_CLIENT_ID;
  return id && id.trim() ? id.trim() : null;
}

/**
 * Ask the provider whether one release may be downloaded, and for its file.
 *
 * `audioformat=audiodownload` is the field that actually carries the
 * downloadable asset; `mp31` (used for search) does not. The two are requested
 * in different queries on purpose, which is why this cannot be folded into
 * `jamendo.searchJamendo`.
 */
async function fetchAuthorizedRelease(
  providerId: string,
  key: string,
): Promise<
  | { ok: true; url: string; title: string; artist: string; licenseUrl: string }
  | { ok: false; decision: DownloadRefusal }
> {
  const url = new URL(API);
  url.searchParams.set("client_id", key);
  url.searchParams.set("format", "json");
  url.searchParams.set("id", providerId);
  url.searchParams.set("limit", String(MAX_LIMIT));
  url.searchParams.set("include", "musicinfo");
  url.searchParams.set("audioformat", "audiodownload");

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, decision: refusalFromFailure(networkFailure()) };
  }
  if (response.status === 429) {
    return { ok: false, decision: refuse("rate-limited") };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, decision: refusalFromFailure(networkFailure()) };
  }

  // This API reports failures inside HTTP 200 (see convex/jamendo.ts).
  const unwrapped = unwrap(body);
  if (!unwrapped.ok) {
    return {
      ok: false,
      decision: refusalFromFailure(unwrapped.failure ?? networkFailure()),
    };
  }

  const results = unwrapped.results;
  if (!Array.isArray(results) || results.length === 0) {
    return { ok: false, decision: refuse("not-found") };
  }
  const track = results[0] as Record<string, unknown>;

  /**
   * The authority. A release is downloadable ONLY when the provider says so for
   * this specific track. The presence of an `audio` URL proves nothing — the
   * streaming field is always present — so this flag is checked before the URL
   * is even read, and a missing flag is treated as "not allowed" rather than
   * "probably fine".
   */
  if (track.audiodownload_allowed !== true) {
    return { ok: false, decision: refuse("not-authorized") };
  }

  const audio = typeof track.audio === "string" ? track.audio.trim() : "";
  if (!audio || !/^https:\/\//i.test(audio)) {
    // An authorized flag with no https file is a broken release, not a licence
    // to fall back to anything else.
    return { ok: false, decision: refuse("not-found") };
  }

  return {
    ok: true,
    url: audio,
    title: typeof track.name === "string" ? track.name.trim() : "",
    artist: typeof track.artist_name === "string" ? track.artist_name.trim() : "",
    licenseUrl:
      typeof track.license_ccurl === "string" ? track.license_ccurl.trim() : "",
  };
}

/**
 * Authorize a download, or explain why it cannot be authorized.
 *
 * Returns the authorized file's URL and metadata. The URL is a provider
 * temporary-asset URL, not a SYNQ-signed one: the asset is already public and
 * unlicensed-by-Jamendo is impossible here, because authorization was just
 * re-verified. The provider key is never included in the response.
 */
export const authorizeDownload = action({
  args: { trackId: v.string() },
  handler: async (
    ctx,
    { trackId },
  ): Promise<
    | {
        authorized: true;
        downloadUrl: string;
        filename: string;
        contentType: string;
        licenseUrl: string;
        /** Attribution is a licence condition, so it travels with the file. */
        attribution: string;
      }
    | { authorized: false; decision: DownloadRefusal }
  > => {
    const providerId = authorizedProviderId(trackId);
    if (providerId === null) {
      // Refused before any I/O and without consulting the provider: this id
      // names a source SYNQ has no distribution right for.
      return { authorized: false, decision: refuse("not-authorized") };
    }

    const key = clientId();
    if (!key) {
      return {
        authorized: false,
        decision: refusalFromFailure(notConfiguredFailure()),
      };
    }

    const release = await fetchAuthorizedRelease(providerId, key);
    if (!release.ok) return { authorized: false, decision: release.decision };

    const attribution = [release.artist, release.title].filter(Boolean).join(" — ");
    return {
      authorized: true,
      downloadUrl: release.url,
      filename: authorizedFilename(providerId, release.title, release.artist),
      contentType: AUTHORIZED_CONTENT_TYPE,
      licenseUrl: release.licenseUrl,
      attribution,
    };
  },
});