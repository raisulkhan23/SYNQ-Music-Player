import { describe, expect, test } from 'vitest';
import { readSource } from "./helpers/tailwind-css.js";

const homeSource = readSource("src/pages/Home.tsx");
const searchSource = readSource("src/pages/Search.tsx");

/** Body of a `const name = ... => { ... };` inside the Home component. */
function homeFn(name) {
  const start = homeSource.indexOf(`  const ${name} = `);
  if (start === -1) throw new Error(`missing ${name}`);
  const end = homeSource.indexOf("\n  const ", start + 10);
  return homeSource.slice(start, end === -1 ? undefined : end);
}

const surpriseMe = homeFn("surpriseMe");
const feelingLucky = homeFn("feelingLucky");

describe("Play something random actually starts a queue of music", () => {
  test("the picked track is played from a queue, not on its own", () => {
    // This is the bug: `playTrack` was called with only the playable, which
    // builds a queue of exactly one entry. The search the button already paid
    // for was thrown away, so it played one song and then sat in silence
    // waiting on a background fetch to find the next one — the opposite of
    // what a "start music instantly" button should do.
    expect(surpriseMe).toMatch(/playTrack\(selected, queue\)/);
    expect(surpriseMe).not.toMatch(/playTrack\(\s*toPlayableYoutube\(/);
  });

  test("the queue is built from the results and capped", () => {
    // Whitespace-tolerant: prettier reflows the `.map` callback across lines.
    expect(surpriseMe.replace(/\s+/g, " ")).toMatch(
      /const queue = pool \.slice\(0, 15\) \.map\(\(item\) => toPlayableYoutube\(item, `https:\/\/youtu\.be\/\$\{item\.id\}`\)/,
    );
  });

  test("the track the user gets is the randomly picked one", () => {
    // The pick must be resolved against the queue that was actually queued,
    // not played as a separate object.
    expect(surpriseMe).toMatch(
      /const selected = queue\.find\(\(t\) => t\.id === pick\.id\) \?\? queue\[0\];/,
    );
  });

  test("an empty result is reported instead of throwing", () => {
    expect(surpriseMe).toMatch(/if \(!pick\) \{/);
    expect(surpriseMe).toMatch(/toast\.error\("No results — try again"\);/);
  });
});

describe("I'm feeling lucky builds the mix it promises", () => {
  test("the mix is shuffled as a list, not by latching global shuffle", () => {
    // This used to reach for the app's persisted shuffle preference, which
    // left shuffle switched on for the rest of the session. The queue is now
    // shuffled here and played in fixed order.
    const shuffleIdx = feelingLucky.indexOf("shuffleList(");
    const playIdx = feelingLucky.indexOf("playListOrdered(selected, queue)");
    expect(shuffleIdx).toBeGreaterThan(-1);
    expect(playIdx).toBeGreaterThan(shuffleIdx);
    expect(feelingLucky).not.toContain("startShuffle()");
  });

  test("it queues a mix rather than a single track", () => {
    expect(feelingLucky).toMatch(/playListOrdered\(selected, queue\)/);
    // The annotation is optional in the pattern: the source declares
    // `const queue: Playable[] = shuffleList(`, and pinning the un-annotated
    // form made a type annotation look like a missing shuffle.
    expect(feelingLucky).toMatch(/const queue(?:\s*:\s*Playable\[\])? = shuffleList\(/);
    expect(feelingLucky).not.toMatch(/playTrack\(toPlayableYoutube\(/);
  });
});

describe("the random buttons are reachable", () => {
  test("the buttons are not hidden behind the Continue-listening condition", () => {
    // Both buttons used to live inside a `continueTrack || likedLoaded`
    // guard meant only for the resume card, so a brand-new account with an
    // empty history and no liked songs saw neither button at all.
    //
    // They now live in the quick-access grid, below the hero. What matters is
    // that they are not inside the conditional resume-card block.
    const resumeStart = homeSource.indexOf("{continueTrack ? (");
    const quickAccess = homeSource.indexOf('aria-label="Quick access"');
    expect(resumeStart).toBeGreaterThan(-1);
    expect(quickAccess).toBeGreaterThan(resumeStart);

    const resumeBlock = homeSource.slice(resumeStart, quickAccess);
    expect(resumeBlock).not.toMatch(/surpriseMe/);
    expect(resumeBlock).not.toMatch(/feelingLucky/);
    // …and they ARE in the quick-access grid, not merely present somewhere.
    const grid = homeSource.slice(quickAccess);
    expect(grid).toMatch(/onClick=\{surpriseMe\}/);
    expect(grid).toMatch(/onClick=\{feelingLucky\}/);
  });

  test("the resume card itself is still conditional", () => {
    // Dropping the guard must not start rendering a card with no track in it.
    expect(homeSource).toMatch(/\{continueTrack \? \(/);
  });

  test("both buttons are wired to their handlers", () => {
    expect(homeSource).toMatch(/onClick=\{surpriseMe\}/);
    expect(homeSource).toMatch(/onClick=\{feelingLucky\}/);
  });
});

describe("the search page's surprise matches the corrected behaviour", () => {
  test("it already plays from a queue, so the two agree", () => {
    // Guards against the Home fix drifting away from the proven pattern.
    expect(searchSource).toMatch(/playTrack\(selected, queue\)/);
  });
});
