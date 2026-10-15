import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  createCursorTrail,
  SHELL_TRAIL_TAUS,
  FULLSCREEN_TRAIL_TAUS,
} from "../src/lib/cursorTrail.ts";

/**
 * The trail is driven entirely by rAF + performance.now, so both are replaced
 * with a manual clock. That makes the easing measurable instead of a matter of
 * opinion — which matters, because the previous CSS-transition version could
 * only be judged by eye, and by eye it read as "laggy, then snappy".
 */
let queue = [];
let now = 0;
const realRaf = globalThis.requestAnimationFrame;
const realCancel = globalThis.cancelAnimationFrame;
const realPerformance = globalThis.performance;

function installClock() {
  queue = [];
  now = 0;
  globalThis.requestAnimationFrame = (callback) => {
    queue.push(callback);
    return queue.length;
  };
  globalThis.cancelAnimationFrame = (id) => {
    if (id >= 1 && id <= queue.length) queue[id - 1] = null;
  };
  Object.defineProperty(globalThis, "performance", {
    value: { now: () => now },
    configurable: true,
  });
}

/** Run one frame `dt` ms later, as the browser would. */
function frame(dt = 16) {
  now += dt;
  const due = queue.filter(Boolean);
  queue = [];
  for (const callback of due) callback(now);
}

function fakeMotes(count) {
  return Array.from({ length: count }, () => ({ style: {} }));
}

const moteX = (mote) =>
  Number(/translate3d\((-?[\d.]+)px/.exec(mote.style.transform)?.[1] ?? NaN);
const pendingFrames = () => queue.filter(Boolean).length;

beforeEach(installClock);
afterEach(() => {
  globalThis.requestAnimationFrame = realRaf;
  globalThis.cancelAnimationFrame = realCancel;
  Object.defineProperty(globalThis, "performance", {
    value: realPerformance,
    configurable: true,
  });
});

describe("cursor trail easing", () => {
  test("snaps to the pointer on the first push instead of streaking in", () => {
    const motes = fakeMotes(5);
    const trail = createCursorTrail({
      motes: () => motes,
      taus: SHELL_TRAIL_TAUS,
    });
    trail.push(400, 300);
    // A parked trail used to glide in from wherever it last stopped, drawing a
    // streak across the screen.
    for (const mote of motes) expect(moteX(mote)).toBe(400);
    expect(moteX(motes[0])).toBe(400);
  });

  test("motes lag progressively behind each other", () => {
    const motes = fakeMotes(5);
    const trail = createCursorTrail({
      motes: () => motes,
      taus: SHELL_TRAIL_TAUS,
    });
    trail.push(0, 0);
    trail.push(600, 0);
    frame();
    // Each mote chases the one in front of it, so the order is strict.
    const xs = motes.map(moteX);
    for (let i = 1; i < xs.length; i += 1) {
      expect(xs[i]).toBeLessThan(xs[i - 1]);
    }
    // And the leader has actually moved, rather than teleporting.
    expect(xs[0]).toBeGreaterThan(0);
  });

  test("converges on the pointer and then stops scheduling frames", () => {
    const motes = fakeMotes(5);
    const trail = createCursorTrail({
      motes: () => motes,
      taus: SHELL_TRAIL_TAUS,
    });
    trail.push(0, 0);
    trail.push(500, 250);
    for (let i = 0; i < 600; i += 1) frame();
    // The loop parks when the chain is within its settle epsilon (0.2px) of
    // the pointer, so the motes land just shy of it rather than exactly on it.
    for (const mote of motes) {
      expect(Math.abs(moteX(mote) - 500)).toBeLessThanOrEqual(0.25);
    }
    // The loop parks itself: no idle rAF burning frames while the pointer is
    // still.
    expect(pendingFrames()).toBe(0);
  });

  test("easing is frame-rate independent", () => {
    // The same wall-clock time must produce the same position at 30fps and
    // 144fps. A per-frame `pos += (target - pos) * 0.1` fails this, which is
    // why the factor is 1 - e^(-dt/tau).
    const at = (stepMs, steps) => {
      installClock();
      const motes = fakeMotes(1);
      const trail = createCursorTrail({
        motes: () => motes,
        taus: SHELL_TRAIL_TAUS,
      });
      trail.push(0, 0);
      trail.push(1000, 0);
      for (let i = 0; i < steps; i += 1) frame(stepMs);
      return moteX(motes[0]);
    };
    const slow = at(33, 10); // ~330ms at 30fps
    const fast = at(7, 47); // ~330ms at 144fps
    expect(Math.abs(slow - fast) / slow).toBeLessThan(0.05);
  });

  test("a long frame (backgrounded tab) cannot teleport a mote", () => {
    const motes = fakeMotes(1);
    const trail = createCursorTrail({
      motes: () => motes,
      taus: SHELL_TRAIL_TAUS,
    });
    trail.push(0, 0);
    trail.push(1000, 0);
    frame(5000); // the tab was hidden for five seconds
    // Clamped, so the mote is still visibly travelling rather than arriving.
    expect(moteX(motes[0])).toBeLessThan(1000);
  });

  test("only writes transform, never layout properties", () => {
    const motes = fakeMotes(5);
    const trail = createCursorTrail({
      motes: () => motes,
      taus: SHELL_TRAIL_TAUS,
    });
    trail.push(0, 0);
    trail.push(300, 300);
    frame();
    for (const mote of motes) {
      expect(mote.style.transform).toContain("translate3d");
      expect(mote.style.left).toBeUndefined();
      expect(mote.style.top).toBeUndefined();
    }
  });

  test("tolerates missing motes while the effects are toggled off", () => {
    const motes = [null, ...fakeMotes(4)];
    const trail = createCursorTrail({
      motes: () => motes,
      taus: SHELL_TRAIL_TAUS,
    });
    expect(() => {
      trail.push(0, 0);
      trail.push(200, 0);
      frame();
    }).not.toThrow();
  });

  test("stop cancels the in-flight frame", () => {
    const motes = fakeMotes(2);
    const trail = createCursorTrail({
      motes: () => motes,
      taus: SHELL_TRAIL_TAUS,
    });
    trail.push(0, 0);
    trail.push(400, 0);
    frame();
    expect(pendingFrames()).toBe(1);
    trail.stop();
    expect(pendingFrames()).toBe(0);
  });

  test("reports the pointer position once per frame for the glow", () => {
    const motes = fakeMotes(2);
    const seen = [];
    const trail = createCursorTrail({
      motes: () => motes,
      taus: SHELL_TRAIL_TAUS,
      onFrame: (x) => seen.push(x),
    });
    trail.push(10, 10);
    trail.push(20, 10);
    trail.push(30, 10);
    frame();
    // Three events, one frame, one write: the glow never sees a stale position
    // and is never written more than once per frame.
    expect(seen).toEqual([30]);
  });

  test("the fullscreen trail is tighter than the shell trail", () => {
    // A long trail on a viewport-sized surface is what read as the cursor
    // dragging behind the window.
    for (let i = 0; i < FULLSCREEN_TRAIL_TAUS.length; i += 1) {
      expect(FULLSCREEN_TRAIL_TAUS[i]).toBeLessThan(SHELL_TRAIL_TAUS[i]);
    }
  });
});
