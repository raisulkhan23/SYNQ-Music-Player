/**
 * A user-supplied stream resolver.
 *
 * WHY THIS EXISTS — THE SHORT VERSION. SYNQ streams YouTube audio. Every
 * resolver that lives on a SERVER is bot-blocked by YouTube, and this is not a
 * bug that can be coded around:
 *
 *  - `youtube:resolveStream` runs on Convex, so YouTube sees a datacenter IP
 *    and answers `"Sign in to confirm you're not a bot"`. Verified against the
 *    deployed backend on a mainstream music video: `url: null`.
 *  - Public Piped mirrors resolve the same way, from their own datacenter IPs.
 *    Verified: `api.piped.private.coffee` returns HTTP 500 for every mainstream
 *    music video, with a body naming
 *    `SignInConfirmNotBotException: YouTube probably temporarily blocked
 *    anonymous watch access with this IP`. The 200s that DO come back are
 *    cached oddities; a widely-streamed video can return 200 while every real
 *    track returns 500.
 *  - Public Invidious instances are down or IP-blocked (403/401/502 measured).
 *  - Calling InnerTube from the browser is not an option: HTTP 403 and, more
 *    fundamentally, no CORS headers, so the response is unreadable by `fetch`.
 *  - The IFrame API player is the only thing that plays, precisely because it
 *    is not a resolver. It runs as a real signed-in browser session on the
 *    LISTENER's IP, so YouTube has no reason to block it. Its audio is
 *    cross-origin and cannot be read back out of it, so it cannot be saved.
 *
 * So the routes are: no resolver at all, or a resolver on a network YouTube
 * does not block. This module is the second one, and it accepts ANY
 * self-hosted Piped-compatible address — the listener's own machine, a box on
 * their LAN, a VPS they own, a residential-network relay. None of those is
 * special-cased. What matters is only that YouTube does not refuse that
 * network's IP, and that the browser can actually reach the URL.
 *
 * WHY THAT SECOND CONDITION NEEDS ITS OWN CODE. Localhost is the one address
 * the browser treats as trustworthy even over plain HTTP, because
 * `http://localhost` and `http://127.0.0.0/8` are "potentially trustworthy"
 * origins and so are exempt from mixed-content blocking. Every other host is
 * not. On an HTTPS page — which is how the app is normally served — the
 * browser refuses `http://box:8080` outright, before a single packet leaves
 * the device, and hands `fetch` an error indistinguishable from "server down".
 * Untreated, that sends people to fix a server that is running perfectly, so it
 * is detected up front and named as what it is. See `mixedContentBlocked`.
 *
 * WHAT IT IS NOT. This is not a workaround that pretends a public mirror will
 * start working. It is an explicit, user-owned dependency, stored locally and
 * never sent anywhere except the host the user typed.
 */

/** localStorage key. Namespaced like the other `ss.*` preferences. */
export const CUSTOM_RESOLVER_KEY = "ss.customResolver";

/**
 * A Piped-compatible API base.
 *
 * Any http(s) address is accepted — `http://localhost:8080`, a bare LAN IP, a
 * hostname, or `https://piped.example.com` behind a reverse proxy. There is no
 * localhost allowlist, because the constraint was never "where it runs"; it is
 * "can the browser reach it, and will YouTube serve it". This function's only
 * job is to guarantee the value is safe to store and safe to hand to `fetch`.
 *
 * The URL is stored in the clear on purpose: it is an address the user typed,
 * it never leaves the device, and it is what makes the feature work.
 */
function sanitise(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  // Only http(s), and no trailing slash, so joining a path never doubles up.
  if (!/^https?:\/\//i.test(trimmed)) return "";
  let parsed: URL;
  try {
    parsed = new URL(trimmed.replace(/\/+$/, ""));
  } catch {
    return "";
  }
  // A scheme with no host fails to parse in most engines but not all; refuse
  // it explicitly rather than letting it become a fetch against an empty host.
  if (!parsed.hostname) return "";
  // Credentials in the URL would be persisted to localStorage in the clear and
  // echoed into any message that quotes the address. Not supported.
  if (parsed.username || parsed.password) return "";
  // Reassembled rather than returned raw, so what gets stored is always a
  // canonical absolute URL and cannot smuggle whitespace or a second scheme.
  const path = parsed.pathname === "/" ? "" : parsed.pathname;
  return `${parsed.protocol}//${parsed.host}${path}${parsed.search}`;
}

/** The user's resolver, or "" when they have not set one. */
export function readCustomResolver(): string {
  try {
    return sanitise(localStorage.getItem(CUSTOM_RESOLVER_KEY) ?? "");
  } catch {
    // Private-mode Safari and locked-down embeds throw on storage access. The
    // feature degrades to "no custom resolver", which is the pre-existing
    // behaviour, so it must not take the app down.
    return "";
  }
}

/** Persist a resolver. Returns what was actually stored, after sanitising. */
export function writeCustomResolver(raw: string): string {
  const value = sanitise(raw);
  try {
    if (value) localStorage.setItem(CUSTOM_RESOLVER_KEY, value);
    else localStorage.removeItem(CUSTOM_RESOLVER_KEY);
  } catch {
    /* nothing to do; the value simply will not persist */
  }
  return value;
}

/** Clear the configured resolver. */
export function clearCustomResolver(): void {
  try {
    localStorage.removeItem(CUSTOM_RESOLVER_KEY);
  } catch {
    /* already unavailable */
  }
}

/**
 * Check a resolver without downloading a track's worth of audio.
 *
 * A dedicated "test" matters here because the whole point is to let someone
 * confirm their own resolver works BEFORE waiting on a download. It asks for
 * one real video and reports what came back, keeping apart the outcomes that
 * each call for a different fix: the address is malformed, the browser refused
 * it as mixed content, the host is unreachable, the host answers but YouTube is
 * blocking its IP, or it simply works.
 */
export type ResolverCheck =
  | { ok: true; detail: string }
  | {
      ok: false;
      reason:
        | "unreachable"
        | "blocked"
        | "no-stream"
        | "invalid"
        | "mixed-content";
      detail: string;
    };

/**
 * Hosts the browser considers secure even when spoken to over plain HTTP.
 *
 * These are the "potentially trustworthy origins": `localhost` and the whole
 * `127.0.0.0/8` loopback range, plus `::1`. Mixed-content rules exempt them,
 * which is the entire reason a loopback resolver works from an HTTPS page while
 * a LAN address on HTTP does not.
 */
function isTrustworthyHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/** Is the page itself served over HTTPS? Unknown means "assume yes is safe". */
function pageIsSecure(): boolean {
  try {
    return typeof location !== "undefined" && location.protocol === "https:";
  } catch {
    return false;
  }
}

const MIXED_CONTENT_DETAIL =
  "This page is HTTPS, so the browser blocks plain-HTTP requests before they leave the device — no request ever reaches your server, which is why it looks like the server is down. Put it behind HTTPS (a domain with a certificate), or run it on localhost, which browsers trust over plain HTTP.";

/**
 * Would the browser block this URL as mixed content, before any request?
 *
 * This is the single biggest difference between a loopback resolver and a
 * remote one, and it is invisible: the browser refuses the request locally and
 * reports the same opaque network error it reports for a dead host. Detecting
 * it up front is what lets the UI say "put it behind HTTPS" instead of "your
 * server is unreachable".
 */
function mixedContentBlocked(url: string): boolean {
  if (!pageIsSecure()) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  return !isTrustworthyHost(parsed.hostname);
}

/** A well-known video that is a stable, public, non-age-gated target. */
const PROBE_VIDEO_ID = "dQw4w9WgXcQ";

/**
 * YouTube's bot-check, as it appears in a resolver's response.
 *
 * Matched against both the error body and the successful body, because Piped
 * reports this as HTTP 500 with the exception named in the payload, and other
 * extractors have been seen to return 200 with the same message. Both mean the
 * same thing: this network's IP is blocked, and the resolver is fine.
 */
const BOT_CHECK =
  /SignInConfirmNotBot|not a bot|LOGIN_REQUIRED|bot.?check/i;

const BLOCKED_DETAIL =
  "It answered, but YouTube is refusing that network's IP. A VPS address is blocked just like a data-centre one — Piped's own docs recommend routing it through an IPv6 rotator or a VPN, or running it on a residential connection.";

export async function checkCustomResolver(
  base: string,
  timeoutMs = 8_000,
): Promise<ResolverCheck> {
  const url = sanitise(base);
  if (!url) {
    return { ok: false, reason: "invalid", detail: "That is not an http(s) address." };
  }

  // Refused by the browser, not by the network — so say so before spending a
  // request that cannot succeed.
  if (mixedContentBlocked(url)) {
    return { ok: false, reason: "mixed-content", detail: MIXED_CONTENT_DETAIL };
  }

  let data: {
    title?: string;
    audioStreams?: { url: string }[];
    videoStreams?: { url: string; videoOnly?: boolean }[];
  };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${url}/streams/${PROBE_VIDEO_ID}`, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      // An error STATUS is not the end of the story. Piped reports YouTube's
      // bot-check as HTTP 500 with the exception named in the body, so
      // returning here would call an IP-blocked resolver "unreachable" and
      // send the user to fix a server that is running perfectly well. Read the
      // body first and let the bot-check check below claim it.
      let text = "";
      try {
        text = await res.text();
      } catch {
        /* an unreadable body is still a usable status */
      }
      if (BOT_CHECK.test(text)) {
        return {
          ok: false,
          reason: "blocked",
          detail: BLOCKED_DETAIL,
        };
      }
      return {
        ok: false,
        reason: "unreachable",
        detail: `The resolver answered HTTP ${res.status}.`,
      };
    }
    data = (await res.json()) as typeof data;
  } catch (err) {
    return {
      ok: false,
      reason: "unreachable",
      detail:
        err instanceof Error
          ? `Could not reach it (${err.message}). Is it running, and does it allow this origin?`
          : "Could not reach it.",
    };
  }

  // Piped surfaces YouTube's bot-check as a 500 whose body names the exception.
  // That is NOT the same as an unreachable resolver, and telling someone their
  // server is down when YouTube is blocking its IP would send them chasing the
  // wrong problem — which is exactly the mistake this whole feature exists to
  // avoid.
  if (BOT_CHECK.test(JSON.stringify(data))) {
    return {
      ok: false,
      reason: "blocked",
      detail: BLOCKED_DETAIL,
    };
  }

  const hasStream =
    (data.audioStreams ?? []).some((s) => !!s.url) ||
    (data.videoStreams ?? []).some((s) => !!s.url && s.videoOnly === false);
  if (!hasStream) {
    return {
      ok: false,
      reason: "no-stream",
      detail: "It answered, but returned no playable stream for the test video.",
    };
  }

  return {
    ok: true,
    detail: `Connected — ${data.title ? `resolved “${data.title}”` : "test video resolved"}.`,
  };
}
