import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Playback must survive a TOTAL stream-resolver outage.
 *
 * This is the failure the whole "keeps buffering" thread actually was. Measured
 * live against the deployed backend while the bug was open:
 *
 *   - Convex `youtube:resolveStream` returned
 *     `{"reason": "Sign in to confirm you're not a bot", "url": null}` for 8
 *     videos out of 8, identically across retries. YouTube has escalated
 *     against the deployment's datacenter IP.
 *   - Both hardcoded Piped fallbacks answered HTTP 500 with
 *     `SignInConfirmNotBotException`.
 *   - Every other public Piped instance was dead, shut down, or 403/526.
 *
 * So NO direct stream could be resolved for essentially any track. Because
 * `wantDeckEngine` includes `gapless`, which ships ON by default, SYNQ
 * therefore always took the deck path, always ended up with a deck holding no
 * source, and only fell back to the YouTube player — on a path with NO load
 * watchdog at all. The reported state was exact and final:
 *
 *   buffering=true  playing=false  position=0.0/265.0s
 *   LIVE deck a: src (no source) · spare deck b: src (no source)
 *
 * A spinner that never resolves, with no sound and no message.
 *
 * Two properties make that survivable, and both are pinned here:
 *
 *   1. the YouTube player is never gated behind the resolver, and
 *   2. if it does not start either, that becomes a visible error in seconds
 *      rather than an indefinite buffer.
 */

const player = readFileSync("src/store/player.ts", "utf8");

function sliceBetween(code, from, to) {
  const a = code.indexOf(from);
  if (a === -1) throw new Error(`missing: ${from}`);
  const b = code.indexOf(to, a);
  if (b === -1) throw new Error(`missing: ${to}`);
  return code.slice(a, b);
}

describe("a total resolver outage must not stop playback", () => {
  test("the deck path races the resolver instead of waiting on it", () => {
    const branch = sliceBetween(
      player,
      "const wantDeckEngine = wantFilter",
      "getAudio().pause();",
    );
    // A raw `await ytResolve` here means a hung resolver keeps the track
    // silent at position 0 indefinitely, so it must race a timer.
    expect(branch).toMatch(/Promise\.race\(\[\s*ytResolve\(videoId\)/);
    expect(branch).toMatch(/15_000/);
    expect(branch).not.toMatch(/void ytResolve\(videoId\)\.then/);
    // And it must NOT go back to the old 1.2s `resolveWithDeadline` race:
    // resolution normally takes longer than that, so the deadline expired
    // first, the deck was abandoned, and playback fell through to the IFrame —
    // the path that hangs forever when YouTube refuses to play. The cap here
    // is a guard against a hung fetch, not a bet that the IFrame will win.
    expect(branch).not.toContain("resolveWithDeadline(videoId)");
  });

  test("the deadline is short enough to actually save the track", () => {
    // Long enough to catch a warm resolver, short enough that the listener is
    // not staring at a spinner. 1.2s.
    expect(player).toMatch(/const RESOLVE_RACE_MS = 1_200;/);
    expect(player).toMatch(
      /function resolveWithDeadline[\s\S]{0,600}?setTimeout\(\(\) => r\(null\), RESOLVE_RACE_MS\)/,
    );
  });

  test("the IFrame fallback is armed with a watchdog", () => {
    const branch = sliceBetween(
      player,
      "const wantDeckEngine = wantFilter",
      "getAudio().pause();",
    );
    // The defect in one line: this path had no timeout, so a refused stream
    // plus a stuck player meant `buffering` forever.
    expect(branch).toMatch(
      /if \(!url\) \{[\s\S]{0,1200}?ytLoadWatchdog = setTimeout\(/,
    );
    expect(branch).toMatch(/clearYtLoadWatchdog\(\)/);
  });

  test("the watchdog ends in a visible error, not another silent stall", () => {
    const branch = sliceBetween(
      player,
      "const wantDeckEngine = wantFilter",
      "getAudio().pause();",
    );
    // `isBuffering: false` plus a bumped errorNonce is what raises the real
    // failure UI. Without both it just spins again.
    expect(branch).toMatch(
      /ytLoadWatchdog = setTimeout\([\s\S]{0,900}?isBuffering: false[\s\S]{0,300}?errorNonce:/,
    );
  });

  test("a watchdog is armed on BOTH engine paths", () => {
    // The plain IFrame path always had one; the fallback path now does too.
    const armed = player.match(/ytLoadWatchdog = setTimeout\(/g) ?? [];
    expect(armed.length).toBeGreaterThanOrEqual(2);
  });
});
