import {
  Children,
  cloneElement,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  advanceOffset,
  MAX_FRAME_SECONDS,
  requiredCopies,
} from "@/lib/infiniteSlider";

/**
 * A seamless, continuously drifting strip.
 *
 * The loop renders the children more than once and slides the whole track by
 * exactly one group width at a time. When the offset wraps, the track is in a
 * pixel-identical position, so the seam is never visible.
 *
 * The period is measured, not assumed: the group carries its own trailing gap
 * as padding, so `offsetWidth` already includes the spacing that precedes the
 * next copy. Wrapping on `offsetWidth` rather than a hard-coded stride is what
 * keeps the seam from jumping by one gap every cycle.
 *
 * Nothing here re-renders per frame. The loop writes `transform` straight to
 * the track node, and the only React state is a copy count that settles once
 * and then stops changing.
 */
export type InfiniteSliderProps = {
  children: ReactNode;
  /** Base drift, in pixels per second. Deliberately slow. */
  speed?: number;
  /**
   * Multiplier applied while the pointer is over the strip.
   *
   * Values BELOW 1 slow the drift down, which is the point: a moving target is
   * hard to click, and every carousel convention in the world eases off when
   * the pointer arrives so the item can actually be hit. The default is 0.25.
   *
   * A value above 1 does the opposite and used to be what shipped here (4),
   * which meant hovering made the strip four times faster — the exact moment
   * the user is trying to click something. Pass one only deliberately.
   */
  speedOnHover?: number;
  /** Space between items, in pixels. Mirrors Tailwind's spacing scale. */
  gap?: number;
  /** Travel right-to-left when false, left-to-right when true. */
  reverse?: boolean;
  /** Accessible name for the scrolling region. */
  label?: string;
  className?: string;
};

export function InfiniteSlider({
  children,
  speed = 18,
  speedOnHover = 0.25,
  gap = 16,
  reverse = false,
  label,
  className = "",
}: InfiniteSliderProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const groupRef = useRef<HTMLDivElement | null>(null);
  const hoveringRef = useRef(false);

  const [copies, setCopies] = useState(2);

  const items = useMemo(() => Children.toArray(children), [children]);

  // Repeat the group until it is wider than the viewport plus one, so a short
  // set of children still covers the full width with somewhere to scroll from.
  useEffect(() => {
    const viewport = viewportRef.current;
    const group = groupRef.current;
    if (!viewport || !group) return;

    const measure = () => {
      const next = requiredCopies(group.offsetWidth, viewport.offsetWidth);
      setCopies((prev) => (next === prev ? prev : next));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(group);
    return () => observer.disconnect();
  }, [items]);

  useEffect(() => {
    const track = trackRef.current;
    const group = groupRef.current;
    const viewport = viewportRef.current;
    if (!track || !group || !viewport) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let last = 0;
    let offset = 0;
    let onScreen = true;

    // A strip that scrolls while nobody is looking at it is pure battery cost,
    // and the footer is the first thing to leave the viewport.
    const visibility = new IntersectionObserver(
      ([entry]) => {
        onScreen = entry.isIntersecting;
      },
      { rootMargin: "100px" },
    );
    visibility.observe(viewport);

    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);

      // Clamp dt rather than trusting it: a backgrounded tab hands back one
      // enormous frame delta, which would teleport the strip to the far end.
      const dt = last ? Math.min((now - last) / 1000, MAX_FRAME_SECONDS) : 0;
      last = now;

      if (reducedMotion.matches || !onScreen || document.hidden) return;

      const period = group.offsetWidth;
      if (period <= 0) return;

      const velocity = speed * (hoveringRef.current ? speedOnHover : 1);
      offset = advanceOffset(
        offset,
        velocity * dt * (reverse ? 1 : -1),
        period,
      );
      track.style.transform = `translate3d(${offset}px, 0, 0)`;
    };

    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      visibility.disconnect();
    };
  }, [copies, gap, reverse, speed, speedOnHover]);

  return (
    <div
      ref={viewportRef}
      onPointerEnter={() => {
        hoveringRef.current = true;
      }}
      onPointerLeave={() => {
        hoveringRef.current = false;
      }}
      role="group"
      aria-label={label}
      className={`relative overflow-hidden ${className}`}
      style={
        {
          // A hard clip makes the strip stop dead at both ends, which reads as
          // a cut-off layout. This fades the *content* out at the edges and
          // leaves the surface behind it untouched.
          maskImage:
            "linear-gradient(90deg, transparent, #000 6rem, #000 calc(100% - 6rem), transparent)",
          WebkitMaskImage:
            "linear-gradient(90deg, transparent, #000 6rem, #000 calc(100% - 6rem), transparent)",
        } satisfies CSSProperties
      }
    >
      <div
        ref={trackRef}
        className="flex w-max items-center will-change-transform"
      >
        {Array.from({ length: copies }, (_, copy) => (
          <div
            key={copy}
            ref={copy === 0 ? groupRef : undefined}
            className="flex shrink-0 items-center"
            style={{ paddingRight: gap }}
            // Every copy after the first is a visual repeat, and leaving them in
            // the accessibility tree would announce each link twice and put a
            // keyboard stop on a duplicate that scrolls off mid-focus.
            //
            // They must NOT be `inert`, though. That was the bug: once the
            // track drifted one group-width to the left, every badge on screen
            // belonged to a later copy, so the entire strip stopped responding
            // to clicks — the drift was continuous, but the links were dead.
            // `aria-hidden` plus `tabIndex={-1}` on the duplicates removes them
            // from the a11y tree and the tab order while leaving them
            // clickable, which is the only combination a marquee actually
            // needs.
            aria-hidden={copy > 0 ? true : undefined}
          >
            {copy === 0
              ? items
              : items.map((child, index) =>
                  isValidElement(child)
                    ? cloneElement(
                        child as ReactElement<Record<string, unknown>>,
                        {
                          key: `copy-${index}`,
                          tabIndex: -1,
                          "aria-hidden": true,
                        },
                      )
                    : child,
                )}
          </div>
        ))}
      </div>
    </div>
  );
}
