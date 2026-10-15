/**
 * `publicAsset()` decides where a /public file lives in each runtime SYNQ
 * ships in. It is the fix for the packaged desktop app showing a broken SYNQ
 * logo: the hand-written URL `/logo.svg` resolved to `file:///logo.svg` (the
 * root of the drive) instead of the file inside the app bundle.
 *
 * Run with: node --test tests/public-asset-resolution.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";

/** Load the module with a simulated runtime in place. */
async function loadWith({ protocol, baseURI }) {
  globalThis.window = { location: { protocol } };
  globalThis.document = { baseURI };
  // Cache-busted so each case gets a fresh module against its own globals.
  const mod = await import(
    `../src/lib/publicAsset.ts?case=${encodeURIComponent(protocol + baseURI)}`
  );
  return mod.publicAsset;
}

test("packaged desktop: resolves next to the loaded document", async () => {
  const publicAsset = await loadWith({
    protocol: "file:",
    baseURI:
      "file:///D:/synq67/synqmusic/desktop-dist/win-unpacked/resources/app.asar/dist/index.html",
  });

  assert.equal(
    publicAsset("logo.svg?v=2"),
    "file:///D:/synq67/synqmusic/desktop-dist/win-unpacked/resources/app.asar/dist/logo.svg?v=2",
  );
  assert.equal(
    publicAsset("/icons/icon-192.png"),
    "file:///D:/synq67/synqmusic/desktop-dist/win-unpacked/resources/app.asar/dist/icons/icon-192.png",
  );
  assert.equal(
    publicAsset("show-me-love-cover.svg"),
    "file:///D:/synq67/synqmusic/desktop-dist/win-unpacked/resources/app.asar/dist/show-me-love-cover.svg",
  );
});

test("hosted site and Android WebView: unchanged root-absolute URLs", async () => {
  const hosted = await loadWith({
    protocol: "https:",
    baseURI: "https://synqmusic.freebuff.app/playlist/abc",
  });
  // Deep routes must keep resolving from the domain root, not from the route.
  assert.equal(hosted("logo.svg?v=2"), "/logo.svg?v=2");
  assert.equal(hosted("/icons/icon-192.png"), "/icons/icon-192.png");

  const android = await loadWith({
    protocol: "https:",
    baseURI: "https://localhost/index.html",
  });
  assert.equal(android("logo.svg?v=2"), "/logo.svg?v=2");
});

test("the query string survives resolution (cache-busting is an origin of its own)", async () => {
  const publicAsset = await loadWith({
    protocol: "file:",
    baseURI: "file:///C:/app/dist/index.html",
  });
  assert.equal(publicAsset("logo.svg?v=2"), "file:///C:/app/dist/logo.svg?v=2");
});
