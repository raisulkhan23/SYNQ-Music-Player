/**
 * The stall bound, measured rather than asserted.
 *
 * The request these mirrors exist to serve is `GET /streams/<id>`, and it is
 * made SEQUENTIALLY, so the worst case is `instances x per-instance timeout`.
 * With the old six-entry list at 6s each that was 36 seconds of a track
 * sitting silent, for callers outside the player's 1.2s race — the download
 * path and `prepareIncoming` waited the whole thing.
 *
 * This drives the REAL `resolveViaPiped` from the real module, with `fetch`
 * replaced by one that never answers, which is precisely the "list of dead
 * mirrors" case. It then checks the total against the budget.
 *
 *   bun scripts/audit.piped.budget.ts
 */

import { resolveViaPiped } from "../src/lib/pipedResolve";

/** Mirrors the constants in src/lib/pipedResolve.ts. */
const BUDGET_MS = 8_000;
const PER_INSTANCE_MS = 4_000;
/** Generous allowance for scheduler noise; the old behaviour was 36s. */
const ALLOWANCE_MS = 1_500;

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const realFetch = globalThis.fetch;

async function main() {
  console.log("A. every mirror hangs (the dead-mirror case)\n");

  // A fetch that never settles: the mirror is up but wedged, which is the
  // worst case because it can only be ended by our own timeout.
  globalThis.fetch = ((_url: string, init?: { signal?: AbortSignal }) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    });
  }) as typeof fetch;

  const t0 = Date.now();
  const result = await resolveViaPiped("dQw4w9WgXcQ");
  const elapsed = Date.now() - t0;

  globalThis.fetch = realFetch;

  console.log(`  elapsed ${elapsed}ms (budget ${BUDGET_MS}ms)`);
  check("gives up with no url", result.url === null);
  check(
    `bounded by the overall budget`,
    elapsed <= BUDGET_MS + ALLOWANCE_MS,
    `${elapsed}ms <= ${BUDGET_MS + ALLOWANCE_MS}ms`,
  );
  check(
    "far below the old unbounded worst case",
    elapsed < 36_000,
    `${elapsed}ms < 36000ms`,
  );
  check(
    "every abort is reported, none swallowed",
    result.failures.length > 0 &&
      result.failures.every((f) => typeof f.detail === "string" && f.detail.length > 0),
    `${result.failures.length} failures: ${result.failures
      .map((f) => f.detail)
      .join(" | ")
      .slice(0, 90)}`,
  );
  check(
    "a single instance cannot outlive the per-instance timeout",
    elapsed < BUDGET_MS + PER_INSTANCE_MS,
    `${elapsed}ms < ${BUDGET_MS + PER_INSTANCE_MS}ms`,
  );

  console.log("\nB. a live mirror resolves for real\n");
  const t1 = Date.now();
  const live = await resolveViaPiped("dQw4w9WgXcQ");
  const liveMs = Date.now() - t1;
  console.log(
    `  ${live.url ? "resolved" : "no url"} in ${liveMs}ms${
      live.failures.length ? ` (${live.failures.length} failures)` : ""
    }`,
  );
  if (live.url) {
    check("returns a usable stream url", /^https?:\/\//.test(live.url));
    check("reports no failures when it succeeded", live.failures.length === 0);
    check(
      "success lands inside the budget",
      liveMs <= BUDGET_MS,
      `${liveMs}ms <= ${BUDGET_MS}ms`,
    );
  } else {
    // Not a failure of the code: every public mirror can be down or
    // bot-blocked at any moment. Report it, do not pretend it passed.
    console.log(
      "  SKIP  no public mirror resolved this run — network condition, not a code result",
    );
  }

  console.log(`\npassed ${pass}  failed ${fail}`);
  process.exit(fail ? 1 : 0);
}

void main();
