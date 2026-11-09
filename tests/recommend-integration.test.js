import { describe, expect, test } from "bun:test";
import { readSource } from "./helpers/tailwind-css.js";

const store = readSource("src/store/player.ts");
const shell = readSource("src/components/layout/AppShell.tsx");
const home = readSource("src/pages/Home.tsx");
const convexReco = readSource("src/convex/recommend.ts");
const balance = readSource("src/lib/recoBalance.ts");
const convexHistory = readSource("src/convex/history.ts");
const schema = readSource("src/convex/schema.ts");
const playable = readSource("src/lib/playable.ts");
const ytLib = readSource("src/lib/youtube.ts");
const ytServer = readSource("src/convex/youtube.ts");
const row = readSource("src/components/tracks/RemoteTrackRow.tsx");

describe("the schema extends the existing data, it does not replace it", () => {
  test("the original tables are untouched", () => {
    for (const table of [
      "playHistory",
      "playEvents",
      "likedSongs",
      "likedRemote",
      "playlists",
      "playlistEvents",
      "lyricsCache",
    ]) {
      expect(schema).toContain(`${table}: defineTable`);
    }
  });

  test("the new tables are additive and scoped to a user", () => {
    for (const table of [
      "trackSignals",
      "recommendationEvents",
      "recommendationCache",
    ]) {
      expect(schema).toContain(`${table}: defineTable`);
    }
    // Private by construction: every new table is keyed by the owner.
    for (const table of [
      "trackSignals",
      "recommendationEvents",
      "recommendationCache",
    ]) {
      const start = schema.indexOf(`${table}: defineTable`);
      const body = schema.slice(start, start + 400);
      expect(body).toContain('userId: v.id("users")');
    }
  });

  test("engagement fields are optional, so old rows stay valid", () => {
    for (const field of [
      "completion: v.optional",
      "listenedSeconds: v.optional",
      "skipped: v.optional",
      "origin: v.optional",
    ]) {
      expect(schema).toContain(field);
    }
  });
});

describe("skips are detected from real playback, not guessed", () => {
  test("a play is recorded with the metadata the engine needs", () => {
    // The old recorder re-read `current` here and always got the PREVIOUS
    // song, so remote plays were stored with no title or artist — leaving the
    // engine with no artist signal at all.
    expect(store).toMatch(/historyMeta|meta: HistoryMeta/);
    expect(store).toMatch(/artistName: track\.artistName/);
  });

  test("engagement is closed when a track ends and when one replaces it", () => {
    expect(store).toContain("function settleEngagement");
    expect(store).toMatch(/settleEngagement\("ended"\)/);
    expect(store).toMatch(/settleEngagement\("changed"\)/);
  });

  test("completion is measured against what was actually heard", () => {
    // Seeking past a track must not read as a full listen.
    expect(store).toMatch(
      /heard = Math\.max\(0, position - session\.startOffset\)/,
    );
    expect(store).toMatch(/completion = Math\.min\(1, heard \/ duration\)/);
  });

  test("a track cannot be recorded twice", () => {
    expect(store).toMatch(/if \(!session\) return;/);
    expect(convexHistory).toMatch(
      /if \(!row \|\| row\.engagedAt !== undefined\) return null;/,
    );
  });

  test("a skip converts the play instead of adding a second one", () => {
    expect(convexHistory).toMatch(/playDelta: isSkip \? -1 : 0/);
    expect(convexHistory).toMatch(/skipDelta: isSkip \? 1 : 0/);
  });

  test("clearing history clears what was derived from it", () => {
    const start = convexHistory.indexOf("clearHistory = mutation");
    const body = convexHistory.slice(start, start + 1800);
    for (const table of [
      "trackSignals",
      "recommendationEvents",
      "recommendationCache",
    ]) {
      expect(body).toContain(table);
    }
  });
});

describe("autoplay and Home run on the same engine", () => {
  test("the player calls the recommendation action, not a second scorer", () => {
    expect(store).toContain("api.recommend.nextTrack");
    expect(convexReco).toContain("import {");
    // The Convex layer delegates to the same pure module Home's rows use.
    expect(convexReco).toMatch(/from "\.\.\/lib\/recommend"/);
  });

  test("autoplay falls back to the existing related mix instead of stopping", () => {
    const start = store.indexOf("function completeEndedTrack");
    // 4000 was too tight once the end-of-track handler grew its crossfade and
    // queue-exhaustion branches; the fallback sat just past the window, so the
    // test failed while the code it describes was correct. Sized to reach the
    // fallback with room to spare rather than to the old line count.
    const body = store.slice(start, start + 7000);
    expect(body).toContain("fetchPersonalNext");
    expect(body).toContain("fetchRelatedMix");
    // The fallback must run whenever the engine returns nothing.
    expect(body).toMatch(/if \(result !== null\) return;/);
  });

  test("a slow or broken recommendation cannot stall playback", () => {
    expect(store).toContain("PERSONAL_NEXT_TIMEOUT_MS");
    expect(store).toMatch(/Promise\.race/);
    const start = store.indexOf("async function fetchPersonalNext");
    const body = store.slice(start, start + 2500);
    expect(body).toMatch(/catch \{\s*\n?\s*return null;/);
  });

  test("recommendations are only requested when the queue is exhausted", () => {
    const start = store.indexOf("function completeEndedTrack");
    const body = store.slice(start, start + 4000);
    // Manual queue actions run first and return; the engine is reached only
    // after every queued track has been consumed. `autoAdvanceToIndex` is the
    // ungated advance these paths use — an end-of-track is playback already in
    // progress, so it must never route through the deferred-auth gate.
    const manual = body.indexOf("autoAdvanceToIndex?.(s.queueIndex + 1)");
    const engine = body.indexOf("fetchPersonalNext(seed, queueIds)");
    expect(manual).toBeGreaterThan(-1);
    expect(engine).toBeGreaterThan(manual);
  });

  test("the live queue is passed in so nothing already queued repeats", () => {
    expect(store).toMatch(/queueIds = s\.queue\.map\(\(q\) => q\.id\)/);
    expect(store).toMatch(
      /if \(queueIds\.includes\(picked\.id\)\) return null;/,
    );
    expect(store).toMatch(/if \(picked\.id === seed\.id\) return null;/);
  });

  test("generated tracks are distinguishable from tracks the user queued", () => {
    expect(playable).toContain('queueOrigin?: "autoplay"');
    expect(store).toContain('queueOrigin: "autoplay"');
    // …and only generated ones are reported back as a rejection.
    expect(store).toMatch(/if \(item\.queueOrigin === "autoplay"\)/);
  });

  test("deleting a suggested track reaches the scoring model", () => {
    expect(store).toMatch(/signalBridge\?\.removal\(\{ trackId: item\.id \}\)/);
    expect(convexReco).toContain("export const recordRemoval");
    expect(shell).toMatch(/recordRemoval\(\{ trackId \}\)/);
  });
});

describe("the signals a cold, low-data or active listener produces", () => {
  test("an anonymous visitor is never given someone's recommendations", () => {
    const start = convexReco.indexOf("export const signals = query");
    const body = convexReco.slice(start, start + 600);
    expect(body).toContain("if (userId === null) return null");
  });

  test("every read is bounded, so no query can blow its budget", () => {
    const start = convexReco.indexOf("export const signals = query");
    const body = convexReco.slice(start, start + 6000);
    // No unbounded collection anywhere in the profile query.
    expect(body).not.toMatch(/\.collect\(\)/);
    expect(body).toMatch(/\.take\(MAX_SIGNAL_ROWS\)/);
    expect(body).toMatch(/\.take\(MAX_LIKES\)/);
    expect(body).toMatch(/\.take\(MAX_PLAYLISTS\)/);
    expect(body).toMatch(/\.take\(MAX_FEEDBACK_ROWS\)/);
  });

  test("each row needs real data before it is allowed to appear", () => {
    const start = convexReco.indexOf("function sectionEligibility");
    const body = convexReco.slice(start, start + 900);
    expect(body).toContain(
      "based_on_likes: userSignals.likes.length >= MIN_LIKES",
    );
    expect(body).toContain("because_you_listened: realPlays >= MIN_PLAYS");
    expect(body).toContain("from_artists: artistsWithPlays >= MIN_ARTISTS");
  });

  test("a section with nothing to show is dropped, not rendered empty", () => {
    // The coordinator decides, not the per-shelf loop: a row that could not
    // reach its own floor is returned empty and skipped here.
    expect(convexReco).toMatch(/if \(section\.items\.length === 0\) continue;/);
    expect(convexReco).toContain("allocateWithBudget");
  });

  test("a track shown in one row does not reappear in the next", () => {
    // De-duplication moved into the one coordinator that sees every shelf at
    // once, so it is also the only place that can enforce an artist budget.
    expect(convexReco).toContain("allocateWithBudget");
    expect(balance).toMatch(/shownIds\.has\(item\.id\)/);
    expect(balance).toMatch(/shownTracks\.has\(identity\)/);
  });

  test("a card only claims the reason its own source supports", () => {
    expect(convexReco).toMatch(
      /case "based_on_likes":\s*\n\s*return seeds\.filter\(\(s\) => s\.source === "likes"\)/,
    );
  });
});

describe("recommendation failures degrade, they never surface as an error", () => {
  test("Home hides a broken recommendation instead of showing a failure", () => {
    const start = home.indexOf("const [recoSections");
    const body = home.slice(start, start + 900);
    expect(body).toMatch(
      /\.catch\(\(\) => \{\s*\n?\s*if \(!cancelled\) setRecoSections\(\[\]\);/,
    );
    // An empty payload simply renders nothing — there is no error banner.
    expect(home).not.toMatch(/recommendation.{0,40}(failed|error banner)/i);
  });

  test("the server never throws out of the player-facing action", () => {
    const start = convexReco.indexOf("export const nextTrack");
    const body = convexReco.slice(start, start + 4000);
    expect(body).toMatch(/catch \{[\s\S]{0,200}return NOTHING;/);
  });

  test("the fallback order is explicit and total", () => {
    expect(convexReco).toMatch(
      /PERSONALISED[\s\S]*RELATED[\s\S]*DISCOVERY \/ GLOBAL/s,
    );
    expect(convexReco).toContain('query: "popular songs"');
  });

  test("a cache miss re-runs instead of returning nothing", () => {
    expect(convexReco).toMatch(
      /catch \{\s*\n\s*\/\* a cache miss must never be fatal \*\//,
    );
    const start = convexReco.indexOf("export const cacheGet");
    const body = convexReco.slice(start, start + 900);
    expect(body).toMatch(/if \(row\.expiresAt <= Date\.now\(\)\) return null;/);
  });

  test("the cache can only be read by its owner", () => {
    const start = convexReco.indexOf("export const cacheGet");
    const body = convexReco.slice(start, start + 900);
    expect(body).toContain("if (userId === null) return null");
    expect(body).toContain('q.eq("userId", userId)');
  });
});

describe("Home reuses the design language it already had", () => {
  test("recommendation rows render through the existing remote components", () => {
    // Presentation-only change: the engine still decides the rows, and the
    // cards reuse the app's own track/playable plumbing.
    expect(home).toContain("<MediaCard");
    expect(home).toContain("<Shelf");
    const start = home.indexOf("const playRecommendation");
    const body = home.slice(start, start + 900);
    expect(body).toContain("playRemoteItem(toYtItem(item)");
  });

  test("there is no bespoke recommendation card component", () => {
    // One visual system: a new card would be a second design language.
    expect(home).not.toContain("RecoCard");
    expect(home).not.toContain("RecommendationCard");
  });

  test("recommendation rows keep every existing row affordance", () => {
    // The actions are defined once in the shared track-actions module and
    // reached by both the list row and the Home card, so a card can never
    // quietly lose an affordance the row still has.
    const actions = readSource("src/components/tracks/useTrackActions.tsx");
    for (const affordance of [
      "Play next",
      "Add to queue",
      "Add to playlist",
      "liked songs",
      "More options",
    ]) {
      expect(actions).toContain(affordance);
    }
    expect(row).toContain("<TrackActionsMenu");
    expect(readSource("src/components/tracks/MediaCard.tsx")).toContain(
      "<TrackActionsMenu",
    );
  });

  test("a cold listener is told the truth about why the row is generic", () => {
    expect(home).toContain('"Popular picks while we learn"');
  });

  test("the loading state exists so an empty Home is never shown as final", () => {
    expect(home).toContain("recoSections === null");
    expect(home).toContain("skeleton");
    // A failure resolves to an empty array, not an error surface — the rest of
    // Home keeps working.
    expect(home).toMatch(/setRecoSections\(\[\]\)/);
  });
});

describe("recommendations never invent metadata", () => {
  test("album is left undefined rather than filled with a placeholder", () => {
    expect(playable).toContain('albumName: item.album ?? ""');
    expect(playable).not.toContain('albumName: "Single"');
    expect(convexReco).toMatch(
      /\.\.\.\(item\.album \? \{ album: item\.album \} : \{\}\)/,
    );
  });

  test("album comes from a real field the source actually reports", () => {
    expect(ytLib).toContain("album?: string");
    expect(ytServer).toContain("album?: string");
    expect(ytServer).toContain("albumCandidate");
  });

  test("there is no fabricated genre or mood feature anywhere", () => {
    // SYNQ has no genre/mood source, so the engine must not pretend to.
    const engine = readSource("src/lib/recommend.ts");
    expect(engine).not.toMatch(/genreSimilarity\s*[:=]\s*0?\.\d/);
    expect(engine).not.toMatch(/moodSimilarity\s*[:=]\s*0?\.\d/);
  });

  test("a reason is only ever attached alongside a real term", () => {
    const engine = readSource("src/lib/recommend.ts");
    expect(engine).toMatch(/if \(best\[0\] <= 0\) return "discovery";/);
  });
});

describe("debugging is possible without shipping it to listeners", () => {
  test("the explain action returns the weighted contributions", () => {
    expect(convexReco).toContain("export const explain = action");
    const start = convexReco.indexOf("export const explain = action");
    const body = convexReco.slice(start, start + 2500);
    expect(body).toContain("breakdown: scored.score");
    expect(body).toContain("explanation: explainCandidate(scored)");
    expect(body).toContain("seeds: seeds.map");
  });

  test("no debug surface is rendered in the product UI", () => {
    expect(home).not.toContain("api.recommend.explain");
    expect(shell).not.toContain("api.recommend.explain");
  });
});

describe("the feedback loop closes without counting anything twice", () => {
  test("starting a recommendation is not yet an outcome", () => {
    expect(convexReco).toMatch(
      /UNSETTLED_OUTCOMES = new Set\(\["shown", "played", "queued"\]\)/,
    );
  });

  test("the real verdict is written once, when the track finishes", () => {
    expect(convexReco).toContain("export const settleOutcome");
    const start = convexReco.indexOf("export const settleOutcome");
    const body = convexReco.slice(start, start + 1200);
    expect(body).toMatch(/r\.trackId === args\.trackId && !r\.settledAt/);
  });

  test("AppShell closes the loop on both a skip and a completion", () => {
    expect(shell).toMatch(/outcome: args\.skipped \? "skipped" : "completed"/);
  });

  test("only settled feedback is allowed to influence ranking", () => {
    const start = convexReco.indexOf("export const signals = query");
    const body = convexReco.slice(start, start + 6000);
    expect(body).toContain("if (!row.outcome || !row.settledAt) continue;");
  });
});

describe("every play has exactly one writer", () => {
  test("the bridge is the only path that records a play", () => {
    // Two writers would create two history rows for every single play.
    const effect = shell.slice(
      shell.indexOf("setSignalBridge({"),
      shell.indexOf("return () => setSignalBridge(null)"),
    );
    expect(effect).toContain("recordPlay(");
    expect(effect).not.toContain("setHistoryRecorder(");
    expect(store).not.toMatch(/if \(historyRecorder\) \{/);
  });
});

describe("exploration material is spent on exploration", () => {
  test("for_you may not rank the broad discovery seed", () => {
    // The broad seed asks for a genre the listener has never played. Ranking it
    // into "Recommended for you" mislabels it, and because this row is served
    // first it also spends the material Discover needs — which is how a thin
    // provider produced a generic for_you row and no discovery row at all.
    const start = convexReco.indexOf('case "for_you"');
    const body = convexReco.slice(start, start + 900);
    expect(body).toContain('s.source !== "broad_discovery"');
    expect(body).toContain("familiar.length > 0 ? familiar : seeds");
  });

  test("the discovery row still receives the broad seed", () => {
    const start = convexReco.indexOf('case "discover"');
    expect(convexReco.slice(start, start + 600)).toContain(
      's.source === "broad_discovery"',
    );
  });
});
