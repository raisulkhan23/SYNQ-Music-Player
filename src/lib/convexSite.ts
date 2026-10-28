/**
 * The Convex site origin, shared by the two streaming relays.
 *
 * Convex serves HTTP actions from the `.site` host of the same deployment the
 * client talks to over `.cloud`; `VITE_CONVEX_URL` only names the latter. This
 * is already how the audio proxy is addressed, and downloads need exactly the
 * same origin — so the derivation lives in one place instead of being copied
 * into every caller and drifting.
 */
export function convexSiteUrl(): string {
  const raw = (import.meta.env?.VITE_CONVEX_URL as string | undefined) ?? "";
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.replace(".cloud", ".site");
}

/**
 * Where the browser asks for an authorized download's bytes.
 *
 * Empty when the deployment URL is unknown. A caller must treat that as "the
 * relay is not configured" rather than guessing a host: a wrong guess would
 * silently point a transfer at someone else's server.
 */
export function downloadProxyUrl(providerId: string): string {
  const base = convexSiteUrl();
  if (!base) return "";
  return `${base}/download-proxy?track=${encodeURIComponent(providerId)}`;
}
