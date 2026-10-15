/**
 * Cover for the remote-artwork fallback.
 *
 * The point of these tests is the behaviour that is easy to get wrong and hard
 * to notice: that the placeholder is applied exactly once (so a placeholder
 * cannot be swapped for itself forever), that it is not applied to elements
 * that are not images, and that it never touches a working image.
 *
 * Run with: node --test tests/image-fallback.test.js
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  FALLBACK_IMAGE_SRC,
  applyImageFallback,
  installImageFallback,
  shouldUseFallback,
} from "../src/lib/imageFallback.ts";

/** Minimal stand-in for an <img>. */
function fakeImage(src) {
  const attributes = new Set();
  return {
    tagName: "IMG",
    src,
    currentSrc: src,
    hasAttribute: (name) => attributes.has(name),
    setAttribute: (name) => attributes.add(name),
  };
}

test("a failed remote image is replaced, once", () => {
  const img = fakeImage("https://i.ytimg.com/vi/abc/hqdefault.jpg");

  assert.equal(applyImageFallback(img), true, "first failure applies");
  assert.equal(img.src, FALLBACK_IMAGE_SRC);
  assert.equal(img.hasAttribute("data-synq-fallback"), true);
  assert.equal(applyImageFallback(img), false, "second failure is a no-op");
});

test("non-images, empty sources and the placeholder itself are left alone", () => {
  assert.equal(shouldUseFallback({ tagName: "DIV", src: "x" }), false);
  assert.equal(shouldUseFallback(fakeImage("")), false);
  assert.equal(shouldUseFallback(fakeImage(undefined)), false);
  assert.equal(shouldUseFallback(fakeImage(FALLBACK_IMAGE_SRC)), false);
  assert.equal(shouldUseFallback(fakeImage("https://example.com/a.png")), true);
  // currentSrc wins when the browser has picked a candidate.
  assert.equal(
    shouldUseFallback({
      tagName: "IMG",
      src: "https://example.com/a.png",
      currentSrc: FALLBACK_IMAGE_SRC,
      hasAttribute: () => false,
    }),
    false,
  );
});

test("the installed listener is capture-phase and idempotent", () => {
  const calls = [];
  const host = {
    addEventListener: (type, handler, capture) => calls.push({ type, capture }),
    removeEventListener: () => {},
  };

  const uninstall = installImageFallback(host);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, "error");
  // `error` does not bubble, so a capture listener is what makes one handler
  // see every image in the document.
  assert.equal(calls[0].capture, true);

  // A second install must not add a duplicate listener.
  installImageFallback(host);
  assert.equal(calls.length, 1);
  uninstall();
});

test("installing outside a browser is a harmless no-op", () => {
  const uninstall = installImageFallback(undefined);
  assert.equal(typeof uninstall, "function");
});
