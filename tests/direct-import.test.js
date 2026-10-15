import { describe, expect, test } from 'vitest';
import { readSource } from "./helpers/tailwind-css.js";
// Both modules are dependency-free, so the behaviour is tested for real
// rather than asserted against source text.
import {
  canDirectImport,
  detectServiceUrl,
  nameFromUrl,
  planImport,
  extractUrl,
} from "../src/lib/sources.ts";

/**
 * Direct playlist import from another service.
 *
 * The importer used to be CSV-only. These lock in the two halves of the
 * replacement: recognising a share link well enough to route it, and the
 * Convex action that reads a YouTube / YouTube Music playlist directly.
 */

const youtube = readSource("src/convex/youtube.ts");
const importSection = readSource("src/components/settings/ImportSection.tsx");

const flat = (s) => s.replace(/\s+/g, " ");

describe("extractUrl", () => {
  test("finds a URL inside the share blurb users actually paste", () => {
    expect(
      extractUrl(
        "Check this out! https://open.spotify.com/playlist/abc123 (so good)",
      ),
    ).toBe("https://open.spotify.com/playlist/abc123");
  });

  test("accepts a bare host with no scheme", () => {
    expect(extractUrl("music.youtube.com/playlist?list=PL1234567890")).toBe(
      "https://music.youtube.com/playlist?list=PL1234567890",
    );
  });

  test("returns null when there is no link at all", () => {
    expect(extractUrl("just some words")).toBeNull();
  });
});

describe("detectServiceUrl", () => {
  test("reads a YouTube Music playlist link", () => {
    const s = detectServiceUrl(
      "https://music.youtube.com/playlist?list=PLabc123XYZ",
    );
    expect(s.service).toBe("youtube-music");
    expect(s.id).toBe("PLabc123XYZ");
    expect(s.kind).toBe("playlist");
    expect(s.direct).toBe(true);
  });

  test("reads a plain YouTube playlist link", () => {
    const s = detectServiceUrl(
      "https://www.youtube.com/playlist?list=PLxyz987654",
    );
    expect(s.service).toBe("youtube");
    expect(s.id).toBe("PLxyz987654");
    expect(s.direct).toBe(true);
  });

  test("keeps a watch link's video id as a track, not a playlist", () => {
    const s = detectServiceUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(s.kind).toBe("track");
    expect(s.id).toBe("dQw4w9WgXcQ");
    expect(s.direct).toBe(false);
  });

  test("reads a youtu.be link", () => {
    const s = detectServiceUrl("https://youtu.be/dQw4w9WgXcQ");
    expect(s.service).toBe("youtube");
    expect(s.kind).toBe("track");
  });

  test("reads a Spotify playlist but refuses to call it direct", () => {
    const s = detectServiceUrl(
      "https://open.spotify.com/playlist/37i9dQZF1DX?si=abc",
    );
    expect(s.service).toBe("spotify");
    expect(s.id).toBe("37i9dQZF1DX");
    expect(s.kind).toBe("playlist");
    // No public read API, so the client must never claim it can fetch this.
    expect(canDirectImport(s)).toBe(false);
  });

  test("reads Apple Music, SoundCloud, Deezer, Tidal and Bandcamp", () => {
    // Tidal is now a DIRECT import: its v2 API serves catalog reads over a
    // server-to-server client-credentials token, so a pasted Tidal link is
    // pulled by the importer instead of sending the user to a CSV export.
    const cases = [
      [
        "https://music.apple.com/us/playlist/road-trip/pl.u-abc123",
        "apple-music",
        "pl.u-abc123",
        false,
      ],
      [
        "https://soundcloud.com/artist/sets/my-mix",
        "soundcloud",
        "my-mix",
        false,
      ],
      [
        "https://www.deezer.com/en/playlist/1234567",
        "deezer",
        "1234567",
        false,
      ],
      ["https://tidal.com/browse/playlist/abc-123", "tidal", "abc-123", true],
      ["https://artist.bandcamp.com/playlist/42", "bandcamp", "42", false],
    ];
    for (const [url, service, id, direct] of cases) {
      const s = detectServiceUrl(url);
      expect(s?.service).toBe(service);
      expect(s?.id).toBe(id);
      expect(s?.direct).toBe(direct);
    }
  });

  test("a Tidal playlist link plans a direct import, not an export", () => {
    const plan = planImport("https://tidal.com/browse/playlist/abc-123");
    expect(plan.mode).toBe("direct");
  });

  test("returns null for a link it does not support", () => {
    expect(detectServiceUrl("https://example.com/playlist/1")).toBeNull();
    expect(detectServiceUrl("nothing here")).toBeNull();
  });

  test("a YouTube link with no list or video is not a direct import", () => {
    const s = detectServiceUrl("https://www.youtube.com/");
    expect(s.direct).toBe(false);
    expect(canDirectImport(s)).toBe(false);
  });
});

describe("planImport", () => {
  test("routes a YouTube Music playlist to a direct import", () => {
    const plan = planImport(
      "https://music.youtube.com/playlist?list=PLabc123XYZ",
    );
    expect(plan.mode).toBe("direct");
    expect(plan.source?.id).toBe("PLabc123XYZ");
  });

  test("routes a Spotify playlist to the export path with real guidance", () => {
    const plan = planImport("https://open.spotify.com/playlist/37i9dQZF1DX");
    expect(plan.mode).toBe("export");
    expect(plan.message).toContain("no public read API");
    expect(plan.message).toContain("CSV");
  });

  test("a single track link is sent to search, not to an import", () => {
    const plan = planImport(
      "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
    );
    expect(plan.mode).toBe("export");
    expect(plan.message).toContain("single Spotify track");
  });

  test("unrecognised text says so instead of pretending to import", () => {
    const plan = planImport("my playlist has some songs in it");
    expect(plan.mode).toBe("unsupported");
    expect(plan.source).toBeNull();
    expect(plan.message).toContain("doesn't look like a playlist link");
  });
});

describe("nameFromUrl", () => {
  test("recovers a playlist name that Apple Music bakes into the URL", () => {
    expect(
      nameFromUrl("https://music.apple.com/us/playlist/road-trip/pl.u-abc"),
    ).toBe("Road Trip");
  });

  test("returns null when the service does not put a name in the link", () => {
    expect(
      nameFromUrl("https://open.spotify.com/playlist/37i9dQZF1DX"),
    ).toBeNull();
  });
});

describe("YouTube playlist import action", () => {
  test("exposes an action that browses a playlist by id", () => {
    expect(youtube).toContain("export const importPlaylistById");
    expect(youtube).toContain("browseId: `VL${id}`");
    expect(youtube).toContain("extractPlaylistBrowse");
  });

  test("validates the playlist id before spending a request", () => {
    const fn = youtube.slice(
      youtube.indexOf("export const importPlaylistById"),
    );
    expect(fn).toContain("/^[A-Za-z0-9_-]{8,64}$/");
    expect(fn).toContain("doesn't look like a YouTube playlist ID");
  });

  test("follows continuations so a long playlist imports whole", () => {
    const fn = youtube.slice(
      youtube.indexOf("export const importPlaylistById"),
    );
    expect(fn).toContain("continuation,");
    expect(fn).toContain("MAX_IMPORT_TRACKS");
  });

  test("caps the import instead of paging forever", () => {
    expect(youtube).toContain("export const MAX_IMPORT_TRACKS = 500");
    const fn = youtube.slice(
      youtube.indexOf("export const importPlaylistById"),
    );
    expect(fn).toMatch(/for \(let page = 0; page < 4/);
  });

  test("rows without a usable id, title or artist are dropped", () => {
    const fn = youtube.slice(
      youtube.indexOf("export function extractPlaylistBrowse"),
    );
    expect(fn).toContain("if (!videoId) continue");
    expect(fn).toContain("if (!title) continue");
    expect(fn).toContain('artist === "Unknown artist"');
  });

  test("the response parser walks for the renderer instead of hard-coding a path", () => {
    // InnerTube reshuffles between client versions; a fixed path silently
    // returns zero rows the next time it does.
    expect(youtube).toContain("function findRenderer");
    expect(youtube).toContain('findRenderer(data, "playlistVideoListRenderer"');
  });

  test("titles are normalised with the same cleaner the player uses", () => {
    const fn = youtube.slice(
      youtube.indexOf("export function extractPlaylistBrowse"),
    );
    expect(fn).toContain("cleanTrackTitle(rawTitle)");
    expect(fn).toContain("firstCreatorName(");
  });
});

describe("import UI", () => {
  test("offers a link box and keeps the file picker", () => {
    expect(importSection).toContain("Paste a playlist link");
    expect(importSection).toContain("detectServiceUrl");
    expect(importSection).toContain("handleFile");
  });

  test("a direct import is fetched on the Convex side then saved through the mutation", () => {
    // The action is a pure public fetch; ownership stays in the mutation.
    expect(importSection).toContain("api.youtube.importPlaylistById");
    expect(importSection).toContain("api.playlists.saveImported");
  });

  test("a non-linkable service explains itself instead of failing", () => {
    // The wording moved out of a toast and into the panel's own error state,
    // but the promise it made is unchanged: say what to do, don't just fail.
    expect(flat(importSection)).toContain("can't be imported from a link yet");
    expect(flat(importSection)).toContain(
      "Export the playlist as CSV or a plain text list and drop it below",
    );
  });
});
