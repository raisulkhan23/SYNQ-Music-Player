import { Download, Loader2, Smartphone } from "lucide-react";
import { toast } from "sonner";

import { usePwaInstall, manualInstallHint, planInstallBlock } from "@/lib/pwa";
import { cn } from "@/lib/utils";

/**
 * The "download SYNQ" button.
 *
 * ## Why this is shared
 *
 * Installability has three surfaces — the landing page, the in-app install
 * strip and the Settings row — and each one has to agree. When the install
 * affordance only existed inside the signed-in shell, the one moment a visitor
 * is most likely to want the app (on the marketing page, before they have any
 * reason to make an account) was the one moment it was unreachable. Under
 * deferred authentication that gap got worse: a visitor no longer passes
 * through a sign-in wall on the way in, so they now reach the landing page and
 * stay there.
 *
 * One component, three call sites, one implementation of the states.
 *
 * ## Why it never lies
 *
 * `usePwaInstall` resolves to `ready`, `manual`, `dismissed`, `installed` or
 * `unavailable`. The button reflects exactly that. In particular it does not
 * show a dead "Download" that silently does nothing in a dev preview: it
 * names the real reason through `planInstallBlock` — no service worker, dev
 * build, or no HTTPS — because a button that fails in silence reads as a
 * broken app rather than an unavailable feature.
 */
export function InstallAppButton({
  className,
  variant = "outline",
}: {
  className?: string;
  /** `outline` sits beside a primary CTA; `solid` stands alone. */
  variant?: "outline" | "solid";
}) {
  const { state, install, installed } = usePwaInstall();

  // Already installed: there is nothing to download, and saying so is more
  // useful than a button that does nothing.
  if (state === "installed" || installed) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-2 rounded-full border border-white/10 px-5 py-3 text-sm font-semibold text-muted-foreground",
          className,
        )}
      >
        <Smartphone className="size-4" />
        App installed
      </span>
    );
  }

  const blocked = planInstallBlock({
    hasServiceWorker: "serviceWorker" in navigator,
    isProd: import.meta.env.PROD,
    isSecureContext: window.isSecureContext,
  });

  const handleClick = async () => {
    if (blocked) {
      toast.error("Can't install yet", { description: blocked });
      return;
    }
    if (state === "manual") {
      // No `beforeinstallprompt` to call — the browser has to be driven from
      // its own menu, so say exactly where to look rather than doing nothing.
      toast("Install SYNQ", {
        description: manualInstallHint(
          /iPad|iPhone|iPod/.test(navigator.userAgent),
        ),
      });
      return;
    }
    const ok = await install();
    if (ok) toast.success("SYNQ installed");
  };

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      aria-label="Download SYNQ as an app"
      className={cn(
        "inline-flex items-center gap-2 rounded-full px-5 py-3 text-sm font-semibold transition-transform",
        variant === "solid"
          ? "bg-brand text-brand-foreground shadow-[0_10px_36px_rgb(203_244_143/0.4)] hover:scale-105"
          : "border border-white/10 text-muted-foreground transition-colors hover:border-white/20 hover:text-foreground",
        className,
      )}
    >
      {state === "ready" ? (
        <Download className="size-4" />
      ) : (
        <Loader2 className="size-4" />
      )}
      Download app
    </button>
  );
}
