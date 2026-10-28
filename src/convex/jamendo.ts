import { v } from "convex/values";
import { action } from "./_generated/server";
import {
  emptyResult,
  httpQuotaFailure,
  networkFailure,
  normalizeTracks,
  notConfiguredFailure,
  unwrap,
  type JamendoTrack,
} from "../lib/jamendo";
import type { ImportFailure } from "../lib/importModel";

/**
 * Jamendo playback source.
 *
 * The one provider in this app that can actually be PLAYED rather than only
 * read. Spotify, Apple Music and Tidal are catalog APIs with no audio endpoint
 * for third-party apps, so their imports resolve against YouTube; a Jamendo
 * track carries its own stream URL and plays through the `<audio>` element the
 * player already uses for non-YouTube sources.
 *
 * Endpoint: GET /v3.0/tracks, authenticated with a bare `client_id` query
 * parameter. No OAuth, no redirect, no secret — the key is read from the server
 * environment and never reaches the browser.
 *
 * Two things about this API that dictate the whole design:
 *
 * 1. IT REPORTS FAILURES INSIDE HTTP 200. A bad key, a rate-limit wall and a
 *    successful empty search all come back 200 with a different
 *    `headers.status`. Checking `response.ok` alone produces an integration
 *    that looks wired up and silently returns nothing forever. Every response
 *    therefore goes through `unwrap`.
 * 2. ITS LIMITS ARE NOT PUBLISHED. Jamendo documents a free "Read only" plan
 *    but does not state a number, and the widely-cited figures are folklore.
 *    So no limit is hardcoded as if it were fact: this file keeps its own
 *    conservative budget to stay a good citizen, and treats the provider's own
 *    rate-limit response as the authoritative signal.
 * 3. IT SOMETIMES ANSWERS A GOOD QUERY WITH A SUCCESSFUL NOTHING. Measured
 *    against a live key, roughly a third of calls for a query with thousands
 *    of matches come back `status: "success"`, `code: 0`, an EMPTY
 *    `error_message` and zero rows. Taken at face value that is "no results",
 *    and it is indistinguishable from a genuine miss at the HTTP level. So an
 *    empty page is treated as a failed attempt and retried before the listener
 *    is told a search found nothing — see `MAX_EMPTY_ATTEMPTS`.
 */

const API = "https://api.jamendo.com/v3.0/tracks/";
const REQUEST_TIMEOUT_MS = 15_000;

/** Our own budget, not Jamendo's. Deliberately well under any plausible free
 *  tier; the upstream response is what actually ends a quota, this just avoids
 *  spending it on a listener hammering the search box.
 *
 *  Counted in UPSTREAM CALLS, not searches, so that the empty-result retries
 *  below cannot quietly triple the load we put on a free key. */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

/** How many upstream calls one search may cost. See `attemptOnce`. */
const MAX_EMPTY_ATTEMPTS = 3;

/** Hard ceiling on rows asked for. Jamendo's own max is 200; a search result
 *  list does not need that many and each row carries a waveform blob. */
const MAX_LIMIT = 25;

function checkRateLimit(key: string): { ok: boolean; retryAfterMs: number } {
  const now = Date.now();
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { ok: true, retryAfterMs: 0 };
  }
  if (bucket.count >= RATE_MAX) {
    return { ok: false, retryAfterMs: bucket.resetAt - now };
  }
  bucket.count += 1;
  return { ok: true, retryAfterMs: 0 };
}

/**
 * What the UI renders. A discriminated union rather than a thrown error,
 * because "Jamendo isn't configured" and "Jamendo's quota is spent" are two
 * different screens with two different pieces of advice, and neither is an
 * exception the caller should have to dig a message out of.
 */
export type JamendoSearchResult =
  | { ok: true; tracks: JamendoTrack[] }
  | { ok: false; failure: ImportFailure; retryAfterMs?: number };

/** Read the key, or explain precisely what is missing. */
function clientId(): string | null {
  const id = process.env.JAMENDO_CLIENT_ID;
  return id && id.trim() ? id.trim() : null;
}

export const searchJamendo = action({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
  },
  /** Returns a result object rather than throwing, so every state is explicit. */
  handler: async (ctx, args): Promise<JamendoSearchResult> => {
    const id = clientId();
    if (!id) return { ok: false, failure: notConfiguredFailure() };

    const query = args.query.trim();
    if (!query) return { ok: false, failure: emptyResult() };

    // Rate limit per caller, falling back to a shared bucket when signed out
    // rather than letting anonymous traffic draw from an unlimited line.
    const identity = await ctx.auth.getUserIdentity();
    const key = `jamendo:${identity?.subject ?? "anon"}`;

    const url = new URL(API);
    url.searchParams.set("client_id", id);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", String(clampLimit(args.limit)));
    url.searchParams.set("search", query);
    // Without this Jamendo returns album tracks only, so every single the
    // listener could plausibly want is silently invisible.
    url.searchParams.set("type", "single albumtrack");
    // One track per artist: a search for "love" returning nine tracks by one
    // artist is a bad result, not a generous one.
    url.searchParams.set("groupby", "artist_id");
    url.searchParams.set("include", "musicinfo");
    // mp31 is Jamendo's low-bitrate stream, which is the one meant for
    // embedding. `audiodownload` is deliberately never requested: this app
    // streams, it does not download, and artists can withdraw download rights
    // per track via `audiodownload_allowed`.
    url.searchParams.set("audioformat", "mp31");

    /**
     * One upstream call, returning either a normalised page or a failure.
     *
     * Split out of the handler because a search may need more than one of
     * these, and the request/parse logic must not drift between attempts.
     */
    const attemptOnce = async (): Promise<JamendoSearchResult> => {
      const limit = checkRateLimit(key);
      if (!limit.ok) {
        return {
          ok: false,
          failure: {
            code: "rate-limited",
            message: "Too many Jamendo searches just now.",
            retryable: true,
            hint: "Give it a minute — SYNQ pauses after 20 Jamendo calls a minute to stay inside the free tier.",
          },
          retryAfterMs: limit.retryAfterMs,
        };
      }

      let response: Response;
      try {
        response = await fetch(url.toString(), {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        return { ok: false, failure: networkFailure() };
      }

      // A real 429 is the one status worth special-casing, and it is the
      // authoritative "your quota is gone" signal.
      if (response.status === 429) {
        return { ok: false, failure: httpQuotaFailure() };
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { ok: false, failure: networkFailure() };
      }

      // The important one: a 200 that contains a failure.
      const unwrapped = unwrap(body);
      if (!unwrapped.ok) {
        return { ok: false, failure: unwrapped.failure ?? networkFailure() };
      }
      return { ok: true, tracks: normalizeTracks(unwrapped.results) };
    };

    for (let attempt = 0; attempt < MAX_EMPTY_ATTEMPTS; attempt++) {
      const outcome = await attemptOnce();
      // A failure is final and must NOT be retried: turning a quota wall or a
      // bad key into three wasted calls would only make a real problem worse.
      if (!outcome.ok) return outcome;
      if (outcome.tracks.length > 0) return outcome;
      // A clean success with zero rows is retried — see MAX_EMPTY_ATTEMPTS.
    }

    return { ok: false, failure: emptyResult() };
  },
});

/** A malformed or hostile limit must not become an unbounded scan. */
function clampLimit(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 10;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(raw)));
}

/**
 * Whether Jamendo is usable at all, for the UI to check before offering it.
 * Lets the search surface say "not connected" instead of failing on click.
 */
export const jamendoConfigured = action({
  args: {},
  handler: async (): Promise<{ configured: boolean }> => {
    return { configured: clientId() !== null };
  },
});
