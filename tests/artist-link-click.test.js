import { describe, expect, test } from "bun:test";
import { readSource } from "./helpers/tailwind-css.js";
import { artistPath, albumPath } from "../src/lib/artistLinks.ts";

const card = readSource("src/components/tracks/MediaCard.tsx");

// Isolate the ArtistLink helper so the assertions describe the link and not
// the whole card component.
const linkBlock = card.slice(
  card.indexOf("function ArtistLink("),
  card.indexOf('/** Inline "loading this card" affordance'),
);

describe("artist and album links navigate instead of hijacking the click", () => {
  test("the link no longer fires the card's own action on a timer", () => {
    // THE bug. `ArtistLink` ran `setTimeout(onNavigate, 0)` after every press,
    // and `onNavigate` was `() => onOpen()` — the card's PLAY action. So every
    // artist click started a track search that raced the router. When the
    // search won it played the song instead of opening the page, and the
    // click looked like it had done nothing; when it changed the route it
    // stranded the listener where they started, which is exactly why the page
    // only appeared after a hard reload remounted the tree.
    expect(linkBlock).not.toContain("setTimeout");
    expect(linkBlock).not.toContain("onNavigate");
  });

  test("the link never invokes the card's own action", () => {
    // THE actual bug. `ArtistLink` took a `stop` prop wired to the card's
    // `onOpen` — the PLAY action — and called it on every press. Clicking an
    // artist name therefore started playing the track instead of navigating,
    // which is why the page only ever appeared after a full reload discarded
    // the race. `stopPropagation()` alone is what keeps the click off the
    // card; nothing may call into it.
    expect(linkBlock).not.toContain("stop()");
    expect(linkBlock).not.toContain("stop,");
    expect(card).not.toContain("stop={onOpen}");
  });

  test("the link still keeps the click off the card", () => {
    // The card's handler is on an ancestor, so stopping propagation is what
    // prevents playback from starting alongside the navigation.
    expect(linkBlock).toContain("event.stopPropagation()");
  });

  test("the link is a real router link to the artist route", () => {
    expect(linkBlock).toContain("<Link");
    expect(linkBlock).toContain("to={href}");
  });

  test("both call sites stopped passing a play fallback", () => {
    // If either call site still passed `onNavigate`, the prop would be dead
    // weight and the intent unclear.
    expect(card).not.toContain("onNavigate");
    const uses = (card.match(/<ArtistLink/g) ?? []).length;
    expect(uses).toBe(2);
  });

  test("the artist shelf card is not given a nested link", () => {
    // `variant="artist"` is the page-level card that navigates on click, so
    // it must never render an inner link to the same place.
    expect(card).toContain(
      'const artistHref = variant === "artist" ? null : artistPath(item.artist)',
    );
  });

  test("the card is a div[role=button], so the inner link is not nested", () => {
    // A real <button> inside a <button> is invalid and browsers resolve the
    // click in ways that break navigation entirely.
    expect(card).toContain('role="button"');
    expect(card).not.toMatch(/<button[^>]*>\s*\{?\s*<ArtistLink/);
  });

  test("the hrefs it renders are real artist and album routes", () => {
    expect(artistPath("Katy Perry")).toBe("/artist/Katy%20Perry");
    expect(albumPath("Katy Perry", "Teenage Dream")).toBe(
      "/album/Katy%20Perry/Teenage%20Dream",
    );
  });
});
