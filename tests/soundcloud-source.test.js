import { describe, expect, test } from "bun:test";
import { readSource } from "./helpers/tailwind-css.js";

import {
  toPlayableSoundcloud,
  SOUNDCLOUD_RESOLVE_MARKER,
} from "../src/lib/playable.ts";
import {
  soundcloudProviderId,
  isTrackDownloadable,
  downloadTargetId,
  downloadAvailability,
  authorizedProviderId,
} from "../src/lib/downloadAuth.ts";
import {
  officialDownloadEndpoint,
  pickSoundcloudTranscoding,
  soundcloudStreamUrl,
} from "../src/convex/soundcloud.ts";

/**
 * SoundCloud as a first-class playable source, ported from the melo player.
 *
 * The player-side branch and the Convex resolver cannot run in this suite
 * (no network, no Convex runtime), so these tests pin the CONTRACTS that keep
 * it honest: the id namespacing that routes playback and downloads and the
 * refusal rules the server must enforce.
 */

describe("soundcloud playables", () => {
  const row = {
    id: "1245132",
    title: "Nightdrive",
    artist: "Analog Ghost",
    durationMs: 213_000,
    artwork: "https://i1.sndcdn.com/artworks-x-large.jpg",
    permalinkUrl: "https://soundcloud.com/analog-ghost/nightdrive",
    explicit: false,
  };

  test("the queue id is namespaced, so a YouTube id can never collide", () => {
    const playable = toPlayableSoundcloud(row);
    expect(playable.id).toBe("sc:1245132");
    expect(playable.source).toBe("soundcloud");
    expect(playable.soundcloudId).toBe("1245132");
    expect(playable.audioUrl).toBe(SOUNDCLOUD_RESOLVE_MARKER);
  });

  test("duration converts to whole seconds for the player", () => {
    expect(toPlayableSoundcloud(row).duration).toBe(213);
  });

  test("webUrl carries the permalink when the source gives one", () => {
    expect(toPlayableSoundcloud(row).webUrl).toBe(row.permalinkUrl);
    const bare = toPlayableSoundcloud({ ...row, permalinkUrl: "" });
    expect(bare.webUrl).toBeUndefined();
  });
});

describe("soundcloud download eligibility", () => {
  test("an sc: track id parses to its numeric provider id", () => {
    expect(soundcloudProviderId("sc:1245132")).toBe("1245132");
    expect(soundcloudProviderId("sc:bad")).toBeNull();
    // A bare YouTube id is NOT a SoundCloud id.
    expect(soundcloudProviderId("dQw4w9WgXcQ")).toBeNull();
    // The Jamendo namespacing stays Jamendo's.
    expect(authorizedProviderId("sc:1245132")).toBeNull();
    expect(soundcloudProviderId("jamendo:4321")).toBeNull();
  });

  test("a bare numeric soundcloudId (provenance) is eligible", () => {
    expect(isTrackDownloadable(undefined, null, "1245132")).toBe(true);
    expect(isTrackDownloadable("sc:1245132", null)).toBe(true);
    expect(isTrackDownloadable("dQw4w9WgXcQ", null)).toBe(false);
  });

  test("jamendo provenance wins over soundcloud provenance", () => {
    expect(downloadTargetId("dQw4w9WgXcQ", "4321", "1245132")).toBe("jamendo:4321");
    expect(downloadTargetId("sc:1245132", null, "1245132")).toBe("sc:1245132");
    expect(downloadTargetId("dQw4w9WgXcQ", null, null)).toBeNull();
  });

  test("availability mirrors eligibility", () => {
    expect(downloadAvailability("sc:1245132").allowed).toBe(true);
    expect(downloadAvailability("dQw4w9WgXcQ").allowed).toBe(false);
    expect(downloadAvailability("dQw4w9WgXcQ").decision.code).toBe("not-authorized");
  });
});

describe("the server-side honesty rules (source contract)", () => {
  const server = readSource("src/convex/soundcloud.ts");
  const downloads = readSource("src/convex/downloads.ts");

  test("SNIP previews are filtered from search AND refused at resolve", () => {
    // Playing a 30-second teaser as if it were the song is the fabrication
    // this codebase refuses. Both layers must enforce it.
    expect(server).toMatch(/SNIP/);
    expect(server).toMatch(/policy.*SNIP|SNIP.*policy/);
  });

  test("HLS-only uploads are playable through the deck's HLS loader", () => {
    // Most current public uploads expose only HLS. The resolver must return
    // it with a marker the player uses to attach HLS.js to the SAME deck —
    // refusing it was the cause of "no playable stream" on valid tracks.
    expect(server).toMatch(/isHls: transcoding\.protocol === "hls"/);
    // The live v2 API nests transcodings under `media`; reading them from the
    // top level is why a valid track resolved to "no format" at all.
    expect(pickSoundcloudTranscoding({
      media: {
        transcodings: [
          { format: { protocol: "hls" }, url: "https://api.soundcloud.com/media/1/hls" },
        ],
      },
    })).toEqual({
      protocol: "hls",
      url: "https://api.soundcloud.com/media/1/hls",
    });
  });

  test("progressive MP3 is preferred when SoundCloud still offers it", () => {
    expect(pickSoundcloudTranscoding({
      media: {
        transcodings: [
          { format: { protocol: "hls" }, url: "https://api.soundcloud.com/media/1/hls" },
          { format: { protocol: "progressive" }, url: "https://api.soundcloud.com/media/1/mp3" },
        ],
      },
    })).toMatchObject({ protocol: "progressive" });
  });

  test("only SoundCloud's own HTTPS media hosts are accepted", () => {
    expect(
      soundcloudStreamUrl(
        "https://playback.media-streaming.soundcloud.cloud/media/1.m3u8?x=1",
      ),
    ).toBeTruthy();
    expect(soundcloudStreamUrl("https://cf-media.sndcdn.com/a.mp3")).toBeTruthy();
    expect(soundcloudStreamUrl("http://cf-media.sndcdn.com/a.mp3")).toBeNull();
    expect(soundcloudStreamUrl("https://sndcdn.com.evil.example/a.mp3")).toBeNull();
    expect(soundcloudStreamUrl("https://user:pass@cf-media.sndcdn.com/a.mp3")).toBeNull();
  });

  test("there is no title-search substitution when a track id fails", () => {
    // A "closest match" is a different recording. Playing it silently is
    // exactly the fabrication the player must never do.
    expect(server).not.toMatch(/fallbackQuery/);
    expect(server).not.toMatch(/search-fallback/);
  });

  test("HLS stays on the existing deck and tears down its old loader", () => {
    const hls = readSource("src/lib/hlsAudio.ts");
    // One loader per element: reusing an audio element for the next upload
    // must destroy the previous Hls instance before attaching a new source.
    expect(hls).toMatch(/WeakMap<HTMLAudioElement, Hls>/);
    expect(hls).toMatch(/hls\.destroy\(\)/);
    expect(hls).toMatch(/hls\.attachMedia\(audio\)/);
    expect(hls).toMatch(/hls\.loadSource\(source\)/);
    expect(hls).toMatch(/Hls\.Events\.MANIFEST_PARSED/);
    // MSE support wins over the ambiguous HLS MIME answer from canPlayType.
    expect(hls).toMatch(/if \(!Hls\.isSupported\(\)\)/);
    // There is no second <audio> element or SoundCloud-only player.
    expect(hls).not.toMatch(/new Audio\(/);
  });

  test("a SoundCloud error never falls into the YouTube substitution path", () => {
    const bar = readSource("src/components/player/PlayerBar.tsx");
    const guard = bar.indexOf('track.source === "soundcloud"');
    const youtubeRescue = bar.indexOf("if (!track.audioUrl) {");
    expect(guard).toBeGreaterThan(-1);
    expect(youtubeRescue).toBeGreaterThan(guard);
    const block = bar.slice(guard, youtubeRescue);
    expect(block).toContain("s.retryCurrent()");
    expect(block).not.toContain("searchSameSong");
    expect(block).not.toContain("replaceCurrentStream");
    // A successful retry must clear the loading toast and re-arm the guard for
    // a later expiry on the same track.
    expect(bar).toMatch(/toast\.dismiss\("soundcloud-playback"\)/);
    expect(bar).toMatch(/attempts\.current = 0;[\s\S]{0,80}toast\.dismiss/);
  });

  test("the download grant is the artist's own flag, re-verified server-side", () => {
    // Both the artist's `downloadable` flag and the API-issued download_url
    // must be present before any file request, same rule as Jamendo's
    // audiodownload_allowed.
    expect(downloads).toMatch(/downloadable !== true/);
    expect(downloads).toMatch(/record\.downloadUrl/);
    expect(downloads).toMatch(/fetchAuthorizedSoundcloudRelease/);
    expect(downloads).toMatch(/soundcloudProviderId\(trackId\)/);
  });

  test("the official download resource is API-issued, not reconstructed", () => {
    expect(server).toContain("raw.download_url");
    expect(server).toContain("officialDownloadEndpoint");
    expect(server).toContain("grant_type=client_credentials");
    expect(server).toContain("Authorization: `OAuth ${token}`");
    expect(server).not.toContain("hasDownloadsLeft");
    expect(server).not.toContain("downloads_remaining");
  });

  test("an un-namespaced id is refused before any network call", () => {
    // The sc branch must run before the Jamendo branch, and a bare YouTube id
    // must fall through to the existing refusal.
    const branch = downloads.indexOf("soundcloudProviderId(trackId)");
    const jamendo = downloads.indexOf("authorizedProviderId(trackId)");
    expect(branch).toBeGreaterThan(-1);
    expect(jamendo).toBeGreaterThan(branch);
  });
});

describe("official SoundCloud download endpoint", () => {
  test("accepts only the official API's track download resource", () => {
    expect(
      officialDownloadEndpoint(
        "https://api.soundcloud.com/tracks/1245132/download?client_id=legacy",
      ),
    ).toBe("https://api.soundcloud.com/tracks/1245132/download");
    expect(
      officialDownloadEndpoint("api.soundcloud.com/tracks/1245132/download"),
    ).toBe("https://api.soundcloud.com/tracks/1245132/download");
  });

  test("rejects lookalike hosts, schemes, paths and missing grants", () => {
    expect(
      officialDownloadEndpoint("https://api.soundcloud.com.evil.test/tracks/1/download"),
    ).toBeNull();
    expect(officialDownloadEndpoint("http://api.soundcloud.com/tracks/1/download")).toBeNull();
    expect(officialDownloadEndpoint("https://api.soundcloud.com/tracks/1/stream")).toBeNull();
    expect(officialDownloadEndpoint("https://api.soundcloud.com/me")).toBeNull();
    expect(officialDownloadEndpoint(null)).toBeNull();
  });
});
