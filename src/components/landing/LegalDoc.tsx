import { Logo } from "@/components/brand/Logo";
import { SiteFooter } from "@/components/landing/SiteFooter";
import { ArrowLeft } from "lucide-react";
import { Link } from "react-router";
import type { ReactNode } from "react";

/**
 * Document layout for the legal pages.
 *
 * Deliberately NOT the card-based `InfoPage` shell. Stacking every section in
 * an identical rounded panel with a big gradient blob above it is the tell of
 * a generated page: uniform rhythm, no hierarchy, nothing that looks authored.
 * This reads like a document instead — a contents index with dotted leaders,
 * a hanging number column, hairline rules instead of boxes, and an optional
 * pull-out note so the beta disclaimer interrupts the rhythm.
 */
export function LegalDoc({
  title,
  version,
  effective,
  preamble,
  sections,
}: {
  title: string;
  version: string;
  effective: string;
  preamble: string;
  sections: {
    id: string;
    heading: string;
    body: ReactNode;
    note?: string;
  }[];
}) {
  const pad = (n: number) => String(n + 1).padStart(2, "0");

  return (
    <div className="min-h-dvh bg-background pt-[env(safe-area-inset-top)] text-foreground">
      <div className="mx-auto w-full max-w-3xl px-5 sm:px-8">
        {/* document header */}
        <header className="flex items-center justify-between gap-4 py-6">
          <Logo              to="/home" />
          <Link
                         to="/home"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            Back
          </Link>
        </header>

        <div className="border-t border-white/[0.08] pt-10 pb-6">
          <p className="font-mono text-[11px] tracking-[0.18em] text-muted-foreground/70 uppercase">
            SYNQ · Legal
          </p>
          <h1 className="mt-5 font-display text-4xl leading-[1.05] font-bold tracking-tight sm:text-[2.75rem]">
            {title}
          </h1>
          <dl className="mt-6 flex flex-wrap gap-x-8 gap-y-1.5 font-mono text-[11px] text-muted-foreground">
            <div className="flex gap-2">
              <dt className="text-muted-foreground/50">Version</dt>
              <dd>{version}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-muted-foreground/50">Effective</dt>
              <dd>{effective}</dd>
            </div>
          </dl>
          <p className="mt-7 max-w-2xl text-[15px] leading-7 text-muted-foreground">
            {preamble}
          </p>
        </div>

        {/* contents */}
        <nav
          aria-label="Contents"
          className="border-t border-white/[0.08] py-8"
        >
          <p className="text-[10px] font-bold tracking-[0.22em] text-muted-foreground uppercase">
            Contents
          </p>
          <ol className="mt-4">
            {sections.map((section, i) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="group flex items-baseline gap-3 py-1.5"
                >
                  <span className="w-5 shrink-0 font-mono text-[11px] text-muted-foreground/45 tabular-nums">
                    {pad(i)}
                  </span>
                  <span className="shrink-0 text-sm text-muted-foreground transition-colors group-hover:text-foreground">
                    {section.heading}
                  </span>
                  <span className="mx-1 min-w-4 flex-1 translate-y-[-3px] border-b border-dotted border-white/12" />
                </a>
              </li>
            ))}
          </ol>
        </nav>

        {/* body */}
        <div className="border-t border-white/[0.08]">
          {sections.map((section, i) => (
            <section
              key={section.id}
              id={section.id}
              className="scroll-mt-20 border-b border-white/[0.06] py-10 last:border-b-0"
            >
              <div className="flex gap-4 sm:gap-7">
                <span className="w-5 shrink-0 pt-1.5 font-mono text-[11px] text-muted-foreground/45 tabular-nums sm:w-6">
                  {pad(i)}
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="font-display text-[22px] leading-tight font-semibold tracking-tight">
                    {section.heading}
                  </h2>
                  <div
                    className="mt-4 space-y-3.5 text-[15px] leading-7 text-muted-foreground
                      [&_a]:text-[rgb(var(--tint))] [&_a]:underline [&_a]:underline-offset-4
                      [&_em]:text-foreground/90
                      [&_li]:relative [&_li]:pl-5
                      [&_li]:before:absolute [&_li]:before:top-[0.85em] [&_li]:before:left-0
                      [&_li]:before:h-px [&_li]:before:w-2.5 [&_li]:before:bg-[rgb(var(--tint))]/55
                      [&_strong]:font-semibold [&_strong]:text-foreground
                      [&_ul]:space-y-2 [&_ul]:pl-0"
                  >
                    {section.body}
                  </div>

                  {section.note ? (
                    <aside className="mt-6 border-l-2 border-[rgb(var(--tint))]/45 bg-white/[0.02] py-3.5 pr-4 pl-4">
                      <p className="text-[13px] leading-6 text-muted-foreground">
                        {section.note}
                      </p>
                    </aside>
                  ) : null}
                </div>
              </div>
            </section>
          ))}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.08] py-8 font-mono text-[11px] text-muted-foreground/60">
          <span>SYNQ · {version}</span>
          <span>Effective {effective}</span>
        </footer>
      </div>

      <SiteFooter />
    </div>
  );
}
