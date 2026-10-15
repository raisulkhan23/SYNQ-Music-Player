import { describe, expect, test } from 'vitest';
import { readSource } from "./helpers/tailwind-css.js";
import {
  cleanField,
  dedupeTracks,
  describeOutcome,
  ImportError,
  IMPORT_ERRORS,
  normalizeTrack,
  summarizeOutcome,
  toStoredTracks,
} from "../src/lib/importModel.ts";
import {
  importerFor,
  IMPORTERS,
  requiredEnvVars,
  DIRECT_IMPORT_SERVICES,
} from "../src/lib/importers.ts";
import {
  extractSpotifyId,
  isSpotifyId,
  readAuthCallback,
  buildAuthorizeUrl,
  SPOTIFY_SCOPES,
} from "../src/lib/spotifyAuth.ts";
import { detectServiceUrl } from "../src/lib/sources.ts";

/**
 * The multi-service import system.
 *
 * The importer used to be CSV-only with one hard-wired YouTube path. These
 * lock in the properties that make it a system rather than a special case: one
 * normalised shape, one error taxonomy, honest reporting of what did not make
 * it in, and no credential material anywhere it could be read.
 */

const track = (title, artist, extra = {}) => ({
  title,
  artist,
  source: "spotify",
  ...extra,
});

describe("normaliseTrack", () => {
  test("keeps the fields a service does report", () => {
    const t = normalizeTrack({
      title: "  Weightless  ",
      artist: "Marconi  Union",
      album: "Ambient Transmissions",
      artwork: "https://img/1.jpg",
      durationMs: 481_000,
      source: "spotify",
      sourceId: "abc",
      sourceUrl: "https://open.spotify.com/track/abc",
    });
    expect(t).toEqual({
      title: "Weightless",
      artist: "Marconi Union",
      album: "Ambient Transmissions",
      artwork: "https://img/1.jpg",
      duration: 481,
      source: "spotify",
      sourceId: "abc",
      sourceUrl: "https://open.spotify.com/track/abc",
    });
  });

  test("refuses a payload that names no song", () => {
    // This is how a removed or region-locked entry is detected rather than
    // being imported as a blank row.
    expect(
      normalizeTrack({ title: "", artist: "X", source: "spotify" }),
    ).toBeNull();
    expect(
      normalizeTrack({ title: "X", artist: null, source: "spotify" }),
    ).toBeNull();
    expect(normalizeTrack({ source: "spotify" })).toBeNull();
  });

  test("accepts a duration in either unit the services use", () => {
    expect(
      normalizeTrack({
        title: "a",
        artist: "b",
        durationMs: 200_000,
        source: "spotify",
      })?.duration,
    ).toBe(200);
    expect(
      normalizeTrack({
        title: "a",
        artist: "b",
        durationSeconds: 200,
        source: "spotify",
      })?.duration,
    ).toBe(200);
  });

  test("omits optional fields rather than storing empty strings", () => {
    const t = normalizeTrack({ title: "a", artist: "b", source: "spotify" });
    expect(t).toEqual({ title: "a", artist: "b", source: "spotify" });
    expect("album" in t).toBe(false);
    expect("duration" in t).toBe(false);
  });

  test("ignores a nonsense duration", () => {
    const t = normalizeTrack({
      title: "a",
      artist: "b",
      durationMs: "not a number",
      source: "spotify",
    });
    expect(t?.duration).toBeUndefined();
  });
});

describe("cleanField", () => {
  test("collapses whitespace and rejects non-strings", () => {
    expect(cleanField("  a   b  ")).toBe("a b");
    expect(cleanField(42)).toBe("");
    expect(cleanField(null)).toBe("");
  });
});

describe("dedupeTracks", () => {
  test("drops a repeat and keeps the first occurrence", () => {
    const { tracks, skipped } = dedupeTracks([
      track("Weightless", "Marconi Union"),
      track("Weightless", "Marconi Union"),
    ]);
    expect(tracks).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  test("ignores case and spacing when deciding identity", () => {
    const { tracks, skipped } = dedupeTracks([
      track("Weightless", "Marconi Union"),
      track("weightless", "  marconi   union  "),
    ]);
    expect(tracks).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  test("preserves the order the user arranged", () => {
    const { tracks } = dedupeTracks([
      track("c", "z"),
      track("a", "y"),
      track("b", "x"),
    ]);
    expect(tracks.map((t) => t.title)).toEqual(["c", "a", "b"]);
  });

  test("keeps genuinely different songs", () => {
    const { tracks, skipped } = dedupeTracks([
      track("One", "A"),
      track("One", "B"),
    ]);
    expect(tracks).toHaveLength(2);
    expect(skipped).toBe(0);
  });
});

describe("toStoredTracks", () => {
  test("carries what the playlist rows actually store", () => {
    // Album and artwork are stored now. They used to be normalised out of the
    // provider payload and then dropped here, which is why every imported
    // playlist rendered as a grid of empty black boxes.
    const stored = toStoredTracks([
      {
        title: "a",
        artist: "b",
        duration: 200,
        source: "spotify",
        album: "X",
        artwork: "https://art/x.jpg",
      },
      { title: "c", artist: "d", source: "apple-music" },
    ]);
    expect(stored).toEqual([
      {
        title: "a",
        artist: "b",
        duration: 200,
        album: "X",
        artwork: "https://art/x.jpg",
      },
      { title: "c", artist: "d" },
    ]);
  });
});

describe("partial imports are reported, not hidden", () => {
  test("a summary names the imported and the unavailable counts", () => {
    expect(
      summarizeOutcome({
        name: "Mix",
        origin: "Spotify",
        tracks: [track("a", "b"), track("c", "d")],
        skipped: 2,
        partial: true,
        warnings: [],
      }),
    ).toBe("Imported 2 tracks • 2 unavailable");
  });

  test("a clean import says only what came in", () => {
    expect(
      summarizeOutcome({
        name: "Mix",
        origin: "Spotify",
        tracks: [track("a", "b")],
        skipped: 0,
        partial: false,
        warnings: [],
      }),
    ).toBe("Imported 1 track");
  });

  test("an outcome with no usable tracks is a failure, not a silent success", () => {
    // Reporting "Imported 0 tracks" as a success is the worst outcome: the
    // playlist looks like it arrived and is empty.
    const verdict = describeOutcome({
      name: "Mix",
      origin: "Spotify",
      tracks: [],
      skipped: 3,
      partial: true,
      warnings: [],
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.failure.code).toBe("not-found");
  });

  test("an empty playlist is reported as empty", () => {
    const verdict = describeOutcome({
      name: "Mix",
      origin: "Spotify",
      tracks: [],
      skipped: 0,
      partial: false,
      warnings: [],
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.failure.code).toBe("empty");
  });
});

describe("the error taxonomy covers the real failures", () => {
  test("every case the UI must explain has a code and a sentence", () => {
    for (const code of [
      "invalid-url",
      "unsupported",
      "not-found",
      "private",
      "auth-required",
      "auth-expired",
      "rate-limited",
      "network",
      "empty",
      "too-large",
      "not-configured",
      "unknown",
    ]) {
      const failure = IMPORT_ERRORS[code];
      expect(failure).toBeDefined();
      expect(failure.message.length).toBeGreaterThan(0);
      expect(typeof failure.retryable).toBe("boolean");
    }
  });

  test("a refusal is not retryable; a timeout is", () => {
    expect(IMPORT_ERRORS.private.retryable).toBe(false);
    expect(IMPORT_ERRORS["not-found"].retryable).toBe(false);
    expect(IMPORT_ERRORS.network.retryable).toBe(true);
    expect(IMPORT_ERRORS["rate-limited"].retryable).toBe(true);
    expect(IMPORT_ERRORS["auth-expired"].retryable).toBe(true);
  });

  test("auth codes explain that nothing is imported yet", () => {
    expect(IMPORT_ERRORS["auth-required"].hint).toContain("read access");
  });

  test("ImportError carries the code and the known wording", () => {
    const error = new ImportError("rate-limited");
    expect(error.code).toBe("rate-limited");
    expect(error.message).toBe(IMPORT_ERRORS["rate-limited"].message);
    expect(error.retryable).toBe(true);
  });
});

describe("the importer registry describes every service", () => {
  test("every detected service has an entry", () => {
    for (const service of [
      "youtube",
      "youtube-music",
      "spotify",
      "apple-music",
      "soundcloud",
      "deezer",
      "tidal",
      "bandcamp",
      "unknown",
    ]) {
      expect(importerFor(service)).toBeDefined();
      expect(importerFor(service).label.length).toBeGreaterThan(0);
    }
  });

  test("only YouTube imports from a link with no account", () => {
    expect(DIRECT_IMPORT_SERVICES.sort()).toEqual(["youtube", "youtube-music"]);
  });

  test("a service we cannot read is not claimed as direct", () => {
    // The registry must never disagree with reality and offer a link import
    // that cannot work.
    for (const service of ["soundcloud", "deezer", "tidal", "bandcamp"]) {
      expect(importerFor(service).direct).toBe(false);
    }
  });

  test("anything that needs auth also says what to configure", () => {
    for (const entry of Object.values(IMPORTERS)) {
      if (entry.needsAuth) expect(entry.envVars.length).toBeGreaterThan(0);
    }
  });

  test("the required env vars are de-duplicated", () => {
    const vars = requiredEnvVars();
    expect(new Set(vars).size).toBe(vars.length);
    expect(vars).toContain("SPOTIFY_CLIENT_ID");
    expect(vars).toContain("APPLE_MUSIC_PRIVATE_KEY");
  });
});

describe("importable is not the same as playable", () => {
  // Tidal, Spotify and Apple Music all hand over catalog data and none of them
  // hands over audio. Tidal is the sharpest case: its developer keys look like
  // a streaming licence and are not one, because playback is restricted to
  // approved partner apps. Someone who wires up credentials expecting sound
  // should be told plainly, at the point of detection.

  const METADATA_ONLY = ["tidal", "spotify", "apple-music"];

  test("every metadata-only service carries a playback note", () => {
    for (const service of METADATA_ONLY) {
      const note = importerFor(service).playbackNote;
      expect(note).toBeTruthy();
      expect(note.length).toBeGreaterThan(20);
    }
  });

  test("Tidal's note says the keys are not a streaming licence", () => {
    // Guards the specific claim. "Metadata" alone reads like an omission; the
    // note has to name the restriction or the user assumes a bug.
    const note = importerFor("tidal").playbackNote.toLowerCase();
    expect(note).toContain("audio");
    expect(note).toMatch(/stream|partner|restrict/);
  });

  test("YouTube is never given a caveat it does not have", () => {
    // YouTube IS the playback source, so a note here would be a lie.
    expect(importerFor("youtube").playbackNote).toBeUndefined();
    expect(importerFor("youtube-music").playbackNote).toBeUndefined();
  });

  test("the note is rendered, not left in the registry", () => {
    // The blurb field was never rendered anywhere, which is exactly how this
    // information was already lost once. Assert the surface, not the data:
    // the note is rendered by ImportServiceHint, and the panel has to actually
    // use that component rather than sitting next to it.
    const hint = readSource("src/components/settings/ImportServiceHint.tsx");
    expect(hint).toContain("playbackNote");

    const client = readSource("src/components/settings/ImportSection.tsx");
    expect(client).toContain("ImportServiceHint");
  });
});

describe("Spotify identifiers", () => {
  test("accepts a real 22-character id and rejects anything else", () => {
    expect(isSpotifyId("37i9dQZF1DX0XUsuxWHRQd")).toBe(true);
    expect(isSpotifyId("short")).toBe(false);
    expect(isSpotifyId("")).toBe(false);
    expect(isSpotifyId(null)).toBe(false);
  });

  test("pulls the id out of every link shape users paste", () => {
    const id = "37i9dQZF1DX0XUsuxWHRQd";
    expect(
      extractSpotifyId(`https://open.spotify.com/playlist/${id}?si=x`),
    ).toBe(id);
    expect(extractSpotifyId(`spotify:playlist:${id}`)).toBe(id);
    expect(
      extractSpotifyId(`https://open.spotify.com/embed/playlist/${id}`),
    ).toBe(id);
    expect(extractSpotifyId(`https://open.spotify.com/?playlist=${id}`)).toBe(
      id,
    );
    expect(
      extractSpotifyId("https://open.spotify.com/playlist/nope"),
    ).toBeNull();
  });

  test("the detector and the id extractor agree on a real link", () => {
    const url = "https://open.spotify.com/playlist/37i9dQZF1DX0XUsuxWHRQd";
    expect(detectServiceUrl(url)?.id).toBe(extractSpotifyId(url));
  });
});

describe("Spotify authorisation needs no secret", () => {
  test("the authorize URL carries a PKCE challenge and no secret", () => {
    const url = buildAuthorizeUrl({
      clientId: "public-client-id",
      redirectUri: "https://synq.example/settings",
      challenge: "CHALLENGE",
      verifier: "verifier",
    });
    expect(url).toContain("code_challenge_method=S256");
    expect(url).toContain("code_challenge=CHALLENGE");
    expect(url).toContain("client_id=public-client-id");
    expect(url).not.toContain("client_secret");
  });

  test("it only asks for read access to playlists", () => {
    for (const scope of SPOTIFY_SCOPES) expect(scope).toMatch(/^playlist-read/);
    expect(SPOTIFY_SCOPES).not.toContain("playlist-modify-public");
    expect(SPOTIFY_SCOPES).not.toContain("playlist-modify-private");
  });

  test("a refusal is told apart from a missing code", () => {
    // Treating "the user pressed Cancel" as a missing code is what turns a
    // deliberate refusal into a confusing retry loop.
    expect(
      readAuthCallback("https://app/settings?error=access_denied"),
    ).toEqual({
      ok: false,
      reason: "denied",
    });
    expect(readAuthCallback("https://app/settings?code=abc")).toEqual({
      ok: true,
      code: "abc",
    });
    expect(readAuthCallback("not a url")).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("no credential material can reach the browser", () => {
  const client = readSource("src/components/settings/ImportSection.tsx");
  const spotify = readSource("src/convex/spotify.ts");
  const apple = readSource("src/convex/appleMusic.ts");

  test("the client never references a secret", () => {
    expect(client).not.toContain("SPOTIFY_CLIENT_SECRET");
    expect(client).not.toContain("APPLE_MUSIC_PRIVATE_KEY");
    expect(client).not.toContain("APPLE_MUSIC_TEAM_ID");
    // The PKCE verifier lives in sessionStorage for exactly one redirect.
    expect(client).toContain("sessionStorage.setItem(PKCE_KEY, verifier)");
    expect(client).toContain("sessionStorage.removeItem(PKCE_KEY)");
    expect(client).not.toContain("localStorage.setItem(PKCE_KEY");
  });

  test("the Spotify secret is read on the server, and only there", () => {
    expect(spotify).toContain("process.env.SPOTIFY_CLIENT_SECRET");
    expect(client).not.toContain("process.env");
  });

  test("the Apple private key never leaves the server", () => {
    expect(apple).toContain("process.env.APPLE_MUSIC_PRIVATE_KEY");
    expect(client).not.toContain("APPLE_MUSIC");
  });

  test("an unconfigured importer says so instead of failing obscurely", () => {
    expect(spotify).toContain('throw new ImportError("not-configured")');
    expect(apple).toContain('throw new ImportError("not-configured")');
  });
});

describe("the import UI can never get stuck loading", () => {
  const client = readSource("src/components/settings/ImportSection.tsx");
  const flat = client.replace(/\s+/g, " ");

  test("every phase is terminal one way or the other", () => {
    for (const kind of ["idle", "working", "done", "failed"]) {
      expect(flat).toContain(`kind: "${kind}"`);
    }
  });

  test("a failure always renders and a retryable one offers a way out", () => {
    expect(flat).toContain("phase.failure.retryable");
    expect(flat).toContain("<RotateCcw");
  });

  test("the detection badge is driven by the shared detector", () => {
    expect(client).toContain("detectServiceUrl");
    expect(client).toContain("importerFor");
    expect(flat).toContain("detected");
  });

  test("the import routes through the shared model, not ad-hoc shapes", () => {
    expect(client).toContain("toStoredTracks");
    expect(client).toContain("describeOutcome");
    expect(client).toContain("summarizeOutcome");
  });

  test("every service is saved through the one existing mutation", () => {
    // One playlist system, not a parallel one.
    expect(client).toContain("api.playlists.saveImported");
    expect(client).not.toMatch(/api\.playlists\.(create|add)/);
  });
});
