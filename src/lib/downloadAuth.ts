// Relative import: this module is imported by the Convex action beside it, and
// the Convex bundler does not resolve the `@/` alias.
import type { ImportFailure } from "./importModel";

/**
 * SYNQ Downloads — who is allowed to download what.
 *
 * ── The rule this module exists to enforce ────────────────────────────────
 *
 * A playable `audioUrl` does NOT mean a track is downloadable. Almost
 * everything SYNQ can play is a stream SYNQ only ever received permission to
 * PLAY (YouTube uploads, catalog metadata services). Copying those bytes to
 * disk is not a feature, it is taking a download the rights holder did not
 * grant — so the previous download pipeline, which resolved InnerTube streams
 * and public Piped mirrors and pulled them down, was removed rather than
 * repaired.
 *
 * The one corpus SYNQ is genuinely authorized to hand out as files is Jamendo:
 * Creative Commons releases whose artists explicitly permit download. Jamendo
 * states that per track as `audiodownload_allowed`, so that flag — not the
 * presence of a URL — is the authority, and `convex/downloads.ts` re-verifies
 * it server-side on every request. A client cannot grant itself permission by
 * sending a URL.
 *
 * ── Why this half is pure ─────────────────────────────────────────────────
 *
 * Id parsing, eligibility, refusal copy and filename hygiene are all decisions
 * with no I/O, so they are unit-testable without a key, a network or a
 * browser. The server keeps the final word regardless.
 */

/** The prefix that marks a track as coming from an authorized source. */
export const AUTHORIZED_ID_PREFIX = "jamendo:";

/** Media type of the file Jamendo serves for an authorized download. */
export const AUTHORIZED_CONTENT_TYPE = "audio/mpeg";

/** Default extension when the provider does not name one. */
export const AUTHORIZED_EXTENSION = ".mp3";

/** Stable codes for every way a download can be turned down. */
export type DownloadRefusalCode =
  | "not-authorized"
  | "not-found"
  | "not-configured"
  | "rate-limited"
  | "network"
  | "invalid-request";

/** One refusal, with copy the UI can show verbatim. */
export interface DownloadRefusal {
  ok: false;
  code: DownloadRefusalCode;
  /** One honest sentence, safe to show a user. */
  message: string;
  /** True when retrying later could plausibly work. */
  retryable: boolean;
}

/** What a download request can end in. Never a thrown error at the UI edge. */
export type DownloadDecision = { ok: true; providerId: string } | DownloadRefusal;

/**
 * Pull the provider id out of a SYNQ track id.
 *
 * A track id is only downloadable when it is namespaced to an authorized
 * source. A bare YouTube video id returns `null` here, which is the first and
 * cheapest place an unauthorized track is turned away — before any network
 * call and before any bytes move.
 */
export function authorizedProviderId(trackId: string | null | undefined): string | null {
  if (!trackId) return null;
  const id = trackId.trim();
  if (!id.startsWith(AUTHORIZED_ID_PREFIX)) return null;
  const providerId = id.slice(AUTHORIZED_ID_PREFIX.length).trim();
  // Jamendo ids are numeric; anything else is not a track we issued.
  return /^\d+$/.test(providerId) ? providerId : null;
}

/** Build the SYNQ track id for an authorized-source track. */
export function authorizedTrackId(providerId: string | number): string {
  return `${AUTHORIZED_ID_PREFIX}${String(providerId).trim()}`;
}

/**
 * First-line eligibility check, run on the client so the menu can hide the
 * action instead of offering something that will be refused.
 *
 * Accepts either a SYNQ track id or, preferably, the full provenance of a
 * playable: a track PLAYS through its YouTube upload, but it is DOWNLOADABLE
 * through the Jamendo release it was discovered from. When `jamendoId` is
 * present it wins — a discovery-resolved upload would otherwise never be
 * eligible even though its original release is licensed for download.
 *
 * This is a UX filter, NOT a security control. The server independently
 * re-verifies `audiodownload_allowed`; a client that forges its way past this
 * function still gets a refusal.
 */
export function isTrackDownloadable(
  trackId: string | null | undefined,
  jamendoId?: string | null,
): boolean {
  return (
    authorizedProviderId(jamendoId ?? undefined) !== null ||
    authorizedProviderId(trackId) !== null
  );
}

/**
 * The id the download API should be asked about. Prefers the Jamendo release
 * id when the playable carries one, since that is the release the artist
 * licensed for download.
 */
export function downloadTargetId(
  trackId: string | null | undefined,
  jamendoId?: string | null,
): string | null {
  if (jamendoId && authorizedProviderId(jamendoId) !== null) {
    return authorizedTrackId(jamendoId);
  }
  return authorizedProviderId(trackId) !== null ? trackId! : null;
}

/**
 * Turn a provider id into a safe download filename.
 *
 * Path separators and control characters are stripped rather than escaped,
 * because this string becomes both a Content-Disposition filename and an OPFS
 * entry name — a traversal attempt must not survive either use.
 */
export function authorizedFilename(
  providerId: string,
  title: string,
  artistName: string,
): string {
  const clean = (value: string) =>
    value
      .replace(/[\\/:*?"<>|]/g, "-")
      .replace(/\p{C}/gu, "")
      .replace(/\s+/g, " ")
      .trim();
  const parts = [artistName, title].map(clean).filter(Boolean);
  const stem = parts.length > 0 ? parts.join(" - ") : `track-${providerId}`;
  const capped = stem.slice(0, 120) || `track-${providerId}`;
  return capped.endsWith(AUTHORIZED_EXTENSION)
    ? capped
    : `${capped}${AUTHORIZED_EXTENSION}`;
}

/** Messages for every way a download can be refused, in SYNQ's own voice. */
export const DOWNLOAD_MESSAGES: Record<DownloadRefusalCode, string> = {
  "not-authorized": "Downloads aren't available for this track.",
  "not-found": "That track is no longer available for download.",
  "not-configured": "Downloads aren't set up on this deployment yet.",
  "rate-limited": "Too many download requests just now. Try again shortly.",
  network: "Couldn't reach the audio source. Check your connection and retry.",
  "invalid-request": "That track can't be downloaded.",
};

/** Build a refusal with the canonical message and the right retry hint. */
export function refuse(
  code: DownloadRefusalCode,
  message?: string,
): DownloadRefusal {
  const retryable = code === "rate-limited" || code === "network";
  return { ok: false, code, message: message ?? DOWNLOAD_MESSAGES[code], retryable };
}

/** Map a provider failure shape onto the refusal the listener should see. */
export function refusalFromFailure(failure: ImportFailure): DownloadRefusal {
  switch (failure.code) {
    case "rate-limited":
      return refuse("rate-limited", failure.message);
    case "network":
      return refuse("network", failure.message);
    case "not-configured":
      return refuse("not-configured", failure.message);
    case "empty":
      return refuse("not-found", failure.message);
    case "invalid-url":
    case "unsupported":
      return refuse("invalid-request", failure.message);
    default:
      // Anything else (private, auth-*, unknown) is simply "not ours to give".
      return refuse("not-authorized", failure.message);
  }
}

/** What the UI needs to render a Download action, per track. */
export interface DownloadAvailability {
  /** Show the action at all. */
  allowed: boolean;
  /** Refusal to explain a hidden action, or to explain a failed press. */
  decision: DownloadDecision;
}

/**
 * Availability for a track. Only tracks from an authorized source are ever
 * eligible; every other track gets the honest refusal above.
 */
export function downloadAvailability(
  trackId: string | null | undefined,
  jamendoId?: string | null,
): DownloadAvailability {
  if (isTrackDownloadable(trackId, jamendoId)) {
    return { allowed: true, decision: { ok: true, providerId: jamendoId ?? authorizedProviderId(trackId)! } };
  }
  return { allowed: false, decision: refuse("not-authorized") };
}