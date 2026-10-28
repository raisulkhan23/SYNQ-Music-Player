import { Logo } from "@/components/brand/Logo";
import { SiteFooter } from "@/components/landing/SiteFooter";
import { ArrowLeft } from "lucide-react";
import { Link } from "react-router";
import type { ReactNode } from "react";

/**
 * Shared shell for the standalone information pages (Support, Privacy, Terms)
 * that the landing footer links to. Each page supplies its own copy so the
 * content lives in `src/pages`, and this handles the chrome plus a
 * scroll-spy-free table of contents.
 */
export function InfoPage({
  eyebrow,
  title,
  intro,
  updated,
  sections,
}: {
  eyebrow: string;
  title: string;
  intro: string;
  updated: string;
  sections: { id: string; heading: string; body: ReactNode }[];
}) {
  return (
    <div className="relative min-h-dvh overflow-x-hidden bg-background pt-[env(safe-area-inset-top)] text-foreground">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px]">
        <div className="absolute left-1/2 top-[-260px] h-[620px] w-[900px] -translate-x-1/2 rounded-full bg-brand/12 blur-3xl" />
      </div>

      <header className="relative z-10 mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-4 py-6 sm:px-6">
        <Logo to="/" />
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 rounded-full border border-white/10 px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:border-white/25 hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to SYNQ
        </Link>
      </header>

      <main className="relative z-10 mx-auto w-full max-w-5xl px-4 pt-6 pb-20 sm:px-6 sm:pt-10">
        <p className="text-[10px] font-bold tracking-[0.24em] text-brand uppercase">
          {eyebrow}
        </p>
        <h1 className="mt-4 font-display text-4xl font-bold tracking-tight sm:text-5xl">
          {title}
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground">
          {intro}
        </p>
        <p className="mt-3 text-xs text-muted-foreground/70">
          Last updated {updated}
        </p>

        <div className="mt-12 grid gap-10 lg:grid-cols-[200px_1fr] lg:gap-14">
          <nav className="lg:sticky lg:top-8 lg:self-start">
            <p className="text-[10px] font-bold tracking-[0.22em] text-muted-foreground uppercase">
              On this page
            </p>
            <ul className="mt-4 space-y-2">
              {sections.map((section) => (
                <li key={section.id}>
                  <a
                    href={`#${section.id}`}
                    className="block text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {section.heading}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="min-w-0 space-y-10">
            {sections.map((section) => (
              <section
                key={section.id}
                id={section.id}
                className="scroll-mt-24 rounded-2xl border border-white/[0.07] bg-white/[0.03] p-6 sm:p-7"
              >
                <h2 className="font-display text-xl font-semibold tracking-tight">
                  {section.heading}
                </h2>
                <div className="mt-3 space-y-3 text-sm leading-7 text-muted-foreground [&_a]:text-brand [&_a]:underline [&_a]:underline-offset-4 [&_strong]:font-semibold [&_strong]:text-foreground">
                  {section.body}
                </div>
              </section>
            ))}
          </div>
        </div>

        <div className="mt-14 flex flex-wrap items-center justify-center gap-3 rounded-3xl border border-white/10 bg-white/[0.03] px-6 py-8 text-center">
          <p className="text-sm font-medium">Ready when you are.</p>
          <Link
            to="/auth?returnTo=/home"
            className="rounded-full bg-brand px-5 py-2.5 text-sm font-semibold text-brand-foreground transition-transform hover:scale-105"
          >
            Start listening
          </Link>
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
