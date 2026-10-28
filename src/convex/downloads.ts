import { v } from "convex/values";
import { action } from "./_generated/server";
import { authorizedProviderId, refuse, type DownloadRefusal } from "../lib/downloadAuth";
import { releaseFilename, resolveJamendoDownload } from "../lib/jamendoDownload";

/**
 * SYNQ's download API — the authority on what may be downloaded.
 *
 * ── What this is and is not ────────────────────────────────────────────────
 *
 * It authorizes ONE thing: Creative Commons audio that the artist has
 * explicitly released for download on Jamendo. It is deliberately incapable of
 * authorizing anything else — a request for a YouTube video id is refused
 * before any network call, because SYNQ holds a right to STREAM that upload and
 * no right to make a copy of it.
 *
 * ── Why the client is never trusted ────────────────────────────────────────
 *
 * The client sends only a SYNQ track id. The provider id is parsed server-side,
 * the provider is asked whether that specific release may be downloaded, and
 * the answer is a decision, not a URL the browser can substitute. The bytes
 * themselves are streamed through `/download-proxy`, which re-runs this exact
 * eligibility check for every ranged request, so even a hand-written proxy URL
 * cannot fetch an unauthorized file.
 *
 * The provider key stays in the server environment (`JAMENDO_CLIENT_ID`) and is
 * never returned to the caller.
 */

/** Read the provider key, or explain precisely what is missing. */
function clientId(): string | null {
  const id = process.env.JAMENDO_CLIENT_ID;
  return id && id.trim() ? id.trim() : null;
}

/**
 * Authorize a download, or explain why it cannot be authorized.
 *
 * Returns the file's format and licensing metadata. The provider's own URL is
 * deliberately NOT part of the response: the browser cannot fetch it anyway
 * (no CORS), and withholding it means the only way to obtain the bytes is the
 * proxy, which re-verifies this same permission.
 */
export const authorizeDownload = action({
  args: { trackId: v.string() },
  handler: async (
    ctx,
    { trackId },
  ): Promise<
    | {
        authorized: true;
        /** The licensed release this permission is for. */
        providerId: string;
        filename: string;
        contentType: string;
        licenseUrl: string;
        /** Attribution is a licence condition, so it travels with the file. */
        attribution: string;
      }
    | { authorized: false; decision: DownloadRefusal }
  > => {
    void ctx;
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
        decision: refuse("not-configured"),
      };
    }

    const resolved = await resolveJamendoDownload(providerId, key);
    if (!resolved.ok) return { authorized: false, decision: resolved.decision };

    const { release } = resolved;
    return {
      authorized: true,
      providerId: release.providerId,
      filename: releaseFilename(release),
      contentType: release.asset.contentType,
      licenseUrl: release.licenseUrl,
      attribution: release.attribution,
    };
  },
});
