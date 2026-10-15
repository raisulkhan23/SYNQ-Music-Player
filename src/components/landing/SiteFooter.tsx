import { Logo } from "@/components/brand/Logo";
import { InfiniteSlider } from "@/components/core/infinite-slider";
import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

/**
 * Landing footer, composed like a launch-directory masthead: a scalloped top
 * edge, a brand block with a "featured on" badge row, four small-caps link
 * columns, an oversized ghosted wordmark bleeding off both sides behind
 * everything, a centred copyright pill, and a floating promise pill.
 *
 * Deliberately built from the app's own tokens (`brand`, `muted-foreground`,
 * glass surfaces) rather than any single flat brand colour, so it re-themes
 * with the accent picker and stays legible in light, dark and amoled.
 */

/**
 * One "featured on" badge.
 *
 * These images come from third-party launch directories, so they can fail for
 * reasons SYNQ cannot control: the directory is down, it moved the badge path,
 * the device is offline, or a privacy/blocklist extension stops the request. A
 * bare <img> then paints the browser's broken-image glyph inside this bordered
 * tile — which is what made the landing footer look unfinished in the packaged
 * app, where the badge hosts are often unreachable.
 *
 * On error the badge withdraws itself. That is the right trade for decoration
 * that points at someone else's site: losing one costs nothing, while a row of
 * broken-image icons costs credibility. This is not "hiding an error" — the
 * badge is remote artwork with no bundled replacement, and the directory is
 * still reachable from its own site; there is simply nothing useful to show.
 * Badges that do load behave exactly as before (real link, real hover/focus).
 */
function FeaturedBadge({
  badge,
}: {
  badge: (typeof featuredOn)[number];
}) {
  const [unavailable, setUnavailable] = useState(false);
  if (unavailable) return null;

  return (
    <a
      href={badge.href}
      target="_blank"
      rel="noopener noreferrer"
      className={`block shrink-0 border border-white/75 transition-all duration-200 hover:-translate-y-0.5 hover:border-white focus-visible:-translate-y-0.5 focus-visible:border-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--tint))] ${badge.radius}`}
    >
      <img
        src={badge.badge}
        alt={`Featured on ${badge.name}`}
        width={badge.width}
        height={badge.height}
        loading="lazy"
        decoding="async"
        onError={() => setUnavailable(true)}
        className="block h-8 w-auto"
      />
    </a>
  );
}

const linkColumns = [
  {
    heading: "Explore",
    links: [
      { label: "Features", to: "/#features" },
      { label: "Experience", to: "/#experience" },
    ],
  },
  {
    heading: "Get started",
    links: [
      { label: "Sign in", to: "/auth" },
      { label: "Your library", to: "/home" },
      { label: "New playlist", to: "/auth?returnTo=/playlists" },
    ],
  },
  {
    heading: "Product",
    links: [
      { label: "Listening stats", to: "/auth?returnTo=/stats" },
      { label: "Discover weekly", to: "/auth?returnTo=/home" },
    ],
  },
  {
    heading: "Connect",
    links: [
      { label: "Support", to: "/support" },
      { label: "Privacy", to: "/privacy" },
      { label: "Terms", to: "/terms" },
    ],
  },
] as const;

// `radius` mirrors the corner shape each badge already draws, so the white
// keyline we add hugs its own outline instead of boxing a pill inside a
// rectangle. Launch Streak and EasyDoFollow ship a near-white stroke inside
// their own artwork; ours lands on the same pixels there, so they read as one
// line rather than two.
const featuredOn = [
  {
    name: "EasyLaunch",
    href: "https://easylaunch.dev/media/synqmusic",
    badge: "https://easylaunch.dev/badge/easylaunch-badge-dark.svg",
    width: 188,
    height: 56,
    radius: "rounded-full",
  },
  {
    name: "Sky Launch",
    href: "https://skylaun.ch/media/synqmusic",
    badge: "https://skylaun.ch/badge/skylaunch-badge-dark.svg",
    width: 188,
    height: 56,
    radius: "rounded-lg",
  },
  {
    name: "Launch Streak",
    href: "https://launchstreak.dev/media/synqmusic",
    badge: "https://launchstreak.dev/badge/launch-streak-badge-dark.svg",
    width: 248,
    height: 68,
    radius: "rounded-xl",
  },
  {
    name: "EasyDoFollow",
    href: "https://easydofollow.dev/media/synqmusic",
    badge: "https://easydofollow.dev/badge/easydofollow-badge-dark.svg",
    width: 188,
    height: 56,
    radius: "rounded-xl",
  },
  {
    name: "Wired Business",
    href: "https://wired.business",
    badge: "https://wired.business/badge0-dark.svg",
    width: 200,
    height: 54,
    radius: "rounded-lg",
  },
] as const;

export function SiteFooter() {
  return (
    /* The footer sits on top of whatever wallpaper the listener picked, so a
       1.5%-white wash left the copy, the badges and the tick marks to be read
       against a photo. It now carries a real surface — a mostly-opaque
       `background` — so contrast is the same on the default dark theme and on
       a bright photo, and the hairline above it is bright enough to read as an
       edge instead of a guess. Deliberately NO `backdrop-filter`: this is a
       full-width element inside the shell's scroll container, so a blur here
       re-ran over the whole footer on every scroll frame, and the 80% surface
       already does the job the blur was doing. */
    <footer className="footer-scallop relative z-10 mt-8 border-t border-white/15 bg-background/80 pt-16 pb-10 sm:mt-12 sm:pt-20">
      {/* Clipping lives on its own layer, NOT on the footer: the scalloped
          edge is drawn above the footer's top border, so an `overflow-hidden`
          here would cut the bumps off entirely. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        {/* Oversized wordmark bleeding off the bottom, the way a masthead sets
            its own name behind the content. */}
        <span className="absolute inset-x-0 -bottom-4 block select-none text-center font-display text-[26vw] leading-none font-bold tracking-tighter text-white/[0.05] sm:-bottom-6">
          SYNQ
        </span>
      </div>

      <div className="relative mx-auto w-full max-w-6xl px-4 sm:px-6">
        <div className="grid gap-12 lg:grid-cols-[1.15fr_1.85fr] lg:gap-10">
          {/* brand block */}
          <div className="max-w-sm">
            <Logo to="/home" />
            <p className="mt-4 text-sm leading-6 text-foreground/70">
              A home for the songs you actually want to hear — no ads, no
              clutter, and a queue that moves like you do.
            </p>

            <span
              aria-hidden="true"
              className="mt-8 block h-px w-5 bg-[rgb(var(--tint))]/90"
            />
            <p className="mt-3 font-mono text-[10px] tracking-[0.2em] text-foreground/60 uppercase">
              Featured on
            </p>
            {/* The badges drift rather than wrap. They were a flex-wrap list,
                which broke into two ragged rows in a narrow column and read as
                an accident; a marquee reads as deliberate and keeps the row to
                a single line at every width. The badges stay exactly as they
                were — real links, real hover and focus states — and only the
                copies past the first are inert, so each launch directory is
                clickable and keyboard-reachable once, not four times. */}
            <InfiniteSlider
              speed={20}
              // EASE OFF on hover. A badge is a link to somebody's launch
              // directory, and a link you cannot hit is a dead button. This
              // used to be 4, which accelerated the strip four-fold at exactly
              // the moment the pointer arrived to click something.
              speedOnHover={0.2}
              gap={10}
              label="Launch directories featuring SYNQ"
              className="mt-3"
            >
              {featuredOn.map((badge) => (
                <FeaturedBadge key={badge.name} badge={badge} />
              ))}
            </InfiniteSlider>
          </div>

          {/* link columns */}
          <nav className="grid grid-cols-2 gap-8 sm:grid-cols-4 sm:gap-6">
            {linkColumns.map((column) => (
              <div key={column.heading} className="min-w-0">
                {/* A short accent tick + mono heading instead of a loud
                    uppercase title in the accent colour on all four columns.
                    Four identical shouty headings is the template tell; a
                    quiet rule and a mono label reads as set typography. */}
                <span
                  aria-hidden="true"
                  className="block h-px w-5 bg-[rgb(var(--tint))]/90"
                />
                <p className="mt-3 font-mono text-[10px] tracking-[0.2em] text-foreground/60 uppercase">
                  {column.heading}
                </p>
                <ul className="mt-3.5">
                  {column.links.map((link, i) => (
                    <li key={link.label} className="min-w-0">
                      {/* Numbered rows echo the Contents index on the legal
                          pages, and the row-wide hover target gives each link
                          a real affordance instead of a bare colour swap. */}
                      <Link
                        to={link.to}
                        className="group -mx-2 flex items-baseline gap-2.5 rounded-md px-2 py-[5px] transition-colors hover:bg-white/[0.05] focus-visible:bg-white/[0.05]"
                      >
                        <span className="w-4 shrink-0 font-mono text-[10px] text-foreground/45 tabular-nums transition-colors group-hover:text-[rgb(var(--tint))]/80">
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        <span className="truncate text-sm text-foreground/85 transition-colors group-hover:text-foreground">
                          {link.label}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>

        {/* Bottom row: the copyright plaque sits in the bottom-RIGHT corner and
            the promise pill balances it on the left. Both used to be stacked —
            the promise pill was absolutely positioned in the corner while the
            plaque was centred in flow, so they sat on unrelated baselines. One
            flex row keeps their bottom edges aligned at every width.
            `justify-end` (not `justify-between`) on mobile, where the promise
            pill is hidden and a lone left-aligned child would look stranded. */}
        <div className="mt-14 flex flex-wrap items-end justify-end gap-4 sm:mt-16 sm:justify-between">
          <div className="hidden sm:block">
            <div className="inline-flex items-center gap-2.5 rounded-full border border-white/20 bg-white/[0.07] py-2 pr-3 pl-2.5">
              <span className="flex size-7 items-center justify-center rounded-full bg-[rgb(var(--tint))]/15 text-[rgb(var(--tint))]">
                <ShieldCheck className="size-3.5" />
              </span>
              <span className="text-xs font-semibold text-foreground">
                Zero ads
              </span>
              <span className="rounded-full bg-[rgb(var(--tint))] px-2 py-0.5 text-[10px] font-bold text-black">
                forever
              </span>
            </div>
          </div>

          <div className="inline-flex max-w-full flex-col items-center gap-1.5 rounded-2xl border border-white/20 bg-white/[0.07] px-6 py-3.5 text-center">
            <p className="font-mono text-xs font-medium tracking-tight text-foreground">
              © 2026 SYNQ — currently in beta
            </p>
            <p className="font-mono text-[10px] font-bold tracking-[0.26em] text-[rgb(var(--tint))] uppercase">
              Made for long listens
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
