import { describe, expect, test } from "bun:test";
import { readSource } from "./helpers/tailwind-css.js";

const storeSource = readSource("src/store/player.ts");
const transitionSource = readSource("src/lib/transition.ts");

/**
 * WHY A DECK SWAP MUST RESYNC THE STORE — the bug these tests pin.
 *
 * A crossfade commit and a gapless hand-off both promote the spare deck while
 * the store's element listeners are still attached to the OUTGOING deck. The
 * incoming deck's "play"/"playing" events therefore fire where nobody was
 * listening, and after the rebind no new event ever fires (the element is
 * already playing). Every store field that only events maintain stayed
 * frozen:
 *
 *  - `isPlaying: false` while music audibly plays. `armTransition` reads it
 *    as `paused: true`, `planTransition` answers "cut" for a paused player,
 *    and so the track AFTER the first successful crossfade never blended
 *    again. One blend, then hard cuts forever — reported as "crossfade
 *    doesn't work".
 *
 * The fix reads the promoted element's real state exactly once, at rebind.
 * These tests pin that the rebind performs the read BEFORE any handler can
 * run, and that the transition planner consumes a resynced `isPlaying`.
 */

/** The body of bindAudioDeck, the one place element listeners are attached. */
function bindBody() {
  const start = storeSource.indexOf("function bindAudioDeck(");
  const end = storeSource.indexOf("\n}\n", start);
  return storeSource.slice(start, end);
}

describe("the store resyncs when the listeners follow a deck swap", () => {
  test("bindAudioDeck reads the promoted element's live state", () => {
    const body = bindBody();
    // The resync must be a setState reading the ELEMENT, not constants.
    expect(body).toMatch(/usePlayerStore\.setState\(\{/);
    expect(body).toMatch(/currentTime: audio\.currentTime/);
    expect(body).toMatch(/isPlaying: currentlySounding/);
    // "Currently sounding" is derived from the element, not from the store.
    expect(body).toMatch(/!audio\.paused && !audio\.ended/);
  });

  test("the resync happens on every rebind, not only the first", () => {
    const body = bindBody();
    // The sync sits in the function BODY, after the rebind teardown and
    // before the handler definitions — so every call re-syncs.
    const rebind = body.indexOf("boundAudio = audio;");
    const sync = body.indexOf("usePlayerStore.setState");
    const handlers = body.indexOf('on("timeupdate"');
    expect(rebind).toBeGreaterThan(-1);
    expect(sync).toBeGreaterThan(rebind);
    expect(handlers).toBeGreaterThan(sync);
  });

  test("buffering is only claimed by a deck that should be making sound", () => {
    // A paused spare deck is not "buffering"; without this guard every
    // rebind of an idle spare deck would flash the spinner.
    const body = bindBody();
    expect(body).toMatch(
      /isBuffering:\s*\n?\s*currentlySounding && audio\.readyState < HTMLMediaElement\.HAVE_FUTURE_DATA/,
    );
  });

  test("the transition planner still treats a genuinely paused player as paused", () => {
    // The resync must not silence the real pause guard: paused players cut.
    // `paused: !s.isPlaying` is what the planner consumes, and after the
    // rebind-sync `s.isPlaying` is the promoted element's truth.
    expect(storeSource).toMatch(/paused: !s\.isPlaying/);
  });
});

describe("the graph exists before a direct-URL track can be asked to blend", () => {
  /** The element branch of loadTrack: from `ytEngine.pause();` after the
   *  YouTube branch to the shared `syncMediaSession(track, true);` tail. */
  function elementPath() {
    const anchor = "      ytEngine.pause();\n      const audio = getAudio();";
    const start = storeSource.indexOf(anchor);
    if (start === -1) return "";
    const end = storeSource.indexOf("syncMediaSession(track, true);", start);
    return storeSource.slice(start, end);
  }

  test("the element path builds the graph for deck-owned non-YouTube tracks", () => {
    // SoundCloud, downloaded copies and direct catalog URLs all land here.
    // This path never built the audio graph, so the FIRST crossfade on any
    // of them was refused with "no-graph" — a hard cut with a toast.
    const path = elementPath();
    expect(path).toMatch(/ensureGraph\(\);/);
    // The build must happen BEFORE the source is assigned, so the context is
    // created inside the same user gesture that started playback.
    const build = path.indexOf("ensureGraph()");
    const assign = path.indexOf("audio.src = track.audioUrl");
    expect(build).toBeGreaterThan(-1);
    expect(assign).toBeGreaterThan(build);
  });

  test("the build respects the same conditions as the YouTube deck path", () => {
    // Crossfade on, gapless on, an effect preset, or any non-flat audio
    // setting — any of these means the graph is doing work and must exist.
    const path = elementPath();
    expect(path).toMatch(/get\(\)\.crossfade > 0/);
    expect(path).toMatch(/get\(\)\.gapless/);
    expect(path).toMatch(/hasAudioProcessing\(\)/);
  });
});

describe("arming asks the graph first, so a refused blend cannot loop", () => {
  test("armTransition consults crossfadeReadiness before planning", () => {
    // The old order armed a crossfade the context could not run, refused it,
    // cancelled, and re-armed on the next timeupdate with a shorter fade —
    // for the rest of the track. Planning with readiness makes the graph
    // failure a PLAN decision (gapless fallback) instead of a runtime loop.
    const arm = storeSource.slice(
      storeSource.indexOf("function armTransition("),
      storeSource.indexOf("  // Start buffering the incoming track now"),
    );
    expect(arm).toMatch(/crossfadeReadiness\(\)/);
    const readiness = arm.indexOf("crossfadeReadiness()");
    const plan = arm.indexOf("const plan = planTransition(");
    expect(readiness).toBeGreaterThan(-1);
    expect(plan).toBeGreaterThan(readiness);
    // The readiness verdict feeds the planner's capability flag.
    expect(arm).toMatch(/crossfadePossible\(s\.current, next\.track\) && readiness\.ok/);
  });

  test("gapless readiness accepts a downloaded copy's blob: src", () => {
    // A downloaded track's element src is a `blob:` object URL — the ONLY
    // form it takes. Refusing it made the offline library gapless-proof.
    expect(transitionSource).toMatch(/startsWith\("blob:"\)/);
  });
});
