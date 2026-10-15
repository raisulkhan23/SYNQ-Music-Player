import { describe, expect, test } from 'vitest';
import { readSource } from "./helpers/tailwind-css.js";
import {
  advanceOffset,
  MAX_FRAME_SECONDS,
  requiredCopies,
} from "../src/lib/infiniteSlider";

const slider = readSource("src/components/core/infinite-slider.tsx");
const footer = readSource("src/components/landing/SiteFooter.tsx");

const tight = (value) => value.replace(/\s+/g, " ");

describe("the loop is seamless", () => {
  test("the period is the measured group width, not a hard-coded stride", () => {
    // The group carries its own trailing gap as padding, so offsetWidth
    // already includes the space before the next copy. Wrapping on anything
    // else shifts the strip by one gap every cycle.
    expect(slider).toContain("const period = group.offsetWidth;");
    expect(slider).toMatch(/paddingRight: gap/);
  });

  test("a full period of travel returns the strip to where it started", () => {
    // The whole point of the wrap: at exactly one period the position is
    // pixel-identical, so the seam between copies cannot be seen.
    expect(advanceOffset(0, -500, 500)).toBe(0);
    expect(advanceOffset(0, 500, 500)).toBe(0);
  });

  test("ordinary frames keep the offset inside exactly one period", () => {
    // The offset always lives in (-period, 0], whichever way the strip
    // travels: direction comes from the sign of the delta, not the offset, so
    // there is no reason for a right-moving strip to occupy the positive half
    // and no reason to guard for it. The important part is that it can never
    // leave the range, which is what keeps the next copy in view.
    for (const delta of [-0.3, 0.3]) {
      let offset = 0;
      for (let i = 0; i < 10_000; i += 1) {
        offset = advanceOffset(offset, delta, 500);
        expect(offset).toBeGreaterThan(-500);
        expect(offset).toBeLessThanOrEqual(0);
      }
    }
  });

  test("the strip is a closed loop: a whole period of travel is the identity", () => {
    // Not just "bounded" but actually periodic, which is what makes the seam
    // invisible. 1000 steps of 0.5 is exactly two periods of a 500px group.
    let offset = 0;
    for (let i = 0; i < 1_000; i += 1)
      offset = advanceOffset(offset, -0.5, 500);
    expect(offset).toBe(0);
  });

  test("a single huge step still lands back inside the range", () => {
    // The dt clamp is what keeps steps small in practice, but the wrap has to
    // survive a big one on its own: a resize can shrink the group mid-flight,
    // and a single add-or-subtract wrap only ever covers one period. Without
    // the modulo this lands hundreds of pixels out of range and the strip
    // renders nothing but the page behind it.
    expect(advanceOffset(0, -1_000_000, 500)).toBe(0);
    expect(advanceOffset(0, 1_000_000, 500)).toBe(0);
    for (const delta of [-1, 1, -7.5, 7.5, -499.9, 499.9, -12_345.6]) {
      const next = advanceOffset(0, delta, 500);
      expect(Math.abs(next)).toBeLessThanOrEqual(500);
    }
  });

  test("the wrap never leaves a negative zero on the style write", () => {
    // `(0 - 500) % 500` is -0, and "-0px" is technically valid CSS but shows
    // up as a visibly different string in the debug overlay.
    expect(Object.is(advanceOffset(0, -500, 500), -0)).toBe(false);
  });

  test("a resized period does not strand the offset", () => {
    // The group can shrink under the loop when the viewport narrows.
    let offset = advanceOffset(0, -499.5, 500);
    offset = advanceOffset(offset, -0.5, 120);
    expect(Math.abs(offset)).toBeLessThanOrEqual(120);
  });

  test("an unmeasured group does not divide by zero or wrap to NaN", () => {
    // `offsetWidth` is 0 on the first frame and whenever the strip is hidden.
    expect(advanceOffset(12, -5, 0)).toBe(12);
    expect(Number.isNaN(advanceOffset(12, -5, 0))).toBe(false);
  });
});

describe("the strip does not spend frames it should not", () => {
  test("a long frame cannot teleport the strip", () => {
    expect(MAX_FRAME_SECONDS).toBeLessThanOrEqual(0.1);
    expect(slider).toContain("MAX_FRAME_SECONDS");
    // A 4-second background gap at the default 18px/s is 72px; un-clamped at
    // a 10x hover speed it is over 700px, more than a whole period.
    expect(slider).toMatch(
      /Math\.min\(\(now - last\) \/ 1000, MAX_FRAME_SECONDS\)/,
    );
  });

  test("reduced motion is honoured, and re-read every frame", () => {
    // Checked inside the loop rather than via a change listener, so toggling
    // the OS setting takes effect on the very next frame with no listener to
    // leak.
    expect(slider).toContain('"(prefers-reduced-motion: reduce)"');
    expect(slider).toMatch(/if \(reducedMotion\.matches/);
  });

  test("a strip that is scrolled out of view stops animating", () => {
    expect(slider).toContain("new IntersectionObserver");
    expect(slider).toMatch(/onScreen = entry\.isIntersecting/);
    expect(slider).toMatch(/!onScreen \|\| document\.hidden/);
  });

  test("both observers are torn down on unmount", () => {
    expect(slider).toContain("observer.disconnect()");
    expect(slider).toContain("visibility.disconnect()");
    expect(slider).toContain("cancelAnimationFrame(frame)");
  });

  test("the loop never re-renders React per frame", () => {
    // The only state is a copy count that settles once. Motion is a direct
    // style write, so a drifting strip costs no reconciliation.
    const stateCalls = [...slider.matchAll(/= useState\(/g)];
    expect(stateCalls.length).toBe(1);
    expect(slider).toContain("track.style.transform");
  });
});

describe("the badges stay clickable", () => {
  test("the footer still renders real external links", () => {
    for (const attr of [
      "href={badge.href}",
      'target="_blank"',
      'rel="noopener noreferrer"',
    ]) {
      expect(footer).toContain(attr);
    }
  });

  test("duplicate copies leave the a11y tree but stay clickable", () => {
    // CORRECTED. This test used to REQUIRE `inert` on the repeat copies, and
    // that assertion is what kept the bug alive: `inert` means "not
    // clickable", and because the strip drifts continuously, after one
    // group-width every badge on screen belonged to a later copy. The whole
    // marquee looked alive and every link on it was dead.
    //
    // The de-duplication goal is still real — a keyboard user should not tab
    // through the same link four times — and it is met with `aria-hidden` plus
    // `tabIndex={-1}`, neither of which blocks a pointer.
    expect(slider).toContain("aria-hidden={copy > 0 ? true : undefined}");
    expect(slider).toContain("tabIndex: -1");
    expect(slider).not.toContain("inert={copy > 0 ? true : undefined}");
  });

  test("there are at least two copies, or the strip has nowhere to wrap to", () => {
    // A single copy has no wrap target: the strip would snap to its origin
    // every cycle instead of drifting.
    expect(requiredCopies(500, 0)).toBe(2);
    expect(requiredCopies(0, 1_200)).toBe(2);
    expect(requiredCopies(500, 1_200)).toBe(4);
    expect(requiredCopies(100, 1_200)).toBe(13);
    expect(slider).toContain(
      "requiredCopies(group.offsetWidth, viewport.offsetWidth)",
    );
  });

  test("the copy count settles instead of oscillating", () => {
    // A setState that re-renders with a new array every measure would loop
    // between two values forever whenever the count sits on a boundary.
    expect(slider).toContain("next === prev ? prev : next");
  });

  test("hover speed is a multiplier on the base, not a separate track", () => {
    // The user's snippet passes `speedOnHover={20}`; if that were read as an
    // absolute px/s the strip would jump velocity every time the pointer
    // crossed the edge.
    expect(slider).toContain(
      "speed * (hoveringRef.current ? speedOnHover : 1)",
    );
    expect(slider).toMatch(
      /onPointerEnter=\{\(\) => \{\s*hoveringRef\.current = true;/,
    );
    expect(slider).toMatch(
      /onPointerLeave=\{\(\) => \{\s*hoveringRef\.current = false;/,
    );
  });

  test("the strip is labelled rather than announced as a bare region", () => {
    expect(slider).toContain('role="group"');
    expect(slider).toContain("aria-label={label}");
    expect(footer).toContain('label="Launch directories featuring SYNQ"');
  });

  test("the footer uses the slider in place of the wrapping list", () => {
    expect(footer).toContain("<InfiniteSlider");
    // The old flex-wrap list broke into ragged rows in a narrow column.
    expect(footer).not.toContain("flex flex-wrap items-center gap-2.5");
  });

  test("badge images keep their intrinsic size and lazy loading", () => {
    expect(footer).toContain('loading="lazy"');
    expect(footer).toContain("width={badge.width}");
  });
});
