// ---------------------------------------------------------------------------
// Vector-powered candidates for the recommender.
//
// WHY THIS FILE EXISTS. The music vector database and the recommendation
// engine were built independently and never connected: `recommend.ts` scored
// candidates that came only from upstream text searches, while the vector store
// was reachable from exactly one page, /discover. The engine could therefore
// only ever find music by matching an artist or title STRING. It could not
// answer the only question that actually matters for a recommender — "what does
// this sound like?" — and adding the vector database changed nothing a listener
// could observe on Home or in autoplay.
//
// This closes that gap. It is a separate file rather than more of
// `recommend.ts`, for two reasons: `recommend.ts` is already the densest file
// in the app, and keeping the vector import behind one small surface means the
// "is the library indexed?" question has exactly one answer.
//
// EVERY failure here is non-fatal by construction. An un-indexed library, a
// missing record, an embedder failure — all return "no candidates", and the
// caller falls back to the existing text-search pool. The recommender must
// never be worse because a vector index is cold.
// ---------------------------------------------------------------------------

import { v } from "convex/values";
import { action, type ActionCtx } from "./_generated/server";
import { api } from "./_generated/api";
import { ConvexVectorStore } from "./convexVectorStore";
import { HashingEmbedder, MusicVectorDB } from "../lib/musicdb";
import type { RecoCandidate, CandidateSeed } from "../lib/recommend";

/** How many recent plays are used as similarity seeds. */
const MAX_SEED_TRACKS = 5;
/** How many neighbours to pull per seed before de-duplication. */
const PER_SEED_LIMIT = 12;
/** Hard ceiling on vector candidates handed back, regardless of index size. */
const MAX_VECTOR_CANDIDATES = 24;

/**
 * The seed that describes where the vector candidates came from.
 *
 * Its `query` is never sent upstream — these candidates come out of the index,
 * not out of a search — but the scorer requires a seed for attribution and the
 * section assembler groups by seed, so one is still needed.
 */
export const VECTOR_SEED: CandidateSeed = {
  query: "",
  source: "vector_sound_alike",
  weight: 0.9,
  seed: "vector:sound-alike",
  reason: "similar_song",
};

/**
 * Library tracks that sound like what the listener has been playing.
 *
 * Returns an empty array — never throws — when the library is not indexed, so
 * the caller can merge the result unconditionally.
 */
export const vectorCandidates = action({
  args: {
    seedTrackIds: v.array(v.string()),
    excludeIds: v.optional(v.array(v.string())),
    limit: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ candidates: RecoCandidate[]; reason: string | null }> => {
    const identity = (await ctx.auth.getUserIdentity()) as {
      subject?: string;
    } | null;
    const ownerId = identity?.subject;
    if (!ownerId) return { candidates: [], reason: null };

    const exclude = new Set(args.excludeIds ?? []);
    const limit = Math.max(
      1,
      Math.min(args.limit ?? MAX_VECTOR_CANDIDATES, 60),
    );
    const seeds = args.seedTrackIds
      .map((id) => id.trim())
      .filter((id) => id && !exclude.has(id))
      .slice(0, MAX_SEED_TRACKS);
    if (seeds.length === 0) return { candidates: [], reason: null };

    let db: MusicVectorDB;
    try {
      db = buildDb(ctx, ownerId);
    } catch {
      return { candidates: [], reason: null };
    }

    // A cold index is the normal state for a new account, not an error.
    try {
      const existing = await db.store.list({ limit: 1 });
      if (existing.length === 0) return { candidates: [], reason: null };
    } catch {
      return { candidates: [], reason: null };
    }

    const seen = new Set<string>(exclude);
    const out: RecoCandidate[] = [];
    let matchedSeed: string | null = null;

    for (const seedId of seeds) {
      if (out.length >= limit) break;
      let neighbours: Awaited<ReturnType<MusicVectorDB["similar"]>>;
      try {
        neighbours = await db.similar({
          trackId: seedId,
          limit: PER_SEED_LIMIT,
        });
      } catch {
        // One bad seed must not abandon the others.
        continue;
      }
      for (const hit of neighbours) {
        if (out.length >= limit) break;
        const properties = (hit.record.properties ?? {}) as Record<
          string,
          unknown
        >;
        const youtubeId =
          typeof properties["youtubeId"] === "string" &&
          properties["youtubeId"].trim()
            ? properties["youtubeId"].trim()
            : "";
        const title =
          typeof properties["title"] === "string"
            ? properties["title"].trim()
            : "";
        const artist =
          typeof properties["artist"] === "string"
            ? properties["artist"].trim()
            : "";
        const duration =
          typeof properties["duration"] === "number" &&
          Number.isFinite(properties["duration"])
            ? properties["duration"]
            : 0;

        // Everything below is the same contract `resolvePool` enforces for
        // search results: no id, no title or no duration means it cannot be
        // PLAYED, and a row the listener can click but that does nothing is
        // worse than an absent row.
        //
        // The id is the YouTube id, not the vector record id, because the rest
        // of the app treats `RecoCandidate.id` as a playable video id. A record
        // with no `youtubeId` is therefore dropped rather than surfaced as an
        // unplayable card.
        if (!youtubeId || !title || duration <= 0) continue;
        if (seen.has(youtubeId)) continue;
        seen.add(youtubeId);
        matchedSeed ??= seedId;

        out.push({
          id: youtubeId,
          title,
          artist,
          duration: Math.round(duration),
          thumbnail:
            typeof properties["coverUrl"] === "string"
              ? properties["coverUrl"]
              : "",
          album:
            typeof properties["album"] === "string" &&
            properties["album"].trim()
              ? properties["album"].trim()
              : undefined,
        });
      }
    }

    return { candidates: out, reason: matchedSeed };
  },
});

/** The shared store construction. Scoped to `ownerId` on every read. */
function buildDb(ctx: ActionCtx, ownerId: string): MusicVectorDB {
  return new MusicVectorDB({
    store: new ConvexVectorStore(
      {
        listRecords: (args) =>
          ctx.runQuery(api.libraryVectors.listRecords, args),
        recordByTrack: (args) =>
          ctx.runQuery(api.libraryVectors.recordByTrack, args),
        saveRecords: (args) =>
          ctx.runMutation(api.libraryVectors.saveRecords, args),
        removeRecords: (args) =>
          ctx.runMutation(api.libraryVectors.removeRecords, args),
      },
      ownerId,
    ),
    embedder: new HashingEmbedder(),
  });
}
