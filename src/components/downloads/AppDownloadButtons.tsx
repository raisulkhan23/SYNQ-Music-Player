"use client";

import { Download, Monitor, Smartphone } from "lucide-react";

import {
  appDownloads,
  type AppDownload,
  type AppPlatform,
} from "@/lib/appDownloads";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/utils";

/** Fire-and-forget: analytics must never delay or block a download. */
function noteDownload(platform: AppPlatform, fileName: string) {
  try {
    track("app_download", { platform, fileName });
  } catch {
    // Analytics is optional; a missing transport is not a download failure.
  }
}

const ICONS: Record<AppPlatform, typeof Monitor> = {
  windows: Monitor,
  android: Smartphone,
};

/**
 * Windows + Android download buttons, rendered from `APP_DOWNLOADS`.
 *
 * Two layouts on purpose. The landing page wants the platform promoted — a
 * card per platform with the icon, the requirement and the size, so nobody
 * downloads an installer their machine cannot run. Settings wants the same
 * information as a compact row that matches the glass rows around it, because
 * it sits inside a list of other settings.
 *
 * Both are real `<a download>` links: the browser handles the transfer, progress
 * and resume, and nothing here can fail silently the way a JS-driven download
 * can.
 */
export function AppDownloadButtons({
  variant = "hero",
  className,
}: {
  variant?: "hero" | "rows";
  className?: string;
}) {
  return (
    <div
      className={cn(
        variant === "hero"
          ? "flex flex-col gap-3 sm:flex-row sm:flex-wrap"
          : "flex flex-col gap-2",
        className,
      )}
    >
      {appDownloads().map((item) => (
        <DownloadLink key={item.id} item={item} variant={variant} />
      ))}
    </div>
  );
}

function DownloadLink({
  item,
  variant,
}: {
  item: AppDownload;
  variant: "hero" | "rows";
}) {
  const Icon = ICONS[item.id];

  if (variant === "rows") {
    return (
      <a
        href={item.href}
        download={item.fileName}
        onClick={() => noteDownload(item.id, item.fileName)}
        className="group flex items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5 transition-colors hover:border-[rgb(var(--tint)_/_0.35)] hover:bg-white/[0.05]"
      >
        <Icon className="size-4 shrink-0 text-[rgb(var(--tint))]" />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{item.label}</span>
          <span className="block text-xs text-muted-foreground">
            {item.detail}
          </span>
        </span>
        <span className="shrink-0 rounded-full border border-white/10 px-2.5 py-1 text-[11px] font-semibold tabular-nums text-muted-foreground transition-colors group-hover:border-white/20 group-hover:text-foreground">
          {item.sizeLabel}
        </span>
      </a>
    );
  }

  return (
    <a
      href={item.href}
      download={item.fileName}
      onClick={() => noteDownload(item.id, item.fileName)}
      className="group flex min-w-[15rem] items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3.5 transition-colors hover:border-[rgb(var(--tint)_/_0.4)] hover:bg-white/[0.07]"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[rgb(var(--tint)_/_0.14)] text-[rgb(var(--tint))]">
        <Icon className="size-5" />
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="flex items-center gap-2 text-sm font-semibold">
          {item.label}
          <Download className="size-3.5 text-muted-foreground transition-transform group-hover:translate-y-0.5" />
        </span>
        <span className="block text-xs text-muted-foreground">
          {item.requirement} · {item.sizeLabel}
        </span>
      </span>
    </a>
  );
}
