import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove
      following: v.optional(v.array(v.id("users"))), // social follows
      // Cold-start taste picks from the "What are you into?" onboarding.
      // Optional forever: an account that never saw onboarding has no taste,
      // which is different from an empty one.
      taste: v.optional(
        v.object({
          artists: v.array(v.string()),
          moods: v.array(v.string()),
        }),
      ),
      /** True once the listener has completed or dismissed onboarding. */
      onboardingDone: v.optional(v.boolean()),
    }).index("email", ["email"]), // index for the email. do not remove or modify

    /**
     * Music vector records, one per (user, track).
     *
     * Durable storage for the vector database so results survive a container
     * restart and are identical on every instance — an in-memory store would
     * silently drop a listener's index and serve different results depending
     * on which replica answered.
     *
     * Scoped by `ownerId` (the auth subject). A user's listening-derived
     * vectors are their own: the Discover search always filters on this field,
     * so one listener can never read another's history through search.
     *
     * `signature` is a hash of the metadata that produced the vectors. It is
     * what makes re-sync cheap and idempotent: an unchanged track is skipped
     * rather than re-embedded, so syncing a 2000-track library does not
     * re-run the embedder over all of it every time.
     */
    vectorRecords: defineTable({
      ownerId: v.string(),
      trackId: v.string(),
      /** Full music metadata for this item. */
      properties: v.any(),
      /** Typed vectors: { audio: number[], lyrics: number[], ... } */
      vectors: v.any(),
      /** Embedding provenance per vector type (spec §13). */
      versions: v.any(),
      /** Hash of the metadata that produced these vectors. */
      signature: v.string(),
      createdAt: v.number(),
      updatedAt: v.number(),
    })
      .index("by_owner_track", ["ownerId", "trackId"])
      .index("by_owner", ["ownerId"]),

    // catalog track ids liked by a user (ordered by when they were liked)
    likedSongs: defineTable({
      userId: v.id("users"),
      trackId: v.string(), // id of the track in the SYNQ demo catalog
      createdAt: v.number(),
    })
      .index("by_user_track", ["userId", "trackId"])
      .index("by_user", ["userId"]),

    // playback snapshots for liked remote tracks (YouTube/Spotify chart items
    // that don't exist in the catalog), keyed by the same trackId as likedSongs
    likedRemote: defineTable({
      userId: v.id("users"),
      trackId: v.string(),
      title: v.string(),
      artistName: v.string(),
      coverUrl: v.string(),
      duration: v.number(),
      youtubeId: v.optional(v.string()),
      source: v.string(),
      createdAt: v.number(),
    })
      .index("by_user_track", ["userId", "trackId"])
      .index("by_user", ["userId"]),

    // Saved smart playlists: a RULE SET recomputed on open, not a track list.
    // `rules` mirrors lib/smartPlaylists.ts SmartRules exactly. Kept as a typed
    // object rather than v.any() so a malformed write is rejected at the
    // boundary instead of surfacing as a broken playlist later.
    smartPlaylists: defineTable({
      userId: v.id("users"),
      name: v.string(),
      rules: v.object({
        source: v.string(),
        minPlays: v.number(),
        maxPlays: v.number(),
        withinDays: v.number(),
        notWithinDays: v.number(),
        artist: v.string(),
        title: v.string(),
        limit: v.number(),
        sort: v.string(),
      }),
      createdAt: v.number(),
      updatedAt: v.number(),
    }).index("by_user", ["userId"]),

    // user-created playlists referencing track ids (any source)
    playlists: defineTable({
      userId: v.id("users"),
      name: v.string(),
      description: v.optional(v.string()),
      trackIds: v.array(v.string()),
      // Durable display/playback metadata. Optional so existing playlists stay
      // valid; new saves never rely on a fragile id-only lookup later.
      trackSnapshots: v.optional(
        v.array(
          v.object({
            id: v.string(),
            title: v.string(),
            artist: v.string(),
            album: v.optional(v.string()),
            coverUrl: v.string(),
            duration: v.number(),
            youtubeId: v.optional(v.string()),
          }),
        ),
      ),
      createdAt: v.number(),
      updatedAt: v.number(),
    }).index("by_user", ["userId"]),

    // Playlist sharing: one row per (playlist, recipient) grant. view-only by
    // design — the owner keeps the only edit rights, which the per-mutation
    // ownership checks in playlists.ts already enforce. `saved` is the
    // recipient's Library reference and is INDEPENDENT of access: removing
    // the reference (saved=false) must not revoke access, and revoking the
    // grant (row deleted) removes both at once. Anonymous sessions are
    // ephemeral, so they are never valid recipients.
    playlistShares: defineTable({
      playlistId: v.id("playlists"),
      ownerId: v.id("users"),
      recipientId: v.id("users"),
      saved: v.boolean(),
      createdAt: v.number(),
    })
      .index("by_playlist", ["playlistId"])
      .index("by_recipient", ["recipientId"])
      .index("by_grant", ["playlistId", "recipientId"]),

    // listening history: one row per user+track, updated on every play.
    // Covers ALL sources — remote plays store a title/artist/cover snapshot.
    playHistory: defineTable({
      userId: v.id("users"),
      trackId: v.string(), // opaque per-source id (youtube video id, etc.)
      playedAt: v.number(),
      playCount: v.number(),
      source: v.optional(v.string()),
      title: v.optional(v.string()),
      artistName: v.optional(v.string()),
      coverUrl: v.optional(v.string()),
      duration: v.optional(v.number()),
    })
      .index("by_user_track", ["userId", "trackId"])
      .index("by_user_playedAt", ["userId", "playedAt"])
      .index("by_user", ["userId"]),

    // One row per individual play. playHistory is an upsert per track (so
    // replaying a song only bumps a counter), which made time-based stats
    // impossible — analytics read from this append-only log instead.
    playEvents: defineTable({
      userId: v.id("users"),
      trackId: v.string(),
      playedAt: v.number(),
      source: v.optional(v.string()),
      title: v.optional(v.string()),
      artistName: v.optional(v.string()),
      // Engagement fields, added later than the table itself. Optional so
      // every event written before this change stays valid and still counts
      // as a play — they are unknown, not zero.
      albumName: v.optional(v.string()),
      /** 0..1 — how much of the track was actually heard. */
      completion: v.optional(v.number()),
      listenedSeconds: v.optional(v.number()),
      /** True when the listener left before the track ended. */
      skipped: v.optional(v.boolean()),
      /** How the play was started: user | autoplay | recommendation | radio. */
      origin: v.optional(v.string()),
      /** Set once recordEngagement has applied this play's outcome. */
      engagedAt: v.optional(v.number()),
    })
      .index("by_playedAt", ["playedAt"])
      .index("by_user", ["userId"])
      // Lets recordEngagement find the exact play it is correcting instead of
      // guessing from a track id alone.
      .index("by_user_playedAt", ["userId", "playedAt"]),

    // Derived per-track engagement summary, one row per user+track.
    // The recommendation engine needs skip counts and a completion ratio for
    // scoring, and recomputing those by scanning playEvents would mean reading
    // a listener's entire event log on every recommendation request. This is
    // maintained incrementally by history.recordPlay, so the profile query
    // stays inside a bounded read budget no matter how long someone listens.
    trackSignals: defineTable({
      userId: v.id("users"),
      trackId: v.string(),
      title: v.optional(v.string()),
      artistName: v.optional(v.string()),
      albumName: v.optional(v.string()),
      plays: v.number(),
      skips: v.number(),
      /** Sum of completion ratios over non-skipped plays. */
      completionSum: v.number(),
      /**
       * How many of `plays` actually reached an outcome. A play that is still
       * open (the tab was closed mid-song) is counted in `plays` but not here,
       * so the completion ratio stays honest instead of being dragged down by
       * listens that were never measured.
       */
      settledPlays: v.number(),
      firstPlayedAt: v.number(),
      lastPlayedAt: v.number(),
    })
      .index("by_user_track", ["userId", "trackId"])
      .index("by_user", ["userId"])
      .index("by_user_lastPlayedAt", ["userId", "lastPlayedAt"]),

    // What the engine recommended, and what actually happened to it.
    // This is the feedback loop (phase 14): a recommendation that is then
    // completed or liked raises artist affinity, while one that is skipped or
    // pulled from the queue lowers it. Rows are private to their user and are
    // read only server-side by the recommendation actions.
    recommendationEvents: defineTable({
      userId: v.id("users"),
      trackId: v.string(),
      title: v.optional(v.string()),
      artistName: v.optional(v.string()),
      albumName: v.optional(v.string()),
      /** Which Home section produced it, or "autoplay" / "next_track". */
      section: v.string(),
      /** RecoReason — derived from the term that actually scored highest. */
      reason: v.string(),
      /** CandidateSource that produced the candidate. */
      source: v.optional(v.string()),
      /** Human-readable seed for the debug view. */
      seed: v.optional(v.string()),
      score: v.optional(v.number()),
      /** Full ScoreBreakdown, kept for tuning and debug. */
      breakdown: v.optional(v.any()),
      createdAt: v.number(),
      /** Set once an outcome is known; null while still undecided. */
      settledAt: v.optional(v.number()),
      outcome: v.optional(v.string()),
      /** user | autoplay | recommendation | radio */
      origin: v.optional(v.string()),
    })
      .index("by_user", ["userId"])
      .index("by_user_createdAt", ["userId", "createdAt"]),

    // Short-lived server-side cache for Home recommendation payloads.
    // Recommendation generation makes upstream searches, so caching keeps the
    // Home page from re-running it on every visit. `expiresAt` is enforced on
    // read, and a cache miss or a failure always falls back to a fresh run —
    // the cache can only ever make things faster, never wrong-by-omission.
    recommendationCache: defineTable({
      userId: v.id("users"),
      key: v.string(), // section set fingerprint, e.g. "home:v3"
      payload: v.any(),
      computedAt: v.number(),
      expiresAt: v.number(),
    })
      .index("by_user_key", ["userId", "key"])
      .index("by_user", ["userId"]),

    // playlists imported from other music services. Tracks are stored as
    // snapshots (title + artist) and resolved to playable YouTube tracks at
    // play time — so a CSV export from any provider works without OAuth.
    // audit trail of playlist changes (rename, add/remove tracks, delete)
    playlistEvents: defineTable({
      userId: v.id("users"),
      playlistId: v.id("playlists"),
      playlistName: v.string(),
      kind: v.string(), // "created" | "renamed" | "added" | "removed" | "deleted"
      detail: v.optional(v.string()), // e.g. track title
      at: v.number(),
    }).index("by_playlist", ["playlistId"]),

    // social: who follows whom (stored on the follower for cheap reads)
    listeningRooms: defineTable({
      name: v.string(),
      hostId: v.id("users"),
      hostName: v.optional(v.string()),
      members: v.array(
        v.object({
          userId: v.id("users"),
          name: v.optional(v.string()),
          joinedAt: v.number(),
        }),
      ),
      nowPlaying: v.optional(v.string()),
      updatedAt: v.number(),
    })
      .index("by_host", ["hostId"])
      // Lets the rooms directory read the most recently active rooms first
      // and stop there, instead of collecting the whole table. Rooms are only
      // deleted on an explicit leave, so a closed tab would otherwise leave
      // one behind forever.
      .index("by_updatedAt", ["updatedAt"]),

    importedPlaylists: defineTable({
      userId: v.id("users"),
      name: v.string(),
      origin: v.string(), // e.g. "YouTube Music", "Spotify", "Other"
      tracks: v.array(
        v.object({
          title: v.string(),
          artist: v.string(),
          duration: v.optional(v.number()),
        }),
      ),
      createdAt: v.number(),
    }).index("by_user", ["userId"]),

    // ---------------------------------------------------------------------
    // Visit analytics (first-party, for the admin page).
    //
    // Amplitude is an outbound, optional integration that needs a key the
    // workspace may not have. These tables are the app's OWN record of who
    // opened which page, so the admin Visits tab works on a fresh deployment
    // with no third-party account at all.
    //
    // Privacy: deliberately NO ip, NO user agent, NO fingerprint. A visitor is
    // a random per-browser id that the client generates and can forget, which
    // is enough to count unique visitors and nothing more. This matches what
    // /privacy promises.
    //
    // Two tables, because an admin dashboard wants two very different reads.
    // `visitEvents` is the raw append-only log and answers "what just
    // happened"; it grows without bound, so `pruneVisits` deletes rows older
    // than RAW_RETENTION_DAYS. `visitDaily` is the rollup that answers "what
    // does the trend look like"; it has one row per (day, path), so it grows
    // with days x distinct pages rather than with traffic, and the admin query
    // reads a bounded number of rows no matter how busy the app gets.
    // ---------------------------------------------------------------------

    // Raw page-view log. Append-only, pruned by a daily cron.
    visitEvents: defineTable({
      /** UTC day, "YYYY-MM-DD". Denormalised so the rollup never re-reads rows. */
      day: v.string(),
      /** Route PATTERN, not a URL: "/artist/:artist", never "/artist/Bjork". */
      path: v.string(),
      at: v.number(),
      /** Random per-browser id. Not a fingerprint, not derived from anything. */
      visitorId: v.string(),
      /** Auth subject when signed in, so visits can be split signed-in vs anon. */
      userId: v.optional(v.string()),
      /** Same-origin path only; a cross-site referrer is dropped, not stored. */
      referrer: v.optional(v.string()),
      /** Coarse bucket, never a UA string. */
      device: v.optional(v.string()),
    })
      .index("by_at", ["at"])
      .index("by_day", ["day"])
      .index("by_visitor_at", ["visitorId", "at"]),

    // One row per (day, path). The table the admin dashboard actually reads.
    visitDaily: defineTable({
      day: v.string(),
      path: v.string(),
      views: v.number(),
      /** Distinct visitorIds seen on this day for this path. Bounded — see the
       *  cap in convex/analytics.ts, which stops recording rather than
       *  silently overstating the number. */
      visitors: v.array(v.string()),
      /** Distinct signed-in auth subjects, same cap. */
      members: v.array(v.string()),
      updatedAt: v.number(),
    })
      .index("by_day", ["day"])
      .index("by_day_path", ["day", "path"]),

    // Explicit "I'm not into this". Distinct from a skip: a skip is a reflex
    // on a song that happened to be playing, whereas this is a deliberate
    // statement that the listener does not want to be shown it again.
    //
    // Two scopes, because "not this song" and "not this artist" are different
    // requests and collapsing them would either over- or under-filter. Both
    // are consumed as HARD EXCLUSIONS by the recommender, so a listener who
    // says no is not shown a near-miss of the thing they said no to.
    notInterested: defineTable({
      userId: v.id("users"),
      /** "track" | "artist" */
      scope: v.string(),
      /** Present for scope "track". */
      trackId: v.optional(v.string()),
      /** Present for both scopes; the artist row is what filters the catalogue. */
      artistName: v.optional(v.string()),
      createdAt: v.number(),
    })
      .index("by_user", ["userId"])
      .index("by_user_scope", ["userId", "scope"]),

    // Lyrics lookups, keyed by the normalised "title|artist" that actually hit.
    // Stores misses too (`missing: true`) so a song with no lyrics anywhere is
    // only looked up once instead of on every open of the panel. Free lyrics
    // APIs are rate limited, so this is what keeps the panel responsive.
    lyricsCache: defineTable({
      key: v.string(),
      lines: v.any(), // LyricLine[]; empty when `missing`
      synced: v.boolean(),
      source: v.string(),
      missing: v.boolean(),
      fetchedAt: v.number(),
    }).index("byKey", ["key"]),

    // Provider metadata cache. YouTube/InnerTube lookups were previously made
    // on every single request — two searches for the same query in a row, or a
    // re-render that re-resolves a stream, each cost a full network round trip
    // against a rate-limited upstream. `key` is an opaque hash of
    // (provider, endpoint, normalised args) so no credential ever reaches a
    // row, and `expiresAt` is enforced on read.
    providerCache: defineTable({
      key: v.string(),
      /** Opaque normalised payload. Never a token or a long-lived stream URL. */
      value: v.any(),
      /** Which provider produced this — kept for debugging and fallback logs. */
      provider: v.string(),
      fetchedAt: v.number(),
      expiresAt: v.number(),
    })
      .index("byKey", ["key"])
      // Lets `cachePrune` delete expired rows without scanning the whole table.
      .index("byExpiry", ["expiresAt"]),

    /**
     * One preferences blob per account — SYNQ has a single profile, so this
     * syncs the listener's settings and player prefs across devices. Values
     * are plain JSON of whitelisted UI preferences only: no tokens, no
     * session material, no queue contents (likes/history have their own
     * tables). A single row per user, last write wins — preferences are
     * toggles and sliders, not data that needs merging.
     */
    userPreferences: defineTable({
      userId: v.id("users"),
      prefs: v.any(),
      updatedAt: v.number(),
    }).index("byUser", ["userId"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
