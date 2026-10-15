import { create } from "zustand";

/**
 * The deferred-authentication gate.
 *
 * ## Why this exists
 *
 * SYNQ used to put every signed-in route behind a blanket `<RequireAuth>`, so
 * opening `/home` as a visitor threw the sign-in page at you before you had
 * seen a single song. That is the wrong order: nobody understands a product
 * they have not used, and asking for an account first is how you lose the
 * visitor permanently.
 *
 * The fix is deferred authentication, the way the big music services do it —
 * browse freely, and ask for an account at the moment an action genuinely
 * needs one.
 *
 * ## This is NOT a second authentication system
 *
 * The authority on "is this person signed in" remains Convex Auth, exactly as
 * before. `authenticated` here is a MIRROR of `useConvexAuth()`, written by
 * exactly one bridge component (`AuthGateProvider`). Nothing else writes it,
 * and nothing reads it to make a security decision — the backend still
 * enforces authentication on every mutation that needs identity. If the mirror
 * and the server ever disagreed, the server would be right and this would be
 * a cosmetic bug, not a hole.
 *
 * What this module owns is the part Convex Auth has no opinion about: *when*
 * to ask, *why*, and *what the visitor was trying to do* when they were asked.
 *
 * ## Why intents are serialisable rather than callbacks
 *
 * The obvious design stores a `resume: () => void` callback. That works for
 * the email-code path, which never leaves the page. It breaks for OAuth:
 * `signIn("google")` navigates the whole document to the provider and back, so
 * every in-memory closure is destroyed by the reload. The visitor would click
 * Play, sign in with Google, land back on the app, and have to find the song
 * again — precisely the "don't make me click Play twice" failure this feature
 * exists to avoid.
 *
 * So an intent is plain data. It survives `JSON.stringify`, is written to
 * sessionStorage, and is re-executed by the provider once Convex reports an
 * authenticated session — whichever path got there.
 */

const PENDING_KEY = "ss.authGate.pending";

/** Why we are asking. Drives the prompt's wording, nothing more. */
export type AuthReason = "playback" | "save" | "library";

/**
 * A deferred action, as DATA.
 *
 * Deliberately not a closure: see the OAuth note above. Every variant is
 * plain JSON so it can round-trip through sessionStorage.
 *
 * Intents are resolved to a concrete track at the moment they are requested,
 * never to "queue index 3". An index is meaningless after the OAuth reload has
 * restored a queue that may no longer match.
 */
export type AuthIntent =
  | { kind: "playTrack"; track: unknown; list?: unknown[] }
  | { kind: "playListOrdered"; track: unknown; list: unknown[] }
  | { kind: "startRadio"; track: unknown; contextQuery?: string }
  | { kind: "startPlaylistRadio"; tracks: unknown[]; label: string }
  | { kind: "playViaStream"; track: unknown; startSeconds?: number }
  | { kind: "like"; trackId: string; remote?: unknown }
  | { kind: "likeAlbum"; albumId: string }
  | { kind: "followArtist"; artistId: string };

interface AuthGateState {
  /**
   * Mirror of Convex Auth. `null` means "still resolving" and is the reason
   * `request()` can neither allow nor prompt: a click during resolution must
   * not start audio for a guest, and must not show a prompt to a signed-in
   * user whose session simply has not resolved yet.
   */
  authenticated: boolean | null;
  /** What the visitor was trying to do, if they were interrupted. */
  pending: AuthIntent | null;
  /** Why we are asking, so the prompt can explain itself. */
  reason: AuthReason;
  /** Whether the prompt is on screen. */
  open: boolean;
  /** Written by the single bridge component. */
  setAuthenticated: (value: boolean | null) => void;
  /**
   * The ONE check. Returns true when the caller may proceed.
   *
   * When it returns false the action has been recorded and either the prompt
   * is open, or — if auth has not resolved yet — the intent is parked and the
   * provider will decide what to do the moment it knows the answer.
   */
  request: (reason: AuthReason, intent: AuthIntent | null) => boolean;
  /** "Maybe later" / Escape / overlay click. Drops the intent deliberately. */
  dismiss: () => void;
  /** Take the pending intent and clear it. Called exactly once, on success. */
  consume: () => AuthIntent | null;
}

/** Best-effort sessionStorage write. Private mode throws; never fatal. */
function persist(intent: AuthIntent | null) {
  try {
    if (intent)
      window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(intent));
    else window.sessionStorage.removeItem(PENDING_KEY);
  } catch {
    /* storage unavailable — the in-memory intent still works for the
       same-page (email code) path, which is the common case. */
  }
}

function restore(): AuthIntent | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthIntent;
    // Only accept something we can actually execute. A half-written or
    // tampered value must not be run as an action on sign-in.
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.kind !== "string"
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}

export const useAuthGate = create<AuthGateState>()((set, get) => ({
  authenticated: null,
  // PICKED UP ON LOAD, not just written in this session. This is what makes
  // the OAuth round-trip work: the provider is a full document navigation, so
  // the store is rebuilt from scratch and the in-memory copy is gone.
  pending: restore(),
  reason: "playback" as AuthReason,
  open: false,

  /**
   * Write the mirrored session, and RECONCILE anything parked while it was
   * still unknown.
   *
   * This reconciliation is not optional. `request()` deliberately does not open
   * the prompt while `authenticated === null`: it cannot know yet whether this
   * is a guest who needs asking or a signed-in listener whose session simply
   * has not resolved. Parking the intent and returning false means the click is
   * refused either way.
   *
   * So the moment the answer arrives, this has to act on it. Without it, a
   * visitor who clicked Play during that window got a dead button: no audio,
   * no dialog, and no explanation — which reads exactly like the app being
   * broken, and is the single most confusing failure this gate can produce.
   */
  setAuthenticated: (value) => {
    const previous = get().authenticated;
    set({ authenticated: value });
    if (previous === value) return;

    // Resolved as signed in: the provider's `resume()` will run the intent.
    if (value === true) {
      if (get().open) set({ open: false });
      return;
    }
    // Resolved as a guest, and something was waiting on the answer.
    if (value === false && get().pending) set({ open: true });
  },

  request: (reason, intent) => {
    const { authenticated } = get();
    if (authenticated === true) return true;

    if (intent) {
      set({ pending: intent, reason });
      persist(intent);
    }
    // While the session is still resolving we must neither play nor prompt.
    // Parking the intent is enough: `setAuthenticated` and the provider will
    // sort it out a moment later. A guest who clicks during this window gets
    // the prompt the instant we know they are a guest.
    if (authenticated === null) return false;

    set({ open: true });
    return false;
  },

  dismiss: () => {
    // Clearing the intent is the whole point of "Maybe later". Keeping it
    // would mean signing in an hour later started playing a song nobody asked
    // for any more. The spec is explicit that a NEW deliberate click may ask
    // again — which it will, because the next `request()` re-records it.
    set({ open: false, pending: null });
    persist(null);
  },

  consume: () => {
    const intent = get().pending;
    if (intent) persist(null);
    set({ pending: null });
    return intent;
  },
}));

/** Read the intent without subscribing — used by tests and the provider. */
export const peekAuthGate = () => useAuthGate.getState();
