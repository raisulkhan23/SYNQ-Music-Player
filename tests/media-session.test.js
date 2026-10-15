import { beforeEach, describe, expect, test, vi } from "vitest";
import { Window } from "happy-dom";

/**
 * The media-session layer, which is what puts SYNQ on the lock screen and what
 * starts the Android foreground service that keeps the WebView (and therefore
 * the music) alive once the app is backgrounded.
 *
 * Two failure modes are worth a test rather than a device:
 *
 * 1. Duplicate writers. The layer caches what it last published precisely so a
 *    re-render cannot re-send it. If that dedupe breaks, every track change
 *    posts twice and every action gets registered twice — which is how one
 *    "next" press from a headset skips two songs.
 * 2. An accessory taking down playback. Every bridge call must be swallowed; a
 *    plugin that throws must cost the lock-screen card, not the music.
 */

const bridge = {
  metadata: [],
  states: [],
  positions: [],
  handlers: new Map(),
  failNext: null,
};

vi.mock("@capgo/capacitor-media-session", () => ({
  MediaSession: {
    setMetadata: (options) => {
      if (bridge.failNext === "metadata") {
        return Promise.reject(new Error("bridge down"));
      }
      bridge.metadata.push(options);
      return Promise.resolve();
    },
    setPlaybackState: (options) => {
      if (bridge.failNext === "state") {
        return Promise.reject(new Error("bridge down"));
      }
      bridge.states.push(options.playbackState);
      return Promise.resolve();
    },
    setPositionState: (options) => {
      if (bridge.failNext === "position") {
        return Promise.reject(new Error("bridge down"));
      }
      bridge.positions.push(options);
      return Promise.resolve();
    },
    setActionHandler: (options, handler) => {
      if (!options || typeof options.action !== "string") {
        throw new Error(`unsupported action ${String(options?.action)}`);
      }
      bridge.handlers.set(options.action, handler);
      return Promise.resolve();
    },
  },
}));

let win;
let session;

beforeEach(async () => {
  bridge.metadata.length = 0;
  bridge.states.length = 0;
  bridge.positions.length = 0;
  bridge.handlers.clear();
  bridge.failNext = null;

  win = new Window({ url: "https://example.test/" });
  globalThis.window = win;
  globalThis.document = win.document;
  // Node 24 exposes `globalThis.navigator` as a getter-only property, so a
  // plain assignment throws. The layer does not actually need it (the shell
  // check below is what makes the session "available"), so this is best-effort.
  try {
    Object.defineProperty(globalThis, "navigator", {
      value: win.navigator,
      configurable: true,
      writable: true,
    });
  } catch {
    /* keep Node's own navigator */
  }
  // A packaged native shell: the plugin IS the media session there, whatever
  // the simulated DOM does or does not implement.
  win.Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => "android",
  };

  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  // Fresh module per test: the layer memoises what it published, and that state
  // is exactly what these tests are about.
  vi.resetModules();
  session = await import("../src/lib/mediaSession.ts");
});

const track = {
  title: "Nightfall Drive",
  artistName: "Vector Bloom",
  albumName: "Neon Atlas",
  coverUrl: "https://cdn.example.test/cover.jpg",
};

describe("now-playing metadata", () => {
  test("publishes title, artist, album and every artwork size", () => {
    session.publishTrackMetadata(track);
    expect(bridge.metadata).toHaveLength(1);
    expect(bridge.metadata[0].title).toBe("Nightfall Drive");
    expect(bridge.metadata[0].artist).toBe("Vector Bloom");
    expect(bridge.metadata[0].album).toBe("Neon Atlas");
    expect(bridge.metadata[0].artwork.map((a) => a.sizes)).toEqual([
      "96x96",
      "256x256",
      "512x512",
    ]);
    expect(bridge.metadata[0].artwork[0].src).toBe(track.coverUrl);
  });

  test("does not re-send the same track", () => {
    session.publishTrackMetadata(track);
    session.publishTrackMetadata({ ...track });
    session.publishTrackMetadata({ ...track, coverUrl: track.coverUrl });
    expect(bridge.metadata).toHaveLength(1);
  });

  test("sends again when the track changes, including a new cover only", () => {
    session.publishTrackMetadata(track);
    session.publishTrackMetadata({ ...track, title: "Other" });
    session.publishTrackMetadata({ ...track, coverUrl: "https://cdn/x.jpg" });
    expect(bridge.metadata).toHaveLength(3);
  });

  test("falls back to SYNQ as the album and sends no artwork without a cover", () => {
    session.publishTrackMetadata({ title: "T", artistName: "A" });
    expect(bridge.metadata[0].album).toBe("SYNQ");
    expect(bridge.metadata[0].artwork).toEqual([]);
  });

  test("clearing takes the metadata down and lets the same track be re-sent", () => {
    session.publishTrackMetadata(track);
    session.publishTrackMetadata(null);
    expect(bridge.metadata).toHaveLength(2);
    expect(bridge.metadata[1].title).toBe("");
    // Playing the same song again after a stop must show it again.
    session.publishTrackMetadata(track);
    expect(bridge.metadata).toHaveLength(3);
  });
});

describe("transport state", () => {
  test("publishes playing / paused / none once each", () => {
    session.publishPlaybackState("playing");
    session.publishPlaybackState("playing");
    session.publishPlaybackState("paused");
    session.publishPlaybackState("none");
    expect(bridge.states).toEqual(["playing", "paused", "none"]);
  });
});

describe("position state", () => {
  test("is not published without a usable duration", () => {
    session.publishPosition({ duration: 0, position: 5, rate: 1 });
    session.publishPosition({ duration: NaN, position: 5, rate: 1 });
    expect(bridge.positions).toHaveLength(0);
  });

  test("clamps a position that overshoots the track", () => {
    session.publishPosition({ duration: 200, position: 900, rate: 1 });
    expect(bridge.positions[0]).toMatchObject({ duration: 200, position: 200 });
  });

  test("is throttled to roughly once a second", () => {
    session.publishPosition({ duration: 200, position: 1, rate: 1 });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.250Z"));
    session.publishPosition({ duration: 200, position: 1.25, rate: 1 });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.900Z"));
    session.publishPosition({ duration: 200, position: 1.9, rate: 1 });
    expect(bridge.positions).toHaveLength(1);

    vi.setSystemTime(new Date("2026-01-01T00:00:01.100Z"));
    session.publishPosition({ duration: 200, position: 2.1, rate: 1 });
    expect(bridge.positions).toHaveLength(2);
  });

  test("a new track's duration is published immediately, throttle or not", () => {
    session.publishPosition({ duration: 200, position: 1, rate: 1 });
    vi.setSystemTime(new Date("2026-01-01T00:00:00.200Z"));
    session.publishPosition({ duration: 240, position: 0, rate: 1 });
    expect(bridge.positions).toHaveLength(2);
    expect(bridge.positions[1]).toMatchObject({ duration: 240, position: 0 });
  });
});

describe("remote controls", () => {
  const handlers = () => ({
    play: vi.fn(),
    pause: vi.fn(),
    nexttrack: vi.fn(),
    previoustrack: vi.fn(),
    seekbackward: vi.fn(),
    seekforward: vi.fn(),
    seekto: vi.fn(),
    stop: vi.fn(),
  });

  test("registers every action exactly once, even if called again", () => {
    const h = handlers();
    session.registerMediaSessionActions(h);
    session.registerMediaSessionActions(handlers());
    expect([...bridge.handlers.keys()].sort()).toEqual([
      "nexttrack",
      "pause",
      "play",
      "previoustrack",
      "seekbackward",
      "seekforward",
      "seekto",
      "stop",
    ]);
    // The SECOND registration's handlers must not have replaced the first's.
    bridge.handlers.get("nexttrack")({});
    expect(h.nexttrack).toHaveBeenCalledTimes(1);
  });

  test("relative seeks use a 10 second step and absolute seeks honour seekTime", () => {
    const h = handlers();
    session.registerMediaSessionActions(h);
    bridge.handlers.get("seekbackward")({});
    bridge.handlers.get("seekforward")({});
    bridge.handlers.get("seekto")({ seekTime: 42.5 });
    // A seekto with no usable time is dropped rather than seeking to NaN.
    bridge.handlers.get("seekto")({ seekTime: undefined });
    expect(h.seekbackward).toHaveBeenCalledWith(10);
    expect(h.seekforward).toHaveBeenCalledWith(10);
    expect(h.seekto).toHaveBeenCalledTimes(1);
    expect(h.seekto).toHaveBeenCalledWith(42.5);
  });

  test("a handler that throws cannot escape into the platform", () => {
    const h = handlers();
    h.play.mockImplementation(() => {
      throw new Error("player exploded");
    });
    session.registerMediaSessionActions(h);
    expect(() => bridge.handlers.get("play")({})).not.toThrow();
  });

  test("stop ends the session while the user's play is honoured", () => {
    const h = handlers();
    session.registerMediaSessionActions(h);
    bridge.handlers.get("stop")({});
    expect(h.stop).toHaveBeenCalledTimes(1);
  });
});

describe("audio route loss", () => {
  test("a lost route reaches the handler, and only once per event", () => {
    const onLost = vi.fn();
    session.registerAudioRouteLossHandler(onLost);
    win.dispatchEvent(new win.CustomEvent(session.AUDIO_ROUTE_LOST_EVENT));
    expect(onLost).toHaveBeenCalledTimes(1);
    win.dispatchEvent(new win.CustomEvent(session.AUDIO_ROUTE_LOST_EVENT));
    expect(onLost).toHaveBeenCalledTimes(2);
  });

  test("registering twice does not double-pause on one unplug", () => {
    const first = vi.fn();
    const second = vi.fn();
    session.registerAudioRouteLossHandler(first);
    session.registerAudioRouteLossHandler(second);

    win.dispatchEvent(new win.CustomEvent(session.AUDIO_ROUTE_LOST_EVENT));

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  test("a throwing handler cannot escape into the platform", () => {
    session.registerAudioRouteLossHandler(() => {
      throw new Error("player exploded");
    });
    expect(() =>
      win.dispatchEvent(new win.CustomEvent(session.AUDIO_ROUTE_LOST_EVENT)),
    ).not.toThrow();
  });
});

describe("resilience", () => {
  test("a rejected bridge call never throws into playback", async () => {
    bridge.failNext = "state";
    expect(() => session.publishPlaybackState("playing")).not.toThrow();
    bridge.failNext = "metadata";
    expect(() => session.publishTrackMetadata(track)).not.toThrow();
    bridge.failNext = "position";
    expect(() =>
      session.publishPosition({ duration: 10, position: 1, rate: 1 }),
    ).not.toThrow();
    // Let the swallowed rejections settle: an unhandled one fails this test.
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.states).toHaveLength(0);
  });
});
