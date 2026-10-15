import { describe, expect, test } from 'vitest';
import {
  dedupeMusicItems,
  discoverySeedQueries,
  DISCOVERY_SEED_LIMIT,
  isLyricVideoTrack,
  isMusicTrack,
  isPrimaryMusicResult,
  parseMusicListItem,
} from "../src/convex/youtube";
import { cleanTrackTitle } from "../src/lib/youtube";

function column(...runs) {
  return {
    musicResponsiveListItemFlexColumnRenderer: {
      text: { runs: runs.map((text) => ({ text })) },
    },
  };
}

function renderer(meta) {
  return {
    playlistItemData: { videoId: "video-1" },
    flexColumns: [column("Test Track"), column(...meta), column("3:45")],
  };
}

describe("supplemental lyric-video filtering", () => {
  const item = (overrides = {}) => ({
    id: "lyric-1",
    title: "Khusir Anek Range | Achena Atithi | Lyrical Video Song",
    artist: "Rp Creation",
    duration: 245,
    thumbnail: "",
    ...overrides,
  });

  test("accepts the attached lo-fi music-video shape", () => {
    expect(
      isLyricVideoTrack(
        {
          id: "lofi-1",
          title:
            "This’ll Kill Me Yet | Mahe Mahe Tobo | LoFi Version | NURE AL MISKAT | MUSIC VIDEO",
          artist: "NURE AL MISKAT",
          duration: 304,
          thumbnail: "",
        },
        "This’ll Kill Me Yet",
      ),
    ).toBe(true);
  });

  test("accepts the attached Bengali lyric-video shape", () => {
    expect(isLyricVideoTrack(item(), "Khusir Anek Range Achena Atithi")).toBe(
      true,
    );
  });

  test("does not treat a generic version label as music evidence", () => {
    expect(
      isLyricVideoTrack(
        item({
          title: "Khusir Anek Range Achena Atithi Version",
          artist: "Random Uploads",
        }),
        "Khusir Anek Range Achena Atithi",
      ),
    ).toBe(false);
  });

  test("rejects a random video even when it mentions music", () => {
    expect(
      isLyricVideoTrack(
        item({ title: "My reaction to this song", artist: "Vlog Channel" }),
        "Khusir Anek Range Achena Atithi",
      ),
    ).toBe(false);
  });

  test("rejects mixes, interviews, and unknown-length results", () => {
    expect(
      isLyricVideoTrack(item({ duration: 3600 }), "Khusir Anek Range"),
    ).toBe(false);
    expect(
      isLyricVideoTrack(
        item({ title: "Song interview", duration: 245 }),
        "Khusir Anek Range",
      ),
    ).toBe(false);
    expect(isLyricVideoTrack(item({ duration: 0 }), "Khusir Anek Range")).toBe(
      false,
    );
  });

  test("deduplicates ids and normalized title/artist pairs", () => {
    expect(
      dedupeMusicItems([
        item(),
        item({ id: "lyric-2" }),
        item({
          id: "lyric-3",
          title: "  Khusir   Anek Range | Achena Atithi | Lyrical Video Song  ",
        }),
      ]).map((entry) => entry.id),
    ).toEqual(["lyric-1"]);
  });
});

describe("primary music result filtering", () => {
  test("keeps a matching music result", () => {
    expect(
      isPrimaryMusicResult(
        {
          id: "music-1",
          title: "Inferno Clash - Music for FlameFrags",
          artist: "FlameFrags",
          duration: 204,
          thumbnail: "",
        },
        "inferno clash",
      ),
    ).toBe(true);
  });

  test("rejects sports and news videos even when they are labeled as singles", () => {
    const sportsVideo = {
      id: "sports-1",
      title: "Skip China Open, No WTA Penalty? Alex Eala Ma... | Music",
      artist: "Crowd Favorite",
      duration: 221,
      thumbnail: "",
    };
    expect(isMusicTrack(sportsVideo)).toBe(false);
    expect(isPrimaryMusicResult(sportsVideo, "China Open")).toBe(false);
  });

  test("rejects Clash of Clans gaming results even when they match the query", () => {
    expect(
      isPrimaryMusicResult(
        {
          id: "game-1",
          title: "Introducing The Inferno Tower | Clash of Clans",
          artist: "Clash of Clans",
          duration: 512,
          thumbnail: "",
        },
        "inferno clash",
      ),
    ).toBe(false);
    expect(
      isPrimaryMusicResult(
        {
          id: "game-2",
          title: "New Max Single Inferno Tower vs All Max Troop!",
          artist: "Gaming channel",
          duration: 734,
          thumbnail: "",
        },
        "inferno clash",
      ),
    ).toBe(false);
  });

  test("accepts a matching markerless music upload during fallback search", () => {
    expect(
      isPrimaryMusicResult(
        {
          id: "music-markerless",
          title: "Weightless",
          artist: "Marconi Union",
          duration: 481,
          thumbnail: "",
        },
        "weightless marconi union",
      ),
    ).toBe(true);
  });

  test("does not reject valid songs whose titles use broad gaming or sports words", () => {
    for (const item of [
      {
        id: "army-song",
        title: "Army",
        artist: "Gaming outfit",
        duration: 204,
        thumbnail: "",
      },
      {
        id: "troop-song",
        title: "Troop",
        artist: "Army of One",
        duration: 198,
        thumbnail: "",
      },
      {
        id: "sports-song",
        title: "Sports",
        artist: "Matchbox",
        duration: 221,
        thumbnail: "",
      },
      {
        id: "highlights-song",
        title: "Highlights",
        artist: "The Newsroom",
        duration: 244,
        thumbnail: "",
      },
    ]) {
      expect(isMusicTrack(item)).toBe(true);
      expect(isPrimaryMusicResult(item, item.title)).toBe(true);
    }
  });
});

describe("cleanTrackTitle", () => {
  test("strips the upload suffixes that survive in real search results", () => {
    // These are the exact strings the existing parseMusicListItem tests assert
    // on after parsing, so the cleaner has to agree with the parser.
    for (const [raw, expected] of [
      ["Inferno Clash - Music for FlameFrags", "Inferno Clash"],
      ["Weightless", "Weightless"],
      ["Song Name (Official Music Video)", "Song Name"],
      ["Song Name (Official Video)", "Song Name"],
      ["Song Name [Official Video]", "Song Name"],
      ["Song Name (Lyrics)", "Song Name"],
      ["Song Name (Visualizer)", "Song Name"],
    ]) {
      expect(cleanTrackTitle(raw)).toBe(expected);
    }
  });

  test("never reduces a real title to nothing", () => {
    // The fallback matters: an over-eager strip that emptied the title used to
    // leave the queue with a nameless track.
    for (const raw of ["(Official Video)", "Lyrics", "Video"]) {
      expect(cleanTrackTitle(raw).length).toBeGreaterThan(0);
    }
  });

  test("leaves ordinary titles untouched", () => {
    for (const raw of [
      "Video Games",
      "Song 2",
      "Music for Others",
      "The Official Chart",
    ]) {
      expect(cleanTrackTitle(raw)).toBe(raw);
    }
  });
});

describe("discoverySeedQueries", () => {
  test("draws from every genre group a broad query matches", () => {
    // "indie pop" matches both the `pop` and `indie` groups.
    const seeds = discoverySeedQueries("indie pop", 10);
    expect(
      seeds.some((seed) =>
        /Phoebe Bridgers|Tame Impala|Arctic Monkeys/.test(seed),
      ),
    ).toBe(true);
    expect(
      seeds.some((seed) => /Taylor Swift|Dua Lipa|Olivia Rodrigo/.test(seed)),
    ).toBe(true);
  });

  test("round-robins genres so the limit does not starve the second group", () => {
    const capped = discoverySeedQueries("indie pop");
    expect(capped).toHaveLength(DISCOVERY_SEED_LIMIT);
    expect(
      capped.filter((seed) =>
        /Taylor Swift|Dua Lipa|Olivia Rodrigo/.test(seed),
      ),
    ).toHaveLength(2);
    expect(
      capped.filter((seed) =>
        /Phoebe Bridgers|Tame Impala|Arctic Monkeys/.test(seed),
      ),
    ).toHaveLength(2);
  });

  test("returns nothing for a query that matches no genre", () => {
    expect(discoverySeedQueries("inferno clash flamefrags")).toEqual([]);
    expect(discoverySeedQueries("")).toEqual([]);
  });

  test("never returns duplicate seeds for overlapping groups", () => {
    // "k-pop" matches the `k-pop` group and also the bare `pop` group.
    const seeds = discoverySeedQueries("k-pop", 20);
    expect(new Set(seeds).size).toBe(seeds.length);
    expect(seeds.some((seed) => /BLACKPINK|TWICE|Stray Kids/.test(seed))).toBe(
      true,
    );
    expect(
      seeds.some((seed) => /Taylor Swift|Dua Lipa|Olivia Rodrigo/.test(seed)),
    ).toBe(true);
  });

  test("a mood-only query still resolves to seeds", () => {
    expect(discoverySeedQueries("something chill", 3)).toHaveLength(3);
  });
});

describe("parseMusicListItem", () => {
  test("uses the artist after a Song metadata run", () => {
    expect(
      parseMusicListItem(renderer(["Song", " • ", "Daft Punk", " • ", "3:45"])),
    ).toMatchObject({
      id: "video-1",
      title: "Test Track",
      artist: "Daft Punk",
      duration: 225,
      kind: "song",
    });
  });

  test("removes upload suffixes from the displayed song title", () => {
    const noisy = renderer(["Song", " • ", "Nombra101", " • ", "3:14"]);
    noisy.flexColumns[0].musicResponsiveListItemFlexColumnRenderer.text.runs[0].text =
      "Inferno Clash - Music for FlameFrags";
    expect(parseMusicListItem(noisy)).toMatchObject({ title: "Inferno Clash" });
  });

  test("replaces placeholder creator metadata instead of rendering '*'", () => {
    expect(
      parseMusicListItem(renderer(["Song", " • ", "*", " • ", "3:45"])),
    ).toMatchObject({
      artist: "Unknown artist",
    });
  });

  test("keeps playlists classified as non-song rows", () => {
    expect(
      parseMusicListItem(renderer(["Playlist", "Daft Punk", "3:45"])),
    ).toMatchObject({
      artist: "Daft Punk",
      kind: "other",
    });
  });

  test("does not promote an untyped row into the primary song results", () => {
    expect(
      parseMusicListItem(renderer(["Phonk Artist", "3:45"])),
    ).toMatchObject({
      artist: "Phonk Artist",
      kind: "other",
    });
  });
});
