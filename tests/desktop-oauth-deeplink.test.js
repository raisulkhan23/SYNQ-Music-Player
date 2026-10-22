import { describe, expect, test } from "bun:test";
import oauth from "../electron/oauth-deep-link.cjs";

/**
 * Deep-link and navigation-policy tests for the desktop OAuth return path.
 *
 * These run under Bun (no Electron), which is why
 * `electron/oauth-deep-link.cjs` requires Electron lazily. They cover the
 * parts that are easy to get wrong and expensive to discover in a packaged
 * build:
 *
 *  - the exact URL shape `@convex-dev/auth` produces when it appends `code`,
 *  - that a callback is only accepted once, for the attempt that started it,
 *  - that unrelated / stale / mismatched / malformed URLs are rejected,
 *  - that web origins are opened externally instead of embedded, that the
 *    app's own scheme stays internal, and that stray deep links, javascript:
 *    and data: targets are denied outright.
 */

/**
 * Mirror of what `@convex-dev/auth` does to a custom-scheme redirect when it
 * appends the `code` parameter: it round-trips the URL through the http
 * parser (`setURLSearchParam`), so `synq://callback?…` comes back as
 * `synq://callback/?…`. We reproduce exactly that round-trip by swapping the
 * scheme for a special http one, appending, and swapping back — deterministic
 * for both the host form (`synq://callback`) and the path form
 * (`synq:/callback`, which the special-scheme parser normalises identically).
 */
function withCodeParam(redirectTo, code) {
  const parsed = new URL(redirectTo.replace("synq:", "http:"));
  parsed.searchParams.set("code", code);
  return parsed.toString().replace("http:", "synq:");
}

const CLIENT = "google-test-client";
const NONCE = "nonce-test";
// The recorder is what anchors freshness: a callback must carry the timestamp
// its attempt was registered with, so the test uses the real clock.
const TS = Date.now();

describe("the server-rewritten synq:// callback URL validates", () => {
  test("the exact shape the SDK produces is accepted", () => {
    const redirectTo = `synq://callback?client=${CLIENT}&ts=${TS}&nonce=${NONCE}`;
    const callback = withCodeParam(redirectTo, "CODE-VALUE");

    // Sanity: the redirect target survives the server's rewrite with both its
    // host and its query intact. If this shape ever changes, the parser below
    // is the thing that must be updated.
    expect(callback).toBe(
      `synq://callback/?client=${CLIENT}&ts=${TS}&nonce=${NONCE}&code=CODE-VALUE`,
    );

    oauth.recordPendingCallback(CLIENT, { nonce: NONCE, ts: TS });
    const result = oauth.parseDeepLinkParams(callback);
    expect(result).not.toBeNull();
    expect(result.client).toBe(CLIENT);
    expect(result.code).toBe("CODE-VALUE");
    expect(result.nonce).toBe(NONCE);
  });

  test("a callback is single-use: replaying it is rejected", () => {
    const replayClient = `${CLIENT}-replay`;
    const redirectTo = `synq://callback?client=${replayClient}&ts=${TS}&nonce=${NONCE}`;
    const callback = withCodeParam(redirectTo, "CODE");
    oauth.recordPendingCallback(replayClient, { nonce: NONCE, ts: TS });

    expect(oauth.parseDeepLinkParams(callback)).not.toBeNull();
    expect(oauth.parseDeepLinkParams(callback)).toBeNull();
  });

  test("unknown, mismatched and stale callbacks are rejected", () => {
    // A client id we never started.
    expect(
      oauth.parseDeepLinkParams(
        `synq://callback?client=unrelated&ts=${Date.now()}&code=CODE`,
      ),
    ).toBeNull();

    // Wrong nonce for a registered attempt.
    oauth.recordPendingCallback("nonce-check", {
      nonce: "expected",
      ts: Date.now(),
    });
    expect(
      oauth.parseDeepLinkParams(
        `synq://callback?client=nonce-check&ts=${Date.now()}&nonce=wrong&code=C`,
      ),
    ).toBeNull();

    // Registered, but the attempt is older than the replay window.
    const staleTs = Date.now() - (oauth.CALLBACK_VALIDITY_MS + 60_000);
    oauth.recordPendingCallback("stale-check", { nonce: "n", ts: staleTs });
    expect(
      oauth.parseDeepLinkParams(
        `synq://callback?client=stale-check&ts=${staleTs}&nonce=n&code=C`,
      ),
    ).toBeNull();

    // Registered, but the URL carries a different timestamp (a replayed URL).
    oauth.recordPendingCallback("ts-mismatch", { nonce: "n", ts: Date.now() });
    expect(
      oauth.parseDeepLinkParams(
        `synq://callback?client=ts-mismatch&ts=${Date.now() - 1000}&nonce=n&code=C`,
      ),
    ).toBeNull();

    // Not a synq URL, and not a callback path.
    oauth.recordPendingCallback("path-check", { nonce: "n", ts: Date.now() });
    expect(oauth.parseDeepLinkParams("https://example.com/?code=X")).toBeNull();
    expect(
      oauth.parseDeepLinkParams(
        `synq://not-a-callback?client=path-check&ts=${Date.now()}`,
      ),
    ).toBeNull();
    expect(oauth.parseDeepLinkParams("synq://callback?code=no-client")).toBeNull();
  });

  test("both slash forms of the callback are understood", () => {
    oauth.recordPendingCallback("path-form", { nonce: "n", ts: Date.now() });
    const pathForm = oauth.parseDeepLinkParams(
      `synq:/callback?client=path-form&ts=${Date.now()}&nonce=n&code=C`,
    );
    expect(pathForm).not.toBeNull();
    expect(pathForm.code).toBe("C");
  });

  test("malformed input never throws", () => {
    expect(oauth.parseDeepLinkParams(null)).toBeNull();
    expect(oauth.parseDeepLinkParams(undefined)).toBeNull();
    expect(oauth.parseDeepLinkParams(42)).toBeNull();
    expect(oauth.parseDeepLinkParams("not a url at all")).toBeNull();
    expect(oauth.findDeepLinkArg("synq://callback")).toBeNull();
    expect(oauth.findDeepLinkArg([null, 7])).toBeNull();
  });
});

describe("the navigation policy keeps the app inside SYNQ", () => {
  test("web origins — consent screens included — are opened externally", () => {
    expect(
      oauth.decideNavigationPolicy("https://accounts.google.com/o/oauth2/v2/auth"),
    ).toBe("open-external");
    expect(
      oauth.decideNavigationPolicy("https://github.com/login/oauth/authorize"),
    ).toBe("open-external");
    // Any other web link also belongs in the browser, so the renderer can
    // never pull arbitrary sites into a privileged window.
    expect(oauth.decideNavigationPolicy("https://example.com/docs")).toBe(
      "open-external",
    );
  });

  test("the packaged app's own scheme navigates internally", () => {
    // `app://synq` is the shell itself: BrowserRouter reloads, the smoke
    // route, etc. must keep working.
    expect(
      oauth.decideNavigationPolicy("app://synq/artist/Hozier", {
        appSchemes: ["app:"],
      }),
    ).toBe("allow");
    // ...but an unconfigured custom scheme gets no such trust.
    expect(oauth.decideNavigationPolicy("app://synq/")).toBe("deny");
  });

  test("file:// navigation is confined to the app's own directory", () => {
    const root = "D:/app/resources/app.asar/dist";
    expect(
      oauth.decideNavigationPolicy(
        "file:///D:/app/resources/app.asar/dist/index.html#/home",
        { appFileRoot: root },
      ),
    ).toBe("allow");
    expect(
      oauth.decideNavigationPolicy(
        "file:///C:/Windows/System32/drivers/etc/hosts",
        { appFileRoot: root },
      ),
    ).toBe("deny");
    // Without a configured root, no file navigation is trusted at all.
    expect(
      oauth.decideNavigationPolicy("file:///D:/app/dist/index.html"),
    ).toBe("deny");
  });

  test("the dev server is internal only when it is the configured origin", () => {
    expect(
      oauth.decideNavigationPolicy("http://localhost:5173/#/home", {
        appOrigins: ["http://localhost:5173"],
      }),
    ).toBe("allow");
    expect(oauth.decideNavigationPolicy("http://localhost:5173/#/home")).toBe(
      "open-external",
    );
  });

  test("stray deep links and dangerous schemes are denied outright", () => {
    expect(oauth.decideNavigationPolicy("synq://callback?code=X")).toBe("deny");
    expect(oauth.decideNavigationPolicy("javascript:alert(1)")).toBe("deny");
    expect(oauth.decideNavigationPolicy("data:text/html,<h1>x")).toBe("deny");
    expect(oauth.decideNavigationPolicy("not a url")).toBe("deny");
    expect(oauth.decideNavigationPolicy(undefined)).toBe("deny");
  });
});
