/**
 * The import panel's "this service can't stream" note, in a real DOM.
 *
 * This exists because the truth was already in the codebase and completely
 * invisible. The importer registry carried a blurb saying Spotify and Tidal are
 * metadata sources and that playback comes from YouTube — and the word "blurb"
 * was never rendered anywhere. The information was correct and reached nobody.
 *
 * On driving it from a keystroke, honestly: React 19 and happy-dom deliver
 * clicks but NOT `change`/`input` events on a controlled field. That was
 * measured, not assumed — a click lands and a typed value does not, so no
 * amount of event tweaking simulates typing here. Rather than assert against
 * source text (which passes just as happily against a component that renders
 * `null`), this mounts the real component with the output of the real
 * `detectServiceUrl`. That covers the whole chain that can actually break:
 * link -> detection -> capability -> rendered text.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import React from "react";
import { createRoot } from "react-dom/client";
import { canDirectImport, detectServiceUrl } from "../src/lib/sources.ts";
import { importerFor } from "../src/lib/importers.ts";

let win;

beforeAll(() => {
  win = new Window({ url: "https://example.test/settings" });
  globalThis.window = win;
  globalThis.document = win.document;
  globalThis.navigator = win.navigator;
  globalThis.location = win.location;
  globalThis.history = win.history;
  globalThis.HTMLElement = win.HTMLElement;
  globalThis.Element = win.Element;
  globalThis.Node = win.Node;
  globalThis.Event = win.Event;
  globalThis.MouseEvent = win.MouseEvent;
  globalThis.getComputedStyle = win.getComputedStyle.bind(win);
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.localStorage = win.localStorage;
  win.matchMedia = () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  });
}); /** Assigned at the very bottom, once the mocks above are in place. */
let Hint = null;

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

/** Mount the real component for a real link, and hand back the rendered text. */
async function renderFor(url) {
  const detected = detectServiceUrl(url);
  if (!detected) throw new Error(`detector found nothing for ${url}`);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  win.happyDOM.setURL("https://example.test/settings");
  root.render(
    React.createElement(Hint, {
      detected,
      capabilities: importerFor(detected.service),
      canImport: canDirectImport(detected),
    }),
  );
  await settle();

  const badge = container.querySelector(
    '[data-testid="import-detection-badge"]',
  );
  const note = container.querySelector('[data-testid="import-playback-note"]');
  return {
    container,
    root,
    badge,
    note,
    text: container.textContent || "",
  };
}

describe("the import panel tells the truth about what it can play", () => {
  test("a Tidal link warns that its keys are not a streaming licence", async () => {
    const { root, badge, note, text } = await renderFor(
      "https://tidal.com/playlist/abc123-def456",
    );

    // The badge proves the link was really recognised as a Tidal playlist,
    // so a passing note cannot be explained by the wrong branch rendering.
    expect(badge).toBeTruthy();
    expect(text).toContain("Tidal");
    expect(text).toContain("playlist detected");

    expect(note).toBeTruthy();
    const noteText = note.textContent || "";
    expect(noteText).toMatch(/can't stream audio/i);
    // The reason has to be named. "Metadata only" on its own reads like an
    // oversight; "approved partner apps" is what tells the listener this is a
    // platform limit and not a bug in SYNQ.
    expect(noteText).toMatch(/approved partner apps/i);
    // And it has to say what DOES happen, or it reads as "this won't work".
    expect(noteText).toMatch(/play through SYNQ/i);
    root.unmount();
  });

  test("a Spotify link gets its own distinct reason", async () => {
    const { root, note, text } = await renderFor(
      "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
    );
    expect(text).toContain("Spotify");
    expect(note).toBeTruthy();
    expect(note.textContent).toMatch(/no audio endpoint for third-party apps/i);
    root.unmount();
  });

  test("an Apple Music link is covered too", async () => {
    const { root, note, text } = await renderFor(
      "https://music.apple.com/us/playlist/my-playlist/pl.u-abc123",
    );
    expect(text).toContain("Apple Music");
    expect(note).toBeTruthy();
    root.unmount();
  });

  test("a YouTube link gets NO note, because YouTube really does play", async () => {
    // The assertion that stops a caveat being added to the one service that
    // would make it a lie.
    const { root, badge, note, text } = await renderFor(
      "https://www.youtube.com/playlist?list=PLabcdefghijklmnop",
    );
    expect(badge).toBeTruthy();
    expect(text).toContain("YouTube");
    expect(note).toBeNull();
    root.unmount();
  });

  test("YouTube Music gets no note either", async () => {
    const { root, note } = await renderFor(
      "https://music.youtube.com/playlist?list=OLAK5uy_abcdef",
    );
    expect(note).toBeNull();
    root.unmount();
  });

  test("the badge still says 'File only' for a service that needs an export", async () => {
    // The note must not come at the cost of the existing affordance: Bandcamp
    // cannot be link-imported, and the panel has to keep saying so.
    const { root, badge } = await renderFor(
      "https://artist.bandcamp.com/playlist/42",
    );
    expect(badge).toBeTruthy();
    expect(badge.textContent).toContain("File only");
    root.unmount();
  });
});

// Last: the `await` suspends module evaluation, so every `describe` has to be
// registered above this line or Bun rejects it with "Cannot call describe()
// after the test run has completed". That only reproduces in a COMBINED run.
Hint = (await import("../src/components/settings/ImportServiceHint.tsx"))
  .ImportServiceHint;
