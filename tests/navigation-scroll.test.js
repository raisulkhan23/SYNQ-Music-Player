import { describe, expect, test } from "bun:test";
import { compileClasses, readSource } from "./helpers/tailwind-css.js";

const cssSource = readSource("src/index.css");

const scrollTopSource = readSource("src/components/ScrollToTop.tsx");
const shellSource = readSource("src/components/layout/AppShell.tsx");
const mainSource = readSource("src/main.tsx");
const footerSource = readSource("src/components/landing/SiteFooter.tsx");

describe("navigation scroll reset", () => {
  test("is actually mounted inside the router", () => {
    // Without this, deleting <ScrollToTop /> from the tree would leave every
    // other test in this file green while the reset silently stopped working.
    expect(mainSource).toContain(
      'import { ScrollToTop } from "@/components/ScrollToTop"',
    );
    expect(mainSource).toMatch(/<BrowserRouter>[\s\S]{0,400}<ScrollToTop \/>/);
  });

  test("resets the app shell scroll container, not just the document", () => {
    // `<main>` is the scroll container inside the shell, so a document-only
    // reset leaves you halfway down the next page. The two must stay in sync:
    // the component queries this attribute, AppShell must tag its element.
    expect(scrollTopSource).toContain("[data-app-scroll]");
    expect(shellSource).toMatch(/<main[\s\S]{0,200}data-app-scroll/);
    // Exactly one container: zero breaks the reset, two means something else
    // grew a second scroll container and is being reset on every navigation.
    // Counted on the element, not the raw string — the comment above `<main>`
    // names the attribute too.
    const tagged = shellSource.match(/<main[^>]*data-app-scroll/g) ?? [];
    expect(tagged.length).toBe(1);
  });

  test("the shell keeps no competing scroll-reset effect", () => {
    // Two resets on the same container is how the effect-based version ended
    // up fighting the paint; the single mechanism lives in ScrollToTop.
    expect(shellSource).not.toMatch(/mainScrollRef/);
    const scrollResets = shellSource.match(/scrollTo\(\{/g) ?? [];
    expect(scrollResets.length).toBe(0);
  });

  test("the reset is instant, not animated by the global smooth scrolling", () => {
    // `html { scroll-behavior: smooth }` and `.focus-study main` both make a
    // behaviour-less scrollTo animate, which slid the new page up from the old
    // offset instead of snapping to the top.
    expect(cssSource).toMatch(/html \{\s*[^}]*scroll-behavior: smooth/);
    const reset = scrollTopSource.match(
      /const resetToTop = [\s\S]*?\n    };/,
    )?.[0];
    expect(reset).toBeDefined();
    expect(reset).not.toMatch(/behavior: "smooth"/);
    expect(
      (
        reset.match(
          /scrollTo\(\{ top: 0, left: 0, behavior: "instant" \}\)/g,
        ) ?? []
      ).length,
    ).toBe(2);
  });

  test("resets immediately and again after paint", () => {
    // A single effect-time reset lost the race with the new route painting.
    expect(scrollTopSource).toContain("requestAnimationFrame");
    const scheduledFrames =
      scrollTopSource.match(/requestAnimationFrame/g) ?? [];
    expect(scheduledFrames.length).toBeGreaterThanOrEqual(2);
  });

  test("an in-page anchor wins over the top-of-page reset", () => {
    expect(scrollTopSource).toContain("scrollIntoView");
    expect(scrollTopSource).toMatch(/if \(!hash\) resetToTop\(\)/);
    expect(scrollTopSource).toMatch(
      /if \(!scrollToAnchor\(\)\) resetToTop\(\)/,
    );
  });

  test("re-running on the same path still resets (location.key in deps)", () => {
    const deps = scrollTopSource.match(/\[pathname, search, hash, key\]/);
    expect(deps).not.toBeNull();
  });
});

describe("footer featured-on badges", () => {
  test("every badge is outlined in white", () => {
    expect(footerSource).toContain("border border-white/75");
    expect(footerSource).toContain("hover:border-white");
  });

  test("the footer carries a real surface so it reads over a wallpaper", () => {
    // A 1.5%-white wash left the copy and badges to be read against whatever
    // photo the listener picked. The opaque-ish background keeps contrast the
    // same on the dark theme and on a bright wallpaper.
    expect(footerSource).toMatch(/<footer[^>]*bg-background\/80/);
    expect(footerSource).toMatch(/<footer[^>]*border-white\/15/);
    expect(footerSource).not.toMatch(/<footer[^>]*bg-white\/\[\?0\.015/);
    // No backdrop-filter: the footer is full-width and lives inside the
    // shell's scroll container, so a blur re-ran over the whole element on
    // every scroll frame. The surface alone carries the contrast.
    expect(footerSource).not.toMatch(/<footer[^>]*backdrop-blur/);
  });

  test("each badge declares a radius matching its own artwork", () => {
    const entries = [
      ...footerSource.matchAll(/name: "([^"]+)"[\s\S]*?radius: "([^"]+)"/g),
    ].map(([, name, radius]) => ({ name, radius }));
    // Wired Business was added to the strip; the count is asserted so a badge
    // cannot be silently dropped from the DATA while the markup still renders.
    expect(entries.length).toBe(5);
    for (const badge of entries) {
      expect(badge.radius).toMatch(/^rounded-(full|lg|xl)$/);
    }
    // The EasyLaunch badge is a pill; boxing it in a rectangle was the tell.
    const easyLaunch = entries.find((badge) => badge.name === "EasyLaunch");
    expect(easyLaunch?.radius).toBe("rounded-full");
  });

  test("the outline utilities actually compile to a visible keyline", async () => {
    const css = await compileClasses([
      "border",
      "border-white/75",
      "bg-background/80",
      "hover:border-white",
      "rounded-full",
      "rounded-lg",
      "rounded-xl",
    ]);
    // The emitted selector escapes the slash, so these are string matches:
    // `/\.border-white\/75/` would look for a bare `/` where the CSS has `\/`.
    expect(css).toMatch(/\.border\{[^}]*border-width:1px/);
    expect(css).toContain(".border-white\\/75{border-color:#ffffffbf");
    expect(css).toContain(".hover\\:border-white");
    expect(css).toContain(".bg-background\\/80{");
    expect(css).toMatch(/\.bg-background\\?\/80\{[^}]*background-color:/);
    expect(css).toMatch(/\.rounded-full\{[^}]*border-radius/);
    expect(css).toMatch(/\.rounded-lg\{[^}]*border-radius/);
    expect(css).toMatch(/\.rounded-xl\{[^}]*border-radius/);
  });
});
