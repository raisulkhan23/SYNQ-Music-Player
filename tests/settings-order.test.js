import { describe, expect, test } from 'vitest';
import { readSource } from "./helpers/tailwind-css.js";

const settingsSource = readSource("src/components/settings/SettingsDialog.tsx");
const flat = settingsSource.replace(/\s+/g, " ");

/** Index of a landmark in the rendered document. */
const at = (needle) => {
  const index = flat.indexOf(needle);
  if (index === -1) throw new Error(`not rendered: ${needle}`);
  return index;
};

const SECTIONS = [
  "settings-playback",
  "settings-audio",
  "settings-appearance",
  "settings-personalization",
  "settings-profile",
  "settings-shortcuts",
  "settings-app",
  "settings-data",
];

const css = readSource("src/index.css");

describe("settings sections are ordered by how often they are used", () => {
  test("the document renders them in the rail's order", () => {
    // The rail and the document used to disagree — the rail opened on
    // Playback while the page started on Profile — so the highlighted chip
    // pointed at a section that was not on screen.
    let previous = -1;
    for (const id of SECTIONS) {
      const index = at(`<section id="${id}"`);
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
  });

  test("the rail lists them in that same order", () => {
    const start = settingsSource.indexOf("const SETTINGS_SECTIONS");
    const rail = settingsSource.slice(
      start,
      settingsSource.indexOf("];", start),
    );
    let previous = -1;
    for (const id of SECTIONS) {
      // Match the QUOTED id. `"settings-app"` is a substring of
      // `"settings-appearance"`, so a bare substring search finds Appearance
      // first and reports App as sitting near the top of the rail — which is
      // the exact class of lie this file exists to catch.
      const index = rail.indexOf(`"${id}"`);
      expect({ id, index }).toEqual({ id, index: rail.indexOf(`"${id}"`) });
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
  });

  test("Playback leads, because it is what people actually change", () => {
    // Profile used to open the page. It is changed rarely — avatar, name,
    // email — so it belongs below the categories with day-to-day use.
    expect(SECTIONS[0]).toBe("settings-playback");
    expect(SECTIONS.indexOf("settings-profile")).toBeGreaterThan(
      SECTIONS.indexOf("settings-appearance"),
    );
  });

  test("destructive data controls stay last", () => {
    expect(SECTIONS[SECTIONS.length - 1]).toBe("settings-data");
  });

  test("the CSS must not re-order the panel behind the rail's back", () => {
    // This is the bug this file missed for so long. The panel used to carry an
    // `order:` ladder — half keyed by `#id`, half by `section:nth-of-type(N)`.
    // `ImportSection` renders a `<section>`, so it occupies an `nth-of-type`
    // slot too; inserting the App section shifted every index after it, and the
    // Data section fell off the end of the ladder with no rule at all. An
    // unmatched child keeps the initial `order: 0`, ties with `.settings-header`,
    // and ties break on document order — so "Your Data" rendered directly under
    // the page title.
    //
    // The consequence was not just misplaced: the scroll hook documents its
    // `ids` as DOCUMENT order, so the rail highlighted Data while the reader
    // was looking at App.
    //
    // Document order is now the only source of truth, which means a ladder
    // cannot exist here at all.
    expect(css).not.toMatch(/\.settings-liquid-glass\s*>[^{]*\{\s*order:/);
    expect(css).not.toMatch(/settings-liquid-glass[^{}]*nth-of-type/);
  });

  test("the rail and the document still agree on where App sits", () => {
    // App is not the last section, so it must not be treated as one. It was
    // inserted before Data in both the rail and the markup, and the ladder is
    // what quietly disagreed.
    expect(SECTIONS.indexOf("settings-app")).toBe(SECTIONS.length - 2);
    const app = at('<section id="settings-app"');
    const data = at('<section id="settings-data"');
    expect(app).toBeLessThan(data);
  });
});

describe("the two depth controls sit next to each other", () => {
  test("card transparency renders directly under the wallpaper blur controls", () => {
    // They are the same decision from both ends — how see-through the app
    // looks — and were separated by the whole theme/accent/wallpaper block.
    const blurToggle = at('label="Wallpaper blur"');
    const blurSlider = at("Blur intensity");
    const transparency = at("<CardTransparencySection />");
    expect(blurToggle).toBeLessThan(blurSlider);
    expect(blurSlider).toBeLessThan(transparency);
  });

  test("nothing sits between the blur intensity and the transparency slider", () => {
    // "One right below another one" — not just somewhere in the same section.
    const between = flat.slice(
      at("Blur intensity"),
      at("<CardTransparencySection />"),
    );
    // Only the intensity card's own markup: its slider, scale labels and the
    // closing tag. Any other labelled control would show up here.
    expect(between).not.toMatch(/<ToggleRow/);
    expect(between).not.toMatch(/WallpaperLibrary|ImagePlus|ImageOff/);
  });

  test("it is not hoisted to the top of Appearance any more", () => {
    // It used to be the first control in the section.
    const appearance = at('id="settings-appearance"');
    const transparency = at("<CardTransparencySection />");
    expect(transparency).toBeGreaterThan(appearance + 2000);
  });

  test("both still live in the Appearance section", () => {
    const appearance = at('id="settings-appearance"');
    const nextSection = at('id="settings-personalization"');
    const transparency = at("<CardTransparencySection />");
    expect(transparency).toBeGreaterThan(appearance);
    expect(transparency).toBeLessThan(nextSection);
  });
});

describe("every gap between sections still has exactly one rule", () => {
  test("Profile and Shortcuts are not separated by two hairlines", () => {
    // Moving Profile carried its divider along, which briefly left a plain
    // rule stacked on top of the shortcuts block's own lg-only rule — a
    // double hairline on desktop.
    const profile = at('id="settings-profile"');
    const shortcuts = at('id="settings-shortcuts"');
    const between = flat.slice(profile, shortcuts);
    expect(between.match(/<Separator/g) ?? []).toHaveLength(1);
  });

  test("Personalize and Profile are separated at every width", () => {
    const personalize = at('id="settings-personalization"');
    const profile = at('id="settings-profile"');
    const between = flat.slice(personalize, profile);
    expect(between).toMatch(/<Separator className="bg-white\/\[0\.07\]" \/>/);
  });

  test("the shortcuts divider stays hidden below lg", () => {
    // It belongs to the shortcuts block, which does not exist on a phone; a
    // divider left with nothing to separate stacks two hairlines there.
    const between = flat.slice(
      at('id="settings-profile"'),
      at('id="settings-shortcuts"'),
    );
    expect(between).toMatch(
      /<Separator className="hidden bg-white\/\[0\.07\] lg:block" \/>/,
    );
  });
});
