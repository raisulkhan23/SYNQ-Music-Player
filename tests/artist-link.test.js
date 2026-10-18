import { describe, expect, test } from "bun:test";
import { readSource } from "./helpers/tailwind-css.js";
// youtube.ts is dependency-free, so the helper is tested for real.
import { artistSearchQuery } from "../src/lib/youtube.ts";

/**
 * Tapping the artist in the player bar.
 *
 * The button was wired correctly and still did nothing, because the search
 * page only ever read `?q=` inside a useState initialiser — which runs on
 * mount and never again — and then wiped the parameter from the URL in an
 * effect. So the artist link worked the first time and silently did nothing
 * from then on. These tests pin the query handling that made it work, plus
 * the guard that stops a track with no artist linking to an empty search.
 */

const search = readSource("src/pages/Search.tsx");
const playerBar = readSource("src/components/player/PlayerBar.tsx");
const fullscreen = readSource("src/components/player/FullscreenPlayer.tsx");

const flat = (s) => s.replace(/\s+/g, " ");
const tight = (s) => s.replace(/\s+/g, "");

describe("artistSearchQuery", () => {
  test("returns the artist name for a normal track", () => {
    expect(artistSearchQuery("Radiohead", "Creep")).toBe("Radiohead");
  });

  test("strips upload metadata from a dirty artist field", () => {
    expect(artistSearchQuery("Daft Punk - Topic", "Song")).toBe("Daft Punk");
    expect(artistSearchQuery("Daft Punk • Topic", "Song")).toBe("Daft Punk");
  });

  test("keeps the stored name when the cleaner rejects it as a placeholder", () => {
    // "Artist" is on the placeholder blacklist, so cleaning it yields
    // "Unknown artist" — but the stored value is still a real, searchable
    // name, and the fallback must not throw it away.
    expect(artistSearchQuery("Artist - Topic", "Song")).toBe("Artist - Topic");
  });

  test("returns null rather than linking to an empty search", () => {
    // Previously this produced /search?q=Unknown+artist — a dead end that
    // looked like a broken button.
    expect(artistSearchQuery("Unknown artist", "Song")).toBeNull();
    expect(artistSearchQuery("", "Song")).toBeNull();
    expect(artistSearchQuery(undefined, "Song")).toBeNull();
  });

  test("falls back to the stored name when cleaning it fails", () => {
    // Some tracks keep a name the cleaner rejects but that is still searchable.
    expect(artistSearchQuery("Official Artist Name", "Song")).toBe(
      "Official Artist Name",
    );
  });
});

describe("search page query handling", () => {
  test("the query is derived from the URL on every render, not seeded once", () => {
    // A useState initialiser runs on mount only. That is the whole bug: a
    // ?q= arriving while the page was already open was thrown away.
    expect(search).not.toContain('useState(() => sharedQuery ?? "")');
    expect(flat(search)).toContain("const query = sharedQuery ?? typedQuery;");
  });

  test("the ?q= is not wiped before it has been read", () => {
    const bad = search.indexOf(
      "if (sharedQuery) setSearchParams({}, { replace: true })",
    );
    expect(bad).toBe(-1);
  });

  test("every way of changing the query goes through the one helper", () => {
    expect(search).toContain("const applyQuery = useCallback(");
    expect(search).toContain("applyQuery(e.target.value)");
    expect(search).toContain('applyQuery("")');
    expect(search).toContain("applyQuery(surpriseQuery)");
    expect(search).toContain("applyQuery(h)");
    expect(search).toContain("<BrowseView onPick={applyQuery} />");
    expect(search).not.toContain("setQuery(");
  });

  test("the helper clears the param so typing is not shadowed by a stale link", () => {
    const fn = search.slice(search.indexOf("const applyQuery = useCallback("));
    expect(tight(fn)).toContain(
      'if(searchParams.has("q"))setSearchParams({},{replace:true});',
    );
  });
});

describe("player artist links", () => {
  test("the bar links the artist to a search", () => {
    expect(playerBar).toContain(
      "artistSearchQuery(current?.artistName, current?.title)",
    );
    expect(tight(playerBar)).toContain(
      "voidnavigate(`/search?q=${encodeURIComponent(artistQuery",
    );
  });

  test("the bar renders plain text when there is no usable artist", () => {
    // A link that always dead-ends is worse than no link.
    expect(playerBar).toContain("{artistQuery ? (");
    expect(tight(playerBar)).toContain("{current.artistName}</span>");
  });

  test("the fullscreen player agrees with the bar", () => {
    expect(fullscreen).toContain(
      "artistSearchQuery(current?.artistName, current?.title)",
    );
    expect(tight(fullscreen)).toContain(
      "voidnavigate(`/search?q=${encodeURIComponent(artistQuery",
    );
  });
});
