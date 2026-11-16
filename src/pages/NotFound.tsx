import { Link } from "react-router";

/**
 * 404. No glow orb, no entrance animation, no shadowed pill: a page you reach
 * by accident needs to tell you where you are and offer the way out, in one
 * glance. The copy keeps the music metaphor because the site has earned it;
 * everything else is a hairline and two links.
 */
export default function NotFound() {
  return (
    <div className="relative flex min-h-dvh flex-col bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-foreground">
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center px-5 py-16 sm:px-6">
        <p className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
          <span className="text-brand">404</span>
          <span aria-hidden className="h-px w-6 bg-white/15" />
          <span>Not found</span>
        </p>
        <h1 className="mt-6 max-w-2xl font-display text-[clamp(2.4rem,6.5vw,4.25rem)] leading-[0.98] font-bold tracking-[-0.03em]">
          This track doesn&apos;t exist.
        </h1>
        <p className="mt-5 max-w-md text-[15px] leading-7 text-muted-foreground">
          The page you were looking for was skipped, deleted, or never queued.
          Your music is still where you left it.
        </p>
        <div className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-white/[0.07] pt-6">
          <Link
            to="/"
            className="inline-flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-brand-foreground transition-ui active:scale-[0.98]"
          >
            Back to SYNQ
          </Link>
          <Link
            to="/search"
            className="text-sm font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
          >
            Search for something else
          </Link>
        </div>
      </div>
    </div>
  );
}
