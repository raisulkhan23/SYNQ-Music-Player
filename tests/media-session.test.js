import { beforeEach, describe, expect, mock, test } from "bun:test";
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
  handlersFail: false,
  handlers: new Map(),
  failNext: null,
};

// bun's equivalent of a module mock, registered before the module under test
// is imported below.
mock.module("@capgo/capacitor-media-session", () => ({
  MediaSession: {
    setMetadata: (options) => {
      if (bridge.failNext === "metadata") {
        bridge.failNext = null;
        return Promise.reject(new Error("bridge down"));
      }
      bridge.metadata.push(options);
      return Promise.resolve();
    },
    setPlaybackState: (options) => {
      if (bridge.failNext === "state") {
        bridge.failNext = null;
        return Promise.reject(new Error("bridge down"));
      }
      bridge.states.push(options.playbackState);
      return Promise.resolve();
    },
    setPositionState: (options) => {
      if (bridge.failNext === "position") {
        bridge.failNext = null;
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

const session = await import("../src/lib/mediaSession.ts");

let win;

beforeEach(() => {
  bridge.metadata.length = 0;
  bridge.states.length = 0;
  bridge.positions.length = 0;
  bridge.handlers.clear();
  bridge.failNext = null;

  win = new Window({ url: "https://example.test/" });
  globalThis.window = win;
  globalThis.document = win.document;
  // Node exposes `globalThis.navigator` as a getter-only property, so a plain
  // assignment throws. The layer does not actually need it (the shell check
  // below is what makes the session "available"), so this is best-effort.
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

  // Fresh publish state per test: the layer memoises what it published, and
  // that state is exactly what these tests are about.
  session.__resetMediaSessionForTests();
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
    const realNow = Date.now;
    let now = Date.parse("2026-01-01T00:00:00Z");
    Date.now = () => now;
    try {
      session.publishPosition({ duration: 200, position: 1, rate: 1 });
      now = Date.parse("2026-01-01T00:00:00.250Z");
      session.publishPosition({ duration: 200, position: 1.25, rate: 1 });
      now = Date.parse("2026-01-01T00:00:00.900Z");
      session.publishPosition({ duration: 200, position: 1.9, rate: 1 });
      expect(bridge.positions).toHaveLength(1);

      now = Date.parse("2026-01-01T00:00:01.100Z");
      session.publishPosition({ duration: 200, position: 2.1, rate: 1 });
      expect(bridge.positions).toHaveLength(2);
    } finally {
      Date.now = realNow;
    }
  });

  test("a new track's duration is published immediately, throttle or not", () => {
    const realNow = Date.now;
    let now = Date.parse("2026-01-01T00:00:00Z");
    Date.now = () => now;
    try {
      session.publishPosition({ duration: 200, position: 1, rate: 1 });
      now = Date.parse("2026-01-01T00:00:00.200Z");
      session.publishPosition({ duration: 240, position: 0, rate: 1 });
      expect(bridge.positions).toHaveLength(2);
      expect(bridge.positions[1]).toMatchObject({ duration: 240, position: 0 });
    } finally {
      Date.now = realNow;
    }
  });
});

describe("remote controls", () => {
  const handlers = () => ({
    play: () => void 0,
    pause: () => void 0,
    nexttrack: () => void 0,
    previoustrack: () => void 0,
    seekbackward: () => void 0,
    seekforward: () => void 0,
    seekto: () => void 0,
    stop: () => void 0,
  });
  const callsOf = () => {
    const counts = {};
    for (const key of Object.keys(handlers())) counts[key] = 0;
    return { counts, bump: (name) => void counts[name]++ };
  };

  test("registers every action exactly once, even if called again", () => {
    const first = callsOf();
    session.registerMediaSessionActions(
      Object.fromEntries(
        Object.keys(first.counts).map((name) => [name, () => first.bump(name)]),
      ),
    );
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
    expect(first.counts.nexttrack).toBe(1);
  });

  test("relative seeks use a 10 second step and absolute seeks honour seekTime", () => {
    const calls = { backward: 0, forward: 0, absolute: [], droppedWithNoTime: 0 };
    session.registerMediaSessionActions({
      ...handlers(),
      seekbackward: (seconds) => void (calls.backward = seconds),
      seekforward: (seconds) => void (calls.forward = seconds),
      seekto: (seconds) => void calls.absolute.push(seconds),
    });
    bridge.handlers.get("seekbackward")({});
    bridge.handlers.get("seekforward")({});
    bridge.handlers.get("seekto")({ seekTime: 42.5 });
    // A seekto with no usable time is dropped rather than seeking to NaN.
    bridge.handlers.get("seekto")({ seekTime: undefined });
    expect(calls.backward).toBe(10);
    expect(calls.forward).toBe(10);
    expect(calls.absolute).toEqual([42.5]);
  });

  test("a handler that throws cannot escape into the platform", () => {
    session.registerMediaSessionActions({
      ...handlers(),
      play: () => {
        throw new Error("player exploded");
      },
    });
    expect(() => bridge.handlers.get("play")({})).not.toThrow();
  });

  test("stop ends the session while the user's play is honoured", () => {
    let stops = 0;
    session.registerMediaSessionActions({
      ...handlers(),
      stop: () => void stops++,
    });
    bridge.handlers.get("stop")({});
    expect(stops).toBe(1);
  });
});

describe("audio route loss", () => {
  test("a lost route reaches the handler, and only once per event", () => {
    let hits = 0;
    session.registerAudioRouteLossHandler(() => void hits++);
    win.dispatchEvent(new win.CustomEvent(session.AUDIO_ROUTE_LOST_EVENT));
    expect(hits).toBe(1);
    win.dispatchEvent(new win.CustomEvent(session.AUDIO_ROUTE_LOST_EVENT));
    expect(hits).toBe(2);
  });

  test("registering twice does not double-pause on one unplug", () => {
    let first = 0;
    let second = 0;
    session.registerAudioRouteLossHandler(() => void first++);
    session.registerAudioRouteLossHandler(() => void second++);

    win.dispatchEvent(new win.CustomEvent(session.AUDIO_ROUTE_LOST_EVENT));

    expect(first).toBe(1);
    expect(second).toBe(0);
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

// ---------------------------------------------------------------------------
// The Android half of the chain is native code this runner cannot execute, so
// the invariants below are checked statically — the same way the rest of this
// suite verifies build configuration. They are the failure modes that would
// otherwise only surface on a device.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p) => readFileSync(join(import.meta.dir, "..", p), "utf8");

const manifest = read(
  "android/app/src/main/AndroidManifest.xml",
);
const mainActivity = read(
  "android/app/src/main/java/com/synq/music/MainActivity.java",
);
const routeLoss = read(
  "android/app/src/main/java/com/synq/music/AudioRouteLossReceiver.java",
);
const playerStore = read("src/store/player.ts");
const playerBar = read("src/components/player/PlayerBar.tsx");

describe("Android manifest background-playback declarations", () => {
  test("the mediaPlayback foreground service permissions are declared", () => {
    for (const permission of [
      "FOREGROUND_SERVICE",
      "FOREGROUND_SERVICE_MEDIA_PLAYBACK",
      "WAKE_LOCK",
      "POST_NOTIFICATIONS",
    ]) {
      expect(manifest).toContain(
        `android.permission.${permission}`,
      );
    }
  });

  test("POST_NOTIFICATIONS is declared once and never requested at runtime", () => {
    // Media-session notifications are exempt from the runtime permission, and
    // nothing else here needs one — there is no `requestPermissions` call in
    // the app's own Android sources.
    expect(
      manifest.match(
        /<uses-permission android:name="android\.permission\.POST_NOTIFICATIONS" \/>/g,
      ),
    ).toHaveLength(1);
    expect(mainActivity).not.toContain("requestPermission");
  });
});

describe("MainActivity audio-route receiver", () => {
  test("receives AUDIO_BECOMING_NOISY with the receiver not exported", () => {
    expect(mainActivity).toContain("ACTION_AUDIO_BECOMING_NOISY");
    expect(mainActivity).toContain("RECEIVER_NOT_EXPORTED");
  });

  test("a registration failure must not stop the app from launching", () => {
    // The receiver is registered inside onCreate, wrapped so any failure is a
    // lost unplug-pause — never a crashed launch.
    const onCreate = mainActivity.slice(
      mainActivity.indexOf("public void onCreate"),
      mainActivity.indexOf("private void registerRouteLossReceiver"),
    );
    expect(onCreate).toContain("registerRouteLossReceiver()");
    expect(mainActivity).toMatch(/catch \(Exception error\)/);
  });

  test("the receiver is unregistered exactly once in onDestroy", () => {
    const onDestroy = mainActivity.slice(
      mainActivity.indexOf("public void onDestroy"),
    );
    expect(onDestroy).toContain("unregisterReceiver");
    expect(onDestroy.match(/unregisterReceiver/g)).toHaveLength(1);
  });
});

describe("AudioRouteLossReceiver", () => {
  test("it delivers the DOM event to the bridge and nothing more", () => {
    expect(routeLoss).toContain("triggerWindowJSEvent");
    expect(routeLoss).toContain("synqAudioRouteLost");
    // Route loss is only ever a pause signal: the receiver must not touch the
    // transport itself, resume anything, or change audio focus.
    expect(routeLoss).not.toMatch(/play\(|pause\(|audioFocus|startForeground/);
  });

  test("a throwing onReceive cannot take the process down", () => {
    expect(routeLoss).toMatch(/catch \(Exception error\)/);
  });
});

describe("the one media-session writer", () => {
  test("the player store publishes through the shared module", () => {
    expect(playerStore).toContain('from "@/lib/mediaSession"');
    expect(playerStore).toContain("registerAudioRouteLossHandler");
    // No second direct writer left in the store.
    expect(playerStore).not.toMatch(/navigator\.mediaSession/);
  });

  test("the lock-screen bar publishes through the shared module too", () => {
    expect(playerBar).toContain('from "@/lib/mediaSession"');
    // No raw metadata / playback-state / position writes left in the bar.
    expect(playerBar).not.toMatch(/new MediaMetadata/);
    expect(playerBar).not.toMatch(/\.metadata\s*=/);
    expect(playerBar).not.toMatch(/\.playbackState\s*=/);
    expect(playerBar).not.toMatch(/setPositionState/);
    // The one deliberate exception that predates this recovery: the
    // Safari/Bluetooth `playpause` action (not a standard Media Session
    // action, so the store's shared registration cannot provide it) still
    // registers transport handlers directly.
    expect(playerBar).toContain("setMediaSessionActionHandler");
  });

  test("the store maps remote controls onto the live store, not stale state", () => {
    const wiring = playerStore.slice(
      playerStore.indexOf("function wireMediaKeys"),
      playerStore.indexOf("// --- store ---"),
    );
    expect(wiring).toContain("registerMediaSessionActions");
    expect(wiring).toContain("usePlayerStore.getState()");
    expect(wiring).toContain('publishPlaybackState("none")');
  });

  test("the plugin is wired into the Gradle build", () => {
    expect(read("android/capacitor.settings.gradle")).toContain(
      "capgo-capacitor-media-session",
    );
    expect(read("android/app/capacitor.build.gradle")).toContain(
      'implementation project(\':capgo-capacitor-media-session\')',
    );
  });

  test("the packaged-shell webview is inspectable only when asked for", () => {
    expect(read("capacitor.config.ts")).toContain(
      'process.env.CAPACITOR_DEBUG_WEBVIEW === "1"',
    );
  });
});
