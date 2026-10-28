import { describe, expect, test } from "bun:test";
import { readSource } from "./helpers/tailwind-css.js";

const store = readSource("src/store/player.ts");
const fullscreen = readSource("src/components/player/FullscreenPlayer.tsx");
const settings = readSource("src/components/settings/SettingsDialog.tsx");

describe("the maximized player can turn video on and off", () => {
  test("the in-player switch is separate from the synced setting", () => {
    // The bug: the button read its state from `videoEnabled` — the persisted,
    // cross-device "Video preview" preference — and toggled it. Turning video
    // off in the player therefore turned the FEATURE off, which both hid the
    // button (it was rendered only while `videoEnabled` was true) and pushed
    // the change to every other device. Video could be turned off from the
    // maximized player but never back on without opening Settings.
    expect(store).toMatch(/videoVisible: boolean;/);
    expect(store).toMatch(/toggleVideoVisible: \(\) => void;/);
    expect(store).toMatch(/videoVisible: true,/);
    expect(store).toMatch(/toggleVideoVisible: \(\) =>/);
    // Session state is NOT a synced preference: pushing it into the server
    // blob would make one device's "hide the picture" fight another's.
    expect(store.includes("videoVisible") && store.includes("ss.videoVisible")).toBe(
      false,
    );
  });

  test("the picture shows only when both the setting and the switch allow it", () => {
    expect(fullscreen).toMatch(
      /const showVideo = videoEnabled && videoVisible;/,
    );
    expect(fullscreen).toMatch(/isYoutube && showVideo \?/);
    // The overlay effect must also stop presenting when the picture is hidden,
    // otherwise the fixed-position player stays on screen with no frame.
    expect(fullscreen).toMatch(
      /if \(!fullscreen \|\| !current \|\| !showVideo\) return;/,
    );
    expect(fullscreen).toMatch(
      /\}, \[fullscreen, current, showVideo, isYoutube, audioFilter\]\);/,
    );
  });

  test("the button stays put while video is hidden, so it can turn back on", () => {
    // Gated on the SETTING (is the feature allowed?) and never on the picture
    // state — that gate is what made the old button disappear after one press.
    const button = fullscreen.slice(
      fullscreen.indexOf("Turn the picture on/off"),
      fullscreen.indexOf("</button>", fullscreen.indexOf("Turn the picture on/off")),
    );
    expect(button).toMatch(/\{videoEnabled && isYoutube && \(/);
    expect(button).not.toMatch(/\{videoVisible &&/);
    expect(button).toMatch(/onClick=\{\(\) => toggleVideoVisible\(\)\}/);
    expect(button).toMatch(/aria-pressed=\{videoVisible\}/);
    expect(button).toMatch(/\{videoVisible \? "Video on" : "Video off"\}/);
  });

  test("the label names the action in both states", () => {
    expect(fullscreen).toMatch(
      /title=\{videoVisible \? "Hide video" : "Show video"\}/,
    );
  });

  test("the audio-effect video slave follows the same switch", () => {
    // With an effect active the picture comes from the muted visual slave, so
    // hiding video must stop it too — otherwise the engine keeps decoding a
    // video nobody can see.
    const slave = store.slice(
      store.indexOf("const wantSlave ="),
      store.indexOf("const wantSlave =") + 400,
    );
    expect(slave).toMatch(/s\.fullscreen &&/);
    expect(slave).toMatch(/s\.videoEnabled &&/);
    expect(slave).toMatch(/s\.videoVisible &&/);
  });

  test("turning the setting back on shows the picture again", () => {
    // A "hidden" session flag must not survive the permission being switched
    // off and on: Settings would say video is on while the player showed art.
    const toggle = store.slice(
      store.indexOf("toggleVideo: () =>"),
      store.indexOf("videoVisible: true,"),
    );
    expect(toggle).toMatch(/return \{ videoEnabled: next, videoVisible: next \? true : state\.videoVisible \};/);
  });

  test("settings still describes the master switch", () => {
    expect(settings).toMatch(/label="Video preview"/);
    expect(settings).toMatch(/The player has its own Video button/);
  });
});
