import { describe, expect, test } from "bun:test";
import { readSource } from "./helpers/tailwind-css.js";

/**
 * Renderer-half contract tests for the ANDROID OAuth flow.
 *
 * The native half (MainActivity hand-off to the system browser, and the
 * `com.synq.music://callback` deep link back into the activity) cannot be
 * exercised here. What CAN be pinned is what the renderer owns, which is where
 * this flow broke before:
 *
 *  - it is gated on the Android shell, so web and desktop keep their paths,
 *  - the return URL is a deep link, not `https://localhost`,
 *  - only THIS attempt's callback settles this attempt,
 *  - an abandoned flow resolves instead of hanging on a spinner.
 *
 * The receiver is registered at import time, so `window` has to exist before
 * the module is loaded — hence the top-level dynamic import.
 */

const win = {
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => "android",
  },
};

globalThis.window = win;

const mod = await import("../src/lib/native-auth.ts");
const { isNativeOAuthRuntime, startNativeOAuth, NATIVE_CALLBACK_SCHEME } = mod;

const deliver = win.synqNativeAuthDeliver;

/** Start a flow and hand back the callback the server would have produced. */
function begin(startSignIn = async () => undefined, timeoutMs = 4000) {
  const promise = startNativeOAuth("google", startSignIn, { timeoutMs });
  return promise;
}

function callbackParams(redirectTo) {
  const url = new URL(redirectTo);
  return {
    client: url.searchParams.get("client") ?? "",
    ts: url.searchParams.get("ts") ?? "",
  };
}

describe("the runtime gate", () => {
  test("the Android shell is an OAuth runtime", () => {
    expect(isNativeOAuthRuntime()).toBe(true);
  });

  test("a non-Android native shell is not", () => {
    const saved = globalThis.window;
    globalThis.window = {
      Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => "ios",
      },
    };
    expect(isNativeOAuthRuntime()).toBe(false);
    globalThis.window = saved;
  });

  test("a plain browser is not", () => {
    const saved = globalThis.window;
    globalThis.window = {};
    expect(isNativeOAuthRuntime()).toBe(false);
    globalThis.window = saved;
  });
});

describe("the callback the app is re-entered through", () => {
  test("is the app's own scheme, never the WebView origin", async () => {
    let seen = "";
    const promise = begin(async (url) => {
      seen = url;
    });
    expect(seen.startsWith(`${NATIVE_CALLBACK_SCHEME}://callback?`)).toBe(true);
    // `https://localhost` is the WebView's origin, and returning there was one
    // of the two reasons sign-in failed on the phone.
    expect(seen).not.toContain("https://");
    const { client, ts } = callbackParams(seen);
    deliver(`${NATIVE_CALLBACK_SCHEME}://callback?client=${client}&ts=${ts}&code=Z`);
    await promise;
  });

  test("it carries a per-attempt client id and timestamp", async () => {
    let seen = "";
    const promise = begin(async (url) => {
      seen = url;
    });
    const { client, ts } = callbackParams(seen);
    expect(client).toContain("google");
    expect(Number(ts)).toBeGreaterThan(0);
    deliver(`${NATIVE_CALLBACK_SCHEME}://callback?client=${client}&ts=${ts}&code=Z`);
    await promise;
  });
});

describe("startNativeOAuth", () => {
  test("a matching callback resolves with the code to exchange", async () => {
    let seen = "";
    const promise = begin(async (url) => {
      seen = url;
    });
    const { client, ts } = callbackParams(seen);
    // `@convex-dev/auth` rewrites the query string when it appends `code`,
    // producing a `//callback/?` form — both shapes have to be understood.
    deliver(`${NATIVE_CALLBACK_SCHEME}://callback/?client=${client}&ts=${ts}&code=CODE`);
    const result = await promise;
    expect(result?.code).toBe("CODE");
    expect(result?.error).toBeNull();
  });

  test("a callback for another attempt is ignored", async () => {
    let seen = "";
    const promise = begin(async (url) => {
      seen = url;
    });
    const { client, ts } = callbackParams(seen);
    deliver(`${NATIVE_CALLBACK_SCHEME}://callback?client=someone-else&ts=1&code=EVIL`);
    deliver(`${NATIVE_CALLBACK_SCHEME}://callback?client=${client}&ts=${ts}&code=GOOD`);
    const result = await promise;
    expect(result?.code).toBe("GOOD");
  });

  test("a URL for another scheme or host is ignored", async () => {
    let seen = "";
    const promise = begin(async (url) => {
      seen = url;
    });
    const { client, ts } = paramsFrom(seen);
    deliver(`synq://callback?client=${client}&ts=${ts}&code=DESKTOP`);
    deliver(`https://localhost/?client=${client}&ts=${ts}&code=WEB`);
    deliver(`${NATIVE_CALLBACK_SCHEME}://elsewhere?client=${client}&ts=${ts}&code=WRONGHOST`);
    deliver(`${NATIVE_CALLBACK_SCHEME}://callback?client=${client}&ts=${ts}&code=RIGHT`);
    const result = await promise;
    expect(result?.code).toBe("RIGHT");
  });

  test("a provider denial surfaces as an error, not a hang", async () => {
    let seen = "";
    const promise = begin(async (url) => {
      seen = url;
    });
    const { client, ts } = paramsFrom(seen);
    deliver(
      `${NATIVE_CALLBACK_SCHEME}://callback?client=${client}&ts=${ts}&error=access_denied&error_description=User%20denied`,
    );
    const result = await promise;
    expect(result?.code).toBeNull();
    expect(result?.error).toBe("User denied");
  });

  test("an abandoned flow times out to null", async () => {
    const result = await begin(async () => undefined, 30);
    expect(result).toBeNull();
  });

  test("a sign-in that cannot start settles instead of leaving the button spinning", async () => {
    const result = await begin(async () => {
      throw new Error("no provider");
    });
    expect(result?.code).toBeNull();
    expect(result?.error).toBe("no provider");
  });
});

describe("the server accepts the app's return leg", () => {
  const auth = readSource("src/convex/auth.ts");

  test("both app schemes are trusted", () => {
    expect(auth).toContain('"synq:"');
    expect(auth).toContain('"com.synq.music:"');
  });

  test("the scheme check runs BEFORE the origin check", () => {
    // `new URL("com.synq.music://callback").origin` is the string "null", so an
    // origin-only check rejects every deep link — that is what broke the
    // desktop flow too.
    const schemeCheck = auth.indexOf("TRUSTED_APP_SCHEMES.includes(parsed.protocol)");
    const originCheck = auth.indexOf("isTrustedOrigin(origin)");
    expect(schemeCheck).toBeGreaterThan(-1);
    expect(originCheck).toBeGreaterThan(schemeCheck);
  });

  test("the Android WebView origin is trusted as well", () => {
    expect(auth).toContain("https://localhost");
  });
});

/** Same as callbackParams; named for the tests that only need the pair. */
function paramsFrom(redirectTo) {
  return callbackParams(redirectTo);
}
