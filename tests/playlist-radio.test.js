import { describe, expect, test } from "bun:test";
import { readSource } from "./helpers/tailwind-css.js";

const storeSource = readSource("src/store/player.ts");
const pageSource = readSource("src/pages/PlaylistDetail.tsx");

/** Body of a `function name(...) { ... }` declared at module scope. */
function fn(name) {
  const start = storeSource.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`missing ${name}`);
  const end = storeSource.indexOf("\n}\n", start);
  return storeSource.slice(start, end === -1 ? undefined : end + 3);
}

/** Body of a `const name = (...) => { ... }` declared inside the store factory. */
function factoryFn(name) {
  const start = storeSource.indexOf(`  const ${name} = (`);
  if (start === -1) throw new Error(`missing ${name}`);
  const end = storeSource.indexOf("\n  const ", start + 10);
  return storeSource.slice(start, end === -1 ? undefined : end);
}

const startPlaylistRadio = factoryFn("startPlaylistRadio");
const stopRadio = factoryFn("stopRadio");
// The queue-building body lives in `playResolved`; `playTrack` and
// `playListOrdered` are thin wrappers over it. Reading the wrapper would miss
// everything the shared body does, so assert against the body itself.
const playTrack = factoryFn("playResolved");
const playIndex = factoryFn("playIndex");
const maybeAutofillQueue = factoryFn("maybeAutofillQueue");
const playlistMixContext = fn("playlistMixContext");
const saveQueue = fn("saveQueue");
// The end-of-track advance lives in `completeEndedTrack`; `handleEnded`
// delegates to it and a deferred blend calls it back.
const handleEnded = fn("completeEndedTrack");

describe("the store exposes a radio mode", () => {
  test("radio state and actions are part of the public surface", () => {
    expect(storeSource).toMatch(/radioActive: boolean;/);
    expect(storeSource).toMatch(/radioSource: string \| null;/);
    expect(storeSource).toMatch(
      /startPlaylistRadio: \(tracks: Playable\[\], label: string\) => void;/,
    );
    expect(storeSource).toMatch(/stopRadio: \(\) => void;/);
    // ...and they are actually handed to the store, not just declared.
    expect(storeSource).toMatch(/\n    startPlaylistRadio,\n/);
    expect(storeSource).toMatch(/\n    stopRadio,\n/);
  });

  test("radio starts off and is never persisted", () => {
    // Restoring a persisted endless queue would silently keep fetching tracks
    // for someone who only wanted their playlist back.
    expect(storeSource).toMatch(/radioActive: false,\n\s*radioSource: null,/);
    expect(storeSource).not.toMatch(/localStorage[^;\n]*radio/);
  });

  test("a track radio is radio too", () => {
    const startRadio = factoryFn("startRadio");
    expect(startRadio).toMatch(/radioActive: true/);
    expect(startRadio).toMatch(/radioSource: seed\.title/);
  });
});

describe("radio never reaches the end of the queue", () => {
  test("the last track of a radio queue seeds another mix", () => {
    // Without this the queue simply stops and the radio is just a playlist.
    expect(handleEnded).toMatch(
      /if \(\(s\.autoplay \|\| s\.radioActive\) && s\.current\) \{/,
    );
  });

  test("the queue is topped up even with autoplay switched off", () => {
    // Radio is explicitly "never stop", so it must not inherit the user's
    // autoplay preference either way.
    expect(maybeAutofillQueue).toMatch(
      /if \(\(!s\.autoplay && !s\.radioActive\) \|\| !s\.current\) return;/,
    );
  });
});

describe("radio seeds from the playlist, not from the last track played", () => {
  test("the dominant genre across the playlist wins", () => {
    // A single seed track is a weak signal: one ballad in a dance playlist
    // would pull the whole radio off-genre.
    expect(playlistMixContext).toMatch(/inferGenre\(t\)/);
    expect(playlistMixContext).toMatch(/tally\.get\(g\) \?\? 0\) \+ 1/);
    expect(playlistMixContext).toMatch(/if \(count > bestCount\)/);
    expect(playlistMixContext).toMatch(/return best;/);
  });

  test("the playlist's context is used for the priming fetch", () => {
    expect(startPlaylistRadio).toMatch(
      /activeMixContext = playlistMixContext\(list\);/,
    );
    expect(startPlaylistRadio).toMatch(
      /fetchRelatedMix\(first, list, 15, activeMixContext\)/,
    );
  });

  test("rows with nothing playable are dropped before starting", () => {
    expect(startPlaylistRadio).toMatch(
      /tracks\.map\(norm\)\.filter\(\(t\) => !!t\.youtubeId \|\| !!t\.audioUrl\)/,
    );
    expect(startPlaylistRadio).toMatch(
      /const first = list\[0\];\n\s*if \(!first\) return;/,
    );
  });

  test("the WHOLE playlist is queued, not just the first track", () => {
    // Queuing only the seed would skip the rest of the playlist entirely and
    // go straight to unrelated songs — that is a track radio wearing a
    // playlist's name.
    expect(startPlaylistRadio).toMatch(/\n      queue: list,/);
    expect(startPlaylistRadio).not.toMatch(/queue: \[first\],/);
  });

  test("the priming fill is deduped against the full playlist", () => {
    // Otherwise the radio can hand back a playlist track as a "related" song
    // and the listener hears it twice.
    expect(startPlaylistRadio).toMatch(
      /fetchRelatedMix\(first, list, 15, activeMixContext\)/,
    );
  });
});

describe("a late radio fill cannot hijack playback", () => {
  test("the priming fetch bails once the user has moved on", () => {
    // The mix takes seconds to arrive. By then the user may have played
    // something else, or stopped the radio, and appending to that queue would
    // be wrong.
    const bail = startPlaylistRadio.indexOf(
      "state.current?.id !== first.id || !state.radioActive",
    );
    const append = startPlaylistRadio.indexOf("st.queue.some(");
    expect(bail).toBeGreaterThan(-1);
    expect(append).toBeGreaterThan(bail);
  });

  test("a stale fill returns the state untouched", () => {
    expect(startPlaylistRadio).toMatch(/if \(fresh\.length === 0\) return st;/);
  });
});

describe("radio ends when the user explicitly picks something else", () => {
  test("starting a list leaves radio", () => {
    expect(playTrack).toMatch(
      /if \(get\(\)\.radioActive\) set\(\{ radioActive: false, radioSource: null \}\);/,
    );
  });

  test("every list entry point shares that body", () => {
    // playListOrdered exists so a page can play a list in a fixed order; if it
    // ever grew its own copy of the queue logic it would stop ending radio.
    expect(storeSource).toContain("playResolved(track, list, true)");
    expect(storeSource).toContain("playResolved(track, list, false)");
  });

  test("jumping within the queue does NOT leave radio", () => {
    // The queue panel navigates with playIndex; switching radio off because
    // the user clicked a row would make it impossible to control.
    expect(playIndex).not.toMatch(/radioActive/);
  });

  test("stopRadio clears both the flag and the mix context", () => {
    expect(stopRadio).toMatch(/if \(!get\(\)\.radioActive\) return;/);
    expect(stopRadio).toMatch(/activeMixContext = null;/);
    expect(stopRadio).toMatch(
      /set\(\{ radioActive: false, radioSource: null \}\);/,
    );
  });
});

describe("a long radio session still restores a sane queue", () => {
  test("the saved window follows the current track, not the head", () => {
    // Radio appends for as long as it runs, so the head of the queue is
    // routinely dozens of tracks stale. Persisting it restored a queue
    // pointing at an unrelated old song.
    expect(saveQueue).toMatch(
      /const start = Math\.max\(0, Math\.min\(queueIndex, queue\.length - 60\)\);/,
    );
    expect(saveQueue).toMatch(/queue\.slice\(start, start \+ 60\)/);
  });

  test("the persisted index is rebased onto that window", () => {
    // Saving the raw index would point past the end of the saved window.
    expect(saveQueue).toMatch(/queueIndex: queueIndex - start,/);
  });
});

describe("the playlist page offers radio", () => {
  test("a Radio button starts and stops the radio", () => {
    expect(pageSource).toMatch(/onClick=\{\(\) => \{/);
    expect(pageSource).toMatch(/if \(radioSource === playlist\.name\) \{/);
    expect(pageSource).toMatch(/stopRadio\(\);/);
    expect(pageSource).toMatch(/void startRadio\(\);/);
  });

  test("starting radio passes the playlist's own tracks and name", () => {
    expect(pageSource).toMatch(
      /startPlaylistRadio\(resolved, playlist\.name\);/,
    );
  });

  test("the button reflects the active state for assistive tech", () => {
    expect(pageSource).toMatch(
      /aria-pressed=\{radioSource === playlist\.name\}/,
    );
  });

  test("radio reuses the same resolution path as Play all", () => {
    // Duplicating the resolver would let the two buttons drift apart.
    expect(pageSource).toMatch(/const resolveAll = async \(\)/);
    expect(pageSource.match(/await resolveAll\(\)/g).length).toBe(2);
  });
});
