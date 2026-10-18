import { describe, expect, test } from "bun:test";
import {
  buildTrackShareUrl,
  isTrackId,
  shareableId,
  trackMetaToPlayable,
  TRACK_PATH,
} from "../src/lib/shareLink";
import { readSource } from "./helpers/tailwind-css.js";

const mainSource = readSource("src/main.tsx");
const fullscreenSource = readSource(
  "src/components/player/FullscreenPlayer.tsx",
);
const trackLinkSource = readSource("src/pages/TrackLink.tsx");
const youtubeSource = readSource("src/convex/youtube.ts");

const track = {
  id: "row-id-42",
  title: "Weightless",
  artistName: "Marconi Union, Someone Else",
  albumName: "Ambient Transmissions",
  coverUrl: "https://img.example/cover.jpg",
  duration: 481,
  source: "youtube",
  youtubeId: "videoid1234",
  audioUrl: "https://youtu.be/videoid1234",
};

const meta = {
  id: "videoid1234",
  title: "Weightless",
  artist: "Marconi Union, Someone Else",
  coverUrl: "https://img.example/cover.jpg",
  duration: 481,
};

describe("a shared track link is just the track id", () => {
  test("the id alone is the whole URL", () => {
    // The old link was `/search?q=<title> <artist>`: the recipient landed on a
    // search box with the query pre-filled and still had to run the search and
    // pick the right row. The next version fixed that but packed
    // `?n=&a=&c=&d=` into every link — long enough for chat apps to truncate,
    // and editable into a link that plays a different song.
    const url = buildTrackShareUrl("https://site.example", track);
    expect(url).toBe(`https://site.example${TRACK_PATH}/videoid1234`);
    expect(url).not.toContain("?");
    expect(url).not.toContain("/search");
  });

  test("no title, artist, cover or duration is smuggled into the link", () => {
    const url = new URL(buildTrackShareUrl("https://site.example", track));
    expect([...url.searchParams.keys()]).toEqual([]);
    // The id has to be the only thing present, so nothing about the song is
    // duplicated into someone's clipboard.
    expect(url.pathname.split("/").filter(Boolean)).toEqual([
      "t",
      "videoid1234",
    ]);
  });

  test("playback uses the youtube id, not the row id", () => {
    // A liked remote track's own `id` can be a database row id that means
    // nothing to the player, so a link built from it could not be played.
    expect(shareableId(track)).toBe("videoid1234");
    expect(shareableId({ ...track, youtubeId: undefined })).toBe("row-id-42");
  });

  test("a trailing slash on the origin does not double up", () => {
    expect(buildTrackShareUrl("https://site.example/", track)).toBe(
      `https://site.example${TRACK_PATH}/videoid1234`,
    );
  });
});

describe("the id identifies the track on its own", () => {
  test("a well-formed video id is accepted", () => {
    expect(isTrackId("videoid1234")).toBe(true);
    expect(isTrackId("dQw4w9WgXcQ")).toBe(true);
    expect(isTrackId("aB_-3xY9zQ1")).toBe(true);
  });

  test("a truncated, missing or malformed id is refused", () => {
    // A link clipped by a chat app used to still render, and rendered as
    // garbage. Refusing it up front is what shows "we couldn't find that".
    expect(isTrackId(undefined)).toBe(false);
    expect(isTrackId(null)).toBe(false);
    expect(isTrackId("")).toBe(false);
    expect(isTrackId("short")).toBe(false);
    expect(isTrackId("way-too-long-to-be-an-id")).toBe(false);
    expect(isTrackId("has spaces!!")).toBe(false);
  });
});

describe("resolved metadata rebuilds a playable track", () => {
  test("the id travels into the playable so the stream resolves", () => {
    const playable = trackMetaToPlayable(meta);
    expect(playable.youtubeId).toBe("videoid1234");
    expect(playable.audioUrl).toBe("https://youtu.be/videoid1234");
    expect(playable.source).toBe("youtube");
  });

  test("the display fields come through", () => {
    const playable = trackMetaToPlayable(meta);
    expect(playable.coverUrl).toBe(meta.coverUrl);
    expect(playable.duration).toBe(481);
  });

  test("raw video titles get cleaned like every other result", () => {
    // The raw value off a video id is the raw video title — "(Official
    // Video)" and "- Topic" suffixes and all. A shared link should not be the
    // one place in the UI that shows them.
    const playable = trackMetaToPlayable({
      ...meta,
      title: "Weightless (Official Video)",
    });
    expect(playable.title).toBe("Weightless");
  });

  test("a non-finite duration does not become NaN in the player", () => {
    const playable = trackMetaToPlayable({
      ...meta,
      duration: Number.NaN,
    });
    expect(playable.duration).toBe(0);
  });
});

describe("the share button copies the link straight away", () => {
  test("it builds the link from the shared module", () => {
    // The old inline template in the component is what made this drift; both
    // sides now go through one module.
    expect(fullscreenSource).toMatch(
      /buildTrackShareUrl\(\s*window\.location\.origin,\s*current,?\s*\)/,
    );
    // The share button must never build a search link. Scoped to the share
    // handler itself: the artist name elsewhere in the file legitimately
    // links to /search?q=…, and a whole-file assertion cannot tell the two
    // apart.
    const shareHandler = fullscreenSource.slice(
      fullscreenSource.indexOf("buildTrackShareUrl"),
      fullscreenSource.indexOf("buildTrackShareUrl") + 400,
    );
    expect(shareHandler).not.toContain("/search?q=");
  });

  test("it copies instead of opening the share sheet", () => {
    // `navigator.share` opened a modal the user then had to navigate a picker
    // to get out of, and did not exist on desktop at all, so on the web the
    // button appeared to do nothing. One tap now always lands the link on the
    // clipboard.
    expect(fullscreenSource).toMatch(/void copyText\(url\)/);
    expect(fullscreenSource).not.toMatch(/navigator\s*\.\s*share/);
  });

  test("the landing page resolves the metadata instead of reading the URL", () => {
    // The id is all the link carries, so the page has to look the rest up.
    expect(trackLinkSource).toMatch(/api\.youtube\.trackMeta/);
    expect(trackLinkSource).toMatch(/isTrackId\(trackId\)/);
    expect(trackLinkSource).not.toMatch(/useSearchParams/);
    expect(trackLinkSource).not.toMatch(/searchParams\.get/);
  });

  test("the resolver is public, so a link works for a first-time visitor", () => {
    expect(youtubeSource).toMatch(/export const trackMeta = action\(/);
  });

  test("the route is public so a link works for a first-time visitor", () => {
    expect(mainSource).toMatch(
      /<Route path="\/t\/:trackId" element={<TrackLink \/>} \/>/,
    );
    // It must sit OUTSIDE the RequireAuth group, or sharing to someone who
    // has no account would bounce them to sign-up with no way back.
    const route = mainSource.slice(
      mainSource.indexOf('path="/t/:trackId"'),
      mainSource.indexOf('path="/dashboard"'),
    );
    expect(route).not.toContain("RequireAuth");
  });
});
