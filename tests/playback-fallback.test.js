import { describe, expect, test } from 'vitest';
import { giveUpNotice, matchScore } from "../src/lib/playbackFallback.ts";

/**
 * Playback honesty: what counts as "the same song", and what the listener is
 * told when nothing will play.
 *
 * The failure this started from: playback was completely dead with no
 * feedback. The rule that matters most here is the one about NOT playing the
 * wrong song — a substitution that quietly plays something else is worse than
 * silence, because the listener hears music and concludes the app works.
 *
 * The cross-provider half of this file is gone. Jamendo's streams were silent
 * too, so it is a discovery index now rather than a playback fallback; the
 * matching rule lives on, because resolving a discovery hit to a real YouTube
 * upload depends on it.
 */

describe("matching is lenient about the artist, strict about the song", () => {
  test("the same song scores highest", () => {
    expect(
      matchScore(
        { title: "Hyperballad", artist: "Björk" },
        { title: "Hyperballad", artist: "Björk" },
      ),
    ).toBe(1);
  });

  test("artist spelling differences do not disqualify a real match", () => {
    // An upload and a catalogue release spell the credit differently all the
    // time. Being strict here throws away the only playable option.
    const s = matchScore(
      { title: "Hyperballad", artist: "Björk" },
      { title: "Hyperballad", artist: "Bjork" },
    );
    expect(s).toBeGreaterThanOrEqual(0.5);
  });

  test("feat noise is stripped before comparing", () => {
    const s = matchScore(
      { title: "Army of Me", artist: "Björk" },
      { title: "Army of Me (feat. Someone)", artist: "Björk" },
    );
    expect(s).toBeGreaterThanOrEqual(0.5);
  });

  test("a different song scores zero and is never chosen", () => {
    expect(
      matchScore(
        { title: "Hyperballad", artist: "Björk" },
        { title: "All Is Full of Love", artist: "Björk" },
      ),
    ).toBe(0);
  });

  test("an empty title on either side never matches", () => {
    expect(
      matchScore({ title: "", artist: "Björk" }, { title: "", artist: "" }),
    ).toBe(0);
  });
});

describe("the listener is told what happened", () => {
  test("a blocked provider is named, because that is the only actionable thing", () => {
    const msg = giveUpNotice({ blockedProvider: "YouTube" });
    expect(msg).toContain("YouTube");
    expect(msg).toMatch(/block/i);
    expect(msg).toMatch(/allow/i);
  });

  test("a song nobody hosts is reported as simply unavailable", () => {
    expect(giveUpNotice({})).toMatch(/couldn/i);
  });

  test("alternatives change the message when nothing was blocked", () => {
    expect(giveUpNotice({ hasAlternatives: true })).toMatch(/every version/i);
  });

  test("the blocked message wins: it is the more useful one", () => {
    expect(
      giveUpNotice({ blockedProvider: "Jamendo", hasAlternatives: true }),
    ).toContain("Jamendo");
  });
});
