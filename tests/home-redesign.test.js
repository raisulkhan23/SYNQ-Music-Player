import { describe, expect, test } from "bun:test";
import { readSource } from "./helpers/tailwind-css.js";

const home = readSource("src/pages/Home.tsx");
const shelf = readSource("src/components/core/shelf.tsx");
const card = readSource("src/components/tracks/MediaCard.tsx");
const actions = readSource("src/components/tracks/useTrackActions.tsx");
const row = readSource("src/components/tracks/RemoteTrackRow.tsx");

describe("recommendations are no longer presented as a ranked list", () => {
  test("Home renders no numbered recommendation rows", () => {
    // The old page built every shelf from RemoteTrackRow, whose first column
    // is a rank number. That made Home read like a scoring report.
    expect(home).not.toContain("<RemoteTrackRow");
    expect(home).not.toContain("<RemoteRows");
    expect(home).not.toContain("<RemoteSection");
  });

  test("the numbered row component is untouched for lists that need one", () => {
    // Removing rankings from Home must not silently break the one place a
    // rank is meaningful.
    expect(row).toContain("text-sm tabular-nums");
  });

  test("no section carries a paragraph of explanation", () => {
    // Explanations were the loudest thing on the page and said very little.
    const subtitles = [...home.matchAll(/subtitle=\{?"([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(subtitles.length).toBeGreaterThan(0);
    for (const subtitle of subtitles) {
      expect(subtitle.length).toBeLessThanOrEqual(60);
    }
  });
});

describe("artwork leads, everything else follows", () => {
  test("the card renders artwork, then title, then artist", () => {
    const img = card.indexOf("<img");
    const title = card.indexOf("{title}");
    const artist = card.indexOf("{subtitle}");
    expect(img).toBeGreaterThan(-1);
    expect(title).toBeGreaterThan(img);
    expect(artist).toBeGreaterThan(title);
  });

  test("the card is square artwork, not a list row", () => {
    expect(card).toContain("aspect-square");
    expect(card).not.toContain("h-12 animate-pulse");
  });

  test("artist cards are round, song cards are not", () => {
    expect(card).toContain('round ? "rounded-full" : "rounded-lg"');
  });

  test("artwork is lazy and decoded off the main thread", () => {
    expect(card).toContain('loading="lazy"');
    expect(card).toContain('decoding="async"');
  });
});

describe("cards stay clean until they are wanted", () => {
  test("the play button is revealed on hover, not always visible", () => {
    expect(card).toMatch(/group-hover:opacity-100/);
    // …and stays reachable on touch, where there is no hover at all.
    expect(card).toMatch(/max-sm:opacity-100/);
  });

  test("the overflow menu is revealed the same way", () => {
    expect(card).toMatch(/opacity-0 group-hover:opacity-100/);
  });

  test("the menu cannot push the shelf out of alignment", () => {
    // The menu is absolutely positioned on purpose: a card that grew on hover
    // would make every row breathe as the pointer moved across it.
    expect(card).toMatch(/absolute top-1 right-1/);
  });
});

describe("the card and the row cannot drift apart", () => {
  test("both reach the same action menu", () => {
    expect(card).toContain("<TrackActionsMenu");
    expect(row).toContain("<TrackActionsMenu");
  });

  test("the menu is defined exactly once", () => {
    const definitions =
      actions.match(/export function TrackActionsMenu\(/g) ?? [];
    expect(definitions).toHaveLength(1);
    expect(actions).toContain("export function useTrackActions");
  });

  test("the card offers the full set of actions", () => {
    for (const affordance of [
      "Play next",
      "Add to queue",
      "Copy song link",
      "liked songs",
    ]) {
      expect(actions).toContain(affordance);
    }
  });

  test("the card never starts playback as a side effect of another action", () => {
    // The play button lives inside the clickable card, so its own click has to
    // stop there or every tap plays twice.
    expect(card).toMatch(/event\.stopPropagation\(\);\s*\n\s*onPlay\(\);/);
  });
});

describe("the page is built from horizontal shelves", () => {
  test("Home uses one shelf primitive, not hand-rolled scrollers", () => {
    expect(home).toContain("<Shelf");
    expect(home).not.toContain("overflow-x-auto");
  });

  test("the rail scrolls natively, so a swipe never re-renders the page", () => {
    expect(shelf).toContain("overflow-x-auto");
    expect(shelf).toMatch(
      /addEventListener\("scroll", onScroll, \{ passive: true \}\)/,
    );
    expect(shelf).toContain("passive: true");
  });

  test("arrows exist on desktop and are hidden on touch", () => {
    // A phone already swipes; two 32px buttons would eat the artwork's width.
    expect(shelf).toMatch(/hidden items-center gap-1 md:flex/);
    expect(shelf).toContain("aria-label={label}");
  });

  test("arrows are disabled at each end rather than looping", () => {
    expect(shelf).toMatch(/disabled=\{!edges\.start\}/);
    expect(shelf).toMatch(/disabled=\{!edges\.end\}/);
    expect(shelf).toContain("disabled:pointer-events-none");
  });

  test("the shelf measures real overflow, with a fractional-width tolerance", () => {
    expect(shelf).toContain("rail.scrollWidth - rail.clientWidth");
    // Without the tolerance an exactly-at-the-end rail leaves a live arrow
    // that scrolls nowhere.
    expect(shelf).toContain("rail.scrollLeft < maxScroll - 1");
  });

  test("cards are full-bleed on mobile so the first and last stay reachable", () => {
    expect(shelf).toContain("-mx-4");
    expect(shelf).toMatch(/px-4[\s\S]*sm:px-0/);
  });

  test("the header is a heading, not a decorative banner", () => {
    expect(shelf).toContain("<h2");
    expect(shelf).toContain("aria-labelledby={id}");
  });

  test("see-all links are real links to a real route", () => {
    expect(shelf).toContain("action.to");
    expect(home).toMatch(
      /action=\{\{ to: "\/(recent|playlists)", label: "See all" \}\}/,
    );
  });
});

describe("the page has a deliberate rhythm, most useful first", () => {
  const order = [
    'aria-label="Quick access"',
    'id="shelf-recent"',
    'id="shelf-continue"',
    'id="shelf-for-you"',
    'id="shelf-playlists"',
    'id="shelf-artists"',
    'id="shelf-chart"',
    'id="shelf-discover"',
    'id="shelf-moods"',
    "listening-pulse-title",
  ];

  test("sections appear in the intended order", () => {
    let cursor = -1;
    for (const marker of order) {
      const at = home.indexOf(marker);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  test("the reading pulse is last: it is a readout, not a way in", () => {
    expect(home.indexOf('id="shelf-moods"')).toBeLessThan(
      home.indexOf("listening-pulse-title"),
    );
  });

  test("the hero is a greeting plus one actionable surface, not a banner", () => {
    expect(home).toContain("{greeting()}");
    // Exactly one hero-level block, and it is the resume card.
    expect(home.match(/<header/g)).toHaveLength(1);
  });
});

describe("sections only appear when they can be honest", () => {
  test("a shelf with nothing to show renders nothing", () => {
    expect(shelf).toMatch(/if \(hidden\) return null;/);
    expect(home).toMatch(
      /hidden=\{\s*remote\.discover !== undefined &&\s*usable\(remote\.discover\)\.length === 0\s*\}/,
    );
  });

  test("the engine still decides which rows exist", () => {
    // The redesign must not start rendering rows the engine refused to build.
    expect(convexHome()).toContain("if (ranked.length === 0) continue;");
  });

  test("recently played needs real history before it claims to have any", () => {
    expect(home).toMatch(/\{recentItems\.length > 0 \? \(/);
  });

  test("continue listening only shows tracks with a saved position", () => {
    // Nothing is invented: a track with no resume entry is not "unfinished".
    expect(home).toMatch(/peekResumePosition\(item\.id, item\.duration\)/);
    expect(home).toMatch(
      /\.filter\(\(\{ item, at \}\) => at > 0 && item\.duration > 0\)/,
    );
  });

  test("a cold listener is not shown an empty personalised shelf", () => {
    // The engine omits ineligible rows; Home renders exactly what arrives and
    // has no branch that invents a row the engine refused to build.
    expect(home).toMatch(/recoSections === null \?/);
    expect(home).toMatch(/\)\s*:\s*\(?\s*recoSections\.map\(/);
  });
});

describe("no duplicate content across shelves", () => {
  test("the track already in the hero is not repeated at the top", () => {
    expect(home).toContain("seenAtTop");
    expect(home).toMatch(
      /recentItems = useMemo\([\s\S]{0,200}!seenAtTop\.has\(item\.id\)/,
    );
  });

  test("the old Jump-back-in grid is gone", () => {
    // It showed the same history items the Recently played shelf now owns.
    expect(home).not.toContain("jumpBackItems");
    expect(home).not.toContain("Jump back in");
  });

  test("the removed shelves are no longer fetched", () => {
    // topTracks, because and artists were queried on every Home visit and then
    // either never rendered or duplicated a recommendation shelf.
    // Compare against code only: prose about the removal still mentions them.
    const code = home.replace(/\/\/[^\n]*/g, "");
    expect(code).not.toContain('key: "topTracks"');
    expect(code).not.toContain('key: "artists"');
    expect(code).not.toContain('key: "because"');
  });
});

describe("loading and failure never block the page", () => {
  test("shelves skeleton independently", () => {
    expect(shelf).toContain("export function ShelfSkeleton");
    expect(shelf).toMatch(/skeleton \? \(\s*<ShelfSkeleton \/>/);
  });

  test("a skeleton matches the real card footprint", () => {
    expect(shelf).toContain("aspect-square w-full animate-pulse");
    expect(shelf).toContain("sm:w-40");
  });

  test("a failed recommendation leaves the rest of Home working", () => {
    expect(home).toMatch(
      /\.catch\(\(\) => \{[\s\S]{0,120}setRecoSections\(\[\]\)/,
    );
    // No technical error is surfaced to the listener.
    expect(home).not.toMatch(/recommendation[s]? (failed|errored)/i);
  });
});

describe("mobile is designed, not shrunk", () => {
  test("cards are sized for a thumb and grow with the viewport", () => {
    expect(card).toMatch(
      /"group relative w-32 shrink-0 snap-start sm:w-36 lg:w-40"/,
    );
  });

  test("touch targets on the card are full-size, not hairline", () => {
    expect(card).toContain("size-10");
    expect(card).toMatch(/focus-visible:opacity-100/);
  });

  test("quick access reflows rather than scrolling sideways", () => {
    expect(home).toMatch(
      /grid grid-cols-2 gap-2\.5 sm:grid-cols-3 lg:grid-cols-6/,
    );
  });

  test("long shelves never push the page itself sideways", () => {
    // The rail owns its overflow; the page column must stay fixed width.
    expect(shelf).toContain("overflow-x-auto");
    expect(home).not.toMatch(/className="[^"]*overflow-x-auto[^"]*"/);
  });
});

describe("the existing design system is reused, not replaced", () => {
  test("the playlist shelf uses the card the Playlists page already renders", () => {
    expect(home).toContain("<PlaylistCard");
  });

  test("tokens, radius and type come from the app, not new values", () => {
    expect(card).toContain("rgb(var(--tint))");
    expect(card).toContain("font-display");
    expect(card).toContain("text-muted-foreground");
  });

  test("the existing scrollbar treatment is reused", () => {
    expect(shelf).toContain("slider-rail");
  });

  test("no third-party branding leaked into the new UI", () => {
    // The app already has its own `api.spotify.spotifyChart` module for reading
    // public chart data; that is an internal dependency, not branding. What must
    // not appear is another service's identity.
    for (const banned of ["spotify.com", "1db954", "Spotify"]) {
      expect(shelf).not.toContain(banned);
      expect(card).not.toContain(banned);
    }
  });

  test("the engine is untouched by the presentation change", () => {
    const engine = readSource("src/lib/recommend.ts");
    for (const stage of [
      "buildSignals",
      "buildSeeds",
      "scoreCandidate",
      "shouldFilter",
      "applyDiversity",
      "rankCandidates",
    ]) {
      expect(engine).toContain(stage);
    }
  });

  test("autoplay still calls the same action Home's rows come from", () => {
    const store = readSource("src/store/player.ts");
    expect(store).toContain("api.recommend.nextTrack");
    expect(home).toContain("api.recommend.forYou");
  });
});

describe("playback from a card behaves like every other play in the app", () => {
  test("a card plays through the shared player path, not a new one", () => {
    expect(home).toContain("playRemoteItem(toYtItem(item)");
    expect(home).toContain("playTrack(");
  });

  test("the resolve step shows a spinner on the card that triggered it", () => {
    expect(home).toContain("resolving={resolvingId === item.id}");
    expect(card).toContain("resolving");
  });

  test("the whole shelf becomes the queue, like every other shelf", () => {
    // The old "lucky mix" bug: a single track passed as the queue, so the
    // button played one song and then sat silent.
    expect(home).toMatch(/const queue = \[match, \.\.\.found/);
  });

  test("no page flicks the global shuffle switch", () => {
    expect(home).not.toContain("startShuffle");
  });
});

function convexHome() {
  return readSource("src/convex/recommend.ts");
}
