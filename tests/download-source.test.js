/**
 * The download SOURCE contract.
 *
 * This file exists because the previous implementation asked Jamendo for
 * `audioformat=audiodownload` — a parameter the live API rejects outright
 * (`accept only values in [mp31,mp32,ogg,flac]`). Because Jamendo reports
 * failures inside HTTP 200, the whole download feature was dead and the
 * refusal surfaced as a misleading "Jamendo rejected the app's API key".
 *
 * So these tests pin two things:
 *
 *  1. the downloadable file comes from `audiodownload`, gated on
 *     `audiodownload_allowed`, and never from the streaming `audio` field;
 *  2. everything the response can contain is validated before it is handed to
 *     a proxy that will fetch it.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { authorizeDownload } from "../src/convex/downloads";
import {
  createResolveCache,
  formatDetails,
  parseDownloadAsset,
  releaseFilename,
  resolveJamendoDownload,
} from "../src/lib/jamendoDownload";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.JAMENDO_CLIENT_ID;
});

const DOWNLOAD_URL =
  "https://prod-1.storage.jamendo.com/download/track/1214935/mp32/?from=app-1";

/** The shape Jamendo actually returns for one track. */
function release(overrides = {}) {
  return {
    id: "1214935",
    name: "Wish You Were Here",
    artist_name: "Some Artist",
    license_ccurl: "http://creativecommons.org/licenses/by-nc-sa/3.0/",
    audio: "https://prod-1.storage.jamendo.com/?trackid=1214935&format=mp31",
    audiodownload: DOWNLOAD_URL,
    audiodownload_allowed: true,
    ...overrides,
  };
}

const envelope = (results) => ({
  headers: { status: "success", code: 0, results_count: results.length },
  results,
});

const okFetch = (track = release(), seen = {}) => async (url) => {
  seen.url = String(url);
  return Response.json(envelope([track]));
};

describe("a provider download URL is validated, not trusted", () => {
  test("accepts the real Jamendo download shape", () => {
    const asset = parseDownloadAsset(DOWNLOAD_URL);
    expect(asset).not.toBeNull();
    expect(asset.providerId).toBe("1214935");
    expect(asset.format).toBe("mp32");
    expect(asset.contentType).toBe("audio/mpeg");
    expect(asset.extension).toBe(".mp3");
  });

  test("refuses the streaming endpoint, which carries no download grant", () => {
    expect(
      parseDownloadAsset(
        "https://prod-1.storage.jamendo.com/?trackid=1214935&format=mp31",
      ),
    ).toBeNull();
  });

  test("refuses a lookalike host", () => {
    expect(
      parseDownloadAsset(
        "https://prod-1.storage.jamendo.com.evil.test/download/track/1/mp32/",
      ),
    ).toBeNull();
    expect(
      parseDownloadAsset(
        "https://evil.test/download/track/1/mp32/?host=storage.jamendo.com",
      ),
    ).toBeNull();
  });

  test("refuses a non-https scheme and embedded credentials", () => {
    expect(
      parseDownloadAsset(
        "http://prod-1.storage.jamendo.com/download/track/1/mp32/",
      ),
    ).toBeNull();
    expect(
      parseDownloadAsset(
        "https://user:pass@prod-1.storage.jamendo.com/download/track/1/mp32/",
      ),
    ).toBeNull();
  });

  test("refuses traversal and arbitrary paths on the right host", () => {
    expect(
      parseDownloadAsset(
        "https://prod-1.storage.jamendo.com/download/track/1/../../etc/passwd",
      ),
    ).toBeNull();
    expect(
      parseDownloadAsset(
        "https://prod-1.storage.jamendo.com/internal/admin/mp32/",
      ),
    ).toBeNull();
  });

  test("refuses junk", () => {
    for (const value of [null, undefined, "", "not a url", 42, {}]) {
      expect(parseDownloadAsset(value)).toBeNull();
    }
  });

  test("names the file with the format it actually is", () => {
    expect(formatDetails("mp31").extension).toBe(".mp3");
    expect(formatDetails("ogg").extension).toBe(".ogg");
    expect(formatDetails("flac")).toEqual({
      contentType: "audio/flac",
      extension: ".flac",
    });
    const ogg = parseDownloadAsset(
      "https://prod-1.storage.jamendo.com/download/track/9/ogg/",
    );
    expect(ogg.format).toBe("ogg");
    expect(
      releaseFilename({
        providerId: "9",
        title: "Song",
        artist: "Artist",
        licenseUrl: "",
        attribution: "",
        asset: ogg,
      }),
    ).toBe("Artist - Song.ogg");
  });
});

describe("resolving a release", () => {
  test("asks for the id WITHOUT the invalid audioformat parameter", async () => {
    const seen = {};
    const out = await resolveJamendoDownload("1214935", "key", okFetch(release(), seen));
    expect(out.ok).toBe(true);
    expect(seen.url).toContain("id=1214935");
    expect(seen.url).toContain("client_id=key");
    // The parameter that killed the feature must never come back.
    expect(seen.url).not.toContain("audioformat=audiodownload");
    expect(seen.url).not.toContain("session_id");
  });

  test("returns the downloadable asset, not the stream", async () => {
    const out = await resolveJamendoDownload("1214935", "key", okFetch());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.release.asset.url).toContain("/download/track/1214935/mp32/");
    expect(out.release.asset.url).not.toBe(release().audio);
    expect(out.release.attribution).toBe("Some Artist — Wish You Were Here");
    expect(out.release.licenseUrl).toContain("creativecommons.org");
  });

  test("refuses a release the artist did not release for download", async () => {
    const out = await resolveJamendoDownload(
      "1214935",
      "key",
      okFetch(release({ audiodownload_allowed: false })),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.decision.code).toBe("not-authorized");
    expect(out.decision.retryable).toBe(false);
  });

  test("an absent or non-boolean flag is NOT permission", async () => {
    for (const flag of [undefined, "yes", 1, null]) {
      const out = await resolveJamendoDownload(
        "1214935",
        "key",
        okFetch(release({ audiodownload_allowed: flag })),
      );
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.decision.code).toBe("not-authorized");
    }
  });

  test("an allowed release with no usable file is not-found, never the stream", async () => {
    for (const value of ["", null, undefined, "https://evil.test/a.mp3"]) {
      const out = await resolveJamendoDownload(
        "1214935",
        "key",
        okFetch(release({ audiodownload: value })),
      );
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.decision.code).toBe("not-found");
    }
  });

  test("a response for a different track is refused", async () => {
    const out = await resolveJamendoDownload(
      "1214935",
      "key",
      okFetch(release({ id: "999" })),
    );
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.decision.code).toBe("not-found");
  });

  test("an invalid provider id is refused before any network call", async () => {
    let called = false;
    const out = await resolveJamendoDownload("1/../2", "key", async () => {
      called = true;
      return Response.json(envelope([]));
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.decision.code).toBe("invalid-request");
    expect(called).toBe(false);
  });

  test("no key is not-configured, not a broken track", async () => {
    let called = false;
    const out = await resolveJamendoDownload("1214935", "", async () => {
      called = true;
      return Response.json(envelope([]));
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.decision.code).toBe("not-configured");
      expect(out.decision.retryable).toBe(false);
    }
    expect(called).toBe(false);
  });

  test("a quota wall is retryable; a bad key is not", async () => {
    const quota = await resolveJamendoDownload(
      "1214935",
      "key",
      async () => new Response("", { status: 429 }),
    );
    expect(quota.ok).toBe(false);
    if (!quota.ok) {
      expect(quota.decision.code).toBe("rate-limited");
      expect(quota.decision.retryable).toBe(true);
    }

    const badKey = await resolveJamendoDownload(
      "1214935",
      "key",
      async () =>
        Response.json({
          headers: { status: "failed", code: 5, error_message: "Invalid client_id" },
          results: [],
        }),
    );
    expect(badKey.ok).toBe(false);
    if (!badKey.ok) expect(badKey.decision.code).toBe("not-configured");
  });

  test("a silent empty success is asked once more", async () => {
    // Jamendo intermittently answers a real query with zero rows inside a
    // successful envelope. Believing it would tell a listener that a track
    // they own has vanished.
    let calls = 0;
    const out = await resolveJamendoDownload("1214935", "key", async () => {
      calls += 1;
      if (calls === 1) return Response.json(envelope([]));
      return Response.json(envelope([release()]));
    });
    expect(out.ok).toBe(true);
    expect(calls).toBe(2);
  });

  test("two empty successes are a genuine miss", async () => {
    let calls = 0;
    const out = await resolveJamendoDownload("1214935", "key", async () => {
      calls += 1;
      return Response.json(envelope([]));
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.decision.code).toBe("not-found");
    expect(calls).toBe(2);
  });

  test("a network failure and an HTTP failure are both retryable", async () => {
    let thrownCalls = 0;
    const thrown = await resolveJamendoDownload("1214935", "key", async () => {
      thrownCalls += 1;
      throw new Error("ECONNRESET");
    });
    expect(thrown.ok).toBe(false);
    if (!thrown.ok) {
      expect(thrown.decision.code).toBe("network");
      expect(thrown.decision.retryable).toBe(true);
    }
    // Retrying a transport failure here would only double the wait; the user
    // retries deliberately.
    expect(thrownCalls).toBe(1);

    let httpCalls = 0;
    const http = await resolveJamendoDownload(
      "1214935",
      "key",
      async () => {
        httpCalls += 1;
        return new Response("gateway", { status: 502 });
      },
    );
    expect(http.ok).toBe(false);
    if (!http.ok) expect(http.decision.code).toBe("network");
    expect(httpCalls).toBe(1);
  });
});

describe("the authorization action", () => {
  const ctx = { auth: { getUserIdentity: async () => ({ subject: "u1" }) } };

  test("a YouTube video id is refused without touching the provider", async () => {
    let called = false;
    globalThis.fetch = async () => {
      called = true;
      return Response.json(envelope([release()]));
    };
    const out = await authorizeDownload._handler(ctx, { trackId: "kJQP7kiw5Fk" });
    expect(out.authorized).toBe(false);
    if (!out.authorized) expect(out.decision.code).toBe("not-authorized");
    expect(called).toBe(false);
  });

  test("an authorized release returns metadata and NO fetchable provider URL", async () => {
    process.env.JAMENDO_CLIENT_ID = "key";
    globalThis.fetch = okFetch();
    const out = await authorizeDownload._handler(ctx, {
      trackId: "jamendo:1214935",
    });
    expect(out.authorized).toBe(true);
    if (!out.authorized) return;
    expect(out.providerId).toBe("1214935");
    expect(out.filename).toBe("Some Artist - Wish You Were Here.mp3");
    expect(out.contentType).toBe("audio/mpeg");
    expect(out.licenseUrl).toContain("creativecommons.org");
    // The bytes are only reachable through the relay, which re-checks this
    // permission; handing the client the storage URL would bypass that.
    expect(JSON.stringify(out)).not.toContain("storage.jamendo.com");
  });

  test("a missing key explains the deployment problem", async () => {
    delete process.env.JAMENDO_CLIENT_ID;
    const out = await authorizeDownload._handler(ctx, {
      trackId: "jamendo:1214935",
    });
    expect(out.authorized).toBe(false);
    if (!out.authorized) expect(out.decision.code).toBe("not-configured");
  });

  test("a non-allowed release is refused with copy a listener can read", async () => {
    process.env.JAMENDO_CLIENT_ID = "key";
    globalThis.fetch = okFetch(release({ audiodownload_allowed: false }));
    const out = await authorizeDownload._handler(ctx, {
      trackId: "jamendo:1214935",
    });
    expect(out.authorized).toBe(false);
    if (!out.authorized) {
      expect(out.decision.code).toBe("not-authorized");
      expect(out.decision.message.length).toBeGreaterThan(0);
    }
  });
});

describe("the proxy's resolution cache", () => {
  test("reuses a success within its lifetime and re-checks afterwards", async () => {
    let calls = 0;
    let clock = 1_000;
    const cached = createResolveCache(
      async () => {
        calls += 1;
        return { ok: true, release: {} };
      },
      { ttlMs: 100, now: () => clock },
    );
    await cached("1");
    await cached("1");
    expect(calls).toBe(1);
    clock += 101;
    await cached("1");
    expect(calls).toBe(2);
  });

  test("does not cache a refusal, so a rate limit can recover", async () => {
    let calls = 0;
    const cached = createResolveCache(async () => {
      calls += 1;
      return { ok: false, decision: { ok: false, code: "network", message: "", retryable: true } };
    });
    await cached("1");
    await cached("1");
    expect(calls).toBe(2);
  });
});
