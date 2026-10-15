import { describe, expect, test } from 'vitest';
import { readSource } from "./helpers/tailwind-css.js";

/**
 * The visit-analytics prune cron.
 *
 * This exists because the cron was silently not running and nothing noticed.
 *
 * It was first declared in `convex.json` under a `crons` key. That file has no
 * such key: the CLI prints "Unknown property in convex.json" and then carries
 * on and reports a successful deploy. So the app was healthy, the tests were
 * green, and the job that stops the raw visit log growing without bound simply
 * never ran. The only symptom would have appeared weeks later as a slow,
 * expensive admin page.
 *
 * These assertions are cheap and would have caught it on day one.
 */
describe("the prune is actually scheduled", () => {
  const crons = readSource("src/convex/crons.ts");

  test("a crons module exists, which is where Convex actually reads them", () => {
    expect(crons).toContain("cronJobs()");
    expect(crons).toContain("export default crons");
  });

  test("it names a real, colon-separated Convex function path", () => {
    // "module:function", not "module/function" and not a bare module name.
    // The server rejects the push if this does not resolve, which is the
    // property that makes the string form safe.
    expect(crons).toMatch(/["']analytics:pruneVisits["']/);
  });

  test("convex.json carries no crons key, because that key is ignored", () => {
    const config = JSON.parse(readSource("convex.json"));
    // A key here would be accepted by JSON.parse and silently dropped by the
    // CLI — the exact failure this file documents.
    expect(Object.keys(config)).not.toContain("crons");
  });

  test("the job it points at exists and is internal", () => {
    const analytics = readSource("src/convex/analytics.ts");
    expect(analytics).toContain("export const pruneVisits = internalMutation");
    // Internal-only means a browser cannot trigger the prune even by guessing
    // the function name.
    expect(analytics).toContain("internalMutation");
  });
});

describe("the raw log is bounded, not just written", () => {
  const analytics = readSource("src/convex/analytics.ts");

  test("there is a retention window, not an unbounded table", () => {
    expect(analytics).toContain("RAW_RETENTION_DAYS");
    expect(analytics).toContain("ROLLUP_RETENTION_DAYS");
  });

  test("the prune deletes by index rather than scanning the table", () => {
    // `.collect()` here would read the entire log every night, which is the
    // thing the retention window exists to avoid.
    expect(analytics).toContain('withIndex("by_at"');
    expect(analytics).toContain('withIndex("by_day"');
    expect(analytics).not.toContain('query("visitEvents").collect()');
  });
});
