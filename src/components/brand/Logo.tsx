import { useState } from "react";
import { cn } from "@/lib/utils";
import { publicAsset } from "@/lib/publicAsset";
import { Link } from "react-router";
import { ArrowRightFromLine } from "lucide-react";

/**
 * Versioned so a new mark is never served from a browser's cache.
 *
 * The file lives in /public, so its URL never changes when the asset does —
 * which means a browser (and any proxy in front of the preview) can happily
 * keep showing the PREVIOUS logo long after the new one was deployed. Bumping
 * this string is the whole fix: a changed query string is a different
 * resource, so the old cached copy cannot be reused. Bump it whenever the
 * mark itself changes.
 */
export const LOGO_SRC = publicAsset("logo.png?v=6");

/** iconOnly renders just the mark — used in the collapsed sidebar rail.
 *  Passing `onToggle` there turns the mark into the rail's expand control. */
export function Logo({
  to = "/home",
  className,
  iconOnly = false,
  onToggle,
}: {
  to?: string;
  className?: string;
  iconOnly?: boolean;
  /** Expand-only: the mark in the collapsed rail reopens the sidebar. The
   *  expanded wordmark stays a plain link, because collapsing is the job of
   *  the dedicated control in the sidebar header. */
  onToggle?: () => void;
}) {
  // Pointer only, never focus: a keyboard user tabbing onto the control should
  // keep seeing the mark, and a touch tap must not leave the icon stuck in
  // place after the finger lifts.
  const [hovered, setHovered] = useState(false);

  if (iconOnly && onToggle) {
    return (
      <button
        type="button"
        onClick={onToggle}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        aria-label="Expand sidebar"
        title="Expand sidebar"
        className={cn("group inline-flex", className)}
      >
        <span className="relative inline-flex items-center justify-center">
          <img
            src={LOGO_SRC}
            alt="SYNQ logo"
            aria-hidden={hovered || undefined}
            className={cn(
              "h-7 w-auto shrink-0 transition-opacity duration-150",
              hovered && "opacity-0",
            )}
            width={104}
            height={104}
          />
          <ArrowRightFromLine
            aria-hidden
            className={cn(
              "absolute left-1/2 top-1/2 size-[18px] -translate-x-1/2 -translate-y-1/2 text-foreground transition-opacity duration-150",
              hovered ? "opacity-100" : "opacity-0",
            )}
          />
        </span>
      </button>
    );
  }

  if (iconOnly) {
    return (
      <Link to={to} className={cn("group inline-flex", className)}>
        <img
          src={LOGO_SRC}
          alt="SYNQ logo"
          className="h-7 w-auto shrink-0"
          width={104}
          height={104}
        />
      </Link>
    );
  }
  return (
    <Link
      to={to}
      className={cn("group inline-flex items-center gap-2.5", className)}
    >
      <img
        src={LOGO_SRC}
        alt="SYNQ logo"
        className="shrink-0 h-[26px] w-auto"
        width={104}
        height={104}
      />
      <span className="font-display text-[17px] font-bold tracking-tight">
        SYNQ
      </span>
      {!iconOnly && (
        <span className="rounded-full border border-[rgb(var(--tint)/0.35)] bg-[rgb(var(--tint)/0.12)] px-1.5 py-px text-[9px] font-bold tracking-[0.08em] text-[rgb(var(--tint))] uppercase">
          Beta{" "}
        </span>
      )}
    </Link>
  );
}
