import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import { useLocation } from "react-router";

import { AuthForm } from "@/components/auth/AuthForm";
import { useAuthGate } from "@/store/authGate";

/**
 * The deferred-authentication prompt.
 *
 * ## Why it is a dialog and not a redirect
 *
 * The thing it replaces was a full navigation to `/auth`, which threw away the
 * page the visitor was on. They arrived from a Home shelf, got bounced to a
 * sign-in card, and after signing in had to find their way back — losing
 * scroll position, the song they had chosen, and any sense of where they were.
 *
 * A dialog keeps all of that. Nothing unmounts, nothing navigates, and the
 * page behind it is still exactly where they left it.
 *
 * ## Why it explains itself
 *
 * A sign-in dialog with no stated reason reads as a broken app: the visitor
 * pressed Play, music did not start, and something is asking them for a
 * password. So the copy names the action that was interrupted. "Sign in to
 * start listening" and "Sign in to save this" are different sentences for a
 * reason.
 *
 * ## Why there is always a way out
 *
 * "Maybe later" is not a courtesy, it is the feature. A visitor who is not
 * ready to make an account must be able to keep browsing without being
 * ambushed by the same dialog on every click, and dismissal must not be
 * sticky enough to stop them asking later on purpose.
 */

/** Wording per interruption reason. Kept here so the copy stays in one place. */
const COPY = {
  playback: {
    title: "Sign in to start listening",
    body: "Create a free SYNQ account to play music and keep your listening experience synced across devices.",
    cta: "Sign in",
  },
  save: {
    title: "Sign in to save this",
    body: "Create a free SYNQ account to save music to your library and keep your likes in sync.",
    cta: "Sign in",
  },
  library: {
    title: "Sign in to use your library",
    body: "Your library, playlists and listening history are tied to your account.",
    cta: "Sign in",
  },
} as const;

export function AuthPromptDialog() {
  const open = useAuthGate((s) => s.open);
  const reason = useAuthGate((s) => s.reason);
  const authenticated = useAuthGate((s) => s.authenticated);
  const dismiss = useAuthGate((s) => s.dismiss);

  const location = useLocation();
  const copy = COPY[reason] ?? COPY.playback;

  // Return the visitor to exactly where they were. This matters most for
  // OAuth, which is a full document round-trip: without an explicit path the
  // server falls back to its own default origin and the listener can land on
  // a different site entirely.
  const returnTo = `${location.pathname}${location.search}`;
  const redirectTo = `${window.location.protocol}//${window.location.host}${returnTo}`;

  // Never show the prompt to someone who is already signed in, and never
  // show a half-styled dialog while the session is still resolving.
  if (authenticated === true) return null;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && dismiss()}>
      <DialogContent
        className="max-w-sm border-white/10 bg-white/[0.04] shadow-[0_30px_80px_rgba(0,0,0,0.5)] backdrop-blur-2xl"
        // The dialog is an interruption the listener did not ask for, so it
        // must be dismissible without reading anything: Escape and an overlay
        // click both land on `onOpenChange(false)` -> `dismiss`.
        showCloseButton
      >
        <div className="px-6 pt-6 text-center">
          <DialogTitle className="font-display text-xl">
            {copy.title}
          </DialogTitle>
          <DialogDescription className="mt-1.5 text-sm">
            {copy.body}
          </DialogDescription>
        </div>

        {authenticated === null ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <AuthForm redirectTo={redirectTo} />
            <div className="border-t border-white/[0.07] bg-white/[0.02] px-6 py-4 text-center">
              <Button
                type="button"
                variant="ghost"
                onClick={dismiss}
                className="w-full text-sm text-muted-foreground"
              >
                Maybe later
              </Button>
            </div>
          </>
        )}
        {/* Desktop OAuth return path: the dialog uses the same redirect target
            as the full-page auth screen, so the desktop runtime can hand the
            browser's callback back to the app. */}
        {window.synq?.desktop && (
          <span className="sr-only" data-desktop-redirect={returnTo} />
        )}
      </DialogContent>
    </Dialog>
  );
}
