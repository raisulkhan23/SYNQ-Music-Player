import { useCallback, useState } from "react";
import { useNavigate } from "react-router";

import { useAuth } from "@/hooks/use-auth";
import { usePlayerStore } from "@/store/player";

/**
 * The one implementation of "leave this listening session".
 *
 * SYNQ had a sign-out button that nothing rendered. `LogoDropdown` was never
 * mounted by any route or layout; both sidebar copies of `SettingsDialog` sat
 * at `open={false}` with no code path that ever flipped that state; and the
 * `/settings` ROUTE — the only settings surface that actually opens — is
 * mounted without an `onSignOut`, so the dialog hides its own sign-out row
 * (`{onSignOut && ...}`). The result was no way to sign out at all, and no way
 * to move to a different account on a shared device.
 *
 * Every surface (sidebar rail, expanded sidebar, phone sheet) calls this, so
 * the action cannot exist in one layout and be missing from another.
 *
 * The order is deliberate and is the whole point: the queue and the
 * half-played track are cleared BEFORE `signOut()`, because they live in
 * localStorage and outlive the auth token. Signing out first and tidying
 * afterwards would still hand the next person the previous listener's queue.
 */
export function useAccountActions() {
  const { signOut } = useAuth();
  const resetForSignOut = usePlayerStore((s) => s.resetForSignOut);
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);

  /**
   * Sign out and land on `destination`.
   *
   * "/" is a plain sign-out (back to the landing page). "/auth" is a SWITCH:
   * Convex Auth keeps exactly one session per browser, so switching accounts
   * is necessarily sign-out-then-sign-in, and the useful destination is the
   * sign-in form rather than the marketing page.
   */
  const signOutAndGo = useCallback(
    async (destination: "/" | "/auth" = "/") => {
      if (pending) return;
      setPending(true);
      try {
        resetForSignOut();
        await signOut();
        void navigate(destination, { replace: true });
      } catch {
        // A listener who asked to be signed out must never be trapped in the
        // account they are trying to leave, so a rejected signOut still
        // navigates — the local session is already gone either way.
        void navigate(destination, { replace: true });
      } finally {
        setPending(false);
      }
    },
    [navigate, pending, resetForSignOut, signOut],
  );

  return {
    /** True while a sign-out is in flight; used to disable and spin the rows. */
    pending,
    /**
     * Plain sign out — back to the landing page.
     *
     * Returns the promise rather than swallowing it, so `SettingsDialog`'s
     * `await onSignOut()` actually keeps its spinner up for the duration.
     * Fire-and-forget made that button flash once and stop.
     */
    signOut: useCallback(() => signOutAndGo("/"), [signOutAndGo]),
    /** Sign out and open the sign-in form for a different account. */
    switchAccount: useCallback(() => signOutAndGo("/auth"), [signOutAndGo]),
    /** Escape hatch for callers that need the raw promise. */
    signOutAndGo,
  };
}
