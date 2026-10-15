import { v } from "convex/values";
import { action } from "./_generated/server";
import {
  dedupeTracks,
  ImportError,
  normalizeTrack,
  type ImportOutcome,
  type NormalizedTrack,
} from "../lib/importModel";

/**
 * Tidal importer.
 *
 * Tidal is a METADATA source for SYNQ, never an audio one — exactly like the
 * Spotify importer next door. It exposes no endpoint that returns playable
 * audio, so an imported playlist carries title/artist/album/artwork and
 * playback resolves those against YouTube the same way every other imported
 * playlist already does. Saying otherwise would be the worst kind of lie in a
 * music app.
 *
 * Endpoints used, both official v2 JSON:API:
 *   GET /v2/playlists/{id}          metadata
 *   GET /v2/playlists/{id}/items    paged, 100 at a time
 *
 * Auth is the OAuth2 CLIENT-CREDENTIALS flow, which is the reason this importer
 * exists at all and the reason it is simpler than the Spotify one: Tidal issues
 * a server-to-server token for catalog reads, so there is no user redirect, no
 * PKCE round trip and no per-listener authorisation. The credentials live only
 * in the server environment and are never sent to the browser.
 *
 * Access to the developer portal is invite/approval based, so an unconfigured
 * deployment must fail with a clear, actionable message rather than a raw 401
 * from Tidal.
 */

const API = "https://openapi.tidal.com/v2";
const TOKEN_URL = "https://auth.tidal.com/v1/oauth2/token";
const REQUEST_TIMEOUT_MS = 15_000;
/** Tidal's page size cap for playlist items. */
const PAGE_SIZE = 100;
/** Guard against a pathological link; a real playlist is far below this. */
const MAX_PAGES = 100;

interface TidalItem {
  item?: {
    id?: string | null;
    type?: string | null;
    title?: string | null;
    duration?: number | null;
    artists?: { name?: string }[];
    album?: { title?: string | null } | null;
    externalLinks?: { href?: string }[];
  } | null;
}

/** Fetch a client-credentials token, or fail with an actionable code. */
async function accessToken(): Promise<string> {
  const clientId = process.env.TIDAL_CLIENT_ID;
  const clientSecret = process.env.TIDAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new ImportError("not-configured");

  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ImportError("network");
  }
  if (response.status === 401 || response.status === 403) {
    // Tidal answered, and said no. That is a credential problem on our side,
    // not something the listener can retry.
    throw new ImportError("not-configured");
  }
  if (!response.ok) throw new ImportError("unknown");

  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new ImportError("unknown");
  return body.access_token;
}

async function tidalGet(
  path: string,
  token: string,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.api+json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new ImportError("network");
    }
    throw new ImportError("network");
  }

  // Tidal's status codes map onto the codes the UI already knows how to
  // explain, so no raw provider string ever reaches the listener.
  if (response.status === 401) throw new ImportError("not-configured");
  if (response.status === 429) throw new ImportError("rate-limited");
  if (response.status === 403) throw new ImportError("private");
  if (response.status === 404) throw new ImportError("not-found");
  if (!response.ok) throw new ImportError("unknown");

  return (await response.json()) as Record<string, unknown>;
}

/** Flatten one playlist entry. Tidal nests the track under `item`. */
function trackFromEntry(entry: TidalItem): NormalizedTrack | null {
  const inner = entry.item;
  // A removed or region-blocked entry keeps its position with `item: null`.
  // It must be reported as skipped, never imported as a blank row.
  if (!inner || inner.type !== "track") return null;
  const artists = (inner.artists ?? [])
    .map((a) => a.name ?? "")
    .filter(Boolean)
    .join(", ");
  return normalizeTrack({
    title: inner.title,
    artist: artists,
    album: inner.album?.title,
    // Tidal artwork is a separate cover endpoint rather than a field on the
    // track, so it is not fetched here; the app derives artwork on playback.
    durationMs:
      typeof inner.duration === "number" ? inner.duration * 1000 : undefined,
    source: "tidal",
    sourceId: inner.id,
  });
}

/**
 * Import a Tidal playlist by id.
 *
 * Paginates properly rather than stopping at the first page, caps the walk,
 * and reports how many listed tracks could not be imported instead of dropping
 * them silently.
 */
export const importPlaylist = action({
  args: { playlistId: v.string() },
  handler: async (_ctx, { playlistId }): Promise<ImportOutcome> => {
    const id = playlistId.trim();
    // Tidal ids are opaque alphanumerics; keep the check loose but non-empty.
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(id)) throw new ImportError("invalid-url");

    const token = await accessToken();
    const warnings: string[] = [];
    const meta = await tidalGet(`/playlists/${id}`, token);
    const name = (meta.title as string | undefined)?.trim() || "Tidal playlist";
    const declaredTotal = Number(meta.numberOfTracks as number | undefined);

    let next: string | undefined;
    let pages = 0;
    let seen = 0;
    const raw: NormalizedTrack[] = [];
    let skipped = 0;

    do {
      // `limit` is REQUIRED here, not decorative: Tidal's own default is 20
      // per page, so omitting it would have quietly imported a twentieth of
      // every playlist while still reporting success.
      const query = new URLSearchParams({
        page: next ?? "0",
        limit: String(PAGE_SIZE),
      });
      const page = await tidalGet(
        `/playlists/${id}/items?${query.toString()}`,
        token,
      );
      const data = (page.data as TidalItem[] | undefined) ?? [];
      for (const entry of data) {
        seen++;
        const track = trackFromEntry(entry);
        if (track) raw.push(track);
        else skipped++;
      }
      pages++;
      // Tidal returns the NEXT page index as a string, or null on the last page.
      const link = (page.links as { next?: string } | undefined)?.next;
      next = link && /^\d+$/.test(link) ? link : undefined;
      if (raw.length + skipped >= 10_000) break;
    } while (next && pages < MAX_PAGES);

    if (next && pages >= MAX_PAGES) {
      warnings.push(
        `Stopped after ${MAX_PAGES} pages. Very large playlists are imported in part.`,
      );
    }
    if (Number.isFinite(declaredTotal) && seen < declaredTotal) {
      warnings.push(
        `${declaredTotal - seen} more ${declaredTotal - seen === 1 ? "track is" : "tracks are"} listed but not returned.`,
      );
    }
    if (skipped > 0) {
      warnings.push(
        `${skipped} ${skipped === 1 ? "entry is" : "entries are"} unavailable in your region.`,
      );
    }

    const deduped = dedupeTracks(raw);
    return {
      name,
      origin: "Tidal",
      tracks: deduped.tracks,
      // A repeat and an unavailable track are both "not in your library", and
      // the user should hear the real number.
      skipped: deduped.skipped + skipped,
      partial: Boolean(next) || skipped > 0,
      warnings,
    };
  },
});
