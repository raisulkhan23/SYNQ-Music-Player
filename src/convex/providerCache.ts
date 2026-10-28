import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";

/**
 * Shared provider infrastructure: a TTL metadata cache, an in-flight request
 * deduplicator, and a rate limiter.
 *
 * WHY THIS EXISTS. Every YouTube/InnerTube lookup used to be a fresh network
 * round trip. Typing the same query twice, opening the app twice, or a
 * re-render that re-resolved a stream all paid full price against an upstream
 * that is aggressively rate limited and answers rate limits with a datacenter
 * bot check (see `youtube.ts`). Three things fix that without touching the UI:
 *
 *  - `cacheKey` + `cacheGet`/`cachePut` — same question, same answer.
 *  - `beginRequest`/`endRequest` — concurrent identical questions collapse to
 *    one upstream call instead of N.
 *  - `takeRateSlot` — a per-key budget so a retry storm cannot turn into a
 *    flood.
 *
 * WHAT IS DELIBERATELY NOT HERE.
 *
 *  - No PO-token minting. A PO token exists solely to prove a request came
 *    from a genuine YouTube web client; generating one outside that client is
 *    anti-bot circumvention. SYNQ streams through the clients it already uses
 *    and falls back cleanly when they are refused. See §12 of the spec.
 *
 *  - No caching of stream URLs beyond their short TTL. A signed
 *    `streamingData` URL is a bearer credential for that media; a long-lived
 *    cache entry would be a stored credential. `streamUrlTtlSeconds` is
 *    deliberately minutes, not hours.
 *
 *  - No caching of anything credential-shaped at all. `cacheKey` hashes its
 *    inputs, so a row can never contain a secret even by accident.
 */

/** TTL by kind. Search changes fastest; track identity is near-static. */
export const TTL = {
  /** Search results — a new release makes these stale quickly. */
  search: 10 * 60,
  /** A single track's metadata. */
  track: 6 * 60 * 60,
  /** Album / playlist membership. */
  collection: 12 * 60 * 60,
  /** Artist metadata. */
  artist: 24 * 60 * 60,
  /**
   * An artist's release list. Long, because a discography changes only when
   * the artist releases something — and re-reading it on every visit is what
   * made the Browse endpoint feel slow.
   */
  artistCatalog: 12 * 60 * 60,
  /** One page of a release's tracklist. */
  releaseTracks: 12 * 60 * 60,
  /**
   * Signed stream URLs. These are bearer credentials for the media itself, so
   * this is short on purpose. When it lapses the client simply asks for a new
   * one — playback is unaffected because `resolveStream` is called per track.
   */
  streamUrl: 5 * 60,
} as const;

export type CacheKind = keyof typeof TTL;

/**
 * A stable key for a provider call.
 *
 * Arguments are sorted so `{a:1,b:2}` and `{b:2,a:1}` are one cache entry
 * rather than two, then hashed so no argument value — least of all anything
 * credential-shaped — is ever stored in the key column.
 */
export function cacheKey(
  provider: string,
  kind: CacheKind,
  args: Record<string, unknown>,
): string {
  const canonical = Object.keys(args)
    .sort()
    .map((k) => `${k}=${JSON.stringify(args[k] ?? null)}`)
    .join("&");
  return `${provider}:${kind}:${fnv1a(canonical)}`;
}

/** FNV-1a. Small, dependency-free, and good enough to key a cache. */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

export const cacheGet = query({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const row = await ctx.db
      .query("providerCache")
      .withIndex("byKey", (q) => q.eq("key", key))
      .unique();
    if (!row) return null;
    if (row.expiresAt <= Date.now()) return null;
    return { value: row.value, provider: row.provider, fetchedAt: row.fetchedAt };
  },
});

export const cachePut = internalMutation({
  args: {
    key: v.string(),
    value: v.any(),
    provider: v.string(),
    ttlSeconds: v.number(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const ttl = Math.max(0, args.ttlSeconds);
    const existing = await ctx.db
      .query("providerCache")
      .withIndex("byKey", (q) => q.eq("key", args.key))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        value: args.value,
        provider: args.provider,
        fetchedAt: now,
        expiresAt: now + ttl * 1000,
      });
      return;
    }
    await ctx.db.insert("providerCache", {
      key: args.key,
      value: args.value,
      provider: args.provider,
      fetchedAt: now,
      expiresAt: now + ttl * 1000,
    });
  },
});

/** Housekeeping for `crons.ts`. Expired rows are pure waste. */
export const cachePrune = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    let removed = 0;
    const cap = args.limit ?? 500;
    const expired = await ctx.db
      .query("providerCache")
      .withIndex("byExpiry", (q) => q.lte("expiresAt", now))
      .take(cap);
    for (const row of expired) {
      await ctx.db.delete(row._id);
      removed++;
    }
    return removed;
  },
});

// ---------------------------------------------------------------------------
// In-flight deduplication
// ---------------------------------------------------------------------------

/**
 * Collapse concurrent identical upstream calls into one.
 *
 * Two components mounting at once, or a user double-submitting, would
 * otherwise fire two identical InnerTube searches inside the same few
 * hundred milliseconds — exactly the pattern that gets a client rate limited.
 *
 * This is process-local on purpose. A Convex action has no shared memory
 * across invocations, and a shared store would mean paying a database round
 * trip to save a network round trip. It still removes the common case (React
 * strict-mode double effects, double clicks, sibling components) at zero cost.
 */
const inFlight = new Map<string, Promise<unknown>>();

export function dedupeRequest<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;

  const started = run().finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, started);
  return started as Promise<T>;
}

/** Test seam: how many calls are currently collapsed. */
export function inFlightCount(): number {
  return inFlight.size;
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

/** Per-key request budget. */
const BUDGET = new Map<string, number[]>();
/**
 * Requests allowed per key per window. Deliberately generous — this is a
 * guard against loops and retry storms, not a quota. It must never be the
 * thing that makes normal use feel broken.
 */
export const RATE_WINDOW_MS = 60_000;
export const RATE_MAX_PER_WINDOW = 30;

export interface RateDecision {
  allowed: boolean;
  /** Milliseconds until the next slot frees up. */
  retryAfterMs: number;
}

/** Take a slot for `key`, or refuse with a backoff hint. */
export function takeRateSlot(key: string): RateDecision {
  const now = Date.now();
  const hits = (BUDGET.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  if (hits.length >= RATE_MAX_PER_WINDOW) {
    BUDGET.set(key, hits);
    return {
      allowed: false,
      retryAfterMs: Math.max(0, RATE_WINDOW_MS - (now - hits[0]!)),
    };
  }
  hits.push(now);
  BUDGET.set(key, hits);
  return { allowed: true, retryAfterMs: 0 };
}

/** Test seam. */
export function resetRateBudget(): void {
  BUDGET.clear();
}

/**
 * Exponential backoff with full jitter.
 *
 * Jitter matters: without it, every client that hit a rate limit at the same
 * moment retries at the same moment, and the retry storm is what keeps the
 * limit in place. Capped so a caller can never be parked indefinitely.
 */
export function backoffMs(attempt: number, base = 500, cap = 30_000): number {
  const exponential = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.floor(Math.random() * exponential);
}

/** Retry only what is worth retrying. A 404 will still be a 404. */
export function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}