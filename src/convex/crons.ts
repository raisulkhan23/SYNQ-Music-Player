// ---------------------------------------------------------------------------
// Scheduled jobs.
//
// Declared HERE rather than in convex.json: that file has no `crons` key, and
// adding one is silently ignored — the CLI answers "Unknown property" and
// carries on, which looks like a clean deploy while the job never runs. That
// failure mode is completely invisible from the app, and it would have left
// `visitEvents` as the only unbounded table in the schema, growing forever.
//
// Why a string and a cast, rather than a reference from `./_generated/api`:
//
//  - The generated `internal` is `anyApi` in this Convex version, and handing
//    a reference from that proxy to `crons` fails analysis with
//    "is not a functionReference".
//  - `makeFunctionReference` has the same string-path signature here, so it
//    cannot be used to recover a typed reference either.
//  - The declared parameter type lists neither string form, even though the
//    runtime accepts it and the server validates the resulting job.
//
// So the name is passed as a "module:function" path with one contained cast.
// The safety that matters is preserved: the server rejects the push outright if
// the name does not resolve, so a typo fails the deploy loudly instead of
// shipping a job that silently never fires. That was verified by trying it —
// a wrong name produces "schedules a function that does not exist".
// ---------------------------------------------------------------------------

import { cronJobs } from "convex/server";

const crons = cronJobs();

/** "module:function", resolved and checked by the server at push time. */
const PRUNE_VISITS = "analytics:pruneVisits";

// 03:00 UTC daily. Off-peak, and the job is two indexed range deletes touching
// at most a few thousand rows.
crons.daily(
  "prune visit analytics",
  { hourUTC: 3, minuteUTC: 0 },
  PRUNE_VISITS as never,
  {},
);

export default crons;
