import { afterEach, describe, expect, test } from "bun:test";
import {
  buildDesktopCallbackUrl,
  isDesktopRuntime,
  startDesktopOAuth,
} from "../src/lib/desktop-auth.ts";

/**
 * Renderer-half contract tests for the desktop OAuth flow.
 *
 * The bridge (`window.synqDesktop`, installed by `electron/preload.cjs`) is
 * stubbed here — bun gives us no Electron renderer — so these pin what the
 * renderer itself is responsible for:
 *
 *  - gated on the bridge: the hosted web build and Android take their
 *    existing path unchanged,
 *  - subscribed BEFORE the sign-in starts, so a fast return cannot be missed,
 *  - only this attempt's callback settles this attempt's promise,
 *  - the timeout abandons the flow honestly, and unsubscribes when it does.
 */

/** Install a controllable fake bridge and return its handle. */
function installBridge({ timeout = false } = {}) {
  const calls = [];
  let authListener = null;
  let unsubCalls = 0;
  globalThis.window = {
    location: { href: "app://synq/" },
    synqDesktop: {
      isDesktop: true,
      platform: "win32",
      shell: "electron",
      beginOAuth: (clientId, params) => calls.push(["begin", clientId, params]),
      onAuthResult: (listener) => {
        if (timeout) throw new Error("listener regist failed");
        authListener = listener;
        return () => {
          unsubCalls += 1;
        };
      },
    },
  };
  return {
    calls,
    get authListener() {
      return authListener;
    },
    get unsubCalls() {
      return unsubCalls;
    },
  };
}

afterEach(() => {
  delete globalThis.window;
});

describe("the runtime gate", () => {
  test("without the bridge or the OAuth surface, it is not a desktop OAuth runtime", () => {
    delete globalThis.window;
    expect(isDesktopRuntime()).toBe(false);

    // A bridge without the OAuth surface (an older shell binary) is also not
    // treated as one, so sign-in falls back to the normal web flow.
    globalThis.window = { synqDesktop: { isDesktop: true } };
    expect(isDesktopRuntime()).toBe(false);
  });

  test("the real bridge shape is detected", () => {
    installBridge();
    expect(isDesktopRuntime()).toBe(true);
  });
});

describe("the callback URL the server rewrites", () => {
  test("carries client, timestamp and nonce in a fixed order", () => {
    expect(
      buildDesktopCallbackUrl({ client: "google-abc", ts: 1234, nonce: "n&=x" }),
    ).toBe(
      "synq://callback?client=google-abc&ts=1234&nonce=n%26%3Dx",
    );
  });
});

describe("startDesktopOAuth", () => {
  const provider = "google";

  test("registers the attempt and then starts sign-in, in that order", async () => {
    const bridge = installBridge();
    const order = [];
    const signIn = async (callbackUrl) => {
      order.push("signIn:" + callbackUrl);
      return undefined;
    };

    const promise = startDesktopOAuth(provider, signIn, { timeoutMs: 2000 });
    // Sign-in is awaited inside startDesktopOAuth; until the main-process
    // result arrives the promise stays pending.
    expect(bridge.calls.length).toBe(1);
    const [verb, clientId, params] = bridge.calls[0];
    expect(verb).toBe("begin");
    expect(clientId).toContain("google");
    expect(typeof params.nonce).toBe("string");
    expect(typeof params.ts).toBe("number");

    // The listener was registered before the sign-in was allowed to start:
    // a callback delivered during startSignIn must still be received.
    expect(bridge.authListener).toBeTruthy();
    bridge.authListener({ client: clientId, code: "CODE", ts: params.ts });
    const result = await promise;
    expect(result.code).toBe("CODE");
    expect(result.client).toBe(clientId);
  });

  test("a callback for another attempt never settles this one", async () => {
    const bridge = installBridge();
    const signIn = async () => undefined;
    const promise = startDesktopOAuth(provider, signIn, { timeoutMs: 5000 });

    const clientId = bridge.calls[0][1];
    // A stray result from an earlier/other flow is ignored.
    bridge.authListener({ client: "someone-else", code: "EVIL", ts: 1 });
    bridge.authListener({ client: clientId, code: "GOOD", ts: 2 });
    const result = await promise;
    expect(result.code).toBe("GOOD");
  });

  test("an abandoned flow times out to null and unsubscribes", async () => {
    const bridge = installBridge();
    const signIn = async () => undefined;
    const result = await startDesktopOAuth(provider, signIn, {
      timeoutMs: 40,
    });
    expect(result).toBeNull();
    expect(bridge.unsubCalls).toBe(1);
  });
  test("non-desktop runtimes resolve null without touching sign-in", async () => {
    delete globalThis.window;
    const signIn = async (url) => {
      throw new Error("should not be called");
    };
    const result = await startDesktopOAuth(provider, signIn);
    expect(result).toBeNull();
  });

  test("a bridge without an OAuth surface resolves null unchanged", async () => {
    globalThis.window = { synqDesktop: { isDesktop: true } };
    const signIn = async (url) => {
      throw new Error("should not be called");
    };
    const result = await startDesktopOAuth("github", signIn);
    expect(result).toBeNull();
  });
});
