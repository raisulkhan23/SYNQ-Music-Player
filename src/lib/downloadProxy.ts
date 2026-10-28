// Relative import: this module is used by the Convex HTTP router, which does
// not resolve path aliases.
import { refuse, type DownloadRefusal } from "./downloadAuth";
import type { DownloadResolution } from "./jamendoDownload";

/**
 * The same-origin byte proxy for authorized downloads.
 *
 * ── Why a proxy exists at all ──────────────────────────────────────────────
 *
 * Jamendo licenses these files for download, but its storage host answers
 * without `Access-Control-Allow-Origin`, so a browser `fetch` cannot read a
 * single byte of them. A server-side hop is the only way to put a genuinely
 * licensed file into OPFS. This is a narrow streaming relay, not an open
 * proxy: it takes a numeric provider id, re-verifies the release server-side,
 * and can only ever reach a validated Jamendo download URL.
 *
 * ── What it forwards ───────────────────────────────────────────────────────
 *
 * Only `Range`. No cookies, no authorization, no client-supplied host, no
 * client-supplied URL — which is what keeps it from being usable as an SSRF
 * gadget or an unrestricted mirror. The final URL after redirects is validated
 * again, so a provider redirect cannot walk the relay somewhere else.
 */

export type ProxyResolver = (providerId: string) => Promise<DownloadResolution>;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Shared CORS surface for the relay. */
export function proxyCorsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers":
      "Content-Range, Content-Length, Accept-Ranges",
    "Cache-Control": "no-store",
  };
}

const STATUS_BY_CODE: Record<DownloadRefusal["code"], number> = {
  "not-authorized": 403,
  "not-found": 404,
  "not-configured": 503,
  "rate-limited": 429,
  network: 502,
  "invalid-request": 400,
};

/** Preflight, so the browser can send `Range`. */
export function downloadProxyPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...proxyCorsHeaders(),
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Range",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function failure(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      ...proxyCorsHeaders(),
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

/** `bytes=0-1023` and `bytes=0-` are the only shapes worth forwarding. */
function forwardableRange(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return /^bytes=\d+-\d*$/.test(trimmed) ? trimmed : null;
}

export async function handleDownloadProxy(
  request: Request,
  deps: { resolve: ProxyResolver; fetchImpl?: FetchLike },
): Promise<Response> {
  if (request.method === "OPTIONS") return downloadProxyPreflight();
  if (request.method !== "GET") {
    return failure(405, "Only GET is supported");
  }

  const url = new URL(request.url);
  const providerId = (url.searchParams.get("track") ?? "").trim();
  if (!/^\d+$/.test(providerId)) {
    return failure(400, "A numeric track id is required");
  }

  const resolved = await deps.resolve(providerId);
  if (!resolved.ok) {
    return failure(
      STATUS_BY_CODE[resolved.decision.code] ?? 502,
      resolved.decision.message,
    );
  }
  const asset = resolved.release.asset;

  const range = forwardableRange(request.headers.get("range"));
  const fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));

  let upstream: Response;
  try {
    upstream = await fetchImpl(asset.url, {
      headers: range ? { Range: range } : {},
      redirect: "follow",
      // The provider must never see the listener's session, and there is no
      // session to send: this is a plain public asset fetch.
    });
  } catch {
    return failure(502, "Couldn't reach the audio source");
  }

  // A redirect is followed by fetch, so the URL it actually landed on is the
  // one that matters. It has to be the same validated provider host.
  let finalUrl: URL;
  try {
    finalUrl = new URL(upstream.url || asset.url);
  } catch {
    return failure(502, "The audio source returned an invalid location");
  }
  if (
    finalUrl.protocol !== "https:" ||
    !/^(?:prod-\d+\.)?storage\.jamendo\.com$/i.test(finalUrl.hostname)
  ) {
    return failure(502, "The audio source redirected somewhere unexpected");
  }

  if (upstream.status >= 400) {
    return failure(
      502,
      `The audio source refused the request (HTTP ${upstream.status})`,
    );
  }

  const headers = new Headers(proxyCorsHeaders());
  // The provider labels MP3s as text/html, which is wrong and would be copied
  // straight into a misleading download. The validated format decides it.
  headers.set("Content-Type", asset.contentType);
  headers.set("X-Content-Type-Options", "nosniff");
  for (const name of [
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
  ] as const) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  // A 206 without Accept-Ranges would make the resume logic distrust a
  // perfectly good ranged response.
  if (upstream.status === 206 && !headers.has("accept-ranges")) {
    headers.set("Accept-Ranges", "bytes");
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}

/** Used by the router when the deployment has no provider key at all. */
export const notConfiguredResolver: ProxyResolver = async () => ({
  ok: false,
  decision: refuse("not-configured"),
});
