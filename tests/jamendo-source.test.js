/**
 * Jamendo as a discovery index (never a playback source).
 *
 * The bug this file is built around: Jamendo reports its failures INSIDE an
 * HTTP 200. A bad key, a spent quota and a successful empty search all come
 * back `200 OK` with a different `headers.status`. Integration code that only
 * checks `response.ok` looks completely wired up and silently returns nothing,
 * forever, with no error anywhere to notice.
 *
 * So the envelope handling is tested as carefully as the happy path, and the
 * action is driven end-to-end against a stubbed `fetch` rather than asserted
 * against its source text.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { searchJamendo } from "../src/convex/jamendo";
import { readSource } from "./helpers/tailwind-css.js";
import {
  httpQuotaFailure,
  networkFailure,
  normalizeTrack,
  normalizeTracks,
  notConfiguredFailure,
  unwrap,
} from "../src/lib/jamendo";

/** A well-formed track as Jamendo actually returns one. */
function goodTrack(overrides = {}) {
  return {
    id: "1848357",
    name: "mañana será tarde",
    artist_name: "fankel",
    album_name: "mañana será tarde",
    image: "https://usercontent.jamendo.com?type=album&id=1&width=300",
    audio: "https://prod-1.storage.jamendo.com/?trackid=1848357&format=mp31",
    duration: 272,
    license_ccurl: "http://creativecommons.org/licenses/by-nc-nd/3.0/",
    shareurl: "https://www.jamendo.com/track/1848357",
    audiodownload_allowed: true,
    musicinfo: {
      tags: { genres: ["rock"], instruments: ["guitar"], vartags: ["groovy"] },
    },
    ...overrides,
  };
}

const successEnvelope = (results) => ({
  headers: { status: "success", code: 0, results_count: results.length },
  results,
});

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.JAMENDO_CLIENT_ID;
});

/** A signed-in caller with a stable subject, so rate buckets don't collide. */
function ctxFor(subject) {
  return { auth: { getUserIdentity: async () => ({ subject }) } };
}

describe("the envelope is the whole ballgame", () => {
  test("a success envelope unwraps to tracks", () => {
    const out = unwrap(successEnvelope([goodTrack()]));
    expect(out.ok).toBe(true);
    expect(out.results).toHaveLength(1);
    expect(out.failure).toBeNull();
  });

  test("a 200 that contains a failure is a FAILURE, not an empty result", () => {
    // This is the exact shape a bad API key returns. Treating it as success is
    // how an integration silently dies.
    const out = unwrap({
      headers: {
        status: "error",
        code: 1002,
        error_message: "Invalid client_id",
      },
      results: [],
    });
    expect(out.ok).toBe(false);
    expect(out.failure).not.toBeNull();
    expect(out.failure.retryable).toBe(false);
  });

  test("a rate-limit message is told apart from a bad key", () => {
    // Both are HTTP 200. Conflating them would tell a listener their key is
    // broken when the truth is the quota is gone for the day.
    const quota = unwrap({
      headers: {
        status: "error",
        code: 9999,
        error_message: "Rate limit exceeded for this application",
      },
      results: [],
    });
    expect(quota.ok).toBe(false);
    expect(quota.failure.code).toBe("rate-limited");
    expect(quota.failure.retryable).toBe(true);
  });

  test("numeric and string zero codes both mean success", () => {
    expect(unwrap({ headers: { status: "success", code: "0" } }).ok).toBe(true);
    expect(unwrap({ headers: { status: "success", code: 0 } }).ok).toBe(true);
  });

  test("a missing envelope is a failure, never a silent empty list", () => {
    expect(unwrap(null).ok).toBe(false);
    expect(unwrap({}).ok).toBe(false);
  });
});

describe("only playable tracks survive normalisation", () => {
  test("a good track keeps its stream URL and licence", () => {
    const track = normalizeTrack(goodTrack());
    expect(track.audioUrl).toContain("prod-1.storage.jamendo.com");
    expect(track.licenseUrl).toContain("creativecommons.org");
    expect(track.tags).toEqual(["rock", "guitar", "groovy"]);
  });

  test("a track with no audio URL is dropped, not shown", () => {
    // A row the user can click and that then plays nothing is worse than an
    // absent row: it reads as a broken player.
    expect(normalizeTrack(goodTrack({ audio: "" }))).toBeNull();
    expect(normalizeTrack(goodTrack({ audio: undefined }))).toBeNull();
  });

  test("a non-http audio URL is refused", () => {
    expect(
      normalizeTrack(goodTrack({ audio: "javascript:alert(1)" })),
    ).toBeNull();
    expect(
      normalizeTrack(goodTrack({ audio: "file:///etc/passwd" })),
    ).toBeNull();
  });

  test("a track with no id is dropped", () => {
    expect(normalizeTrack(goodTrack({ id: "" }))).toBeNull();
  });

  test("a single with no album keeps an EMPTY album, not a fake one", () => {
    // Jamendo leaves album_name blank for singles. Writing "Single" here would
    // feed the recommender a fabricated album axis.
    const track = normalizeTrack(
      goodTrack({ album_name: "", image: "https://x/y.jpg" }),
    );
    expect(track.albumName).toBe("");
    expect(track.coverUrl).toBe("https://x/y.jpg");
  });

  test("a junk duration becomes 0, never NaN", () => {
    expect(
      normalizeTrack(goodTrack({ duration: "not-a-number" })).duration,
    ).toBe(0);
    expect(normalizeTrack(goodTrack({ duration: "90" })).duration).toBe(90);
  });

  test("duplicates are removed and the input order is kept", () => {
    const out = normalizeTracks([
      goodTrack(),
      goodTrack(),
      goodTrack({ id: "2", name: "other" }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].jamendoId).toBe("1848357");
  });

  test("a non-array body yields nothing rather than throwing", () => {
    expect(normalizeTracks(null)).toEqual([]);
    expect(normalizeTracks("nope")).toEqual([]);
  });
});

describe("the action's states", () => {
  test("no API key says exactly which variable is missing", async () => {
    delete process.env.JAMENDO_CLIENT_ID;
    const out = await searchJamendo._handler(ctxFor("u1"), { query: "jazz" });
    expect(out.ok).toBe(false);
    expect(out.failure.code).toBe("not-configured");
    expect(out.failure.hint).toContain("JAMENDO_CLIENT_ID");
    // Must not be retryable: retrying cannot conjure a credential.
    expect(out.failure.retryable).toBe(false);
  });

  test("an empty query never reaches the network", async () => {
    process.env.JAMENDO_CLIENT_ID = "key";
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return new Response("{}");
    };
    const out = await searchJamendo._handler(ctxFor("u2"), { query: "   " });
    expect(out.ok).toBe(false);
    expect(called).toBe(false);
  });

  test("a real 429 is reported as a retryable quota wall", async () => {
    process.env.JAMENDO_CLIENT_ID = "key";
    globalThis.fetch = async () => new Response("", { status: 429 });
    const out = await searchJamendo._handler(ctxFor("u3"), { query: "jazz" });
    expect(out.ok).toBe(false);
    expect(out.failure.code).toBe("rate-limited");
    expect(out.failure.retryable).toBe(true);
  });

  test("a network failure is distinguished from a quota wall", async () => {
    process.env.JAMENDO_CLIENT_ID = "key";
    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const out = await searchJamendo._handler(ctxFor("u4"), { query: "jazz" });
    expect(out.ok).toBe(false);
    expect(out.failure.code).toBe("network");
  });

  test("a matched-but-unplayable page is EMPTY, not an error", async () => {
    process.env.JAMENDO_CLIENT_ID = "key";
    globalThis.fetch = async () =>
      Response.json(successEnvelope([goodTrack({ audio: "" })]));
    const out = await searchJamendo._handler(ctxFor("u5"), { query: "jazz" });
    expect(out.ok).toBe(false);
    expect(out.failure.code).toBe("empty");
  });

  test("the happy path returns playable tracks", async () => {
    process.env.JAMENDO_CLIENT_ID = "key";
    let seen = "";
    globalThis.fetch = async (url) => {
      seen = String(url);
      // Genuinely different tracks: same artist, same title and same length
      // IS a duplicate by design, so the dedupe would (correctly) eat it.
      return Response.json(
        successEnvelope([
          goodTrack(),
          goodTrack({ id: "2", name: "a different song", duration: 180 }),
        ]),
      );
    };
    const out = await searchJamendo._handler(ctxFor("u6"), { query: "rock" });
    expect(out.ok).toBe(true);
    expect(out.tracks).toHaveLength(2);
    // The request must ask for both singles and album tracks, or every single
    // is invisible, and must never ask for a download URL.
    expect(seen).toContain("type=single");
    expect(seen).toContain("albumtrack");
    expect(seen).toContain("client_id=key");
  });

  test("the own-budget limiter stops a hammering listener", async () => {
    process.env.JAMENDO_CLIENT_ID = "key";
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return Response.json(successEnvelope([goodTrack()]));
    };
    const ctx = ctxFor("u7");
    for (let i = 0; i < 20; i += 1) {
      const ok = await searchJamendo._handler(ctx, { query: `q${i}` });
      expect(ok.ok).toBe(true);
    }
    // The 21st call in the same window is refused before any network I/O.
    const blocked = await searchJamendo._handler(ctx, {
      query: "one too many",
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.failure.code).toBe("rate-limited");
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
    expect(calls).toBe(20);
  });

  test("an absurd limit is clamped instead of scanning", async () => {
    process.env.JAMENDO_CLIENT_ID = "key";
    let seen = "";
    globalThis.fetch = async (url) => {
      seen = String(url);
      return Response.json(successEnvelope([goodTrack()]));
    };
    await searchJamendo._handler(ctxFor("u8"), {
      query: "jazz",
      limit: 100_000,
    });
    expect(seen).toContain("limit=25");
  });
});

/**
 * Jamendo's free tier intermittently answers a query with thousands of
 * matches using `status: "success"`, `code: 0`, an EMPTY `error_message` and
 * zero rows — measured live at roughly a third of calls. Taken at face value
 * that is "no results", and it is indistinguishable from a genuine miss, so
 * the only defence is to try again before telling a listener a search found
 * nothing. These tests pin that behaviour, because the bug it fixes is
 * invisible: without them the app simply loses a third of all searches.
 */
describe("a successful nothing is retried, not believed", () => {
  test("a silent empty page is retried and the retry's tracks are returned", async () => {
    process.env.JAMENDO_CLIENT_ID = "key";
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      // First call: the silent-empty success. Second: the real page.
      if (calls === 1) {
        return Response.json({
          headers: {
            status: "success",
            code: 0,
            results_count: 0,
            error_message: "",
          },
          results: [],
        });
      }
      return Response.json(successEnvelope([goodTrack()]));
    };
    const out = await searchJamendo._handler(ctxFor("r1"), { query: "techno" });
    expect(out.ok).toBe(true);
    expect(out.tracks).toHaveLength(1);
    expect(calls).toBe(2);
  });

  test("retries are bounded, then reported as a genuine empty", async () => {
    process.env.JAMENDO_CLIENT_ID = "key";
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return Response.json(successEnvelope([]));
    };
    const out = await searchJamendo._handler(ctxFor("r2"), { query: "jazz" });
    expect(out.ok).toBe(false);
    expect(out.failure.code).toBe("empty");
    // Bounded: it gives up rather than retrying forever.
    expect(calls).toBe(3);
  });

  test("an all-unplayable page is still retried, because it is still empty", async () => {
    process.env.JAMENDO_CLIENT_ID = "key";
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return Response.json(successEnvelope([goodTrack({ audio: "" })]));
    };
    const out = await searchJamendo._handler(ctxFor("r3"), { query: "jazz" });
    expect(out.ok).toBe(false);
    expect(out.failure.code).toBe("empty");
    expect(calls).toBe(3);
  });

  test("a genuine failure is NOT retried, so a real problem is not made worse", async () => {
    process.env.JAMENDO_CLIENT_ID = "key";
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      throw new Error("ECONNRESET");
    };
    const out = await searchJamendo._handler(ctxFor("r4"), { query: "jazz" });
    expect(out.ok).toBe(false);
    expect(out.failure.code).toBe("network");
    // Retrying a quota wall or a bad key would only spend more of a budget
    // that is already gone.
    expect(calls).toBe(1);
  });

  test("a bad key is reported once, not three times", async () => {
    process.env.JAMENDO_CLIENT_ID = "key";
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return Response.json({
        headers: {
          status: "failed",
          code: 5,
          error_message:
            "Jamendo Api Invalid Client Id Error: Your credential is not authorized.",
        },
        results: [],
      });
    };
    const out = await searchJamendo._handler(ctxFor("r5"), { query: "jazz" });
    expect(out.ok).toBe(false);
    expect(out.failure.code).toBe("not-configured");
    expect(calls).toBe(1);
  });

  test("retries spend the own-budget, so they cannot multiply upstream load", async () => {
    process.env.JAMENDO_CLIENT_ID = "key";
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return Response.json(successEnvelope([]));
    };
    const ctx = ctxFor("r6");
    // Each search costs 3 upstream calls, so the 20-call budget runs out
    // part-way through the seventh search rather than after twenty.
    for (let i = 0; i < 6; i += 1) {
      const out = await searchJamendo._handler(ctx, { query: `q${i}` });
      expect(out.ok).toBe(false);
      expect(out.failure.code).toBe("empty");
    }
    const blocked = await searchJamendo._handler(ctx, {
      query: "one too many",
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.failure.code).toBe("rate-limited");
    expect(calls).toBe(20);
  });
});

describe("the failures are written for a listener", () => {
  test("the quota hint names the real constraint", () => {
    const f = httpQuotaFailure();
    expect(f.code).toBe("rate-limited");
    expect(f.hint).toMatch(/day|minute|free/i);
  });

  test("not-configured points at the free key, not a paid plan", () => {
    expect(notConfiguredFailure().hint).toMatch(/free/i);
  });

  test("network is retryable and unconfigured is not", () => {
    expect(networkFailure().retryable).toBe(true);
    expect(notConfiguredFailure().retryable).toBe(false);
  });
});

describe("a Jamendo track can no longer become a playable", () => {
  // Jamendo's streams were silent for the listeners this was built for, so
  // the queue-building path was deleted outright rather than left to fail
  // quietly. These tests exist so it cannot creep back.
  const playableSrc = readSource("src/lib/playable.ts");

  test("no Jamendo track can be turned into a queueable track", () => {
    expect(playableSrc).not.toContain("toPlayableJamendo");
  });

  test("the only playback source is YouTube", () => {
    // A second source that cannot play is not a fallback, it is a second way
    // to be silent.
    expect(playableSrc).not.toContain('"jamendo"');
  });

  test("the licence fields are still parsed, so discovery can credit them", () => {
    // Dropping the parser would have been the easy way to "remove" Jamendo,
    // and it would have taken the discovery index with it.
    const lib = readSource("src/lib/jamendo.ts");
    expect(lib).toContain("license_ccurl");
    expect(lib).toContain("shareUrl");
  });
});
