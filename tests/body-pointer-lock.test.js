import { describe, expect, test } from "bun:test";
import { readSource } from "./helpers/tailwind-css.js";

const shell = readSource("src/components/layout/AppShell.tsx");
const main = readSource("src/main.tsx");

const flatShell = shell.replace(/\s+/g, " ");

describe("the app can never be left fully unclickable", () => {
  test("the stale body lock is only honoured for genuinely OPEN layers", () => {
    // THE bug: Radix sets `body { pointer-events: none }` while a layer is
    // open. The old check asked whether ANY layer ELEMENT existed, so a
    // closed or unmounting layer kept the lock forever — the app rendered
    // perfectly and not one control responded, and only a manual browser
    // reload recovered it. Detection must require `data-state="open"`.
    expect(flatShell).toContain(
      '[data-radix-dialog-content][data-state="open"]',
    );
    expect(flatShell).toContain(
      '[data-slot="sheet-content"][data-state="open"]',
    );
    // And it must NOT fall back to a presence-only match.
    expect(shell).not.toContain('[role="dialog"]:not([hidden])');
    expect(shell).not.toContain('[role="menu"],');
  });

  test("the lock is re-checked on navigation, not only on pointerdown", () => {
    // A route change is enough to recover even if the user never clicks again.
    expect(flatShell).toMatch(/\}, \[location\.pathname\]\);/);
  });

  test("the lock is also re-checked on keyboard input", () => {
    // Keyboard nav must not be permanently dead either.
    expect(flatShell).toContain(
      'window.addEventListener("keydown", clearStaleBodyLock, true)',
    );
  });

  test("a crashed route releases the lock it orphaned", () => {
    // A route that dies while a menu/sheet/dialog is open unmounts the layer
    // that owned the lock, so nothing would ever clear it. The boundary is
    // the one place that knows the unmount happened. Comments are stripped
    // first: they quote the very CSS this test asserts on.
    const code = main.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const start = code.indexOf(
      "componentDidCatch(error: Error) {",
      code.indexOf("class RouteErrorBoundary"),
    );
    const block = code.slice(start, code.indexOf("render()", start));
    expect(block).toContain("document.body.style.pointerEvents");
    expect(block).toContain('=== "none"');
    expect(block).toContain('document.body.style.pointerEvents = "";');
  });

  test("genuine modals are still allowed to lock the body", () => {
    // The fix must not neuter Radix: an OPEN dialog legitimately holds the
    // lock, and the app must still be able to lock it in the first place.
    const block = shell.slice(
      shell.indexOf("const clearStaleBodyLock"),
      shell.indexOf('window.addEventListener("pointerdown"'),
    );
    expect(block).toContain("hasOpenLayer");
    expect(block).toMatch(
      /if \(!hasOpenLayer\) document\.body\.style\.pointerEvents = "";/,
    );
  });
});
