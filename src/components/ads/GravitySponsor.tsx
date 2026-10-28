import { useEffect, useState } from "react";
import { useAction } from "convex/react";
import { GravityAd, type AdResponse } from "@gravity-ai/react";
import { api } from "@/convex/_generated/api";
import { cn } from "@/lib/utils";
import { Sparkles } from "lucide-react";

/**
 * A single, clearly-labelled sponsored slot.
 *
 * Deliberately restrained: one card, labelled, skippable, and it renders
 * nothing at all when the integration isn't configured (no key, no fill) or
 * after the user dismisses it for this view. The request happens server-side,
 * so no API key is ever exposed.
 */

const VISITOR_KEY = "ss.gravityVisitorId";
const adCache = new Map<string, AdResponse | null>();

function getVisitorId(): string {
  try {
    const existing = localStorage.getItem(VISITOR_KEY);
    if (existing) return existing;
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(VISITOR_KEY, id);
    return id;
  } catch {
    return `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function GravitySponsor({
  context,
  placement = "search_results",
  className,
}: {
  context: string;
  placement?: string;
  className?: string;
}) {
  const requestAds = useAction(api.gravity.requestAds);
  const [ad, setAd] = useState<AdResponse | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (dismissed) return;
    const query = context.trim();
    if (query.length < 2) return;
    const key = `${placement}:${query}`;
    const cached = adCache.get(key);
    let cancelled = false;
    if (cached !== undefined) {
      const timer = window.setTimeout(() => {
        if (!cancelled) setAd(cached);
      }, 0);
      return () => {
        cancelled = true;
        window.clearTimeout(timer);
      };
    }

    const timer = window.setTimeout(() => {
      void requestAds({ context: query, placement, visitorId: getVisitorId() })
        .then((res) => {
          if (cancelled) return;
          const first = res.ads?.[0];
          const nextAd: AdResponse | null =
            first && typeof first.adText === "string" ? first : null;
          adCache.set(key, nextAd);
          setAd(nextAd);
        })
        .catch(() => undefined);
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [context, dismissed, placement, requestAds]);

  const dismiss = () => {
    setDismissed(true);
    setAd(null);
  };

  if (dismissed || ad === null) return null;

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4",
        className,
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[10px] font-semibold tracking-widest text-muted-foreground/80 uppercase">
          <Sparkles className="size-3" />
          Sponsored
        </span>
        <button
          type="button"
          onClick={dismiss}
          aria-label="Hide sponsored content"
          className="rounded-full px-2 py-0.5 text-[10px] text-muted-foreground/70 transition-colors hover:bg-white/[0.06] hover:text-foreground"
        >
          Hide ads
        </button>
      </div>
      <GravityAd
        ad={ad}
        variant="labeled"
        showLabel={false}
        openInNewTab
        className="w-full"
      />
    </div>
  );
}
