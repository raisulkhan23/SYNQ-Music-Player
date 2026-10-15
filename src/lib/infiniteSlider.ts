/**
 * The pure arithmetic behind a continuously drifting strip.
 *
 * Kept out of the component so it can be reasoned about and tested on its
 * own — the component is a wall of effects, and the one line that can strand
 * the strip off-screen is exactly the one you want to test in isolation.
 */

/**
 * The longest frame the loop will honour.
 *
 * A backgrounded tab hands back one enormous delta. At the default 18px/s that
 * is a visible jump, and under a 4x hover speed it is more than a whole
 * period in a single step.
 */
export const MAX_FRAME_SECONDS = 0.05;

/**
 * One frame of the loop.
 *
 * The wrap is a modulo rather than a conditional add-or-subtract. A single
 * conditional wrap only ever covers one period, so any step larger than that —
 * a resize that shrinks the group mid-flight, or a dropped frame on a loaded
 * machine — would leave the strip hundreds of pixels outside its own range,
 * showing nothing but the page behind it. Modulo lands back inside the range
 * however big the step was.
 */
export function advanceOffset(
  offset: number,
  delta: number,
  period: number,
): number {
  if (!(period > 0)) return offset;
  const next = (offset + delta) % period;
  // JS `%` keeps the sign of the dividend, so a left-moving strip already
  // lands in (-period, 0]; a right-moving one lands in (0, period). Shifting a
  // legitimate forward remainder down a period would make it jump backwards,
  // so only the exact zero needs normalising — and -0 would otherwise reach
  // the style write as "-0px".
  if (next > 0) return next - period;
  return next === 0 ? 0 : next;
}

/**
 * How many copies of the group are needed to cover the viewport.
 *
 * Two is the floor: with a single copy there is nowhere to wrap to, and the
 * strip would snap back to its origin every cycle.
 */
export function requiredCopies(
  groupWidth: number,
  viewportWidth: number,
): number {
  if (!(groupWidth > 0)) return 2;
  return Math.max(2, Math.ceil(viewportWidth / groupWidth) + 1);
}
