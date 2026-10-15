import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link } from "react-router";

import { cn } from "@/lib/utils";

/**
 * A horizontal content shelf — the spine of the Home page.
 *
 * Design notes, all of them deliberate:
 *
 * - ONE scroll implementation for every row on the page. The Home shelves,
 *   the mood rail and the artist rail used to be three hand-rolled
 *   `overflow-x-auto` divs with three different widths and three different
 *   amounts of padding, which is why the page never lined up.
 * - Arrows are pointer-only. A phone already has swipe, and two 32px buttons
 *   stealing width from the artwork is the single most common way a shelf
 *   component gets worse on mobile than on desktop.
 * - The rail bleeds to the screen edge with a negative margin so cards can
 *   scroll *under* the padding instead of being trapped inside it. Without
 *   the bleed, the first and last cards are unreachable while scrolled.
 * - Scrolling is driven by the element itself, never by React state, so a
 *   swipe does not re-render the page sixty times a second. The arrow state
 *   only updates when the available scroll space actually changes.
 */
export function Shelf({
  title,
  subtitle,
  icon,
  action,
  children,
  className,
  /** Rendered instead of the rail while the section's data is in flight. */
  skeleton,
  /** Hide the rail entirely (used when a section has nothing to show). */
  hidden,
  id,
}: {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  /** Optional "see all" affordance in the header. */
  action?: { to: string; label: string };
  children: ReactNode;
  className?: string;
  skeleton?: boolean;
  hidden?: boolean;
  id?: string;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    const maxScroll = rail.scrollWidth - rail.clientWidth;
    // A 1px tolerance: fractional layout widths make an exactly-at-the-end
    // scroller report a sub-pixel remainder, which would leave a permanently
    // enabled "next" arrow that does nothing when clicked.
    const start = rail.scrollLeft > 1;
    const end = maxScroll > 1 && rail.scrollLeft < maxScroll - 1;
    // Bail out when neither edge moved, by returning the PREVIOUS object.
    //
    // This is load-bearing, not an optimisation. `setEdges` used to be handed a
    // fresh object literal on every call, and React compares state with
    // `Object.is` — a new object is never equal, so every call re-rendered.
    // Combined with the dependency-free effect below that meant render → effect
    // → setState → render, forever. React stopped at 50 nested updates with
    // "Maximum update depth exceeded" and unwound the commit, leaving the last
    // painted frame on screen: the URL would change and the page would not.
    setEdges((prev) =>
      prev.start === start && prev.end === end ? prev : { start, end },
    );
  }, []);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    // Re-measure after every render: cards arriving change `scrollWidth`
    // without changing the rail's own box, which ResizeObserver would miss.
    // Safe to run on every render precisely because `measure` returns the
    // previous state unchanged when the answer is the same, so React bails out
    // and this costs two layout reads on a quiet render.
    measure();
  });

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const onScroll = () => measure();
    rail.addEventListener("scroll", onScroll, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);
    observer?.observe(rail);
    return () => {
      rail.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [measure]);

  const scrollByPage = (direction: -1 | 1) => {
    const rail = railRef.current;
    if (!rail) return;
    // Roughly one "page" of cards: the visible width less one card, so the
    // next card always lands fully in view.
    const card = rail.firstElementChild;
    const step = card
      ? Math.max(160, rail.clientWidth - (card as HTMLElement).offsetWidth - 16)
      : rail.clientWidth * 0.8;
    rail.scrollBy({ left: direction * step, behavior: "smooth" });
  };

  if (hidden) return null;

  return (
    <section className={cn("group/shelf", className)} aria-labelledby={id}>
      <div className="mb-3 flex items-end justify-between gap-4 px-0.5">
        <div className="min-w-0">
          <h2
            id={id}
            className="font-display flex items-center gap-2 text-lg font-bold tracking-tight sm:text-xl"
          >
            {icon}
            {title}
          </h2>
          {subtitle ? (
            <p className="mt-0.5 truncate text-sm text-muted-foreground">
              {subtitle}
            </p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {action ? (
            <Link
              to={action.to}
              className="rounded-full px-2.5 py-1 text-xs font-semibold text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
            >
              {action.label}
            </Link>
          ) : null}
          {/* Pointer devices only — see the note at the top of this file. */}
          <div className="hidden items-center gap-1 md:flex">
            <ShelfArrow
              direction="back"
              disabled={!edges.start}
              onClick={() => scrollByPage(-1)}
              label={`Scroll ${title} left`}
            />
            <ShelfArrow
              direction="forward"
              disabled={!edges.end}
              onClick={() => scrollByPage(1)}
              label={`Scroll ${title} right`}
            />
          </div>
        </div>
      </div>

      {skeleton ? (
        <ShelfSkeleton />
      ) : (
        <div className="relative">
          {/* Soft edges tell the eye there is more content off-screen. Purely
              decorative — hidden from assistive tech. */}
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-background to-transparent transition-opacity duration-200",
              edges.start ? "opacity-100" : "opacity-0",
            )}
          />
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-background to-transparent transition-opacity duration-200",
              edges.end ? "opacity-100" : "opacity-0",
            )}
          />
          <div
            ref={railRef}
            // `pb-3` reserves a real band for `.slider-rail`'s 8px scrollbar, which
            // renders inside the padding box — the old `pb-1` let the scrollbar
            // ride up over the bottom of the cards.
            className="slider-rail -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pt-0.5 pb-3 sm:mx-0 sm:gap-4 sm:px-0"
          >
            {children}
          </div>
        </div>
      )}
    </section>
  );
}

function ShelfArrow({
  direction,
  disabled,
  onClick,
  label,
}: {
  direction: "back" | "forward";
  disabled: boolean;
  onClick: () => void;
  label: string;
}) {
  const Icon = direction === "back" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex size-8 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-muted-foreground transition-all",
        "hover:border-[rgb(var(--tint)_/_0.4)] hover:bg-white/[0.08] hover:text-foreground",
        "disabled:pointer-events-none disabled:opacity-0",
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}

/**
 * Placeholder cards shown while a shelf's data is still in flight.
 *
 * Skeletons mirror the real card footprint, so nothing reflows when the data
 * lands, and the rest of the page stays fully usable in the meantime.
 */
export function ShelfSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div
      aria-hidden="true"
      className="-mx-4 flex gap-3 overflow-hidden px-4 sm:mx-0 sm:gap-4 sm:px-0"
    >
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="w-32 shrink-0 sm:w-40">
          <div className="aspect-square w-full animate-pulse rounded-xl bg-white/[0.05]" />
          <div className="mt-2.5 h-3 w-4/5 animate-pulse rounded-full bg-white/[0.05]" />
          <div className="mt-1.5 h-2.5 w-3/5 animate-pulse rounded-full bg-white/[0.04]" />
        </div>
      ))}
    </div>
  );
}
