/**
 * Browser-side stream resolution through public Piped instances.
 *
 * WHY THIS EXISTS ALONGSIDE THE CONVEX RESOLVER. `youtube:resolveStream` runs
 * on the Convex backend, so YouTube sees a datacenter IP and frequently answers
 * `"Sign in to confirm you're not a bot"` — that is the bot-check, and it is
 * why the Convex path alone could not download anything. Piped resolves from
 * the LISTENER'S OWN IP and sends CORS headers itself, so it is neither
 * bot-blocked nor a cross-origin problem for the page.
 *
 * WHY IT IS A SEPARATE MODULE. This logic used to live inline inside
 * `resolveYoutubeStream` in the player store, so the download path could not
 * reach it and had no way to resolve a stream when the backend was
 * bot-blocked. Playback worked and downloading did not, for the same track, at
 * the same moment. One implementation, used by both, is what stops that drift
 * coming back.
 *
 * WHY IT REPORTS A REASON INSTEAD OF `null`. This used to return a bare
 * `string | null`, and every failure looked identical to the caller. That is
 * how a dead third-party instance ended up surfacing to the user as YouTube's
 * bot-check: the caller had nothing to say except the backend's reason, so the
 * one message shown was the one that was least likely to be the true cause. A
 * `null` here now always carries why, so a download failure can name the thing
 * that actually broke.
 *
 * WHAT COMES BACK. An audio-only stream where Piped offers one, otherwise the
 * lowest-resolution MUXED stream — Piped now strips audio-only formats for many
 * videos, and only the audio track is wanted here. It is NOT wrapped in
 * `/audio-proxy`: Piped already serves the CORS headers the fetch needs, so
 * routing it through the proxy would add a hop and a failure mode for nothing.
 */

import { readCustomResolver } from "@/lib/customResolver";

/**
 * Public Piped instances, tried in order.
 *
 * This list is the result of probing every instance on the official TeamPiped
 * list (15 of them) and keeping only the ones that actually answer. Run
 * `bun scripts/audit.piped.instances.ts` to re-probe and refresh it.
 *
 * The four that were removed were not removed for being slow, and not because
 * they refused me — they are gone for the listener too:
 *
 *     adminforge.de    HTTP 403   Cloudflare HTML, not the API
 *     kavin.rocks      HTTP 526   invalid SSL certificate
 *     reallyaweso.me   HTTP 502   upstream gone
 *     leptons.xyz      HTTP 502   upstream gone
 *
 * Nine further official instances (nosebs.ru, piped-api.privacy.com.de,
 * api.piped.yt, drgns.space, owo.si, codespace.cz, darkness.services,
 * orangenet.cc, pipedapi-libre.kavin.rocks) no longer resolve in DNS at all,
 * so they were never added. That is the whole public network right now: two
 * hosts, and a rotation is the only defence against both disappearing.
 *
 * WHAT WAS DELIBERATELY NOT PRUNED. Both survivors are frequently answered by
 * YouTube with `SignInConfirmNotBotException` — for some videos, from some IPs.
 * That is a verdict about the caller's IP reputation, not evidence the host is
 * down, and these instances resolve normally for the same video from a
 * residential connection. Pruning on that basis would have emptied the list
 * while the one working fallback was still in it.
 *
 * ORDER IS BY MEASURED SPEED, ducks.party first: 761ms average against
 * private.coffee's 1149ms over repeated probes of the same video. Since the
 * first instance to answer ends the search, putting the slower one second is
 * worth roughly 390ms of perceived start-up on every track that resolves.
 */
const PIPED_INSTANCES = [
  "https://pipedapi.ducks.party",
  "https://api.piped.private.coffee",
] as const;

/**
 * The user's own resolver, if they configured one.
 *
 * Tried FIRST, and deliberately not merged into the public list: it is the
 * only entry that is expected to work, so a failure here is worth reporting
 * on its own rather than lumped in with mirrors that are blocked by YouTube.
 */
function customInstance(): string | null {
  const custom = readCustomResolver();
  return custom || null;
}

/** The user's resolver first, then the public mirrors. */
function instanceList(): string[] {
  const custom = customInstance();
  return custom ? [custom, ...PIPED_INSTANCES] : [...PIPED_INSTANCES];
}

/**
 * Per-instance resolve budget. Short, because a dead host must not stall us.
 *
 * Down from 6000ms. The slowest instance that actually works answers in
 * ~1200ms, so 4000ms leaves generous headroom for a slow-but-alive mirror
 * while cutting the cost of a dead one by a third.
 */
const RESOLVE_TIMEOUT_MS = 4_000;

/**
 * Ceiling for the WHOLE mirror search, not per instance.
 *
 * The per-instance timeout alone does not bound anything. These are tried
 * SEQUENTIALLY, so the worst case is `instances x per-instance timeout` —
 * with the previous six-entry list that was up to 36 seconds of a track
 * sitting silent, and callers outside the player's 1.2s race (the download
 * path, `prepareIncoming`) waited the full amount. A list of dead mirrors
 * should cost a moment, not half a minute.
 *
 * Eight seconds comfortably covers both live instances answering normally
 * while guaranteeing the search ends promptly. Whichever instance is in flight
 * when the budget expires is aborted rather than left to finish.
 */
const RESOLVE_BUDGET_MS = 8_000;

export interface PipedResolutionFailure {
  /** The instance that was tried, host only — enough to identify it. */
  instance: string;
  /** What it actually did: a status, a network error, or an empty result. */
  detail: string;
}

export interface PipedResolution {
  url: string | null;
  /** Every instance's outcome, in the order tried. Empty when `url` is set. */
  failures: PipedResolutionFailure[];
}

const hostOf = (base: string): string => base.replace(/^https?:\/\//, "");

/**
 * Resolve `videoId` to a stream URL through public Piped instances.
 *
 * Returns `{ url: null, failures }` rather than throwing: every failure here is
 * an expected, recoverable condition (an instance is down, rate-limited, or has
 * no stream for this video), and the caller has a better fallback to try than
 * an exception is.
 */
export async function resolveViaPiped(
  videoId: string,
  /**
   * Cancels the whole search. Used by the caller that RACES this against the
   * Convex resolver: when Convex wins, this request is abandoned rather than
   * left running, so a success there does not spend one of the two surviving
   * Piped instances' requests for nothing.
   */
  signal?: AbortSignal,
): Promise<PipedResolution> {
  if (!videoId || typeof fetch !== "function") {
    return { url: null, failures: [] };
  }
  if (signal?.aborted) return { url: null, failures: [] };

  const failures: PipedResolutionFailure[] = [];

  const deadline = Date.now() + RESOLVE_BUDGET_MS;

  for (const base of instanceList()) {
    const host = hostOf(base);

    // Checked BEFORE starting a fetch, never after: beginning a request we
    // have no time left to hear the answer to is exactly how a mirror list
    // turns into a stall. Whatever is left is reported rather than skipped
    // silently, so "the budget ran out" stays distinguishable from "that
    // instance was broken" in the failures the caller shows a person.
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      failures.push({
        instance: host,
        detail: "not tried: resolve budget spent",
      });
      break;
    }

    // Cancelled between instances: stop before starting another request.
    if (signal?.aborted) break;

    let res: Response;
    try {
      const ctrl = new AbortController();
      const onOuterAbort = () => ctrl.abort();
      signal?.addEventListener("abort", onOuterAbort, { once: true });
      // An instance can never outlive the overall budget, not even the first.
      const timer = setTimeout(
        () => ctrl.abort(),
        Math.min(RESOLVE_TIMEOUT_MS, remaining),
      );
      try {
        res = await fetch(`${base}/streams/${videoId}`, {
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onOuterAbort);
      }
    } catch (err) {
      // A network error, a DNS failure, an aborted timeout, or a CORS block —
      // all indistinguishable from here, and all "this instance is no use".
      failures.push({
        instance: host,
        detail: err instanceof Error ? err.message : "network error",
      });
      continue;
    }

    if (!res.ok) {
      failures.push({ instance: host, detail: `HTTP ${res.status}` });
      continue;
    }

    let data: {
      audioStreams?: { url: string; bitrate?: number; mimeType?: string }[];
      videoStreams?: {
        url: string;
        quality?: string;
        videoOnly?: boolean;
        mimeType?: string;
      }[];
    } & { proxyUrl?: string };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      failures.push({ instance: host, detail: "malformed JSON" });
      continue;
    }

    // Preferred: a dedicated audio-only stream (best bitrate first).
    const audio = (data.audioStreams ?? [])
      .filter((s) => !!s.url && (!s.mimeType || s.mimeType.includes("audio")))
      .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
    if (audio[0]?.url) return { url: audio[0].url, failures: [] };

    // Piped strips audio-only formats for most videos now, so the fallback is
    // a MUXED stream. Which one is picked decides whether playback streams or
    // stalls, and the label tells you nothing — so rank by what was MEASURED:
    //
    //   player.odycdn.com        video/mp4   136ms first 64KB  ~470 KB/s  CORS: *
    //   piped-proxy.ducks.party  video/mp4   923ms first 64KB   ~69 KB/s  (403s
    //                                                       without its cookies)
    //
    // 69 KB/s is under what one 128 kbps audio track needs, and the
    // piped-proxy host answers 403 to anything that is not a browser holding
    // its cookies. The old rank sorted on `parseInt(quality)`, which reads
    // "LBRY" as NaN→9999 and "360p" as 360, so it ALWAYS chose the 69 KB/s
    // piped-proxy entry over the 470 KB/s odycdn one. That ordering is the
    // constant-buffering report.
    const isCorsDirect = (url: string): boolean => {
      try {
        // odycdn is LBRY-backed and serves `access-control-allow-origin: *`,
        // so an <audio crossOrigin="anonymous"> element can read it with no
        // proxy hop at all.
        const h = new URL(url).host;
        return h === "odycdn.com" || h.endsWith(".odycdn.com");
      } catch {
        return false;
      }
    };
    const proxyUrl = data.proxyUrl;
    const muxed = (data.videoStreams ?? [])
      .filter(
        (s): s is typeof s & { url: string } =>
          !!s.url &&
          s.videoOnly !== true &&
          (!s.mimeType ||
            s.mimeType.includes("mp4") ||
            s.mimeType.includes("webm")),
      )
      .map((s) => {
        let hostname = "";
        try {
          hostname = new URL(s.url).host;
        } catch {
          /* unparseable — ranked as neither direct nor proxied */
        }
        return {
          ...s,
          hostname,
          corsDirect: isCorsDirect(s.url),
          throughInstanceProxy: hostname.includes("piped-proxy."),
        };
      })
      .sort((a, b) => {
        // 1. A CORS-direct host wins: no extra hop, and measured ~7x the
        //    throughput of the instance's own proxy.
        if (a.corsDirect !== b.corsDirect) return a.corsDirect ? -1 : 1;
        // 2. The instance's own proxy goes LAST — it measured slowest and it
        //    rejects any client it did not hand a cookie to.
        if (a.throughInstanceProxy !== b.throughInstanceProxy)
          return a.throughInstanceProxy ? 1 : -1;
        // 3. Only then does the resolution label decide, and only between
        //    streams whose labels are actually comparable.
        return (
          (parseInt(a.quality ?? "0", 10) || 9999) -
          (parseInt(b.quality ?? "0", 10) || 9999)
        );
      });

    const best = muxed[0];
    if (!best) {
      // The instance answered, and had nothing for us. Piped returns HTTP 200
      // with empty stream lists for videos it cannot extract, so this is a
      // real per-video outcome rather than a broken host.
      failures.push({ instance: host, detail: "no audio or muxed stream" });
      continue;
    }

    // A CORS-direct stream plays WITHOUT the proxy: it already sends the header
    // the <audio crossOrigin="anonymous"> element needs, and routing it through
    // /audio-proxy would add a hop and a failure mode for nothing.
    if (best.corsDirect) return { url: best.url, failures: [] };

    // Anything else is routed through /audio-proxy, which adds the missing CORS
    // headers. Piped's own proxyUrl is preferred as the upstream when it is
    // advertised, because the instance is then responsible for fetching it.
    if (proxyUrl && proxyUrl.startsWith("http")) {
      try {
        const target = new URL(best.url);
        return {
          url: `${import.meta.env.VITE_CONVEX_URL?.replace(".cloud", ".site") ?? ""}/audio-proxy?u=${encodeURIComponent(target.origin + target.pathname)}${target.search ? "&" + target.search.slice(1) : ""}`,
          failures: [],
        };
      } catch {
        failures.push({ instance: host, detail: "bad proxy target url" });
        continue;
      }
    }

    // No proxy advertised: the stream is used directly.
    return { url: best.url, failures: [] };
  }

  return { url: null, failures };
}
