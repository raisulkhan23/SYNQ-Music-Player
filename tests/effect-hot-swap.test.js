import { describe, expect, test } from "bun:test";
import { readSource } from "./helpers/tailwind-css.js";

const storeSource = readSource("src/store/player.ts");

/** The body of a named function declared inside the store factory. */
function body(name) {
  const start = storeSource.indexOf(`  const ${name} = (`);
  if (start === -1) throw new Error(`missing ${name}`);
  const end = storeSource.indexOf("\n  const ", start + 10);
  return storeSource.slice(start, end === -1 ? undefined : end);
}

const swap = body("swapToFilteredStream");
const resolve = body("resolveAndPlayWithFilter");
const verify = body("verifyEffectIsLive");

describe("turning an effect on does not interrupt playback", () => {
  test("a hot swap is detected instead of always reloading", () => {
    // "The same song already playing through the other source" — the user
    // just switched an effect on. Nothing is wrong with the current playback.
    expect(resolve).toMatch(/const hotSwap =/);
    expect(resolve).toMatch(/prev\.current\?\.youtubeId === videoId/);
  });

  test("the outgoing source is not paused before the stream is resolved", () => {
    // Pausing first meant the listener sat in dead silence for the entire
    // network round-trip, every single time an effect was applied. This is the
    // "delay on effect-enabled tracks".
    const pauseIdx = swap.indexOf("ytEngine.pause()");
    const resolveIdx = swap.indexOf("void ytResolve(videoId)");
    expect(pauseIdx).toBeGreaterThan(-1);
    expect(resolveIdx).toBeGreaterThan(-1);
    // The pause must come after the resolve is *requested*, never before.
    expect(pauseIdx).toBeGreaterThan(resolveIdx);
  });

  test("a hot swap leaves the playhead and the buffering flag alone", () => {
    // Setting currentTime/isBuffering up front froze the scrubber at the
    // enable-time position for the whole resolve. Both the optimistic state
    // and the tear-down pauses now sit INSIDE the !hotSwap guard, so they
    // only happen for a real load.
    const guard = resolve.indexOf("if (!hotSwap) {");
    const guardEnd = resolve.indexOf("\n    }", guard);
    expect(guard).toBeGreaterThan(-1);
    expect(guardEnd).toBeGreaterThan(guard);
    const genuineLoad = resolve.slice(guard, guardEnd);
    expect(genuineLoad).toContain("isBuffering: true");
    expect(genuineLoad).toContain("ytEngine.pause()");
    expect(genuineLoad).toContain("getAudio().pause()");
    // Nothing before the guard may freeze the position or stop a source.
    expect(resolve.slice(0, guard)).not.toContain("isBuffering");
    expect(resolve.slice(0, guard)).not.toContain(".pause()");
  });

  test("a failed hot swap does not start a second source on top", () => {
    // The IFrame engine starting while the still-playing element is audible
    // plays the song twice at once.
    expect(resolve).toMatch(
      /if \(hotSwap\) \{[\s\S]*?set\(\{ isBuffering: false \}\);[\s\S]*?return;[\s\S]*?\}\s*const from = livePlaybackPosition/,
    );
  });
});

describe("a swapped track resumes from the live playhead, not a stale snapshot", () => {
  test("there is a live position reader that interrogates the real source", () => {
    // The store's currentTime is a polled snapshot; by the time a stream has
    // resolved it is already behind the audio that is actually sounding.
    expect(storeSource).toMatch(
      /const livePlaybackPosition = \(videoId\?: string\): number \| null/,
    );
    expect(storeSource).toMatch(/audioElementIsSource\(s\.current\)/);
    expect(storeSource).toMatch(/ytEngine\.getEngineTime\(\)/);
  });

  test("it returns null rather than inventing a position", () => {
    expect(storeSource).toMatch(
      /if \(!videoId \|\| s\.current\?\.youtubeId !== videoId\)\s*\n?\s*return null;/,
    );
  });

  test("the swap seeks to the live head, with the old one only as a fallback", () => {
    expect(swap).toMatch(
      /const from = livePlaybackPosition\(videoId\) \?\? at;/,
    );
    // The stale capture must not be what the element is seeked to.
    expect(swap).toMatch(/audio\.currentTime = from;/);
    expect(swap).not.toMatch(/audio\.currentTime = at;/);
  });

  test("the filtered load does the same", () => {
    expect(resolve).toMatch(
      /const from = hotSwap\s*\?\s*\(livePlaybackPosition\(videoId\) \?\? resumeAt\)\s*\n?\s*: resumeAt;/,
    );
    expect(resolve).toMatch(/audio\.currentTime = from;/);
  });

  test("the IFrame fallback engine also resumes from the live head", () => {
    expect(resolve).toMatch(
      /const from = livePlaybackPosition\(videoId\) \?\? resumeAt;\s*\n\s*getAudio\(\)\.pause\(\);/,
    );
  });

  test("switching an effect OFF does not rewind either", () => {
    // The element is stopped, so its clock has to be read before that.
    expect(storeSource).toMatch(
      /const resumeAt =\s*livePlaybackPosition\(\s*s\.current\.youtubeId,?\s*\)\s*\?\?\s*s\.currentTime;\s*\n\s*getAudio\(\)\.pause\(\);/,
    );
  });
});

describe("an effect-enabled track no longer reloads itself mid-song", () => {
  test("the liveness check never re-swaps the stream", () => {
    // This was the random jump: the analyser dips below its threshold on any
    // intro, fade or quiet passage, and the old response was a full
    // pause / re-resolve / reload / seek.
    expect(verify).not.toContain("swapToFilteredStream");
  });

  test("a suspended AudioContext is still recovered", () => {
    // Dropping the re-swap must not drop the real fix it was reaching for.
    expect(verify).toMatch(/void resumeGraph\(\)/);
  });

  test("the threshold is not so tight that ordinary quiet triggers a swap", () => {
    expect(verify).toMatch(/if \(level > 0\.004\) return;/);
  });
});
