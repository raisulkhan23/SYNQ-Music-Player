import type { ReactNode } from "react";

export function SectionRow({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="truncate font-display text-lg font-bold tracking-tight sm:text-xl">
            {title}
          </h2>
          {subtitle && (
            <p className="mt-0.5 truncate text-sm text-muted-foreground">{subtitle}</p>
          )}
        </div>
        {action}
      </div>
      <div className="hide-scrollbar -mx-4 flex gap-4 overflow-x-auto px-4 pt-1 pb-2">
        {children}
      </div>
    </section>
  );
}