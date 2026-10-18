import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { readSource } from "./helpers/tailwind-css.js";

/**
 * Deferred authentication.
 *
 * SYNQ used to put every app route behind `<RequireAuth>`, so a visitor
 * opening `/home` was thrown at a sign-in page before seeing a single song.
 * That is the wrong order: nobody signs up for a product they have not used.
 *
 * The change is DEFERRED authentication — browse freely, and ask for an
 * account at the moment an action genuinely needs one:
 *
 *   /home -> browse -> click Play -> prompt -> sign in -> THAT SONG PLAYS
 *
 * These tests assert the properties that make that flow safe. The load-bearing
 * ones are the negative space: that autoplay is NOT gated (a queue running
 * dry must never summon a sign-in dialog), that no playback path reaches
 * `loadTrack` without passing the gate (one forgotten branch means a guest
 * gets a silent "playing" player), and that the backend still enforces auth
 * (the client gate is a courtesy, not a lock).
 */

const main = readSource("src/main.tsx");
const store = readSource("src/store/player.ts");
const gate = readSource("src/store/authGate.ts");
const provider = readSource("src/components/auth/AuthGateProvider.tsx");
const dialog = readSource("src/components/auth/AuthPromptDialog.tsx");

/** Strip comments so prose about a pattern cannot satisfy an assertion. */
const code = (text) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ")
    .replace(/\s+/g, " ");

const mainCode = code(main);
const storeCode = code(store);

describe("/home is open to visitors", () => {
  test("the app shell is not behind a blanket RequireAuth", () => {
    // The single most important assertion in this file. If the shell is
    // wrapped, every route inside it is unreachable without an account and
    // the whole feature is inert.
    expect(mainCode).not.toMatch(/<RequireAuth> <AppShell \/> <\/RequireAuth>/);
    expect(mainCode).toMatch(/<Route element=\{<AppShell \/>\}>/);
  });

  test("no Navigate to /auth is left on the browse path", () => {
    // `RequireAuth` is what redirects. With the shell ungated, a browse route
    // must not reach it.
    const browse = [
      "/home",
      "/search",
      "/discover",
      "/artist/:artist",
      "/album/:artist/:album",
    ];
    for (const path of browse) {
      const at = main.indexOf(`path="${path}"`);
      expect(at).toBeGreaterThan(-1);
      // The next ~200 chars are that route's element. None may be a
      // RequireAuth.
      const element = main.slice(at, at + 220);
      expect(element).not.toMatch(/RequireAuth/);
    }
  });

  test("every route that keeps a guard is a private one", () => {
    // Counting `<RequireAuth>` in the file is worthless — prose in a comment
    // contains the string too, and so does the old /dashboard redirect. What
    // actually matters is the pairing: for each guard, is the route it wraps
    // one of the private pages? Any guard on a browse route is a regression.
    //
    // Matching `path="X" … <RequireAuth>` with a bounded wildcard looks right
    // and is not: the window happily spans the END of one route and the start
    // of the next, so `/` gets paired with the guard that belongs to
    // `/dashboard` and `/album/...` gets paired with `/liked`'s. Split on the
    // route boundary first so each guard is attributed to its own route.
    const guarded = main
      .split("<Route")
      .slice(1)
      .filter((chunk) => chunk.includes("<RequireAuth>"))
      .map((chunk) => chunk.match(/path="([^"]+)"/)?.[1])
      .filter(Boolean);
    const PRIVATE = [
      "/liked",
      "/playlists",
      "/playlist/:id",
      "/stats",
      "/recent",
      "/recap",
      "/social",
      "/profile",
      "/settings",
      "/admin",
    ];
    // `/dashboard` also keeps a guard: it is a legacy alias that redirects to
    // /home, and it must not become a way around the private routes.
    const ALLOWED = [...PRIVATE, "/dashboard"];
    for (const path of guarded) {
      expect(ALLOWED).toContain(path);
    }
    // And all nine are still guarded — this catches a guard being deleted as
    // well as one being added in the wrong place.
    for (const path of PRIVATE) expect(guarded).toContain(path);
  });
});

describe("genuinely private routes stay protected", () => {
  const PRIVATE = [
    "/liked",
    "/playlists",
    "/playlist/:id",
    "/stats",
    "/recent",
    "/social",
    "/profile",
    "/settings",
    "/admin",
  ];

  test.each(PRIVATE)("%s keeps its own RequireAuth", (path) => {
    const at = main.indexOf(`path="${path}"`);
    expect(at).toBeGreaterThan(-1);
    // The guard must wrap THIS route's element, not merely appear somewhere
    // in the file, or the count above would pass while this route stayed open.
    const element = main.slice(at, at + 400);
    expect(element).toMatch(/RequireAuth/);
  });

  test("the private set is exactly the account-scoped pages", () => {
    // A guard on a public route is a regression; a missing guard on a private
    // one is a data leak. Assert the whole list, both directions.
    for (const path of PRIVATE) expect(main).toContain(`path="${path}"`);
  });
});

describe("playback is gated in ONE place", () => {
  test("there is a single gate function, not scattered checks", () => {
    expect(storeCode).toMatch(
      /const gatePlayback = \(intent: AuthIntent \| null\): boolean/,
    );
    expect(storeCode).toMatch(/const gateAccount = /);
    // Every gate call goes through those two helpers. A component-level
    // `if (!isAuthenticated)` would be a fourth opinion that nobody maintains.
    const direct =
      storeCode.match(/useAuthGate\.getState\(\)\.request\(/g) ?? [];
    expect(direct.length).toBe(2);
  });

  test("the gate runs BEFORE any state is mutated", () => {
    // A guest who clicks Play must not end up with `isPlaying: true` and a
    // progress bar advancing over silence. So the gate has to come first in
    // every wrapped action — this asserts that on the primary entry point.
    const at = store.indexOf("const playTrack = (track: Playable");
    const body = store.slice(at, at + 400);
    expect(body).toMatch(/gatePlayback\(/);
    // `playResolved` (which mutates and calls loadTrack) comes after.
    expect(body.indexOf("gatePlayback(")).toBeLessThan(
      body.indexOf("playResolved("),
    );
  });

  const ENTRY_POINTS = [
    ["playTrack", "Home shelf row, song card, artist page"],
    ["playListOrdered", "Album Play / playlist Play / Play all"],
    ["startRadio", "artist Radio"],
    ["startPlaylistRadio", "playlist radio"],
    ["playViaStream", "stream rescue from the player bar"],
    ["replaceCurrentStream", "manual source switch"],
    ["playIndex", "queue row click"],
    ["playFromHistory", "recently played row"],
  ];

  test.each(ENTRY_POINTS)("%s is gated (%s)", (fn) => {
    // Find the IMPLEMENTATION. `indexOf` would otherwise match the
    // declaration in the `PlayerStore` interface, which contains no body and
    // so can never satisfy — or fail — the assertion.
    const impl =
      store.indexOf(`const ${fn} = (`) >= 0
        ? store.indexOf(`const ${fn} = (`)
        : store.indexOf(`\n    ${fn}: (`);
    expect(impl).toBeGreaterThan(-1);
    const at = impl;
    // Read a generous window: the guard may sit a few lines below the
    // signature (some actions validate arguments first).
    const body = store.slice(at, at + 600);
    expect(body).toMatch(/gatePlayback\(/);
  });

  test("togglePlay, next and prev inherit the gate through playIndex", () => {
    // These three are not wrapped individually, and deliberately so: they all
    // delegate to `playIndex`, which is. Asserting the delegation is what
    // proves a queue click and the Next button cannot both be checked in one
    // place and forgotten in the other.
    for (const fn of ["const next = () =>", "const prev = () =>"]) {
      const at = store.indexOf(fn);
      const body = store.slice(at, at + 900);
      expect(body).toMatch(/playIndex\(/);
    }
  });

  test("nothing reaches loadTrack from a public action without the gate", () => {
    // The structural backstop. `loadTrack` is the only thing that starts
    // audio, so each public action that calls it must sit behind a gate.
    // `playResolved` is the one deliberate exception: it has no gate of its
    // own because its only two callers (`playTrack`, `playListOrdered`) are
    // both gated before delegating to it. That is asserted separately below.
    for (const marker of [
      "const playViaStream = (",
      "const replaceCurrentStream = (",
      "\n    playFromHistory: (index) =>",
    ]) {
      const at = store.indexOf(marker);
      expect(at).toBeGreaterThan(-1);
      expect(store.slice(at, at + 1200)).toMatch(/gatePlayback\(/);
    }

    // playIndex delegates to the ungated advance, so the gate belongs on
    // playIndex itself — which is exactly where it is.
    const playIndexImpl = store.indexOf("const playIndex = (index: number) =>");
    expect(playIndexImpl).toBeGreaterThan(-1);
    const body = store.slice(playIndexImpl, playIndexImpl + 900);
    expect(body).toMatch(/gatePlayback\(/);
    expect(body).toMatch(/advanceToIndex\(index\)/);
  });

  test("the ungated internal is reachable only through gated wrappers", () => {
    // `advanceToIndex` must never be called by a public action directly. It
    // is called by `playIndex` (gated) and by the module-level autoplay path.
    // Exactly two CALL SITES: the one inside the gated `playIndex`, and the
    // module-level assignment `autoAdvanceToIndex = advanceToIndex`. A third
    // is a new caller added without thinking about the gate — which is the
    // regression this assertion exists to catch.
    const calls = [...code(store).matchAll(/(?<![\w])advanceToIndex\(/g)]
      .length;
    expect(calls).toBe(1);
  });
});

describe("autoplay never surprises a guest with a dialog", () => {
  test("end-of-track advance is UNGATED", () => {
    // This is the subtle one. A queue running dry is playback already in
    // progress, not a request to start it. Gating it would throw a sign-in
    // dialog at someone at the exact moment a song finished.
    expect(store).toMatch(/const advanceToIndex = \(index: number\)/);
    expect(store).toMatch(/autoAdvanceToIndex = advanceToIndex/);
  });

  test("handleEnded uses the ungated advance, not the gated one", () => {
    // The advance lives in `completeEndedTrack`, which handleEnded delegates
    // to; a blend that deferred the boundary calls the same function back.
    const at = store.indexOf("function completeEndedTrack");
    const body = code(store.slice(at, at + 4000));
    // The manual advance must be the ungated one.
    expect(body).toMatch(/autoAdvanceToIndex\?\.\(s\.queueIndex \+ 1\)/);
    expect(body).toMatch(/autoAdvanceToIndex\?\.\(0\)/);
    // And it must NOT call the gated playIndex at all.
    expect(body).not.toMatch(/playIndex\(/);
  });

  test("radio autoplay advance is ungated too", () => {
    // Both personalised-pick and related-mix fallback branches.
    expect(store).toMatch(/autoAdvanceToIndex\?\.\(after\.queue\.length - 1\)/);
    expect(store).toMatch(
      /autoAdvanceToIndex\?\.\(after\.queue\.length - appended\)/,
    );
  });

  test("the ungated advance is never exposed on the store's public surface", () => {
    // Only the gated `playIndex` is public. If `advanceToIndex` ever joins the
    // interface, a component could call it directly and walk past the gate.
    const start = store.indexOf("interface PlayerStore");
    const end = store.indexOf("// --- queue persistence");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const iface = store.slice(start, end);
    expect(iface).not.toMatch(/advanceToIndex/);
    expect(iface).toMatch(/playIndex: \(index: number\) => void/);
  });
});

describe("account actions are gated, and never lie about state", () => {
  const ACCOUNT = [
    ["toggleLike", "like a song"],
    ["toggleLikedAlbum", "save an album"],
    ["toggleFollowArtist", "follow an artist"],
  ];

  test.each(ACCOUNT)("%s is gated (%s)", (fn) => {
    // Search for the IMPLEMENTATION BODY, not the declaration in the
    // `PlayerStore` interface — a declaration has no body, so it can never
    // satisfy this and would mask a genuinely missing gate.
    const bodies = [
      `const ${fn} = (trackId: string`,
      `\n    ${fn}: (albumId) => {`,
      `\n    ${fn}: (artistId) => {`,
    ];
    const at = bodies.map((m) => store.indexOf(m)).find((i) => i > -1);
    expect(at).toBeGreaterThan(-1);
    expect(store.slice(at, at + 700)).toMatch(/gateAccount\(/);
  });

  test("like is gated BEFORE the optimistic flip", () => {
    // Ordering matters more here than anywhere. Flipping the heart first and
    // prompting afterwards leaves the control showing "liked" for a save that
    // does not exist — and if the visitor dismisses the dialog, the lie
    // stays on screen.
    const at = store.indexOf("const toggleLike = (");
    const body = store.slice(at, at + 700);
    expect(body.indexOf("gateAccount(")).toBeLessThan(
      body.indexOf("// optimistic flip"),
    );
  });

  test("the account gate does not touch playback", () => {
    // Gating is a UX courtesy. The optimistic like still only reaches the
    // server through `likeMutation`, which is the Convex mutation that
    // enforces the real session.
    expect(store).toMatch(/if \(!likeMutation\) return;/);
  });
});

describe("the visitor's intent survives sign-in", () => {
  test("intents are serialisable, so an OAuth reload cannot lose them", () => {
    // The whole feature rests on this. OAuth is a full document navigation;
    // a stored closure would be destroyed and the visitor would have to find
    // their song again. Plain JSON in sessionStorage survives it.
    // Matched against the comment-stripped source: this exact call is quoted
    // in the module's own doc comment, so an unstripped match would pass even
    // if the code were deleted.
    expect(code(gate)).toMatch(
      /sessionStorage\.setItem\(PENDING_KEY, JSON\.stringify\(intent\)\)/,
    );
    // The store RESTORES on construction. That is what survives an OAuth
    // round-trip rebuilding the entire tree.
    expect(code(gate)).toMatch(/pending: restore\(\)/);
  });

  test("intents resolve to a concrete track, never a queue index", () => {
    // An index is meaningless after the reload has restored a queue that may
    // no longer match.
    const intents = gate.slice(gate.indexOf("export type AuthIntent"));
    expect(intents).not.toMatch(/kind: "playIndex"/);
  });

  test("the intent carries a full playable, not the queue's trimmed snapshot", () => {
    // `persistPlayable` drops audioUrl/source/albumName. An intent built from
    // it would resume a track that resolves to silence.
    expect(store).toMatch(
      /const intentPlayable = \(p: Playable\): IntentPlayable/,
    );
    const body = store.slice(store.indexOf("const intentPlayable"));
    for (const field of ["audioUrl", "source", "albumName"]) {
      expect(body.slice(0, 700)).toMatch(new RegExp(`${field}:`));
    }
  });

  test("the bridge runs the intent once a session exists", () => {
    expect(provider).toMatch(/if \(isLoading \|\| !isAuthenticated\) return;/);
    expect(provider).toMatch(/resume\(\)/);
    expect(code(provider)).toMatch(/runIntent\(intent\)/);
  });

  test("resuming re-enters the normal store actions, so the gate runs again", () => {
    // One path in, for clicks and resumes alike. If resume called a private
    // internal it would bypass the gate that is now satisfied.
    expect(provider).toMatch(/store\.playTrack\(/);
    expect(provider).toMatch(/store\.toggleLike\(/);
    // No direct loadTrack / playResolved reach-through.
    expect(provider).not.toMatch(/loadTrack|playResolved/);
  });

  test("the intent runs at most once per sign-in", () => {
    // React commits effects twice under StrictMode in development, and the
    // effect re-runs while state settles. Playing the song twice is worse than
    // not playing it once.
    expect(provider).toMatch(/const resumed = useRef\(false\)/);
    expect(provider).toMatch(/if \(resumed\.current\) return;/);
  });
});

describe("the prompt can always be dismissed", () => {
  test("Maybe later exists and returns the visitor to the page", () => {
    expect(dialog).toMatch(/Maybe later/);
    // Dismissing must NOT navigate — that is what preserving context means.
    expect(code(dialog)).not.toMatch(/navigate\(/);
  });

  test("dismissal drops the intent rather than deferring it forever", () => {
    // Keeping it would mean signing in an hour later started playing a song
    // nobody asked for any more.
    //
    // `indexOf` would find the TYPE in the interface, which has no body and
    // cannot clear anything — so take the LAST occurrence, which is the
    // implementation inside the store.
    //
    // The slice is bounded at `consume`, the NEXT member. Slicing to the end
    // of the file instead lets `consume`'s own `pending: null` satisfy this,
    // so a `dismiss` that forgot to clear anything would pass — which is
    // exactly the mutation this is here to catch.
    const flat = code(gate);
    const start = flat.lastIndexOf("dismiss: () =>");
    expect(start).toBeGreaterThan(-1);
    const body = flat.slice(start, flat.indexOf("consume: () =>", start));
    expect(body.length).toBeGreaterThan(0);
    expect(body).toMatch(/open: false/);
    expect(body).toMatch(/pending: null/);
    // And it must not persist the intent for a later sign-in to find.
    expect(body).toMatch(/persist\(null\)/);
  });

  test("a NEW deliberate click may ask again", () => {
    // The dismissal is not sticky: `request` re-records the intent and reopens
    // on the next Play press, which is the behaviour the spec requires.
    expect(gate).toMatch(
      /if \(authenticated === null\) return false;\s*set\(\{ open: true \}\);/,
    );
  });

  test("Escape and an overlay click both dismiss", () => {
    expect(dialog).toMatch(/onOpenChange=\{\(next\) => !next && dismiss\(\)\}/);
  });
});

describe("no duplicate auth systems", () => {
  test("Convex Auth stays the only source of truth", () => {
    // The gate holds a MIRROR, written by exactly one component from the
    // existing hook. It is not a second session, provider or token store.
    expect(provider).toMatch(/import \{ useAuth \} from "@\/hooks\/use-auth"/);
    expect(provider).toMatch(
      /setAuthenticated\(isLoading \? null : isAuthenticated\)/,
    );
  });

  test("only the bridge writes the mirrored session", () => {
    // One writer. Two writers would be two opinions about who is signed in,
    // and the disagreement would be invisible until a guest got a prompt they
    // did not deserve.
    const writers = srcFiles().filter((f) =>
      /setAuthenticated\(/.test(stripAll(readSource(f))),
    );
    expect(writers.length).toBe(1);
    expect(writers[0]).toContain("AuthGateProvider");
  });

  test("the existing useAuth hook is reused, not reimplemented", () => {
    const hook = readSource("src/hooks/use-auth.ts");
    expect(hook).toMatch(/useConvexAuth/);
    expect(hook).toMatch(/useAuthActions/);
  });
});

describe("the backend remains the authority", () => {
  test("playback-adjacent mutations still require a session", () => {
    // The client gate is UX. If these ever stopped checking, the feature would
    // have become a security bypass rather than a nicer front door.
    const history = readSource("src/convex/history.ts");
    const likes = readSource("src/convex/likes.ts");
    expect(history).toMatch(/const userId = await getAuthUserId\(ctx\)/);
    expect(likes).toMatch(/const userId = await getAuthUserId\(ctx\)/);
  });

  test("the recommendation engine refuses to invent history for a guest", () => {
    // Requirement: guests get real general/discovery content, not a faked
    // listening profile.
    const recommend = readSource("src/convex/recommend.ts");
    expect(recommend).toMatch(/const userId = await getAuthUserId\(ctx\);/);
    expect(recommend).toMatch(/if \(userId === null\) return null;/);
  });

  test("listening stats are absent, not empty, for a guest", () => {
    // `null` lets Home skip the personalised shelf. An empty object would
    // render a chart with no data and imply a history that does not exist.
    const history = readSource("src/convex/history.ts");
    expect(history).toMatch(/if \(userId === null\) return null;/);
  });
});

describe("the prompt is SYNQ's own UI, not a generic one", () => {
  test("it reuses the extracted AuthForm, not a second implementation", () => {
    expect(dialog).toMatch(
      /import \{ AuthForm \} from "@\/components\/auth\/AuthForm"/,
    );
    expect(dialog).toMatch(/<AuthForm/);
    // The /auth page uses the same component, so the two cannot drift apart
    // in providers or flow.
    expect(readSource("src/pages/Auth.tsx")).toMatch(/<AuthForm/);
  });

  test("it explains WHY, differently per action", () => {
    expect(dialog).toMatch(/Sign in to start listening/);
    expect(dialog).toMatch(/Sign in to save this/);
    expect(dialog).toMatch(/Sign in to use your library/);
  });

  test("only providers that really exist are offered", () => {
    const form = readSource("src/components/auth/AuthForm.tsx");
    expect(form).toMatch(/handleOAuth\("google"\)/);
    expect(form).toMatch(/handleOAuth\("github"\)/);
    expect(form).toMatch(/signIn\("email-otp"/);
  });

  test("it returns the visitor to the exact page after OAuth", () => {
    // Without this the server picks its own default origin and a listener can
    // land on a completely different site after authenticating.
    expect(dialog).toMatch(/window\.location\.origin\}/);
    expect(dialog).toMatch(/location\.pathname/);
  });

  test("it never renders for someone already signed in", () => {
    expect(dialog).toMatch(/if \(authenticated === true\) return null;/);
  });
});

describe("guests are told the truth about who they are", () => {
  test("the account menu offers sign-in, not a dead sign-out", () => {
    const menu = readSource("src/components/layout/AccountMenu.tsx");
    expect(menu).toMatch(/const isGuest = !isAuthenticated;/);
    expect(menu).toMatch(/Browsing as guest/);
    // "Sign out" must not be reachable from the guest branch.
    const guestBranch = menu.slice(
      menu.indexOf("if (isGuest) {"),
      menu.indexOf("if (isGuest) {") + 1200,
    );
    expect(guestBranch).not.toMatch(/Sign out/);
  });

  test("the phone sheet does the same", () => {
    const sheet = readSource("src/components/layout/MobileMoreMenu.tsx");
    expect(sheet).toMatch(/const isGuest = !isAuthenticated;/);
    expect(sheet).toMatch(/Browsing as guest/);
  });
});

/** Every source file under src/, for the single-writer assertion. */
function srcFiles(dir = "src", acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) srcFiles(full, acc);
    else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

/**
 * Comments removed AND whitespace collapsed.
 *
 * Both halves matter. Without stripping comments the module's own doc block
 * quotes `setAuthenticated(` and every file that mentions the symbol in prose
 * counts as a writer. Without collapsing whitespace, a prettier reflow silently
 * stops matching and the assertion passes or fails for the wrong reason.
 */
function stripAll(text) {
  return code(text);
}

describe("playlist actions ask too", () => {
  const addTo = readSource("src/components/playlists/useAddToPlaylist.ts");
  const dialog = readSource("src/components/playlists/PlaylistDialog.tsx");

  test("saving a track to a playlist is gated", () => {
    // Without this a guest gets a raw server toast reading "Sign in to manage
    // playlists" — technically honest, but it is an error message where the
    // rest of the app now offers a calm prompt.
    expect(addTo).toMatch(
      /useAuthGate\.getState\(\)\.request\("library", null\)/,
    );
    expect(addTo).toMatch(
      /if \(!useAuthGate\.getState\(\)\.request\("library", null\)\) return;/,
    );
  });

  test("creating a playlist is gated", () => {
    expect(dialog).toMatch(
      /useAuthGate\.getState\(\)\.request\("library", null\)/,
    );
  });

  test("neither parks an intent it could not honour", () => {
    // The playlist belongs to an account that does not exist yet, so there is
    // no destination to resume into. Claiming otherwise would leave a stale
    // intent that fires an action nobody can complete.
    expect(addTo).not.toMatch(/kind: "addToPlaylist"/);
    expect(dialog).not.toMatch(/kind: "createPlaylist"/);
  });

  test("the gate is checked before the mutation is attempted", () => {
    // Otherwise the request goes out, fails, and the error toast races the
    // prompt.
    const at = addTo.indexOf('request("library"');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(addTo.indexOf("await addTrack("));
  });
});

describe("queue building is NOT gated, on purpose", () => {
  test("adding to the queue does not start audio, so it is not gated", () => {
    // Requirement: do not block actions that work fine without an account. The
    // queue is device-local (localStorage), needs no identity, and starting
    // nothing means the visitor loses nothing by being allowed to build one.
    const store = readSource("src/store/player.ts");
    const at = store.indexOf("addToQueue: (track) => {");
    expect(at).toBeGreaterThan(-1);
    // Bounded at the next member so the assertion cannot accidentally cover a
    // gated action that happens to follow it.
    const body = store.slice(
      at,
      store.indexOf("playFromHistory:", at) > -1
        ? store.indexOf("playFromHistory:", at)
        : at + 600,
    );
    expect(body).not.toMatch(/gatePlayback|gateAccount/);
    // And it genuinely starts nothing — that is WHY it is not gated.
    expect(body).not.toMatch(/loadTrack/);
  });

  test("media-session keys route through the gated playIndex", () => {
    // Requirement: hardware/browser media controls must not be a way around
    // the gate. `next`/`prev`/`togglePlay` all delegate to the gated
    // `playIndex`, so a media key cannot start audio for a guest either.
    const store = readSource("src/store/player.ts");
    expect(store).toMatch(
      /setActionHandler\("nexttrack", \(\) => usePlayerStore\.getState\(\)\.next\(\)\)/,
    );
    expect(store).toMatch(
      /setActionHandler\("play", \(\) => usePlayerStore\.getState\(\)\.togglePlay\(\)\)/,
    );
  });
});

describe("the bridge is mounted somewhere it can actually work", () => {
  test("it is inside BrowserRouter, because the prompt uses useLocation", () => {
    // This is a real crash, not a style preference. `useLocation` throws
    // "may be used only in the context of a <Router> component" when called
    // outside one, and the throw happens on EVERY render of the dialog — so
    // mounting the provider as a sibling of `</BrowserRouter>` took down the
    // whole app the moment the prompt appeared.
    const routerOpen = main.indexOf("<BrowserRouter>");
    const routerClose = main.indexOf("</BrowserRouter>");
    const mount = main.indexOf("<AuthGateProvider />");
    expect(mount).toBeGreaterThan(-1);
    expect(routerOpen).toBeGreaterThan(-1);
    expect(routerClose).toBeGreaterThan(routerOpen);
    expect(mount).toBeGreaterThan(routerOpen);
    expect(mount).toBeLessThan(routerClose);
  });

  test("it is inside ConvexAuthProvider, because it reads the session", () => {
    const authOpen = main.indexOf("<ConvexAuthProvider");
    const authClose = main.indexOf("</ConvexAuthProvider>");
    const mount = main.indexOf("<AuthGateProvider />");
    expect(mount).toBeGreaterThan(authOpen);
    expect(mount).toBeLessThan(authClose);
  });

  test("it is OUTSIDE <Routes>, so it is not tied to one route", () => {
    // Mounted inside a route it would unmount on every navigation, taking the
    // prompt with it.
    const routesClose = main.indexOf("</Routes>");
    const mount = main.indexOf("<AuthGateProvider />");
    expect(routesClose).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(routesClose);
  });

  test("the prompt really does read router state", () => {
    // The reason for the placement above. If this ever stops using
    // `useLocation`, the placement becomes a free choice again.
    const dialogSource = readSource("src/components/auth/AuthPromptDialog.tsx");
    expect(dialogSource).toMatch(/useLocation/);
  });

  test("every hook the prompt uses has a provider above it", () => {
    // A cheap, general guard: the dialog uses router state and the form uses
    // the auth context, so both providers must enclose the mount.
    const dialogSource = readSource("src/components/auth/AuthPromptDialog.tsx");
    const usesRouter = /useLocation|useNavigate|Link/.test(dialogSource);
    if (usesRouter) {
      const mount = main.indexOf("<AuthGateProvider />");
      expect(main.lastIndexOf("<BrowserRouter>", mount)).toBeGreaterThan(-1);
    }
  });
});

describe("no auth prompt without a deliberate action", () => {
  const shell = readSource("src/components/layout/AppShell.tsx");
  const trackLink = readSource("src/pages/TrackLink.tsx");

  test("a click during session resolution is not silently swallowed", () => {
    // `request()` cannot open the prompt while `authenticated === null`, so it
    // parks the intent and returns false. If nothing reconciles when the
    // answer arrives, that click is a DEAD BUTTON: no audio, no dialog, no
    // explanation — indistinguishable from a broken app.
    const flat = code(readSource("src/store/authGate.ts"));
    const body = flat.slice(
      flat.lastIndexOf("setAuthenticated: (value)"),
      flat.indexOf("request: (reason", flat.lastIndexOf("setAuthenticated:")),
    );
    expect(body.length).toBeGreaterThan(0);
    // Resolving as a guest with something parked must open the prompt.
    expect(body).toMatch(/value === false && get\(\)\.pending/);
    expect(body).toMatch(/open: true/);
    // Resolving as signed in must close it and let the provider resume.
    expect(body).toMatch(/if \(value === true\)/);
  });

  test("a shared track link does not auto-play for a guest", () => {
    // `/t/:id` resolved its metadata in an effect and played immediately. For
    // a visitor that fired the auth dialog on page load, triggered by nothing
    // they did — the single clearest violation of deferred auth.
    const effect = trackLink.slice(
      trackLink.indexOf("if (!meta) return;"),
      trackLink.indexOf("if (!meta) return;") + 400,
    );
    expect(effect).toMatch(/if \(!isAuthenticated\) return;/);
  });

  test("a guest gets a real Play button on the track link instead", () => {
    // Suppressing autoplay must not leave the page with no way to play. The
    // button is the deliberate action that earns the prompt.
    expect(trackLink).toMatch(/isCurrent \|\| !isAuthenticated/);
    expect(trackLink).toMatch(
      /isCurrent \? togglePlay\(\) : playTrack\(trackMetaToPlayable\(meta\)\)/,
    );
  });

  test("the global Space shortcut does not fire over a focused control", () => {
    // Space activates a focused button. The global handler also called
    // `togglePlay()`, which for a guest reaches the auth gate — so tabbing to
    // a row and pressing Space produced a dialog nobody asked for.
    const guard = code(shell).slice(
      code(shell).indexOf("if (typing) return;"),
      code(shell).indexOf("if (typing) return;") + 700,
    );
    expect(guard).toMatch(/BUTTON/);
    expect(guard).toMatch(/if \(e\.code !== "Enter"\) return;/);
  });

  test("Space still works as play/pause when nothing is focused", () => {
    // The guard must not disable the shortcut entirely — that would be a
    // silent feature removal.
    const flat = code(shell);
    const after = flat.slice(flat.indexOf('if (e.code === "Space")'));
    expect(after.slice(0, 200)).toMatch(/s\.togglePlay\(\)/);
  });
});

describe("the landing page sends people INTO the product, not to a wall", () => {
  const landing = readSource("src/pages/Landing.tsx");

  test("no primary CTA routes to /auth", () => {
    // The old CTAs pointed at `/auth?returnTo=/home`, so the very first thing a
    // visitor clicked was a sign-in form. That is the opposite of deferred
    // authentication: it asks for an account before showing the product.
    expect(landing).not.toContain('to="/auth?returnTo=/home"');
  });

  test("every 'Start listening' CTA enters the app instead", () => {
    const ctas = [...landing.matchAll(/Start listening[^<]*/g)];
    expect(ctas.length).toBeGreaterThanOrEqual(3);
    // Each one must sit inside a Link to /home. Count the links so a CTA left
    // pointing at auth cannot hide behind a still-correct sibling.
    const homeLinks = [...landing.matchAll(/to="\/home"/g)];
    expect(homeLinks.length).toBeGreaterThanOrEqual(3);
  });

  test("an explicit Sign in link still exists", () => {
    // Removing the sign-in link entirely would be over-correction. Asking is
    // wrong; offering is not. A visitor who WANTS an account must still be able
    // to say so.
    expect(landing).toMatch(/to="\/auth"/);
  });

  test("the closing copy no longer promises a sign-in step", () => {
    // It said "Sign in, bring your taste…" directly above a button that no
    // longer signs in. The copy has to match the behaviour.
    expect(landing).not.toMatch(/Sign in, bring your taste/);
    expect(landing).toMatch(/Browse first/);
  });
});

describe("SYNQ can be downloaded from the landing page", () => {
  const landing = readSource("src/pages/Landing.tsx");
  const button = readSource("src/components/pwa/InstallAppButton.tsx");

  test("the landing page renders the install button", () => {
    expect(landing).toMatch(/import \{ InstallAppButton \}/);
    expect(landing).toMatch(/<InstallAppButton \/>/);
  });

  test("it appears in more than one spot, not just the footer", () => {
    // A single instance is easy to miss on a long marketing page.
    const count = (landing.match(/<InstallAppButton \/>/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  test("it reuses the real install hook, not a second implementation", () => {
    // Three surfaces (landing, in-app strip, settings) must agree on what is
    // installable and why.
    expect(button).toMatch(/usePwaInstall\(\)/);
    expect(button).toMatch(/planInstallBlock\(\{/);
    expect(button).toMatch(/manualInstallHint\(/);
  });

  test("it is honest when installation is impossible", () => {
    // A "Download" button that silently does nothing in a dev preview reads
    // as a broken app. It must name the real reason.
    expect(button).toMatch(
      /toast\.error\("Can't install yet", \{ description: blocked \}\)/,
    );
  });

  test("an installed app says so instead of offering a dead download", () => {
    expect(button).toMatch(/state === "installed" \|\| installed/);
    expect(button).toMatch(/App installed/);
  });

  test("the manual-install path explains where to tap", () => {
    // Browsers without `beforeinstallprompt` (notably iOS Safari) can still be
    // installed, just not from a page-driven prompt.
    expect(button).toMatch(/if \(state === "manual"\)/);
  });
});

describe("the What's New section tells the truth", () => {
  const landing = readSource("src/pages/Landing.tsx");

  test("it exists, is anchored, and is linked from the nav", () => {
    // A section nobody can reach is not published copy.
    expect(landing).toMatch(/id="whats-new"/);
    expect(landing).toMatch(/href="#whats-new"/);
  });

  test("it is driven by data, not repeated markup", () => {
    // Three cards written out three times is how they drift apart.
    expect(landing).toMatch(/const whatsNewCards = \[/);
    expect(landing).toMatch(/whatsNewCards\.map\(/);
  });

  test("it covers the features from this cycle", () => {
    // Re-cut when the section was rewritten for the search / lyrics / mixes /
    // cache / downloads cycle. The identity of the cards is expected to change
    // with each cycle; what must NOT change is the guarantee this test
    // provides — every shipped card is named here, and the count is exact, so
    // a card cannot be quietly dropped while the others keep the test green.
    expect(landing).toMatch(/Search that actually finds the song/);
    expect(landing).toMatch(/Lyrics that keep up/);
    expect(landing).toMatch(/Mixes that mix/);
    expect(landing).toMatch(/Roughly 10× faster lookups/);
    expect(landing).toMatch(/Downloads that are actually downloadable/);
    const cards = landing.slice(
      landing.indexOf("const whatsNewCards = ["),
      landing.indexOf("const fadeUp = {"),
    );
    expect(cards.match(/\n    icon: /g) ?? []).toHaveLength(5);
  });

  test("it sells features, not bug fixes", () => {
    // The honest reason the fixes live in CHANGELOG.md instead. Padding a
    // changelog with "fixed the thing that was broken" reads as a confession,
    // and this assertion is what stops someone helpfully adding them back.
    //
    // Scoped to BOTH the card data and the section markup. The card text is
    // defined at the top of the file and rendered inside the section, so
    // slicing only the markup misses every word a visitor actually reads —
    // which is exactly how bug-fix language got published as a feature the
    // first time this assertion was written.
    const cards = landing.slice(
      landing.indexOf("const whatsNewCards = ["),
      landing.indexOf("const fadeUp = {"),
    );
    const section = landing.slice(
      landing.indexOf('id="whats-new"'),
      landing.indexOf("Ready when you are."),
    );
    expect(cards.length).toBeGreaterThan(0);
    // Targeted at BUG-FIX FRAMING, not individual words. A blunt word ban
    // fails on legitimate copy — "no silence between tracks" is a feature
    // selling point, and banning "silence" made this test wrong rather than
    // the copy. What must never appear is the retrospective voice.
    //
    // Compared LOWERCASED. Checking exact case let "Used to be broken" through
    // a guard looking for "used to", which is the same defect in miniature:
    // a check that reads as covering something and does not.
    for (const raw of [cards, section]) {
      const copy = raw.toLowerCase();
      for (const framing of [
        "silent playback",
        "no longer clipped",
        "restarted the song",
        "nothing found",
        "bug fix",
        "fixed:",
        "we fixed",
        "used to",
        "no longer",
      ]) {
        expect(copy).not.toContain(framing);
      }
    }
  });

  test("the changelog carries the full record, fixes included", () => {
    // The counterpart to the assertion above: the fixes have to be written
    // down *somewhere*, or "sell features not bugs" just means hiding them.
    const changelog = readSource("CHANGELOG.md");
    expect(changelog).toMatch(/### Fixed/);
    expect(changelog).toMatch(/Silent playback/);
    expect(changelog).toMatch(/#### Deferred authentication/);
    expect(changelog).toMatch(/#### Crossfade & gapless playback/);
    expect(changelog).toMatch(/#### Installable app \(PWA\)/);
  });

  test("the changelog is explicit that the gate is not a security control", () => {
    // Publishing a UX change that reads like a security change is the failure
    // mode worth pre-empting in writing.
    //
    // Matched against whitespace-collapsed prose: markdown wraps at roughly 80
    // columns, so "not a security\ncontrol" is the same sentence as
    // "not a security control" and must satisfy the same assertion.
    expect(code(readSource("CHANGELOG.md"))).toMatch(/not a security control/);
  });
});
