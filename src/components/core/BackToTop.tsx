import { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Back-to-top, for the long pages (Discover, an artist with a big catalogue).
 *
 * `ScrollToTop` already resets the scroll position on NAVIGATION; this is the
 * other half of that problem — a listener who has scrolled a long way down one
 * page and wants back without hunting for the nav.
 *
 * Three things keep it out of the way:
 * - It renders nothing at all until there is somewhere to go back to, so it
 *   never floats over a short page.
 * - It is a real `<button>` with a label, so it is reachable by keyboard and
 *   announced, not a div with an onClick.
 * - It respects `prefers-reduced-motion` and jumps instead of animating.
 */
export function BackToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      // Two screens of scrolling before it appears, and only if the page is
      // actually taller than the viewport in the first place.
      const scrollable =
        document.documentElement.scrollHeight > window.innerHeight + 200;
      setVisible(scrollable && window.scrollY > window.innerHeight);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  if (!visible) return null;

  const toTop = () => {
    const reduce =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  };

  return (
    <button
      type="button"
      onClick={toTop}
      aria-label="Back to top"
      className={cn(
        "fixed right-4 bottom-24 z-40 flex size-10 items-center justify-center rounded-full",
        "border border-white/10 bg-[#12151d]/90 text-muted-foreground shadow-xl backdrop-blur-xl",
        "transition-colors hover:border-white/20 hover:text-foreground",
        "focus-visible:ring-2 focus-visible:ring-[rgb(var(--tint))] focus-visible:outline-none",
      )}
    >
      <ArrowUp className="size-4" />
    </button>
  );
}
