/**
 * Deep-link and navigation-policy tests for the desktop OAuth return path.
 *
 * These run under plain Node (no Electron), which is why
 * `electron/oauth-deep-link.cjs` requires Electron lazily. They cover the parts
 * that are easy to get wrong and expensive to discover in a packaged build:
 *
 *  - the exact URL shape `@convex-dev/auth` produces when it appends `code`,
 *  - that a callback is only accepted once, for the attempt that started it,
 *  - that unrelated / stale / malformed URLs are rejected,
 *  - that auth origins are opened externally instead of embedded, and that
 *    internal app routes are still allowed.
 *
 * Run with: node --test tests/desktop-oauth-deeplink.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";

import oauth from "../electron/oauth-deep-link.cjs";

/** Mirror of the server's `setURLSearchParam`, used to build the real URL. */
function withCodeParam(redirectTo, code) {
  const pattern = /([^:]+):(.*)/;
  const [, scheme, rest] = redirectTo.match(pattern);
  const hasNoDomain = /^\/\/(?:\/|$|\?)/.test(rest);
  const startsWithPath = hasNoDomain && rest.startsWith("///");
  const url = new URL(
    `http:${hasNoDomain ? "//googblibok" + rest.slice(2) : rest}`,
  );
  url.searchParams.set("code", code);
  const [, , withParam] = url.toString().match(pattern);
  return `${scheme}:${
    hasNoDomain
      ? (startsWithPath ? "/" : "") + "//" + withParam.slice(13)
      : withParam
  }`;
}

const CLIENT = "google-test-client";
const NONCE = "nonce-test";
// The recorder is what anchors freshness: a callback must carry the timestamp
// its attempt was registered with, so the test uses the real clock.
const TS = Date.now();

test("the server-rewritten synq:// callback URL is accepted", () => {
  const redirectTo = `synq://callback?client=${CLIENT}&ts=${TS}&nonce=${NONCE}`;
  const callback = withCodeParam(redirectTo, "CODE-VALUE");

  // Sanity: the redirect target survives the server's rewrite with both its
  // host and its query intact. If this shape ever changes, the parser below is
  // the thing that must be updated.
  assert.equal(
    callback,
    `synq://callback/?client=${CLIENT}&ts=${TS}&nonce=${NONCE}&code=CODE-VALUE`,
  );

  oauth.recordPendingCallback(CLIENT, { nonce: NONCE, ts: TS });
  const result = oauth.parseDeepLinkParams(callback);
  assert.ok(result, "expected the callback to validate");
  assert.equal(result.client, CLIENT);
  assert.equal(result.code, "CODE-VALUE");
  assert.equal(result.nonce, NONCE);
});

test("a callback is single-use: replaying it is rejected", () => {
  const redirectTo = `synq://callback?client=${CLIENT}-replay&ts=${TS}&nonce=${NONCE}`;
  const callback = withCodeParam(redirectTo, "CODE");
  oauth.recordPendingCallback(`${CLIENT}-replay`, { nonce: NONCE, ts: TS });

  assert.ok(oauth.parseDeepLinkParams(callback), "first delivery accepted");
  assert.equal(
    oauth.parseDeepLinkParams(callback),
    null,
    "second delivery must be rejected",
  );
});

test("unknown, mismatched and stale callbacks are rejected", () => {
  // A client id we never started.
  assert.equal(
    oauth.parseDeepLinkParams(
      `synq://callback?client=unrelated&ts=${Date.now()}&code=CODE`,
    ),
    null,
  );

  // Wrong nonce for a registered attempt.
  oauth.recordPendingCallback("nonce-check", { nonce: "expected", ts: Date.now() });
  assert.equal(
    oauth.parseDeepLinkParams(
      `synq://callback?client=nonce-check&ts=${Date.now()}&nonce=wrong&code=C`,
    ),
    null,
  );

  // Registered, but the attempt is older than the replay window.
  oauth.recordPendingCallback("stale-check", {
    nonce: "n",
    ts: Date.now() - 11 * 60 * 1000,
  });
  assert.equal(
    oauth.parseDeepLinkParams(
      `synq://callback?client=stale-check&ts=${
        Date.now() - 11 * 60 * 1000
      }&nonce=n&code=C`,
    ),
    null,
  );

  // Registered, but the URL carries a different timestamp (a replayed URL).
  oauth.recordPendingCallback("ts-mismatch", { nonce: "n", ts: Date.now() });
  assert.equal(
    oauth.parseDeepLinkParams(
      `synq://callback?client=ts-mismatch&ts=${Date.now() - 1000}&nonce=n&code=C`,
    ),
    null,
  );

  // Not a synq URL, and not a callback path.
  oauth.recordPendingCallback("path-check", { nonce: "n", ts: Date.now() });
  assert.equal(oauth.parseDeepLinkParams("https://example.com/?code=X"), null);
  assert.equal(
    oauth.parseDeepLinkParams(`synq://not-a-callback?client=path-check&ts=${Date.now()}`),
    null,
  );
  assert.equal(oauth.parseDeepLinkParams("synq://callback?code=no-client"), null);
});

test("both slash forms of the callback are understood", () => {
  oauth.recordPendingCallback("path-form", { nonce: "n", ts: Date.now() });
  const pathForm = oauth.parseDeepLinkParams(
    `synq:/callback?client=path-form&ts=${Date.now()}&nonce=n&code=C`,
  );
  assert.ok(pathForm, "path form synq:/callback must be accepted");
  assert.equal(pathForm.code, "C");
});

test("auth origins are opened externally, app routes are not", () => {
  assert.equal(
    oauth.decideNavigationPolicy("https://accounts.google.com/o/oauth2/v2/auth"),
    "open-external",
  );
  assert.equal(
    oauth.decideNavigationPolicy("https://github.com/login/oauth/authorize"),
    "open-external",
  );
  // Any other web link also belongs in the browser, so the renderer can never
  // pull arbitrary sites into a privileged window.
  assert.equal(
    oauth.decideNavigationPolicy("https://example.com/docs"),
    "open-external",
  );
  // The packaged renderer's own pages stay inside the app...
  assert.equal(
    oauth.decideNavigationPolicy(
      "file:///D:/app/resources/app.asar/dist/index.html#/home",
      { appFileRoot: "D:/app/resources/app.asar/dist" },
    ),
    "allow",
  );
  // ...but local files outside the app directory are not navigable.
  assert.equal(
    oauth.decideNavigationPolicy("file:///C:/Windows/System32/drivers/etc/hosts", {
      appFileRoot: "D:/app/resources/app.asar/dist",
    }),
    "deny",
  );
  // Without a configured root, no file navigation is trusted at all.
  assert.equal(
    oauth.decideNavigationPolicy("file:///D:/app/dist/index.html"),
    "deny",
  );
  // The dev server is the app itself when it is the configured origin...
  assert.equal(
    oauth.decideNavigationPolicy("http://localhost:5173/#/home", {
      appOrigins: ["http://localhost:5173"],
    }),
    "allow",
  );
  // ...but a localhost URL that is not the app origin is still just a website.
  assert.equal(
    oauth.decideNavigationPolicy("http://localhost:5173/#/home"),
    "open-external",
  );
  // A stray deep link must never be opened by the renderer itself.
  assert.equal(oauth.decideNavigationPolicy("synq://callback?code=X"), "deny");
  assert.equal(oauth.decideNavigationPolicy("javascript:alert(1)"), "deny");
  assert.equal(oauth.decideNavigationPolicy("data:text/html,<h1>x"), "deny");
  assert.equal(oauth.decideNavigationPolicy("not a url"), "deny");
});
