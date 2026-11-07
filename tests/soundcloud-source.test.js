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
import { buildId3Tag } from "../src/lib/id3.ts";

/**
 * SoundCloud as a first-class playable source, ported from the melo player.
 *
 * The player-side branch and the Convex resolver cannot run in this suite
 * (no network, no Convex runtime), so these tests pin the CONTRACTS that keep
 * it honest: the id namespacing that routes playback and downloads, the
 * refusal rules the server must enforce, and the byte-level ID3 tag the
 * download pipeline prepends.
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

  test("HLS-only tracks are refused, not returned to choke the player", () => {
    // The resolver returns progressive MP3s only; there is no isHls:true path.
    expect(server).toMatch(/progressive/);
    expect(server).not.toMatch(/isHls: true/);
  });

  test("the download grant is the artist's own flag, re-verified server-side", () => {
    // SoundCloud's /download endpoint only honours artist-enabled tracks; the
    // check must happen BEFORE the URL is fetched, same rule as Jamendo's
    // audiodownload_allowed.
    expect(downloads).toMatch(/downloadable !== true/);
    expect(downloads).toMatch(/fetchAuthorizedSoundcloudRelease/);
    expect(downloads).toMatch(/soundcloudProviderId\(trackId\)/);
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

describe("the ID3v2.3 tag writer", () => {
  test("an empty input builds nothing — no dead bytes", () => {
    expect(buildId3Tag({})).toBeNull();
    expect(buildId3Tag({ title: "   ", artist: "" })).toBeNull();
  });

  test("the header is ID3/v2.3 with a syncsafe size", () => {
    const tag = buildId3Tag({ title: "Nightdrive", artist: "Analog Ghost" });
    expect(tag).not.toBeNull();
    const t = tag;
    expect(t[0]).toBe(0x49); // I
    expect(t[1]).toBe(0x44); // D
    expect(t[2]).toBe(0x33); // 3
    expect(t[3]).toBe(0x03); // v2.3
    expect(t[5]).toBe(0x00); // no flags
    // Syncsafe: every size byte's high bit must be clear.
    for (const b of [t[6], t[7], t[8], t[9]]) expect(b & 0x80).toBe(0);
  });

  test("declared size equals the frame bytes that follow the header", () => {
    const tag = buildId3Tag({
      title: "Nightdrive",
      artist: "Analog Ghost",
      album: "Signals",
      durationMs: 213_000,
    });
    const declared =
      ((tag[6] & 0x7f) << 21) | ((tag[7] & 0x7f) << 14) | ((tag[8] & 0x7f) << 7) | (tag[9] & 0x7f);
    expect(declared).toBe(tag.length - 10);
  });

  test("frames carry the expected ids in order", () => {
    const tag = buildId3Tag({ title: "T", artist: "A", album: "L" });
    const text = new TextDecoder("latin1").decode(tag);
    expect(text).toContain("TIT2");
    expect(text).toContain("TPE1");
    expect(text).toContain("TALB");
  });

  test("artwork becomes an APIC frame only with a valid image mime", () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const withJpeg = buildId3Tag({
      title: "T",
      artwork: bytes,
      artworkMime: "image/jpeg",
    });
    expect(new TextDecoder("latin1").decode(withJpeg)).toContain("APIC");
    // A wrong mime must be dropped, not embedded as a corrupt picture.
    const withBadMime = buildId3Tag({
      title: "T",
      artwork: bytes,
      artworkMime: "image/webp",
    });
    expect(new TextDecoder("latin1").decode(withBadMime)).not.toContain("APIC");
  });

  test("the licence URL travels as a TXXX frame", () => {
    const tag = buildId3Tag({
      title: "T",
      licenseUrl: "https://soundcloud.com/track",
    });
    // Text frames are UTF-16 with a BOM; decoding as latin1 interleaves
    // zero bytes, so the readable text is checked with them stripped.
    const flat = new TextDecoder("latin1").decode(tag).replace(/\u0000/g, "");
    expect(flat).toContain("TXXX");
    expect(flat).toContain("soundcloud.com");
  });
});
