/**
 * Spotify authorisation, PKCE flavour.
 *
 * SYNQ reads playlists; it never plays Spotify audio. Reading a playlist is
 * still a user-authorised endpoint — Spotify will not serve one to a
 * client-credentials token — so the user has to authorise SYNQ once. PKCE is
 * the flow Spotify recommends for exactly this case, and it is the reason
 * nothing secret has to exist:
 *
 *  - The client id is a PUBLIC identifier. A PKCE app has no client secret at
 *    all, so there is nothing to leak, nothing to hide in a server, and no
 *    secret to rotate.
 *  - The token exchange happens in a Convex action, never with a secret.
 *  - The access token is held in memory for the duration of the import and is
 *    never written to the database or to localStorage.
 *
 * Pure helpers only; the network calls live in `convex/spotify.ts`.
 */

import type { PlaylistService } from "./sources";

export const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
export const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";

/** Only what SYNQ actually needs, and nothing that can write. */
export const SPOTIFY_SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative",
];

/** Spotify ids are 22 base62 characters. */
const SPOTIFY_ID_RE = /^[A-Za-z0-9]{22}$/;

export function isSpotifyId(id: string | null | undefined): boolean {
  return typeof id === "string" && SPOTIFY_ID_RE.test(id);
}

/**
 * Pull the playlist id out of any Spotify link shape.
 *
 * Users paste share links, `spotify:playlist:…` URIs, embed URLs and mobile
 * deep links; all of them carry the same 22-character id somewhere.
 */
export function extractSpotifyId(input: string): string | null {
  const uri = input.match(/spotify:playlist:([A-Za-z0-9]+)/i)?.[1];
  if (isSpotifyId(uri)) return uri!;
  const path = input.match(/\/playlist\/([A-Za-z0-9]+)/i)?.[1];
  if (isSpotifyId(path)) return path!;
  const query = input.match(/[?&]playlist=([A-Za-z0-9]+)/i)?.[1];
  if (isSpotifyId(query)) return query!;
  return null;
}

const base64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

const randomBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
};

/**
 * S256 challenge for a verifier. Async because SHA-256 is.
 *
 * Kept separate from challenge creation so the caller can persist the verifier
 * across the redirect without recomputing anything.
 */
export async function pkceChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64url(new Uint8Array(digest));
}

/** A fresh verifier plus the challenge derived from it. */
export async function createPkcePair(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: await pkceChallenge(verifier) };
}

export interface AuthorizeOptions {
  clientId: string;
  /** Where Spotify sends the browser back; must be allow-listed in the app. */
  redirectUri: string;
  challenge: string;
  verifier: string;
}

/** The URL that starts the authorisation. */
export function buildAuthorizeUrl({
  clientId,
  redirectUri,
  challenge,
}: AuthorizeOptions): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: SPOTIFY_SCOPES.join(" "),
    code_challenge_method: "S256",
    code_challenge: challenge,
    state: "",
  });
  return `${SPOTIFY_AUTHORIZE_URL}?${params.toString()}`;
}

/**
 * Read the `code` back out of the callback URL.
 *
 * Spotify reports a refusal in the query string too, and treating that as a
 * missing code is how "the user pressed Cancel" turns into "try again".
 */
export function readAuthCallback(
  url: string,
): { ok: true; code: string } | { ok: false; reason: "denied" | "malformed" } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const error = parsed.searchParams.get("error");
  if (error) return { ok: false, reason: "denied" };
  const code = parsed.searchParams.get("code");
  if (!code) return { ok: false, reason: "malformed" };
  return { ok: true, code };
}

/** Which importer a normalised track belongs to — used by the outcome mapper. */
export const SPOTIFY_SOURCE: PlaylistService = "spotify";
