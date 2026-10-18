import { describe, expect, test } from "bun:test";
import { readSource } from "./helpers/tailwind-css.js";

const storeSource = readSource("src/store/player.ts");
const seekBarSource = readSource("src/components/player/SeekBar.tsx");

/** Body of a `const name = (...) => { ... }` declared inside the store factory. */
function factoryFn(name) {
  const start = storeSource.indexOf(`  const ${name} = (`);
  if (start === -1) throw new Error(`missing ${name}`);
  const end = storeSource.indexOf("\n  const ", start + 10);
  return storeSource.slice(start, end === -1 ? undefined : end);
}

const seek = factoryFn("seek");

describe("a non-finite position can never reach the media element", () => {
  test("seek ignores NaN and Infinity outright", () => {
    // `HTMLMediaElement.currentTime` takes a double and THROWS on a
    // non-finite value, which took down the whole pointer handler and left
    // the transport stuck. It must never see one.
    expect(seek).toMatch(/if \(!Number\.isFinite\(time\)\) return;/);
    // ...and the guard has to come before the clamp and the assignment.
    const guard = seek.indexOf("Number.isFinite(time)");
    const clamp = seek.indexOf("Math.max(0, Math.min(time");
    const assign = seek.indexOf("getAudio().currentTime = t");
    expect(guard).toBeGreaterThan(-1);
    expect(clamp).toBeGreaterThan(guard);
    expect(assign).toBeGreaterThan(guard);
  });

  test("the seek bar cannot manufacture a NaN from a zero-width track", () => {
    // (clientX - left) / 0 is Infinity, and `Math.max(0, Infinity)` is
    // Infinity; for a 0/0 track it is NaN, and `Math.max(0, NaN)` is still
    // NaN — so the clamp downstream never cleaned it up.
    expect(seekBarSource).toMatch(/if \(!\(rect\.width > 0\)\) return 0;/);
    const guard = seekBarSource.indexOf("rect.width > 0");
    const divide = seekBarSource.indexOf("/ rect.width)");
    expect(guard).toBeGreaterThan(-1);
    expect(divide).toBeGreaterThan(guard);
  });

  test("the progress fill and thumb cannot render NaN%", () => {
    expect(seekBarSource).toMatch(
      /duration > 0 && Number\.isFinite\(currentTime\) \? currentTime \/ duration : 0/,
    );
    expect(seekBarSource).toMatch(
      /duration > 0 && Number\.isFinite\(bufferedEnd\)/,
    );
  });
});

describe("a storage failure can never break a control", () => {
  test("the guarded writer swallows the throw instead of propagating it", () => {
    // localStorage.setItem throws when storage is blocked or full. Every call
    // site sits inside a zustand setter, so the throw skipped the set(...)
    // that followed and the control silently did nothing.
    expect(storeSource).toMatch(
      /function writeSetting\(key: string, value: string\): void \{/,
    );
    expect(storeSource).toMatch(
      /function writeSetting[\s\S]{0,160}try \{[\s\S]{0,80}localStorage\.setItem\(key, value\);[\s\S]{0,80}\} catch \{/,
    );
    expect(storeSource).toMatch(
      /function removeSetting[\s\S]{0,200}localStorage\.removeItem\(key\);[\s\S]{0,80}\} catch \{/,
    );
  });

  test("no control calls localStorage directly any more", () => {
    // Only the two helpers may touch the raw API. Everything else going
    // through them is what makes the guarantee hold.
    const rawWrites = storeSource.match(/localStorage\.setItem\(/g) ?? [];
    const rawRemoves = storeSource.match(/localStorage\.removeItem\(/g) ?? [];
    expect(rawWrites.length).toBe(1);
    expect(rawRemoves.length).toBe(1);
  });

  test("the transport and settings setters persist through the guard", () => {
    // These are the controls that were most visibly broken: the slider moved
    // nothing, the repeat button lit up but playback ignored it.
    for (const key of [
      "ss.volume",
      "ss.muted",
      "ss.shuffle",
      "ss.repeat",
      "ss.rate",
      "ss.autoplay",
      "ss.performanceMode",
    ]) {
      expect(storeSource).toContain(`writeSetting("${key}"`);
    }
  });

  test("a setting that mutates the DOM still reports its new value", () => {
    // setCardTransparency applies the change to the document BEFORE
    // persisting. A throw between the two left the panel visibly changed
    // while the store still reported the old value.
    const start = storeSource.indexOf("setCardTransparency: (value) => {");
    const fn = storeSource.slice(
      start,
      storeSource.indexOf("toggleLiquidGlass", start),
    );
    expect(start).toBeGreaterThan(-1);
    // Asserted structurally: the persisted write must be guarded and must come
    // before the set(...), without depending on the imported key's spelling.
    expect(fn).toMatch(/writeSetting\([A-Z_]+, String\(next\)\)/);
    expect(fn.indexOf("writeSetting(")).toBeLessThan(
      fn.indexOf("set({ cardTransparency: next })"),
    );
  });

  test("reads are untouched — only writes needed guarding", () => {
    // getItem returns null rather than throwing, so the read paths above the
    // factory were never at risk and should not have been churned.
    expect(storeSource).toMatch(/localStorage\.getItem\(QUEUE_KEY\)/);
    expect(storeSource).toMatch(/readBool\("ss\.performanceMode", false\)/);
  });
});
