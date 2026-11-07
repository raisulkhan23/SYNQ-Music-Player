import { useCallback, useEffect, useRef } from "react";

import { AuthPromptDialog } from "@/components/auth/AuthPromptDialog";
import { useAuth } from "@/hooks/use-auth";
import { usePlayerStore } from "@/store/player";
import { useAuthGate, type AuthIntent } from "@/store/authGate";
import type { Playable } from "@/lib/playable";

/**
 * The bridge between Convex Auth and the deferred-auth gate.
 *
 * ## One writer, one reader
 *
 * This component is the ONLY place that writes `authenticated` into the gate,
 * and it does so from the existing `useAuth()` hook. Convex Auth remains the
 * single source of truth about who is signed in — this does not create a
 * second authentication system, it mirrors the existing one so that a plain
 * zustand store (which cannot call hooks) can ask the question.
 *
 * ## Finishing what the visitor was trying to do
 *
 * This is the part that makes the feature worth building. Someone clicks Play,
 * the dialog appears, they sign in — and then the song they chose actually
 * starts. They never have to find it again or press Play twice.
 *
 * It has to work for BOTH sign-in paths, which arrive very differently:
 *
 *  - **Email code.** The document never unloads. `isAuthenticated` flips in
 *    place and this effect runs a few hundred milliseconds later.
 *  - **OAuth.** `signIn()` navigates the whole document to the provider and
 *    back. Every React tree, including this one, is destroyed and rebuilt. The
 *    intent survives because it is plain JSON in sessionStorage, restored by
 *    the gate on construction, and executed here on the far side.
 *
 * ## Why playback runs FIRST
 *
 * The signal bridge that records plays has to be installed before a track
 * loads, or the first song after sign-in is the one song never written to
 * listening history. Awaiting the app shell's effect here would race it.
 */
export function AuthGateProvider() {
  const { isLoading, isAuthenticated } = useAuth();
  const setAuthenticated = useAuthGate((s) => s.setAuthenticated);
  const consume = useAuthGate((s) => s.consume);

  // Guards against running the intent twice. `consume` clears the pending
  // slot, but the effect can re-run while React is still committing (and
  // again under StrictMode's double-invoke in development), and playing the
  // song twice is a far worse bug than not playing it once.
  const resumed = useRef(false);

  useEffect(() => {
    // `null` while unresolved, which is a real third state and NOT the same as
    // false. The gate treats it as "ask nothing, decide later".
    setAuthenticated(isLoading ? null : isAuthenticated);
  }, [isLoading, isAuthenticated, setAuthenticated]);

  const resume = useCallback(() => {
    if (resumed.current) return;
    const intent = consume();
    if (!intent) return;
    resumed.current = true;
    // Clear the flag on the next tick so a LATER sign-in (sign out, sign in
    // again) can resume its own action. Without this the guest's second
    // attempt would be silently swallowed.
    queueMicrotask(() => {
      resumed.current = false;
    });
    runIntent(intent);
  }, [consume]);

  useEffect(() => {
    if (isLoading || !isAuthenticated) return;
    resume();
  }, [isLoading, isAuthenticated, resume]);

  return <AuthPromptDialog />;
}

/**
 * Execute a parked intent against the player store.
 *
 * Kept as data in the gate and turned into an action HERE, rather than stored
 * as a closure, so it can survive the OAuth reload. It re-enters the exact
 * same public store actions a click would have called — which means the gate
 * runs again on the way through and passes, because the session is now
 * genuinely authenticated. One path in, for clicks and for resumes alike.
 */
function runIntent(intent: AuthIntent): void {
  const store = usePlayerStore.getState();
  switch (intent.kind) {
    case "playTrack":
      store.playTrack(intent.track as Playable, intent.list as Playable[]);
      return;
    case "playListOrdered":
      store.playListOrdered(
        intent.track as Playable,
        (intent.list ?? []) as Playable[],
      );
      return;
    case "startRadio":
      store.startRadio(intent.track as Playable, intent.contextQuery);
      return;
    case "startPlaylistRadio":
      store.startPlaylistRadio(
        (intent.tracks ?? []) as Playable[],
        intent.label,
      );
      return;
    case "playViaStream":
      store.playViaStream(intent.track as Playable, intent.startSeconds);
      return;
    case "like":
      store.toggleLike(intent.trackId, intent.remote as never);
      return;
    case "likeAlbum":
      store.toggleLikedAlbum(intent.albumId);
      return;
    default:
      // An intent kind this build does not understand (an older tab, a
      // half-written value). Dropping it is correct: doing nothing is always
      // better than guessing at an action the visitor did not ask for.
      return;
  }
}
