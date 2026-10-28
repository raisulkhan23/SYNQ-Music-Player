import { describe, expect, test } from "bun:test";
import { parsePlaylistImport } from "../src/lib/importPlaylist";

const titles = (text) => parsePlaylistImport(text)?.tracks.map((t) => t.title);

describe("playlist import reads the right column", () => {
  test("column roles come from the header, never from the data", () => {
    // The parser used to test each DATA value against /title|track|song|video/
    // to decide which column held the title. A row whose ARTIST was called
    // "Video Games" therefore had that column promoted to the title, and the
    // song was imported under the artist's name.
    const csv = [
      "Track Name,Artist Name(s),Album Name",
      "Weightless,Marconi Union,Ambient Transmissions",
      "Theme,Video Games,Chris Huelsbeck",
      "Sonic,Track Title,Rick Moraine",
    ].join("\n");
    expect(titles(csv)).toEqual(["Weightless", "Theme", "Sonic"]);
  });

  test("the header row itself is never imported as a track", () => {
    // A header that slipped past detection became a phantom track: the first
    // column is the word "Song" or "Track", and the old `&& !artist` guard let
    // it through whenever a second column parsed as an artist.
    for (const header of [
      "Song,Artist",
      "song,artist",
      "Name,Artist",
      "Track,Artist",
    ]) {
      const parsed = parsePlaylistImport(`${header}\nWeightless,Marconi Union`);
      expect(parsed?.tracks.map((t) => t.title)).toEqual(["Weightless"]);
    }
  });

  test("a song actually titled like a header word still imports", () => {
    // Only an EXACT match on the whole title is a header row, so real songs
    // named "Video Games" or "Theme" are unaffected.
    const csv = "Track Name,Artist\nVideo Games,Some Band\nSong,Solo Act";
    expect(titles(csv)).toEqual(["Video Games", "Song"]);
  });

  test("YouTube Music exports keep the song title and drop the id", () => {
    const csv = [
      '"Video Title","Video ID","Channel"',
      '"Inferno Clash","dQw4w9WgXcQ","FlameFrags"',
      '"Weightless","abc12345678","Marconi Union"',
    ].join("\n");
    expect(titles(csv)).toEqual(["Inferno Clash", "Weightless"]);
  });

  test("durations are still picked up from the header-named layout", () => {
    const parsed = parsePlaylistImport(
      "Track Name,Artist,Duration\nWeightless,Marconi Union,8:01",
    );
    expect(parsed?.tracks[0]?.duration).toBe(481);
  });

  test("plain text lists still work in every documented shape", () => {
    expect(titles("Marconi Union - Weightless")).toEqual(["Weightless"]);
    expect(titles("Weightless, Marconi Union")).toEqual(["Weightless"]);
    expect(titles("Weightless")).toEqual(["Weightless"]);
  });

  test("imported rows get the same normalisation as native tracks", () => {
    // The importer used to keep the raw upload text, so a YouTube export landed
    // as "Inferno Clash - Music for FlameFrags" and then searched YouTube with
    // that whole string. The player already strips this everywhere else, so
    // imported rows have to agree with native ones.
    const csv = [
      '"Video Title","Channel"',
      '"Inferno Clash - Music for FlameFrags","FlameFrags"',
      '"Weightless [Official Video]","Marconi Union"',
    ].join("\n");
    expect(titles(csv)).toEqual(["Inferno Clash", "Weightless"]);
  });

  test("an empty or unparseable file reports nothing rather than junk", () => {
    expect(parsePlaylistImport("")).toBeNull();
    expect(parsePlaylistImport("   \n  \n")).toBeNull();
  });
});
