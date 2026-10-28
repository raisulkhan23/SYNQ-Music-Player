import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

/**
 * Section navigation for the Settings rail.
 *
 * The rail used to scroll with `scrollTo({ behavior: "smooth" })` while a
 * scroll listener recomputed the highlighted chip from the same geometry.
 * Those two fought each other:
 *
 *  - A smooth scroll animates for a few hundred milliseconds, firing `scroll`
 *    on every frame. Each of those frames recomputed the highlight, so the
 *    chip raced through every section the animation passed on its way to the
 *    target — and whichever frame the animation happened to end on decided the
 *    highlight, not the section the user clicked.
 *  - Each new click started a *second* smooth scroll while the first was still
 *    running, and computed its destination from `getBoundingClientRect()` of a
 *    target that was itself mid-flight. That is how a click on "Data" landed
 *    on "Personalize" or overshot into the page footer.
 *  - The destination was derived from a live rect plus a hardcoded 96px, so it
 *    silently changed meaning whenever the sticky rail wrapped to two rows or
 *    the viewport changed.
 *
 * This hook fixes that at the root by making navigation a single, explicit,
 * cancellable operation:
 *
 *  1. Sections register themselves in a ref map. Nothing looks a section up by
 *     `document.getElementById`, so a second mounted copy of the dialog can
 *     never make the rail target somebody else's element.
 *  2. The destination is an ABSOLUTE scroll offset derived once from the
 *     section's position in the scroll container's content, and is therefore
 *     the same value no matter where the container currently is. Recomputing it
 *     mid-animation is safe, which is what makes a click during a click land
 *     where the last click asked for.
 *  3. Scrolling is animated here, on our own clock, so a new request cancels
 *     the previous one outright instead of racing it.
 *  4. While a programmatic scroll is in flight the observer is suspended, so
 *     the animation can never feed back into the state it is driving.
 *  5. The offset under the sticky rail is MEASURED, not hardcoded.
 *  6. The destination is clamped to the container's real scroll range, so the
 *     last section lands flush and the footer is never scrolled to as a
 *     side effect.
 *
 * While the user scrolls by hand an IntersectionObserver tracks which sections
 * occupy the band under the sticky rail, and the highlight is the one the
 * reader is actually in — including in the gap between two tall sections,
 * where no observer entry fires at all.
 */

/** Gap kept between the sticky rail and the section it scrolls to. */
const SECTION_GAP_PX = 12;

const clamp = (value: number, min: number, max: number) =>
  value < min ? min : value > max ? max : value;

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Ancestors that could plausibly be the scroll container.
 *
 * `[data-app-scroll]` is what the app shell marks its scroll container with
 * (`ScrollToTop` and the focus-layout effects already key off it); the others
 * cover the compact dialog's `role="dialog"` panel and a plain page.
 */
const CONTAINER_SELECTOR =
  "[data-app-scroll], [data-settings-scroll], main, [role='dialog']";

/**
 * Can this element actually be scrolled?
 *
 * `scrollHeight` and `clientHeight` are both 0 for a `display: none` subtree
 * and equal for a non-scrolling box, so this is the honest test — and the
 * reason "the nearest match" is not good enough.
 */
function canScroll(element: HTMLElement): boolean {
  return element.scrollHeight > element.clientHeight + 1;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export interface SectionNavOptions {
  /**
   * Section ids in document order. The active chip and the observer's
   * "which section comes next" both depend on this order, so it is the one
   * list the hook is driven from.
   */
  ids: readonly string[];
  /**
   * The scrolling element, when the caller can name it.
   *
   * Optional on purpose: in page mode the settings panel is rendered inside
   * the shell's `<main>`, which is a DOM ancestor the dialog cannot hold a ref
   * to. Callers that CAN name it should; the rest get
   * {@link resolveContainer}'s nearest-scrollable-ancestor search.
   */
  containerRef?: RefObject<HTMLElement | null>;
  /** The sticky rail whose height has to be cleared. */
  stickyRef: RefObject<HTMLElement | null>;
  /** Track the reader's position. Only the full settings page scrolls. */
  enabled: boolean;
}

export interface SectionNav {
  activeId: string;
  /** Wire a section element up. Spread onto the section's `ref`. */
  register: (id: string) => (element: HTMLElement | null) => void;
  /** Navigate to a section. Safe to call repeatedly and concurrently. */
  goTo: (id: string) => void;
}

export function useSettingsNavigation({
  ids,
  containerRef,
  stickyRef,
  enabled,
}: SectionNavOptions): SectionNav {
  const [activeId, setActiveId] = useState<string>(ids[0] ?? "");

  // Elements by id. A ref map rather than getElementById: the dialog is
  // mounted from several places, and a global lookup can hand back a section
  // that belongs to a different copy.
  const elements = useRef(new Map<string, HTMLElement>());
  // Mirror of `activeId` so the scroll handler can read it without being
  // re-subscribed on every highlight change. Kept in step by `setActive`
  // rather than assigned during render.
  const activeRef = useRef<string>(ids[0] ?? "");
  // Non-null while our own animation owns the scroll position. The observer
  // and the scroll handler both stand down while it is set.
  const animating = useRef(false);
  const frame = useRef(0);
  // The id we are heading for, so the highlight can be settled on the
  // destination once the animation lands rather than on whatever section the
  // animation happened to pass.
  const pending = useRef<string | null>(null);

  const setActive = useCallback((next: string) => {
    if (activeRef.current === next) return;
    activeRef.current = next;
    setActiveId(next);
  }, []);

  const register = useCallback(
    (id: string) => (element: HTMLElement | null) => {
      if (element) elements.current.set(id, element);
      else elements.current.delete(id);
    },
    [],
  );

  /** Cancel any in-flight animation, leaving the scroll where it is. */
  const stopAnimation = useCallback(() => {
    if (frame.current) {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    }
    animating.current = false;
  }, []);

  const resolveContainer = useCallback(
    (element: HTMLElement): HTMLElement => {
      const explicit = containerRef?.current;
      if (explicit) return explicit;
      // The NEAREST SCROLLABLE ancestor, not the nearest MATCHING one.
      //
      // `closest()` stops at the first ancestor that matches the selector,
      // whether or not that box can scroll. Both settings surfaces put a
      // non-scrolling wrapper between the sections and the real scroller:
      // the page-mode panel is `!overflow-y-visible` inside the shell's
      // `<main>`, and the compact dialog's panel is the scroller while the
      // `<main>` around it is not. Writing `scrollTop` to a box that cannot
      // scroll is a silent no-op, so a chip appears to do nothing at all.
      //
      // `[data-app-scroll]` is the attribute the shell actually marks its
      // scroll container with; the previous selector asked for
      // `[data-settings-scroll]`, which exists nowhere in the app, so it only
      // ever worked because `main` happened to be in the list too.
      let node: HTMLElement | null = element.parentElement;
      let fallback: HTMLElement | null = null;
      while (node) {
        if (node.matches?.(CONTAINER_SELECTOR)) {
          fallback ??= node;
          if (canScroll(node)) return node;
        }
        node = node.parentElement;
      }
      return (
        fallback ??
        (document.scrollingElement as HTMLElement | null) ??
        document.documentElement
      );
    },
    [containerRef],
  );

  /**
   * Where the section should end up, in absolute scrollTop coordinates.
   *
   * Derived from the section's position inside the container's *content*,
   * which is independent of the current scroll — so this returns the same
   * answer mid-animation as it does at rest, and a click during a click
   * retargets cleanly instead of compounding.
   */
  const destinationFor = useCallback(
    (element: HTMLElement, container: HTMLElement): number => {
      const contentTop =
        container.scrollTop +
        (element.getBoundingClientRect().top -
          container.getBoundingClientRect().top);
      // Measure the rail rather than assuming a height: it wraps to a second
      // row on narrow viewports, and a fixed constant silently aimed the
      // section underneath it.
      const stickyHeight =
        stickyRef.current?.getBoundingClientRect().height ?? 0;
      const offset = stickyHeight + SECTION_GAP_PX;
      const max = Math.max(0, container.scrollHeight - container.clientHeight);
      return clamp(contentTop - offset, 0, max);
    },
    [stickyRef],
  );

  const goTo = useCallback(
    (id: string) => {
      const element = elements.current.get(id);
      // An id we do not own, or a section that is not laid out at this width
      // (the keyboard panel below `lg`), is a no-op. Guessing here is what
      // used to throw the reader to the top of the shell.
      if (!element || element.offsetParent === null) return;
      // A section can also be laid out inside a collapsed container, which
      // still reports a zero-height rect.
      if (element.getBoundingClientRect().height === 0) return;

      const container = resolveContainer(element);

      // Last request wins. Cancelling first is what stops two animations from
      // interleaving their writes to scrollTop.
      stopAnimation();
      pending.current = id;
      // Claim the highlight now so it never lags the click, and hold the
      // observer off until we land.
      animating.current = true;
      setActive(id);

      const max = Math.max(0, container.scrollHeight - container.clientHeight);
      const target = destinationFor(element, container);
      const start = clamp(container.scrollTop, 0, max);

      // Already there (or as close as the scroll range allows) — settle now
      // instead of starting a no-op animation. Clicking the same chip over and
      // over is harmless because of this.
      if (Math.abs(target - start) < 1) {
        animating.current = false;
        pending.current = null;
        return;
      }

      if (prefersReducedMotion()) {
        container.scrollTop = target;
        animating.current = false;
        pending.current = null;
        return;
      }

      const duration = 380;
      const began = performance.now();
      const step = (now: number) => {
        const t = clamp((now - began) / duration, 0, 1);
        container.scrollTop = start + (target - start) * easeOutCubic(t);
        if (t < 1) {
          frame.current = requestAnimationFrame(step);
          return;
        }
        frame.current = 0;
        animating.current = false;
        pending.current = null;
        // Land exactly on the destination. The clamp above can leave the last
        // section short of its ideal offset, so the highlight is settled on
        // what the user asked for rather than re-derived from the geometry.
        setActive(id);
      };
      frame.current = requestAnimationFrame(step);
    },
    [destinationFor, resolveContainer, setActive, stopAnimation],
  );

  // Track the reader. Two mechanisms, because neither alone is sufficient:
  // the observer says which sections occupy the band under the sticky rail,
  // and the scroll pass resolves the gap between two tall sections where no
  // entry ever crosses.
  useEffect(() => {
    if (!enabled) return;
    const first = elements.current.get(ids[0] ?? "");
    if (!first) return;
    const container = resolveContainer(first);

    stopAnimation();
    pending.current = null;

    // Ids the reader currently has on screen in the band we care about.
    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        if (animating.current) return; // our own scroll — not an observation
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).id;
          if (entry.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        // No signal when nothing is intersecting (the reader is between two
        // sections), so only re-derive when the set actually changed.
        if (entries.some((e) => e.isIntersecting)) syncFromGeometry();
      },
      {
        root: container,
        // The band is the visible area with the sticky rail's height removed
        // from the top, so "intersecting" means "readable", not "on screen
        // behind the rail".
        rootMargin: `-${Math.round(
          stickyRef.current?.getBoundingClientRect().height ?? 0,
        )}px 0px -55% 0px`,
        threshold: [0, 0.01],
      },
    );
    for (const id of ids) {
      const element = elements.current.get(id);
      if (element && element.offsetParent !== null) observer.observe(element);
    }

    const syncFromGeometry = () => {
      if (animating.current) return;
      const offset =
        (stickyRef.current?.getBoundingClientRect().height ?? 0) +
        SECTION_GAP_PX;
      const containerTop = container.getBoundingClientRect().top;
      const laid = ids
        .map((id) => elements.current.get(id))
        .filter(
          (element): element is HTMLElement =>
            element != null && element.offsetParent !== null,
        );
      if (laid.length === 0) return;

      // The reader is in the last section whose top has passed the band; if
      // none has, they are above the first one.
      let best: string | null = null;
      for (const element of laid) {
        const top = element.getBoundingClientRect().top - containerTop;
        if (top - offset <= 1) {
          // Later sections come later in `laid`, so the last match wins
          // regardless of how tall any of them are.
          best = element.id;
        } else if (best === null && top < 0) {
          best = element.id;
        }
      }
      if (best === null) best = laid[0]!.id;
      setActive(best);
      visible.clear();
    };

    let raf = 0;
    const onScroll = () => {
      if (raf || animating.current) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        syncFromGeometry();
      });
    };

    syncFromGeometry();
    container.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      stopAnimation();
      observer.disconnect();
      container.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
    // `ids` is a module-level constant; depending on it would re-run this on
    // every render of the dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, resolveContainer, setActive, stopAnimation, stickyRef]);

  // A section that goes away (unmount, viewport change) must not stay
  // highlighted.
  useEffect(() => {
    if (!ids.includes(activeId)) setActive(ids[0] ?? "");
  }, [activeId, ids, setActive]);

  return { activeId, register, goTo };
}
