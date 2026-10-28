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
 * Apple Music importer, using Apple's supported catalog API.
 *
 * Apple requires a "developer token": a short-lived ES256 JWT signed with a
 * private key from the Apple Developer portal. That private key is the reason
 * this whole file lives on the server: it is read from the environment here and
 * is never bundled, never sent to the browser, and never returned by an action.
 *
 *   GET /v1/catalog/{storefront}/playlists/{id}
 *
 * The storefront comes out of the URL the user pasted (`…/us/playlist/…`), so
 * no separate configuration is needed for it.
 *
 * Apple is a METADATA source here. Like Spotify, it is not an audio source,
 * and nothing here pretends otherwise — the tracks are stored as title/artist
 * and resolved for playback the way every imported playlist already is.
 */

const REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_TTL_SECONDS = 50 * 60; // Apple caps this at an hour; stay well under.
const MAX_PAGES = 100;

const base64url = (input: ArrayBuffer | Uint8Array | string): string => {
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

/**
 * Build the developer token.
 *
 * ES256 signatures come out of WebCrypto as the raw r‖s pair Apple expects,
 * which is why this is plain WebCrypto rather than a JWT library.
 */
async function developerToken(): Promise<string> {
  const teamId = process.env.APPLE_MUSIC_TEAM_ID;
  const keyId = process.env.APPLE_MUSIC_KEY_ID;
  const privateKey = process.env.APPLE_MUSIC_PRIVATE_KEY;
  if (!teamId || !keyId || !privateKey) throw new ImportError("not-configured");

  const header = base64url(
    JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }),
  );
  const now = Math.floor(Date.now() / 1000);
  const payload = base64url(
    JSON.stringify({
      iss: teamId,
      iat: now,
      exp: now + TOKEN_TTL_SECONDS,
      aud: "https://appleid.apple.com",
    }),
  );
  const signingInput = `${header}.${payload}`;

  // Apple hands out the key as PEM, possibly with the literal \n escapes that
  // survive a trip through an environment variable.
  const pem = privateKey.replace(/\\n/g, "\n");
  const der = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const keyBytes = Uint8Array.from(atob(der), (c) => c.charCodeAt(0));

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "pkcs8",
      keyBytes,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new ImportError(
      "not-configured",
      "Apple Music's private key couldn't be read. Check APPLE_MUSIC_PRIVATE_KEY.",
    );
  }

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64url(signature)}`;
}

interface AppleTrack {
  id?: string;
  type?: string;
  attributes?: {
    name?: string;
    artistName?: string;
    albumName?: string;
    durationInMillis?: number;
    url?: string;
    artwork?: { url?: string; width?: number };
    playParams?: { id?: string };
  };
}

async function appleGet(
  path: string,
  token: string,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`https://api.music.apple.com${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ImportError("network");
  }
  if (response.status === 401) throw new ImportError("auth-required");
  if (response.status === 403) throw new ImportError("private");
  if (response.status === 404) throw new ImportError("not-found");
  if (response.status === 429) throw new ImportError("rate-limited");
  if (!response.ok) throw new ImportError("unknown");
  return (await response.json()) as Record<string, unknown>;
}

/** Apple artwork needs a size in the path; 600px is the largest they serve. */
function artworkAt(url: string | undefined, size: number): string | undefined {
  if (!url) return undefined;
  return url.replace("{w}", String(size)).replace("{h}", String(size));
}

function trackFromItem(item: AppleTrack): NormalizedTrack | null {
  const attributes = item.attributes ?? {};
  return normalizeTrack({
    title: attributes.name,
    // Apple reports one primary artist on the track. Multi-artist features
    // appear as separate "songs", which is Apple's own model, so it is kept
    // rather than merged into something Apple never said.
    artist: attributes.artistName,
    album: attributes.albumName,
    artwork: artworkAt(attributes.artwork?.url, 600),
    durationMs: attributes.durationInMillis,
    source: "apple-music",
    sourceId: item.id,
    sourceUrl: attributes.url,
  });
}

export const importPlaylist = action({
  args: {
    playlistId: v.string(),
    /** "us", "gb", … — taken from the pasted URL. */
    storefront: v.string(),
  },
  handler: async (_ctx, { playlistId, storefront }): Promise<ImportOutcome> => {
    const id = playlistId.trim();
    if (!/^pl\.[A-Za-z0-9-]+$/.test(id)) throw new ImportError("invalid-url");
    const store = storefront.trim().toLowerCase();
    if (!/^[a-z]{2}$/.test(store)) throw new ImportError("invalid-url");

    const token = await developerToken();
    const warnings: string[] = [];
    const meta = await appleGet(
      `/v1/catalog/${store}/playlists/${encodeURIComponent(id)}`,
      token,
    );
    const attributes = (meta.attributes ?? {}) as {
      name?: string;
      curatorName?: string;
    };
    const name = attributes.name?.trim() || "Apple Music playlist";

    let next: string | undefined;
    let pages = 0;
    let skipped = 0;
    const raw: NormalizedTrack[] = [];

    do {
      const path = `/v1/catalog/${store}/playlists/${encodeURIComponent(
        id,
      )}/tracks?limit=100${next ? `&offset=${next}` : ""}`;
      const page = await appleGet(path, token);
      const data = (page.data ?? []) as AppleTrack[];
      for (const item of data) {
        const track = trackFromItem(item);
        if (track) raw.push(track);
        else skipped++;
      }
      pages++;
      next = (page.next as string | undefined) ?? undefined;
      if (raw.length + skipped >= 10_000) break;
    } while (next && pages < MAX_PAGES);

    if (next && pages >= MAX_PAGES) {
      warnings.push(
        `Stopped after ${MAX_PAGES} pages. Very large playlists are imported in part.`,
      );
    }
    if (attributes.curatorName) {
      warnings.push(`Curated by ${attributes.curatorName}.`);
    }

    const deduped = dedupeTracks(raw);
    return {
      name,
      origin: "Apple Music",
      tracks: deduped.tracks,
      skipped: deduped.skipped + skipped,
      partial: Boolean(next) || skipped > 0,
      warnings,
    };
  },
});
