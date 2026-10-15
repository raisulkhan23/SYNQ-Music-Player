/**
 * Tests for the USER-SUPPLIED RESOLVER.
 *
 * WHY THIS IS TESTED CAREFULLY. This module is the only route by which
 * downloads can work at all, and it has two failure modes that are easy to
 * conflate and expensive to get wrong:
 *
 *  1. A resolver that is DOWN, and a resolver that is UP but IP-blocked by
 *     YouTube, look identical if you only check "did it throw". Telling
 *     someone their server is unreachable when YouTube is blocking its IP
 *     sends them to fix the wrong thing — which is precisely the mistake that
 *     made this feature look broken for an entire session.
 *  2. The stored value is a URL that gets fetched, so it must be sanitised
 *     before it is ever stored or used.
 *
 * The real module is loaded from source with `localStorage` and `fetch`
 * injected, so the shipped logic runs here rather than a copy of it.
 *
 * Run: bun scripts/audit.resolver.ts
 */

import { readFileSync } from "node:fs";

const source = readFileSync("src/lib/customResolver.ts", "utf8");
const js = new Bun.Transpiler({ loader: "ts" }).transformSync(
  source.replace(/^import[\s\S]*?from "@\/lib\/[^"]*";\n/gm, "").replace(
    /^export /gm,
    "",
  ),
);

// ---------------------------------------------------------------------------
// A fake localStorage, including a mode that throws like private-mode Safari.
// ---------------------------------------------------------------------------

class MemoryStorage {
  private map = new Map<string, string>();
  throwOnAccess = false;
  getItem(k: string) {
    if (this.throwOnAccess) throw new Error("storage blocked");
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    if (this.throwOnAccess) throw new Error("storage blocked");
    this.map.set(k, v);
  }
  removeItem(k: string) {
    if (this.throwOnAccess) throw new Error("storage blocked");
    this.map.delete(k);
  }
}

interface Module {
  CUSTOM_RESOLVER_KEY: string;
  readCustomResolver(): string;
  writeCustomResolver(raw: string): string;
  clearCustomResolver(): void;
  checkCustomResolver(
    base: string,
    timeoutMs?: number,
  ): Promise<
    | { ok: true; detail: string }
    | { ok: false; reason: string; detail: string }
  >;
}

function load(storage: MemoryStorage, fetchImpl: typeof fetch, loc?: unknown): Module {
  const factory = new Function("localStorage", "fetch", "location", `${js}
    return { CUSTOM_RESOLVER_KEY, readCustomResolver, writeCustomResolver, clearCustomResolver, checkCustomResolver };`) as (
    s: MemoryStorage,
    f: typeof fetch,
    l: unknown,
  ) => Module;
  return factory(storage, fetchImpl, loc);
}

const noFetch = (() => {
  throw new Error("fetch must not be called");
}) as unknown as typeof fetch;

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\nstoring a resolver");

{
  const store = new MemoryStorage();
  const m = load(store, noFetch);

  check("starts empty", m.readCustomResolver() === "");
  check("saves an http address", m.writeCustomResolver("http://localhost:8080") === "http://localhost:8080");
  check("reads it back", m.readCustomResolver() === "http://localhost:8080");
  check("stores under a namespaced key", m.CUSTOM_RESOLVER_KEY.startsWith("ss."), m.CUSTOM_RESOLVER_KEY);

  // Trailing slashes would double up when a path is joined onto the base.
  check("strips trailing slashes", m.writeCustomResolver("http://localhost:8080///") === "http://localhost:8080");
  check("trims surrounding whitespace", m.writeCustomResolver("  http://box:8080  ") === "http://box:8080");
  check("keeps https", m.writeCustomResolver("https://piped.example.com") === "https://piped.example.com");
}

console.log("\nrefusing what must never be fetched");

{
  const m = load(new MemoryStorage(), noFetch);
  for (const bad of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "localhost:8080",
    "not a url",
    "",
    "   ",
    // A scheme with no host. `new URL("http://")` throws in most engines but
    // must never become a fetch against an empty host either way.
    "http://",
    "https://",
    // Credentials would be persisted to localStorage in the clear and echoed
    // into any message quoting the address.
    "http://user:secret@box.example.com",
    "http://user@box.example.com",
  ]) {
    check(`rejects ${JSON.stringify(bad)}`, m.writeCustomResolver(bad) === "", m.writeCustomResolver(bad));
  }
  check("rejects a rejected value even if one was stored", (() => {
    m.writeCustomResolver("http://localhost:8080");
    m.writeCustomResolver("javascript:alert(1)");
    return m.readCustomResolver() === "";
  })());

  m.writeCustomResolver("http://localhost:8080");
  m.clearCustomResolver();
  check("clearing empties it", m.readCustomResolver() === "");
}

console.log("\nsurviving a browser that refuses storage");

{
  const store = new MemoryStorage();
  store.throwOnAccess = true;
  const m = load(store, noFetch);
  // Must not throw: a locked-down browser should degrade to "no resolver",
  // which is the pre-existing behaviour, not take the settings page down.
  let read: unknown;
  try {
    read = m.readCustomResolver();
  } catch (e) {
    read = `THREW: ${e}`;
  }
  check("reading survives blocked storage", read === "", String(read));
  let wrote: unknown;
  try {
    wrote = m.writeCustomResolver("http://localhost:8080");
  } catch (e) {
    wrote = `THREW: ${e}`;
  }
  check("writing survives blocked storage", wrote === "http://localhost:8080", String(wrote));
}

/** A minimal well-formed Piped response, for the "resolver works" path. */
const GOOD = {
  title: "Test",
  audioStreams: [{ url: "https://cdn.test/a.m4a" }],
  videoStreams: [],
};

console.log("\nany self-hosted address is accepted, not just localhost");

{
  const m = load(new MemoryStorage(), noFetch);
  // THE POINT OF THIS BLOCK. There is no allowlist and no localhost check, so a
  // resolver on a LAN box, a VPS, or a hostname behind a reverse proxy is a
  // first-class setting. Previously this feature could only be described in
  // terms of localhost, which made a perfectly good remote resolver look
  // unsupported.
  const cases: [string, string][] = [
    ["http://localhost:8080", "http://localhost:8080"],
    ["http://127.0.0.1:8080", "http://127.0.0.1:8080"],
    ["http://192.168.1.50:8080", "http://192.168.1.50:8080"],
    ["http://10.0.0.7:8080", "http://10.0.0.7:8080"],
    ["https://piped.example.com", "https://piped.example.com"],
    ["https://resolver.my-domain.net/api", "https://resolver.my-domain.net/api"],
    ["http://nas.local:8080", "http://nas.local:8080"],
    ["http://[::1]:8080", "http://[::1]:8080"],
    ["https://user.example.com:8443", "https://user.example.com:8443"],
    ["  https://box.example.com/  ", "https://box.example.com"],
  ];
  for (const [input, expected] of cases) {
    check(
      `accepts ${JSON.stringify(input)}`,
      m.writeCustomResolver(input) === expected,
      m.writeCustomResolver(input),
    );
  }
  check("a remote resolver survives a reload", (() => {
    m.writeCustomResolver("https://piped.example.com");
    return m.readCustomResolver() === "https://piped.example.com";
  })());
}

console.log("\nplain-HTTP remote addresses are blocked by the browser, not the network");

{
  const { f, calls } = scripted(() => ({ json: GOOD }));
  const httpsPage = load(new MemoryStorage(), f, { protocol: "https:" });
  const r = await httpsPage.checkCustomResolver("http://192.168.1.50:8080");

  // The single most important new behaviour. On an HTTPS page the browser
  // refuses a plain-HTTP request to any non-loopback host before it leaves the
  // device, and hands `fetch` an error identical to "server down". Reporting
  // that as "unreachable" sends people to debug a server that is running fine.
  check(
    "a plain-HTTP remote address is named mixed-content, not unreachable",
    r.ok === false && r.reason === "mixed-content",
    JSON.stringify(r),
  );
  check("its message says HTTPS is the fix", /https/i.test(r.detail), r.detail);
  check(
    "it never spends a request that cannot succeed",
    calls.length === 0,
    `${calls.length} calls`,
  );
}

{
  // Loopback is exempt from mixed-content blocking, which is the ONLY reason a
  // localhost resolver works from an HTTPS page. If this regressed, the
  // headline setup would start reporting as broken.
  const { f } = scripted(() => ({ json: GOOD }));
  const httpsPage = load(new MemoryStorage(), f, { protocol: "https:" });
  for (const loopback of [
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "http://127.1.2.3:8080",
    "http://[::1]:8080",
    "http://app.localhost:8080",
  ]) {
    const r = await httpsPage.checkCustomResolver(loopback);
    check(`${loopback} is trusted on an HTTPS page`, r.ok === true, JSON.stringify(r));
  }
}

{
  const { f } = scripted(() => ({ json: GOOD }));
  const httpsPage = load(new MemoryStorage(), f, { protocol: "https:" });
  const r = await httpsPage.checkCustomResolver("https://piped.example.com");
  check("an HTTPS remote address is tested for real", r.ok === true, JSON.stringify(r));
}

{
  // Same address, insecure page: there is no mixed content, so the request must
  // actually be attempted rather than being pre-emptively refused.
  const { f, calls } = scripted(() => ({ json: GOOD }));
  const httpPage = load(new MemoryStorage(), f, { protocol: "http:" });
  const r = await httpPage.checkCustomResolver("http://192.168.1.50:8080");
  check("on an HTTP page a plain-HTTP address is attempted", calls.length === 1, `${calls.length} calls`);
  check("and reports what the server said", r.ok === true, JSON.stringify(r));
}

console.log("\ntesting a resolver — the outcomes must stay distinct");

function scripted(
  behaviour: (url: string) => { status?: number; json?: unknown; throws?: string },
) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const b = behaviour(url);
    if (b.throws) throw new TypeError(b.throws);
    const status = b.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      // A real `Response` can be read as text OR json, and the module uses
      // `text()` on an error status to look for YouTube's bot-check. The stub
      // has to offer both, or the error path cannot be exercised at all.
      text: async () => (b.json === undefined ? "" : JSON.stringify(b.json)),
      json: async () => {
        if (b.json === undefined) throw new Error("no body");
        return b.json;
      },
    };
  }) as unknown as typeof fetch;
  return { f, calls };
}

{
  const { f } = scripted(() => ({ json: GOOD }));
  const r = await load(new MemoryStorage(), f).checkCustomResolver("http://localhost:8080");
  check("a working resolver reports ok", r.ok === true, JSON.stringify(r));
}

{
  const { f } = scripted(() => ({ throws: "Failed to fetch" }));
  const r = await load(new MemoryStorage(), f).checkCustomResolver("http://localhost:8080");
  check("an unreachable resolver is NOT ok", r.ok === false);
  check(
    "an unreachable resolver is reported as unreachable, not blocked",
    r.ok === false && r.reason === "unreachable",
    JSON.stringify(r),
  );
  check("its message mentions reachability", /reach/i.test(r.detail), r.detail);
}

{
  // The real, measured body from a public Piped mirror. It answers HTTP 500
  // with YouTube's own exception named inside it.
  const { f } = scripted(() => ({
    status: 500,
    json: {
      error:
        "org.schabi.newpipe.extractor.exceptions.SignInConfirmNotBotException: YouTube probably temporarily blocked anonymous watch access with this IP , got error LOGIN_REQUIRED: \"Sign in to confirm that you're not a bot\"",
    },
  }));
  const r = await load(new MemoryStorage(), f).checkCustomResolver("http://localhost:8080");
  check("a bot-blocked resolver is NOT ok", r.ok === false);
  check(
    "a bot-blocked resolver says BLOCKED, not unreachable",
    r.ok === false && r.reason === "blocked",
    JSON.stringify(r),
  );
  check(
    "its message says the IP is blocked, so the user fixes the right thing",
    /block/i.test(r.detail),
    r.detail,
  );
}

{
  const { f } = scripted(() => ({ json: { audioStreams: [], videoStreams: [] } }));
  const r = await load(new MemoryStorage(), f).checkCustomResolver("http://localhost:8080");
  check(
    "a resolver with no stream is distinct again",
    r.ok === false && r.reason === "no-stream",
    JSON.stringify(r),
  );
}

{
  const { f, calls } = scripted(() => ({ json: GOOD }));
  const r = await load(new MemoryStorage(), f).checkCustomResolver("nonsense");
  check("an invalid address is rejected without a request", r.ok === false && r.reason === "invalid", JSON.stringify(r));
  check("an invalid address makes no network call", calls.length === 0, `${calls.length} calls`);
}

{
  const { f, calls } = scripted(() => ({ json: GOOD }));
  await load(new MemoryStorage(), f).checkCustomResolver("http://localhost:8080/");
  check("trailing slash is normalised before the request", calls[0] === "http://localhost:8080/streams/dQw4w9WgXcQ", calls[0]);
}

console.log("\nthe custom resolver is tried BEFORE the public mirrors");

{
  // The ordering assertion, against the real `resolveViaPiped`.
  const pipedSrc = readFileSync("src/lib/pipedResolve.ts", "utf8");
  const customIdx = pipedSrc.indexOf("function customInstance()");
  const listIdx = pipedSrc.indexOf("function instanceList()");
  const loopIdx = pipedSrc.indexOf("for (const base of instanceList())");
  check("a custom instance is read from storage", customIdx > 0);
  check("a custom instance is prepended to the mirror list", customIdx > 0 && listIdx > customIdx);
  check(
    "the custom instance comes first in the list",
    /return custom \? \[custom, \.\.\.PIPED_INSTANCES\]/.test(pipedSrc),
  );
  check("the loop iterates the combined list, not the raw mirrors", loopIdx > 0 && /instanceList\(\)/.test(pipedSrc.slice(loopIdx, loopIdx + 60)));
}

console.log(
  `\n${passed} passed, ${failures.length} failed` +
    (failures.length ? `\n\nFailing:\n${failures.map((f) => `  - ${f}`).join("\n")}` : ""),
);
process.exit(failures.length ? 1 : 0);
