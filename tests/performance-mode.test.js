import { describe, expect, test } from "bun:test";
import { compileClasses, readSource } from "./helpers/tailwind-css.js";

const cssSource = readSource("src/index.css");
const storeSource = readSource("src/store/player.ts");
const mainSource = readSource("src/main.tsx");
const shellSource = readSource("src/components/layout/AppShell.tsx");
const fullscreenSource = readSource(
  "src/components/player/FullscreenPlayer.tsx",
);
const visualizerSource = readSource(
  "src/components/player/VisualizerCanvas.tsx",
);
const landingSource = readSource("src/pages/Landing.tsx");
const settingsSource = readSource("src/components/settings/SettingsDialog.tsx");

/** The `html.perf-lite` rules exactly as the browser receives them. Testing the
 *  compiled output is the point: the previous version of this file asserted on
 *  the stylesheet source and passed while the mode did nothing, because the
 *  rules it named were the wrong ones. */
const compiledCss = await compileClasses([]);

const perfRule = (needle) => {
  const rule = compiledCss
    .split("}")
    .find((part) => part.includes("perf-lite") && part.includes(needle));
  return rule ? `${rule}}` : "";
};

describe("performance mode is a real, persisted switch", () => {
  test("the store owns the flag and persists it", () => {
    expect(storeSource).toMatch(/performanceMode: boolean;/);
    expect(storeSource).toMatch(/togglePerformanceMode: \(\) => void;/);
    expect(storeSource).toMatch(/readBool\("ss\.performanceMode", false\)/);
    // Whitespace-tolerant: prettier wraps this call across lines, and a source
    // assertion should track the code, not the formatter's line width. The
    // write goes through the guarded `writeSetting` helper so a full or
    // blocked localStorage cannot make the toggle a no-op.
    expect(storeSource).toMatch(/writeSetting\(\s*"ss\.performanceMode"/);
  });

  test("the class is applied at the app root, not only inside the shell", () => {
    // Landing, Auth, Support/Privacy/Terms and NotFound render outside
    // AppShell, and they carry the heaviest decorations. A class only the
    // signed-in shell ever set left every one of them at full cost.
    expect(mainSource).toMatch(
      /document\.documentElement\.classList\.toggle\("perf-lite", performanceMode\)/,
    );
    expect(mainSource).toMatch(/<PerformanceModeSync \/>/);
    expect(shellSource).not.toMatch(/classList\.toggle\("perf-lite"/);
  });

  test("a returning user gets it before the first paint", () => {
    // Restoring it in an effect means one full frame of the expensive layers
    // before the mode engages.
    expect(mainSource).toMatch(
      /localStorage\.getItem\("ss\.performanceMode"\) === "1"[\s\S]{0,120}classList\.add\("perf-lite"\)/,
    );
  });

  test("it is reachable in settings and survives a visual reset", () => {
    expect(settingsSource).toMatch(/label="Performance mode"/);
    expect(settingsSource).toMatch(/on=\{performanceMode\}/);
    expect(settingsSource).toMatch(/togglePerformanceMode\(\);/);
    // "Reset visual preferences" must not silently leave the heavy mode on.
    expect(settingsSource).toMatch(
      /if \(performanceMode\) togglePerformanceMode\(\);/,
    );
    expect(settingsSource).toMatch(
      /localStorage\.setItem\("ss\.performanceMode", "0"\)/,
    );
  });
});

describe("the compiled mode actually switches the work off", () => {
  test("every backdrop-filter goes, not just the named panel classes", () => {
    // The named list missed every surface that gets its blur from a plain
    // Tailwind utility: `backdrop-blur-xl` on the player bar, the queue panel,
    // the landing hero, the auth card and the admin header.
    const rule = perfRule("backdrop-filter:none");
    expect(rule).not.toBe("");
    expect(rule).toMatch(/html\.perf-lite \*/);
    expect(rule).toMatch(/:is\(|:before|:after/);
    expect(rule).toMatch(/backdrop-filter:none!important/);
  });

  test("animations and transitions go everywhere too", () => {
    const rule = perfRule("animation:none");
    expect(rule).toMatch(/animation:none!important/);
    expect(rule).toMatch(/transition:none!important/);
  });

  test("the busy indicator keeps spinning", () => {
    // The blanket rule also stops `animate-spin`, and a loader frozen on one
    // frame reads as a permanent hang rather than as a fast device. All 25
    // spinners in the product depend on it.
    const rule = perfRule("animate-spin");
    expect(rule).toMatch(/html\.perf-lite \.animate-spin\{/);
    // Lightning CSS normalises the shorthand and puts the name last.
    expect(rule).toMatch(/animation:1s linear infinite spin!important/);
    // Scoped to the spinner only, and it has to outrank the `*` rule.
    expect(rule).not.toContain("html.perf-lite *");
  });

  test("large blur filters are dropped, including the Tailwind blur utilities", () => {
    // `blur-3xl` on the aurora blobs and the auth/landing decor is a
    // full-element filter on a layer big enough to matter.
    // NB: not `filter:none` as the needle — that substring also occurs inside
    // `backdrop-filter:none` in the first rule.
    const rule = perfRule("perf-wallpaper-blur");
    // Lightning CSS minifies the attribute selector and drops its quotes.
    const unquoted = rule.replace(/"/g, "");
    expect(unquoted).toContain(":is([class*=blur-sm]");
    expect(unquoted).toContain("[class*=blur-3xl]");
    expect(rule).toMatch(/html\.perf-lite \.perf-wallpaper-blur/);
    expect(rule).toMatch(/filter:none!important/);
    expect(shellSource).toContain("perf-wallpaper-blur");
    expect(fullscreenSource).toContain("perf-wallpaper-blur");
  });

  test("the moving glass sheen is removed, not just paused", () => {
    // `animation: none` would freeze the 420% gradient band on one frame,
    // which reads as a flat tint across every panel.
    const rule = perfRule("content:none");
    expect(rule).toMatch(/\.liquid-glass:before/);
    expect(rule).toMatch(/\.settings-liquid-glass:before/);
    expect(rule).toMatch(/content:none!important/);
  });

  test("the layers that exist only to be pretty are hidden outright", () => {
    const rule = perfRule("display:none");
    for (const selector of [
      ".aurora-orb",
      ".ambient-grid",
      ".pointer-glow",
      ".cursor-trail-layer",
      ".click-ripple",
    ]) {
      expect(rule).toContain(selector);
    }
    expect(rule).toMatch(/display:none!important/);
  });
});

describe("performance mode stops the frame loops CSS cannot reach", () => {
  test("the shell stops handling pointer events and stops the trail", () => {
    // CSS alone would leave a rAF loop and five style writes per frame running
    // for a layer nobody can see.
    expect(shellSource).toMatch(
      /const pointerFx = pointerEffects && !performanceMode;/,
    );
    expect(shellSource).not.toMatch(
      /if \(!pointerEffects \|\| event\.pointerType === "touch"\) return;/,
    );
    expect(shellSource).toMatch(
      /if \(!pointerFx \|\| !rippleLayerRef\.current\) return;/,
    );
    expect(shellSource).toMatch(
      /if \(performanceMode\) cursorTrailRef\.current\?\.stop\(\);/,
    );
  });

  test("the fullscreen player does the same", () => {
    expect(fullscreenSource).toMatch(
      /const pointerFx = pointerEffects && !performanceMode;/,
    );
    // Whitespace-tolerant: the guard wraps across lines, which is formatting.
    expect(fullscreenSource).toMatch(
      /if \(\s*!pointerFx \|\| event\.pointerType === "touch" \|\| !rippleLayerRef\.current\s*\)\s*return;/,
    );
  });

  test("the canvas visualizer stops repainting", () => {
    // A canvas redraws from a rAF loop; no stylesheet rule reaches it, so this
    // is the loop that kept a phone hot even with every effect hidden. The
    // landing page's decorative demo canvas was removed, so the player's
    // visualizer is the only one left to park.
    expect(visualizerSource).toMatch(
      /if \(!canvas \|\| !visualizerEnabled \|\| !active \|\| performanceMode\) return;/,
    );
    expect(visualizerSource).toMatch(
      /if \(!visualizerEnabled \|\| performanceMode\) return null;/,
    );
    expect(landingSource).not.toContain("requestAnimationFrame");
    expect(landingSource).not.toContain("getContext");
  });

  test("a video wallpaper stops decoding", () => {
    // A full-screen looping video is a per-frame decode; pausing keeps the
    // first frame on screen and gives the decoder back to the music.
    expect(shellSource).toMatch(
      /if \(fullscreen \|\| isBuffering \|\| performanceMode\) \{/,
    );
    expect(shellSource).toMatch(
      /\[fullscreen, isBuffering, performanceMode, wallpaper, wallpaperType\]/,
    );
  });

  test("framer-motion animations are switched off at the root", () => {
    // framer-motion animates from JavaScript, so the `animation: none` blanket
    // rule never reached the hero, the queue panel or the sidebar.
    expect(mainSource).toMatch(
      /import \{ MotionConfig \} from "framer-motion"/,
    );
    // The value is computed now rather than inlined: performance mode (and
    // motion Off) stop framer-motion outright, Reduced defers to the OS
    // preference, and anything else runs full.
    expect(mainSource).toMatch(
      /<MotionConfig reducedMotion=\{reducedMotion\}>/,
    );
    expect(mainSource).toMatch(
      /performanceMode \|\| animationLevel === "off"[\s\S]{0,80}?"always"/,
    );
    expect(mainSource).toMatch(/<MotionPrefs>/);
  });
});
