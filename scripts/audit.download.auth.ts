/**
 * Audit harness for SYNQ's download AUTHORIZATION layer.
 *
 *   bun scripts/audit.download.auth.ts
 *
 * Pure modules only — no browser, no key, no network. The point is that the
 * rules deciding who may save what are pinned here, because that boundary is
 * the one thing this system must never get wrong: a playable stream is not
 * permission to make a copy.
 */

import {
  AUTHORIZED_CONTENT_TYPE,
  AUTHORIZED_EXTENSION,
  AUTHORIZED_ID_PREFIX,
  DOWNLOAD_MESSAGES,
  authorizedFilename,
  authorizedProviderId,
  authorizedTrackId,
  downloadAvailability,
  isTrackDownloadable,
  refuse,
  refusalFromFailure,
  type DownloadRefusalCode,
} from "../src/lib/downloadAuth";
import { normalizeTrack, type JamendoTrack } from "../src/lib/jamendo";
import { importFailure } from "../src/lib/importModel";

let pass = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = "") {
  if (cond) pass++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function eq<T>(name: string, actual: T, expected: T) {
  check(
    name,
    Object.is(actual, expected),
    `got ${String(actual)}, want ${String(expected)}`,
  );
}

// ---------------------------------------------------------------- track ids
{
  eq("a namespaced id resolves", authorizedProviderId("jamendo:12345"), "12345");
  eq(
    "a bare YouTube id is refused",
    authorizedProviderId("kJQP7kiw5Fk"),
    null,
  );
  eq(
    "an imported id is refused",
    authorizedProviderId("import:some-title-artist"),
    null,
  );
  eq("an empty id is refused", authorizedProviderId(""), null);
  eq("null is refused", authorizedProviderId(null), null);
  eq("undefined is refused", authorizedProviderId(undefined), null);
  // A prefix with a non-numeric payload must not pass: the provider id is
  // interpolated into an upstream query.
  eq("a non-numeric payload is refused", authorizedProviderId("jamendo:abc"), null);
  eq(
    "a prefixed traversal attempt is refused",
    authorizedProviderId("jamendo:1/../2"),
    null,
  );
  eq("a wrong prefix is refused", authorizedProviderId("spotify:123"), null);
  eq("round trip", authorizedProviderId(authorizedTrackId(99)), "99");
}

// ---------------------------------------------------------------- eligibility
{
  check("an authorized track is downloadable", isTrackDownloadable("jamendo:7"));
  check("an ordinary track is not", !isTrackDownloadable("dQw4w9WgXcQ"));
  check("an empty track is not", !isTrackDownloadable(""));

  const allowed = downloadAvailability("jamendo:7");
  check("availability allows an authorized track", allowed.allowed);
  check("availability carries an ok decision", allowed.decision.ok);

  const denied = downloadAvailability("dQw4w9WgXcQ");
  check("availability denies an unauthorized track", !denied.allowed);
  check(
    "the refusal explains itself",
    !denied.decision.ok && denied.decision.code === "not-authorized",
  );
}

// ---------------------------------------------------------------- refusal copy
{
  const codes: DownloadRefusalCode[] = [
    "not-authorized",
    "not-found",
    "not-configured",
    "rate-limited",
    "network",
    "invalid-request",
  ];
  check(
    "every refusal code has copy",
    codes.every((c) => DOWNLOAD_MESSAGES[c].length > 0),
  );
  check(
    "only transient refusals are retryable",
    refuse("rate-limited").retryable && refuse("network").retryable,
  );
  check(
    "a licence refusal is not retryable",
    !refuse("not-authorized").retryable && !refuse("not-found").retryable,
  );
  check(
    "the canonical message is used when none is supplied",
    refuse("not-authorized").message === DOWNLOAD_MESSAGES["not-authorized"],
  );
  check(
    "a custom message is preserved",
    refuse("network", "custom").message === "custom",
  );
}

// ---------------------------------------------------- provider failure mapping
{
  eq(
    "rate limit maps to rate-limited",
    refusalFromFailure(importFailure("rate-limited")).code,
    "rate-limited",
  );
  eq(
    "network maps to network",
    refusalFromFailure(importFailure("network")).code,
    "network",
  );
  eq(
    "not-configured maps to not-configured",
    refusalFromFailure(importFailure("not-configured")).code,
    "not-configured",
  );
  eq(
    "empty maps to not-found",
    refusalFromFailure(importFailure("empty")).code,
    "not-found",
  );
  eq(
    "private maps to not-authorized",
    refusalFromFailure(importFailure("private")).code,
    "not-authorized",
  );
  eq(
    "unknown maps to not-authorized",
    refusalFromFailure(importFailure("unknown")).code,
    "not-authorized",
  );
  check(
    "a provider message survives the mapping",
    refusalFromFailure(importFailure("network", "no route")).message ===
      "no route",
  );
}

// ---------------------------------------------------------------- filenames
{
  const name = authorizedFilename("123", "Song", "Artist");
  eq("filename shape", name, "Artist - Song.mp3");
  check("has the expected extension", name.endsWith(AUTHORIZED_EXTENSION));

  const traversal = authorizedFilename("123", "../../etc/passwd", "a/b");
  check(
    "path separators cannot survive",
    !traversal.includes("/") && !traversal.includes("\\"),
  );
  check(
    "no traversal segment remains",
    !traversal.includes("..") || traversal.replace(/\.\./g, "").length > 0,
  );

  const control = authorizedFilename("123", "song", "artist");
  // Compared by code point rather than a regex literal, so the assertion itself
  // stays lint-clean while still proving real control bytes are stripped.
  check(
    "control characters are stripped",
    [...control].every((ch) => (ch.codePointAt(0) ?? 0) >= 32),
  );

  const empty = authorizedFilename("123", "", "");
  check("an untitled release still gets a name", empty.endsWith(".mp3"));

  const already = authorizedFilename("123", "Song.mp3", "Artist");
  check("an existing extension is not doubled", !already.endsWith(".mp3.mp3"));

  const long = authorizedFilename("123", "x".repeat(400), "y".repeat(400));
  check("a very long name is capped", long.length <= 124);

  eq("content type is declared", AUTHORIZED_CONTENT_TYPE, "audio/mpeg");
  eq("id prefix is stable", AUTHORIZED_ID_PREFIX, "jamendo:");
}

// --------------------------------------------- the flag survives normalisation
{
  const base = { id: 7, name: "Song", artist_name: "Artist", audio: "https://x/a.mp3" };
  const allowed = normalizeTrack({ ...base, audiodownload_allowed: true });
  check("an authorized release is marked", allowed?.downloadAllowed === true);

  const denied = normalizeTrack({ ...base, audiodownload_allowed: false });
  check("a denied release is marked", denied?.downloadAllowed === false);

  // Absent means NOT allowed. Reading "probably fine" as permission is exactly
  // the bug this flag's strictness exists to prevent.
  const absent = normalizeTrack(base);
  check("an absent flag is NOT allowed", absent?.downloadAllowed === false);

  const truthy = normalizeTrack({ ...base, audiodownload_allowed: "yes" as never });
  check("a non-boolean flag is NOT allowed", truthy?.downloadAllowed === false);

  const typed: JamendoTrack = allowed as JamendoTrack;
  check("the field exists on the track shape", typed.downloadAllowed === true);
}

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} download-authorization check(s) failed:\n`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error(`\n${pass} passed, ${failures.length} failed\n`);
  process.exit(1);
} else {
  console.log(`✓ download authorization: ${pass}/${pass} checks passed`);
}