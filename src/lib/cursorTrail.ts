/**
 * Cursor trail that lives entirely on the compositor.
 *
 * The trail used to be a CSS transition on the mote position, fed by a
 * rAF-batched write. That is the "laggy, snappy, glitchy" feel in one
 * mechanism: writing a new target every frame RESTARTS the transition, so
 * each frame only advanced the mote by a fraction of the remaining distance
 * (it eased asymptotically, never arriving), and the moment the pointer
 * stopped it snapped the rest of the way. Faster pointer movement made the
 * lag worse, and the snap worse.
 *
 * Instead, one rAF loop eases mote 0 toward the pointer and every other mote
 * toward the one in front of it, using a frame-rate independent exponential
 * decay. The loop parks itself the moment the motes settle, so it costs
 * nothing while the pointer is still. Only `transform` is written, so no
 * layout and no paint.
 */

/** Per-mote time constant in seconds. Larger = lags further behind. */
export type CursorTrailTaus = readonly number[];

const SETTLE_EPSILON_PX = 0.2;
/** A frame longer than this (tab was backgrounded) must not teleport a mote. */
const MAX_FRAME_SECONDS = 0.064;

export type CursorTrail = {
  /** Record a new pointer position and make sure the loop is running. */
  push: (x: number, y: number) => void;
  /** Cancel any in-flight frame. Call on unmount. */
  stop: () => void;
};

export function createCursorTrail(options: {
  /** Live mote elements. Entries may be null while effects are toggled off. */
  motes: () => Array<HTMLSpanElement | null>;
  taus: CursorTrailTaus;
  /** Called once per frame with the raw pointer position (drives the glow). */
  onFrame?: (x: number, y: number) => void;
}): CursorTrail {
  const { motes, taus, onFrame } = options;
  const positions = taus.map(() => ({ x: 0, y: 0 }));
  let frame: number | null = null;
  let running = false;
  let lastFrameTime = 0;
  let targetX = 0;
  let targetY = 0;

  const tick = (now: number) => {
    frame = null;
    const delta = Math.min((now - lastFrameTime) / 1000, MAX_FRAME_SECONDS);
    lastFrameTime = now;
    const elements = motes();

    // Mote 0 chases the pointer, each following the one ahead of it: that
    // chain is the trail.
    let chaseX = targetX;
    let chaseY = targetY;
    let settled = true;
    for (let index = 0; index < taus.length; index += 1) {
      const position = positions[index];
      // 1 - e^(-dt/tau): the same easing at 60Hz, 120Hz or a janky 30Hz.
      const factor = 1 - Math.exp(-delta / taus[index]);
      position.x += (chaseX - position.x) * factor;
      position.y += (chaseY - position.y) * factor;
      const element = elements[index];
      if (element) {
        element.style.transform = `translate3d(${position.x}px, ${position.y}px, 0) translate(-50%, -50%)`;
      }
      if (
        Math.abs(chaseX - position.x) > SETTLE_EPSILON_PX ||
        Math.abs(chaseY - position.y) > SETTLE_EPSILON_PX
      ) {
        settled = false;
      }
      chaseX = position.x;
      chaseY = position.y;
    }

    // The glow is not part of the trail: it tracks the pointer itself, one
    // frame behind the event, so the motes read as motion trailing a light.
    onFrame?.(targetX, targetY);

    if (settled) {
      running = false;
      return;
    }
    frame = requestAnimationFrame(tick);
  };

  return {
    push(x, y) {
      targetX = x;
      targetY = y;
      if (running) return;
      running = true;
      // Snap on the first push after the trail has come to rest. Without this,
      // re-entering the window glided the motes in from wherever they parked
      // last time, which drew a streak across the screen.
      const elements = motes();
      for (let index = 0; index < positions.length; index += 1) {
        positions[index].x = x;
        positions[index].y = y;
        const element = elements[index];
        if (element) {
          element.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
        }
      }
      lastFrameTime = performance.now();
      frame = requestAnimationFrame(tick);
    },
    stop() {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      running = false;
    },
  };
}

/** Shell trail: a visible, soft lag behind the pointer. */
export const SHELL_TRAIL_TAUS = [0.035, 0.06, 0.085, 0.11, 0.14] as const;

/** Fullscreen player: tighter, because the surface is viewport-sized and a
 *  long trail there reads as the cursor dragging behind the window. */
export const FULLSCREEN_TRAIL_TAUS = [0.018, 0.03, 0.045, 0.06, 0.08] as const;
