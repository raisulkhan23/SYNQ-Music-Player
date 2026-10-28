import { useEffect, useRef } from "react";
import { useLocation } from "react-router";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { deviceBucketOf } from "@/lib/visitAnalytics";

/**
 * Records one visit per route change.
 *
 * The hard requirement here is that this component can NEVER affect the app.
 * Analytics that can break navigation are worse than no analytics, so every
 * guard below is deliberate:
 *
 * - It renders null. There is no DOM, no layout, nothing to shift.
 * - It records in an effect, never during render, so React never sees a state
 *   update caused by a network call.
 * - The mutation is called with `.catch(() => {})`; an unauthenticated visitor,
 *   an offline device or a deployment without the function all resolve to
 *   silence rather than an unhandled rejection.
 * - `recordVisit` is idempotent per visitor within a 1.2s window, so the
 *   StrictMode double-invoke in development cannot double-count.
 *
 * Rendered ONCE, in the app shell. Mounting it per-route would re-send on every
 * navigation and defeat the whole point.
 */
export function VisitTracker() {
  const location = useLocation();
  const recordVisit = useMutation(api.analytics.recordVisit);
  // Guards against a re-render (not a navigation) re-sending the same view.
  const lastPath = useRef<string | null>(null);

  useEffect(() => {
    const path = location.pathname;
    if (lastPath.current === path) return;
    lastPath.current = path;

    try {
      void recordVisit({
        path,
        visitorId: visitorId(),
        referrerPath: sameOriginReferrerPath(),
        device: deviceBucketOf(
          typeof navigator === "undefined" ? undefined : navigator.userAgent,
          typeof window === "undefined" ? undefined : window.innerWidth,
        ),
      }).catch(() => {
        // A dropped visit is not worth surfacing to a listener.
      });
    } catch {
      // Analytics must never throw into a route change.
    }
  }, [location.pathname, recordVisit]);

  return null;
}

/**
 * The referrer path, but only when the listener actually came from this app.
 *
 * A cross-site referrer is the one piece of third-party data that could ride
 * along with every single page view, and it is worth nothing to an admin
 * dashboard that only needs to know "did they click through from Home?". It is
 * filtered HERE rather than on the server because the browser is the only
 * place that knows the current origin — there is no `location` global in the
 * Convex runtime (verified against the live deployment, not assumed) — so a
 * server-side check could never pass.
 */
function sameOriginReferrerPath(): string | undefined {
  if (typeof document === "undefined") return undefined;
  const ref = document.referrer;
  if (!ref) return undefined;
  try {
    const url = new URL(ref);
    if (url.origin !== window.location.origin) return undefined;
    return url.pathname;
  } catch {
    return undefined;
  }
}

/**
 * A random id for this browser, kept in localStorage.
 *
 * Explicitly NOT a fingerprint: it is a fresh random value, not derived from
 * the user agent, screen, canvas or anything else, and it is never sent
 * anywhere except this app's own Convex deployment. Clearing site data or
 * using a different browser produces a different visitor.
 */
const VISITOR_KEY = "ss.visitVisitorId";

function visitorId(): string {
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
    // Private browsing with storage disabled. A per-session id still counts
    // the visit correctly; it just counts this browser as a new visitor.
    return `anon-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
}
