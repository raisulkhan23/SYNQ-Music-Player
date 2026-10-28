/**
 * The download relay.
 *
 * Jamendo's storage sends no CORS headers, so a browser cannot read a licensed
 * file directly; this relay is the only route from the provider to OPFS. That
 * makes it security-relevant: it must never become an open proxy, and it must
 * still behave like an origin the download engine can resume from.
 */
import { describe, expect, test } from "bun:test";
import {
  downloadProxyPreflight,
  handleDownloadProxy,
} from "../src/lib/downloadProxy";

const ASSET = {
  providerId: "1214935",
  url: "https://prod-1.storage.jamendo.com/download/track/1214935/mp32/?from=app-1",
  format: "mp32",
  contentType: "audio/mpeg",
  extension: ".mp3",
};

const release = (asset = ASSET) => ({ ok: true, release: { asset } });

const REFUSAL = (code) => ({
  ok: false,
  decision: { ok: false, code, message: `refused: ${code}`, retryable: false },
});

function request(search = "?track=1214935", headers = {}, method = "GET") {
  return new Request(`https://synq.test/download-proxy${search}`, {
    method,
    headers,
  });
}

/** A 206 fixture that records what the relay asked the provider for. */
function upstreamFixture({ status = 206, body = new Uint8Array([1, 2, 3]) } = {}) {
  const seen = [];
  return {
    seen,
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      const response = new Response(body, {
        status,
        headers: {
          // The provider genuinely mislabels MP3s as HTML.
          "Content-Type": "text/html; charset=UTF-8",
          "Content-Length": String(body.length),
          "Content-Range": `bytes 0-${body.length - 1}/2048`,
          "Accept-Ranges": "bytes",
        },
      });
      return response;
    },
  };
}

describe("only an id ever reaches the provider", () => {
  test("a URL in the query string is ignored", async () => {
    const { seen, fetchImpl } = upstreamFixture();
    const res = await handleDownloadProxy(
      request("?track=1214935&u=https://evil.test/steal"),
      { resolve: async () => release(), fetchImpl },
    );
    expect(res.status).toBe(206);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(ASSET.url);
  });

  test("a non-numeric id is refused before resolving", async () => {
    let resolved = false;
    for (const id of ["", "abc", "1/../2", "https://evil.test/a"]) {
      const res = await handleDownloadProxy(
        request(`?track=${encodeURIComponent(id)}`),
        {
          resolve: async () => {
            resolved = true;
            return release();
          },
        },
      );
      expect(res.status).toBe(400);
    }
    expect(resolved).toBe(false);
  });

  test("works without a query string at all", async () => {
    const res = await handleDownloadProxy(request(""), {
      resolve: async () => release(),
    });
    expect(res.status).toBe(400);
  });
});

describe("it behaves like an origin the engine can resume from", () => {
  test("CORS is present and Range is forwarded, nothing else", async () => {
    const { seen, fetchImpl } = upstreamFixture();
    const res = await handleDownloadProxy(
      request("?track=1214935", {
        Range: "bytes=1024-2047",
        Cookie: "session=secret",
        Authorization: "Bearer nope",
      }),
      { resolve: async () => release(), fetchImpl },
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-expose-headers")).toContain(
      "Content-Range",
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    // A provider must never see the listener's own credentials.
    const headers = seen[0].init.headers;
    expect(headers).toEqual({ Range: "bytes=1024-2047" });
    expect(seen[0].init.credentials).toBeUndefined();
  });

  test("the real media type wins over the provider's text/html label", async () => {
    const { fetchImpl } = upstreamFixture();
    const res = await handleDownloadProxy(request(), {
      resolve: async () => release(),
      fetchImpl,
    });
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("content-range")).toBe("bytes 0-2/2048");
    expect(res.headers.get("content-length")).toBe("3");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
  });

  test("bytes are passed through unchanged", async () => {
    const body = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]);
    const { fetchImpl } = upstreamFixture({ body });
    const res = await handleDownloadProxy(request(), {
      resolve: async () => release(),
      fetchImpl,
    });
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...body]);
  });

  test("a junk Range is dropped rather than forwarded", async () => {
    const { seen, fetchImpl } = upstreamFixture();
    await handleDownloadProxy(
      request("?track=1214935", { Range: "bytes=0-1, 5-9" }),
      { resolve: async () => release(), fetchImpl },
    );
    expect(seen[0].init.headers).toEqual({});
  });

  test("a whole-file 200 is passed through", async () => {
    const { fetchImpl } = upstreamFixture({ status: 200 });
    const res = await handleDownloadProxy(request(), {
      resolve: async () => release(),
      fetchImpl,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("refusals are honest HTTP answers", () => {
  test("each refusal code maps to a status the client can act on", async () => {
    const cases = [
      ["not-authorized", 403],
      ["not-found", 404],
      ["not-configured", 503],
      ["rate-limited", 429],
      ["network", 502],
      ["invalid-request", 400],
    ];
    for (const [code, status] of cases) {
      const res = await handleDownloadProxy(request(), {
        resolve: async () => REFUSAL(code),
      });
      expect([code, res.status]).toEqual([code, status]);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      // The message is the shared refusal copy, not provider internals.
      expect(await res.text()).toContain(code);
    }
  });

  test("the relay never fetches when authorization refuses", async () => {
    let fetched = false;
    await handleDownloadProxy(request(), {
      resolve: async () => REFUSAL("not-authorized"),
      fetchImpl: async () => {
        fetched = true;
        return new Response("x");
      },
    });
    expect(fetched).toBe(false);
  });

  test("an upstream error becomes a 502, not a partial file", async () => {
    const { fetchImpl } = upstreamFixture({ status: 503 });
    const res = await handleDownloadProxy(request(), {
      resolve: async () => release(),
      fetchImpl,
    });
    expect(res.status).toBe(502);
  });

  test("a redirect off the provider host is refused", async () => {
    const fetchImpl = async () => {
      const response = new Response("payload", { status: 200 });
      Object.defineProperty(response, "url", {
        value: "https://evil.test/payload.mp3",
      });
      return response;
    };
    const res = await handleDownloadProxy(request(), {
      resolve: async () => release(),
      fetchImpl,
    });
    expect(res.status).toBe(502);
  });

  test("a redirect within the provider host is fine", async () => {
    const fetchImpl = async () => {
      const response = new Response("payload", { status: 200 });
      Object.defineProperty(response, "url", {
        value: "https://prod-2.storage.jamendo.com/download/track/1/mp32/",
      });
      return response;
    };
    const res = await handleDownloadProxy(request(), {
      resolve: async () => release(),
      fetchImpl,
    });
    expect(res.status).toBe(200);
  });

  test("an unreachable provider is a retryable 502", async () => {
    const res = await handleDownloadProxy(request(), {
      resolve: async () => release(),
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(res.status).toBe(502);
  });
});

describe("methods and preflight", () => {
  test("preflight advertises Range and GET", async () => {
    const res = downloadProxyPreflight();
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toBe("Range");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
  });

  test("OPTIONS short-circuits and POST is rejected", async () => {
    let resolved = false;
    const preflight = await handleDownloadProxy(request("", {}, "OPTIONS"), {
      resolve: async () => {
        resolved = true;
        return release();
      },
    });
    expect(preflight.status).toBe(204);

    const post = await handleDownloadProxy(request("", {}, "POST"), {
      resolve: async () => release(),
    });
    expect(post.status).toBe(405);
    expect(resolved).toBe(false);
  });
});
