import { describe, expect, test } from 'vitest';
import fs from "node:fs";
import path from "node:path";

import { readSource } from "./helpers/tailwind-css.js";

/**
 * "There is no logout button, and no way to switch accounts."
 *
 * The complaint was true, and the reason was structural rather than cosmetic.
 * SYNQ has THREE sign-out implementations and none of them was reachable:
 *
 *  - `src/components/LogoDropdown.tsx` had a Sign Out item, and nothing in the
 *    app ever imported or rendered the component.
 *  - `Sidebar` mounted TWO `SettingsDialog`s (one per layout branch) with
 *    `open={settingsOpen}`, and no code path ever called
 *    `setSettingsOpen(true)`.
 *  - `AppShell` mounted a THIRD one, same problem.
 *  - The `/settings` ROUTE — the only settings surface that actually opens —
 *    did not pass `onSignOut`, and the dialog hides its own sign-out row
 *    behind `{onSignOut && ...}`.
 *
 * So every path dead-ended. These tests exist to make that specific class of
 * bug impossible to reintroduce: the actions must be present on every layout,
 * there must be exactly ONE implementation of them, and signing out must
 * clear the previous listener's session before the auth token goes.
 */

const FILES = {
  auth: "src/hooks/use-auth.ts",
  menu: "src/components/layout/AccountMenu.tsx",
  hooks: "src/hooks/use-account-actions.ts",
  sidebar: "src/components/layout/Sidebar.tsx",
  mobile: "src/components/layout/MobileMoreMenu.tsx",
  shell: "src/components/layout/AppShell.tsx",
  settings: "src/pages/Settings.tsx",
  dialog: "src/components/settings/SettingsDialog.tsx",
  store: "src/store/player.ts",
};
const files = FILES;

/** The single file allowed to wrap Convex's raw auth actions. */
const AUTH_HOOK = FILES.auth;

const src = {};
for (const [key, file] of Object.entries(files)) src[key] = readSource(file);

/**
 * Strip comments so a doc comment that NAMES a symbol cannot be mistaken for
 * a real dependency on it. Without this, every explanation of the bug would
 * itself register as an instance of the bug.
 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** True when `text` really imports `symbol` (named, default or namespace). */
function importsSymbol(text, symbol) {
  const t = stripComments(text);
  const named = new RegExp(
    `import\\s+(?:type\\s+)?\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s+from`,
  );
  if (named.test(t)) return true;
  // `import X from ".../X"` and `require(".../X")`.
  return new RegExp(`from\\s*["'][^"']*\\b${symbol}["']`).test(t);
}

/** Every source file under src/, so "nothing else renders this" is provable. */
function allSourceFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name))
        out.push(full.replace(/\\/g, "/"));
    }
  };
  walk("src");
  return out.map((f) => ({ f, text: fs.readFileSync(f, "utf8") }));
}

const allSource = allSourceFiles();
const layouts = allSource.filter(({ f }) =>
  f.startsWith("src/components/layout/"),
);

/** Count non-overlapping matches of a literal substring. */
function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

describe("a signed-in listener can always sign out", () => {
  test("the account menu offers both Sign out and Switch account", () => {
    expect(src.menu).toMatch(/Switch account/);
    expect(src.menu).toMatch(/Sign out/);
  });

  test("the menu consumes the shared hook instead of re-implementing it", () => {
    // Two implementations is how the app ended up with three, each wrong in
    // a different way.
    expect(importsSymbol(src.menu, "useAccountActions")).toBe(true);
    expect(importsSymbol(src.menu, "useAuthActions")).toBe(false);
  });

  test("the sidebar renders the account menu in BOTH layout branches", () => {
    expect(importsSymbol(src.sidebar, "AccountMenu")).toBe(true);
    // Two mount sites: the 72px rail and the 240px panel. One would mean a
    // collapsed sidebar with no way out of the account.
    expect(count(src.sidebar, "<AccountMenu")).toBe(2);
    // Whitespace-tolerant: prettier reflows these props across lines.
    expect(src.sidebar).toMatch(/<AccountMenu\s+variant="collapsed"/);
    expect(src.sidebar).toMatch(/<AccountMenu\s+variant="expanded"/);
  });

  test("the phone sheet offers both actions (the sidebar is lg:-only)", () => {
    expect(importsSymbol(src.mobile, "useAccountActions")).toBe(true);
    expect(src.mobile).toMatch(/Switch account/);
    expect(src.mobile).toMatch(/Sign out/);
  });

  test("the settings route passes onSignOut so the dialog shows its row", () => {
    // This one missing prop is the entire reason there was no logout button:
    // the dialog renders `{onSignOut && (...)}`, and the route passed nothing.
    expect(src.dialog).toMatch(/\{onSignOut && \(/);
    expect(src.settings).toMatch(/onSignOut=\{signOut\}/);
    expect(importsSymbol(src.settings, "useAccountActions")).toBe(true);
  });

  test("the collapsed rail is an account control, not a plain avatar", () => {
    // A rail with a bare profile link would pass a naive "is there an avatar"
    // check while offering no way out of the account.
    expect(src.menu).toMatch(/aria-label="Account menu"/);
    expect(src.menu).not.toMatch(/<NavLink/);
  });
});

describe("there is exactly one sign-out implementation", () => {
  test("no component imports Convex's useAuthActions directly", () => {
    // `useAuthActions().signOut` bypasses the session reset entirely. The one
    // sanctioned wrapper is `src/hooks/use-auth.ts`; anyone else importing it
    // is reaching around the account actions.
    const offenders = allSource
      .filter(
        ({ f, text }) =>
          f !== AUTH_HOOK && importsSymbol(text, "useAuthActions"),
      )
      .map(({ f }) => f);
    expect(offenders).toEqual([]);
  });

  test("useAuth re-exports signOut, but no layout pulls it off useAuth", () => {
    // The re-export exists for non-account callers (e.g. the auth pages).
    // What must not happen again is a LAYOUT destructuring `signOut` from
    // `useAuth`, because that path cannot clear the previous listener's
    // session. Layouts legitimately import `useAuth` for `user`; what they may
    // not do is take the sign-out from it.
    expect(importsSymbol(src.auth, "useAuthActions")).toBe(true);
    const fromUseAuth = /\{[^}]*\bsignOut\b[^}]*\}\s*=\s*useAuth\(/;
    const offenders = layouts
      .filter(({ text }) => fromUseAuth.test(stripComments(text)))
      .map(({ f }) => f);
    expect(offenders).toEqual([]);
  });

  test("no layout component still owns a private signOut handler", () => {
    // The dead `Sidebar`/`AppShell` copies each had a `handleSignOut` that
    // only called signOut + navigate. Any layout doing that again is
    // re-introducing the divergent path that made this bug invisible.
    const offenders = layouts
      .filter(({ text }) => /\bhandleSignOut\b/.test(stripComments(text)))
      .map(({ f }) => f);
    expect(offenders).toEqual([]);
  });

  test("no layout mounts an unreachable SettingsDialog", () => {
    // `open={someState}` where nothing ever calls the setter. Asserted
    // against the concrete pattern that shipped three times.
    const offenders = layouts
      .filter(({ text }) => /<SettingsDialog/.test(stripComments(text)))
      .map(({ f }) => f);
    expect(offenders).toEqual([]);
  });

  test("LogoDropdown is dead code and nothing renders it", () => {
    // It is the reason the codebase LOOKED like it had sign-out. Left in
    // place it will keep misleading the next person auditing auth.
    const file = "src/components/LogoDropdown.tsx";
    expect(fs.existsSync(file)).toBe(true);
    const importers = allSource
      .filter(
        ({ f, text }) => f !== file && importsSymbol(text, "LogoDropdown"),
      )
      .map(({ f }) => f);
    expect(importers).toEqual([]);
  });
});

describe("signing out leaves no trace of the previous listener", () => {
  test("the local session is cleared BEFORE the auth token is dropped", () => {
    // The queue and the half-played track live in localStorage and outlive
    // the token. Clearing after signOut() still hands the next person on a
    // shared device the previous listener's queue.
    const reset = src.hooks.indexOf("resetForSignOut()");
    const signOut = src.hooks.indexOf("await signOut()");
    expect(reset).toBeGreaterThan(-1);
    expect(signOut).toBeGreaterThan(-1);
    expect(reset).toBeLessThan(signOut);
  });

  test("switching accounts lands on the sign-in form, not the landing page", () => {
    // Convex Auth keeps one session per browser, so a switch is necessarily
    // sign-out-then-sign-in. Landing on "/" would make "Switch account" and
    // "Sign out" the same button.
    expect(src.hooks).toMatch(/signOutAndGo\("\/auth"\)/);
    expect(src.hooks).toMatch(/signOutAndGo\("\/"\)/);
  });

  test("a rejected signOut still navigates instead of trapping the user", () => {
    // Someone trying to escape an account must not be held in it because a
    // network call failed.
    expect(src.hooks).toMatch(/catch[\s\S]{0,240}navigate\(destination/);
  });

  test("resetForSignOut stops BOTH decks and the YouTube engine", () => {
    // Pausing only the live deck leaves the incoming crossfade song playing
    // with no session at all — silence in the UI, music in the room.
    const fn = resetBody();
    expect(fn).toMatch(/cancelTransition\(/);
    expect(fn).toMatch(/pauseAllDecks\(\)/);
    expect(fn).toMatch(/ytEngine\.pause\(\)/);
  });

  test("resetForSignOut drops the PERSISTED queue, not just the in-memory one", () => {
    // Without the storage key the next sign-in restores the old queue from
    // the reload that follows the sign-out.
    const fn = resetBody();
    expect(fn).toMatch(/removeSetting\(QUEUE_KEY\)/);
    expect(fn).toMatch(/current: null/);
    expect(fn).toMatch(/queueIndex: -1/);
    expect(fn).toMatch(/isPlaying: false/);
    expect(fn).toMatch(/history: \[\]/);
    expect(fn).toMatch(/liked: \{\}/);
  });

  test("resetForSignOut is exposed on the store interface, not only the impl", () => {
    // A store action missing from the interface is invisible to
    // `usePlayerStore((s) => s.x)` and fails to typecheck.
    expect(src.store).toMatch(/resetForSignOut: \(\) => void;/);
  });

  test("the hook reads the action off the store, so a rename breaks loudly", () => {
    expect(src.hooks).toMatch(/usePlayerStore\(\(s\) => s\.resetForSignOut\)/);
  });
});

/** The body of the store's `resetForSignOut` implementation. */
function resetBody() {
  const start = src.store.indexOf("resetForSignOut: () => {");
  expect(start).toBeGreaterThan(-1);
  const rest = src.store.slice(start + "resetForSignOut: () => {".length);
  const end = rest.indexOf("setHistoryRecorder");
  return end === -1 ? rest.slice(0, 2000) : rest.slice(0, end);
}
