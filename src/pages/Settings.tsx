import { SettingsDialog } from "@/components/settings/SettingsDialog";
import { useAccountActions } from "@/hooks/use-account-actions";

/**
 * Settings as a ROUTE.
 *
 * This is the only settings surface that actually opens: the two sidebar
 * copies of `SettingsDialog` and the one in `AppShell` are mounted with
 * `open={false}` and no code path ever flips that state, so they are dead.
 *
 * Because this page did not pass `onSignOut`, the dialog's own sign-out row
 * (`{onSignOut && ...}`) was hidden here — which, combined with the dead
 * copies, is the whole reason the app appeared to have no way to log out.
 * The action comes from the shared hook so it clears the listening session
 * and lands somewhere sensible, exactly like every other surface.
 */
export default function Settings() {
  const { signOut } = useAccountActions();

  return (
    <SettingsDialog
      open
      pageMode
      onOpenChange={() => {
        // This is a route, not a dismissible dialog. Radix can still emit an
        // outside-press event when modal={false}; clicking the app around the
        // page must never navigate away from Settings.
      }}
      onSignOut={signOut}
    />
  );
}
