import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * Cover for the recovered remote-artwork fallback.
 *
 * The point of these tests is the behaviour that is easy to get wrong and hard
 * to notice: that the placeholder is applied exactly once (so a placeholder
 * cannot be swapped for itself forever), that it is not applied to elements
 * that are not images, and that it never touches a working image.
 */

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

describe("a failed remote image is replaced, once", () => {
  test("first failure applies, second is a no-op", () => {
    const img = fakeImage("https://i.ytimg.com/vi/abc/hqdefault.jpg");

    expect(applyImageFallback(img)).toBe(true);
    expect(img.src).toBe(FALLBACK_IMAGE_SRC);
    expect(img.hasAttribute("data-synq-fallback")).toBe(true);
    expect(applyImageFallback(img)).toBe(false);
  });

  test("a placeholder that itself fails is left alone", () => {
    const fallenOnce = fakeImage("https://example.com/dead.jpg");
    applyImageFallback(fallenOnce);
    // After the fallback, the img's src IS the placeholder; a later error
    // event on it (e.g. React re-rendering it with the same dead url) must
    // not reset the marker and loop.
    expect(applyImageFallback({ ...fallenOnce })).toBe(false);
  });
});

describe("non-images, empty sources and the placeholder itself are left alone", () => {
  test("the guard rejects everything that is not a loadable remote image", () => {
    expect(shouldUseFallback({ tagName: "DIV", src: "x" })).toBe(false);
    expect(shouldUseFallback(fakeImage(""))).toBe(false);
    expect(shouldUseFallback(fakeImage(undefined))).toBe(false);
    expect(shouldUseFallback(fakeImage(FALLBACK_IMAGE_SRC))).toBe(false);
    expect(shouldUseFallback(fakeImage("https://example.com/a.png"))).toBe(true);
    // currentSrc wins when the browser has picked a candidate.
    expect(
      shouldUseFallback({
        tagName: "IMG",
        src: "https://example.com/a.png",
        currentSrc: FALLBACK_IMAGE_SRC,
        hasAttribute: () => false,
      }),
    ).toBe(false);
  });
});

describe("the installed listener is capture-phase and idempotent", () => {
  test("one listener, capture=true, no duplicates, clean teardown", () => {
    const calls = [];
    const host = {
      addEventListener: (type, handler, capture) =>
        calls.push({ type, capture }),
      removeEventListener: () => {},
    };

    const uninstall = installImageFallback(host);
    expect(calls.length).toBe(1);
    expect(calls[0].type).toBe("error");
    // `error` does not bubble, so a capture listener is what makes one handler
    // see every image in the document.
    expect(calls[0].capture).toBe(true);

    // A second install must not add a duplicate listener.
    installImageFallback(host);
    expect(calls.length).toBe(1);
    uninstall();
  });

  test("installing outside a browser is a harmless no-op", () => {
    const uninstall = installImageFallback(undefined);
    expect(typeof uninstall).toBe("function");
    uninstall();
  });
});

// ---------------------------------------------------------------------------
// Real-DOM section: the module must behave against actual happy-dom elements,
// not only the fake stand-ins used above.
// ---------------------------------------------------------------------------
const win = new Window({ url: "https://example.test/" });
globalThis.window = win;
globalThis.document = win.document;
globalThis.HTMLElement = win.HTMLElement;
globalThis.Event = win.Event;

const { installImageFallback: installOnRealWindow } = await import(
  "../src/lib/imageFallback.ts"
);

describe("against real happy-dom elements", () => {
  test("the fallback works on a real <img> element", () => {
    const broken = win.document.createElement("img");
    broken.setAttribute("src", "https://i.ytimg.com/vi/def/hqdefault.jpg");

    expect(applyImageFallback(broken)).toBe(true);
    expect(broken.getAttribute("src")).toBe(FALLBACK_IMAGE_SRC);
    expect(broken.hasAttribute("data-synq-fallback")).toBe(true);
    // Second application must be a no-op against the real element too.
    expect(applyImageFallback(broken)).toBe(false);
  });

  test("the window capture listener replaces a broken real <img>, and a healthy one is untouched", () => {
    installOnRealWindow();

    const broken = win.document.createElement("img");
    broken.setAttribute("src", "https://i.ytimg.com/vi/ghi/hqdefault.jpg");
    win.document.body.appendChild(broken);
    // In a browser, resource `error` events are non-bubbling but DO traverse
    // the capture path — happy-dom's propagation does not model that, so the
    // test lets the event bubble. The production listener stays capture-phase
    // (asserted by the fake-host test above); capture listeners receive
    // bubbling events from descendants during the capture phase as well.
    broken.dispatchEvent(new win.Event("error", { bubbles: true }));
    expect(broken.getAttribute("src")).toBe(FALLBACK_IMAGE_SRC);
    expect(broken.hasAttribute("data-synq-fallback")).toBe(true);

    const healthy = win.document.createElement("img");
    healthy.setAttribute("src", "https://example.com/ok.jpg");
    win.document.body.appendChild(healthy);
    healthy.dispatchEvent(new win.Event("load", { bubbles: true }));
    expect(healthy.getAttribute("src")).toBe("https://example.com/ok.jpg");
    expect(healthy.hasAttribute("data-synq-fallback")).toBe(false);
  });
});
