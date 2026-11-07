#!/usr/bin/env node
/**
 * Selective sync from the private SYNQ development checkout into this public
 * release checkout.
 *
 * It exists to make the dangerous version of this job impossible:
 *
 *   - it copies an ALLOWLIST, never the whole tree (`tools/release-paths.txt`),
 *   - it never touches `.git`, never stages, and never pushes on its own,
 *   - it refuses to run when the source and destination are the same checkout,
 *   - it prints every file it would change before changing it,
 *   - `--checks` runs the release's own build/lint/tests and fails loudly,
 *   - `--publish` refuses to continue if a secret-looking file is in the change
 *     set, and needs an explicit confirmation flag.
 *
 * Modes (default is a dry run):
 *
 *   node tools/sync-from-dev.mjs --source <dev-checkout>
 *   node tools/sync-from-dev.mjs --source <dev-checkout> --apply
 *   node tools/sync-from-dev.mjs --checks
 *   node tools/sync-from-dev.mjs --publish --message "Release 1.1" --confirm-publish
 *
 * See docs/RELEASING.md.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const RELEASE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = path.join(RELEASE_ROOT, "tools", "release-paths.txt");
const KEEP = path.join(RELEASE_ROOT, "tools", "release-keep.txt");

/** Paths that are copied from source. */
const INCLUDE = readFileSync(MANIFEST, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

/**
 * Never copied, whatever the manifest says. Kept as directory/file names so a
 * nested `node_modules` or a new keystore cannot slip through with a new path.
 */
const BLOCKED = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)dist(-web)?(\/|$)/,
  /(^|\/)desktop-dist(\/|$)/,
  /(^|\/)all-installers(\/|$)/,
  /(^|\/)build-electron\.out(\/|$)/,
  /(^|\/)\.gradle(\/|$)/,
  /(^|\/)build(\/|$)/,
  /(^|\/)keystores?(\/|$)/,
  // Capacitor regenerates these into the Android project on every `cap sync`.
  // `app/src/main/assets/public` is a compiled copy of the web build, so it
  // carries whatever deployment URL that build was pointed at.
  /(^|\/)capacitor-cordova-android-plugins(\/|$)/,
  /(^|\/)assets\/public(\/|$)/,
  /(^|\/)capacitor\.(config|plugins)\.json$/,
  /res\/xml\/config\.xml$/,
  /(^|\/)local\.properties$/,
  /(^|\/)keystore\.properties$/,
  /(^|\/)\.env(\..+)?$/,
  /\.(jks|keystore|p12|pem|key|apk|aab|zip|exe|blockmap|log|tsbuildinfo)$/i,
];

/**
 * Development-only files that live inside an allowlisted directory. The audit
 * harnesses drive a specific private deployment and the rest are one-off
 * probes; none of them are part of what a reader needs to build SYNQ.
 */
const DEV_ONLY = [
  /^scripts\/audit\./,
  /^scripts\/__/,
  /^scripts\/pw-/,
  /^scripts\/check/,
  /^scripts\/explore-/,
  /^scripts\/inspect-/,
];

/** Files this release owns a deliberately different copy of. Never overwritten. */
const KEPT = readFileSync(KEEP, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const source = value("--source") ?? process.env.SYNQ_DEV_DIR;
const message = value("--message");

function fail(text) {
  console.error(`\n✗ ${text}\n`);
  process.exit(1);
}

function run(cmd, cmdArgs, options = {}) {
  console.log(`\n$ ${cmd} ${cmdArgs.join(" ")}`);
  // Windows ships `npm` and `npx` only as `.cmd` shims, and execFileSync does
  // not search PATHEXT, so it throws ENOENT for both unless a shell resolves
  // them. Git is a real executable and needs no shell either way.
  return execFileSync(cmd, cmdArgs, {
    cwd: RELEASE_ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
}

function git(cmdArgs, options = {}) {
  return execFileSync("git", cmdArgs, { cwd: RELEASE_ROOT, encoding: "utf8", ...options }).trim();
}

/** Every publishable file under one manifest entry, as { rel, abs }. */
function expand(relEntry) {
  const abs = path.join(source, relEntry);
  if (!existsSync(abs)) return [];
  const excluded = (rel) => [...BLOCKED, ...DEV_ONLY].some((re) => re.test(rel));
  if (!statSync(abs).isDirectory()) {
    return excluded(relEntry.replaceAll("\\", "/")) ? [] : [{ rel: relEntry, abs }];
  }
  const out = [];
  for (const inner of readdirSync(abs, { recursive: true })) {
    const rel = path.posix.join(relEntry, String(inner).replaceAll("\\", "/"));
    if (excluded(rel)) continue;
    const full = path.join(source, rel);
    if (statSync(full).isFile()) out.push({ rel, abs: full });
  }
  return out;
}

function plan() {
  const wanted = INCLUDE.flatMap(expand);
  const changed = [];
  const missing = [];
  const kept = [];
  for (const file of wanted) {
    const target = path.join(RELEASE_ROOT, file.rel);
    if (KEPT.includes(file.rel)) {
      // Sanitised on purpose: compare only to warn that the source moved on.
      if (existsSync(target) && !readFileSync(file.abs).equals(readFileSync(target))) kept.push(file.rel);
      continue;
    }
    if (!existsSync(target)) {
      changed.push({ ...file, verb: "add" });
      continue;
    }
    const a = readFileSync(file.abs);
    const b = readFileSync(target);
    if (a.length !== b.length || !a.equals(b)) changed.push({ ...file, verb: "update" });
  }
  // Files the release has inside an allowlisted directory that the source no
  // longer has. Reported, never deleted: removal is a human decision.
  for (const entry of INCLUDE) {
    const abs = path.join(RELEASE_ROOT, entry);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
    const sourceSet = new Set(wanted.map((f) => f.rel));
    for (const inner of readdirSync(abs, { recursive: true })) {
      const rel = path.posix.join(entry, String(inner).replaceAll("\\", "/"));
      if (statSync(path.join(RELEASE_ROOT, rel)).isFile() && !sourceSet.has(rel)) missing.push(rel);
    }
  }
  return { wanted, changed, missing, kept };
}

function assertSafeSource() {
  if (!source) fail("Pass the development checkout: --source <path> (or set SYNQ_DEV_DIR).");
  const src = path.resolve(source);
  if (src === RELEASE_ROOT) fail("Source and release are the same checkout. Point --source at the private tree.");
  if (RELEASE_ROOT.startsWith(src + path.sep)) fail("The release directory is inside the source tree. Move it out.");
  if (!existsSync(path.join(src, "package.json"))) fail(`${src} does not look like the SYNQ checkout (no package.json).`);
  return src;
}

function sync() {
  const src = assertSafeSource();
  const { changed, missing, kept } = plan();
  const apply = flag("--apply");

  console.log(`\nSource     ${src}\nRelease    ${RELEASE_ROOT}\nManifest   ${INCLUDE.length} entries`);
  if (!changed.length) console.log("\nNothing to copy — the release already matches the allowlist.");
  for (const file of changed) console.log(`  ${file.verb === "add" ? "A" : "M"} ${file.rel}`);
  if (kept.length) {
    console.log(`\n${kept.length} file(s) kept as-is because this release differs on purpose:`);
    for (const rel of kept) console.log(`  ! ${rel} — development copy differs; reconcile by hand (tools/release-keep.txt)`);
  }
  if (missing.length) {
    console.log(`\n${missing.length} file(s) exist only in the release. Not deleted automatically; remove them deliberately:`);
    for (const rel of missing) console.log(`  ? ${rel}`);
  }
  if (!apply) {
    console.log("\nDry run. Re-run with --apply to copy these files, then review with `git status` and `git diff`.");
    return;
  }
  for (const file of changed) {
    const target = path.join(RELEASE_ROOT, file.rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(file.abs));
  }
  console.log(`\n✓ Copied ${changed.length} file(s). Review before staging:`);
  try {
    console.log(git(["status", "--short"]) || "  (no changes)");
  } catch {
    console.log("  (not a git repository yet — run `git init` to review this as a diff)");
  }
}

function checks() {
  if (!existsSync(path.join(RELEASE_ROOT, "node_modules"))) run("npm", ["ci"]);
  run("npm", ["run", "build"]);

  // Lint is reported, not enforced: the codebase carries pre-existing findings
  // (see README, "Known limitations"). A release should not be blocked by a
  // style debt that predates it, and it should not be hidden either.
  try {
    run("npm", ["run", "lint"]);
    console.log("\n✓ Lint clean.");
  } catch {
    console.log("\n! Lint reported findings (non-blocking — see README).");
  }

  try {
    run("bun", ["test"]);
    console.log("\n✓ Build and tests passed against the release contents.");
  } catch {
    if (!flag("--allow-test-failures")) {
      fail(
        "Tests failed. If every failure is one of the Bun-only suites listed in\n" +
          "  README → \"Running the tests\", re-run with --allow-test-failures to\n" +
          "  publish anyway; otherwise fix them first.",
      );
    }
    console.log("\n! Tests failed (accepted with --allow-test-failures).");
  }
}

const SECRET_PATHS = /(^|\/)(\.env(\.|$)|.*\.(jks|keystore|p12|pem|key)$|local\.properties|keystore\.properties)/;

function publish() {
  if (!flag("--confirm-publish")) fail("Refusing to publish without --confirm-publish (and a reviewed `git diff`).");
  if (!message) fail("Pass --message \"<release title>\".");

  const staged = git(["status", "--porcelain"]).split("\n").filter(Boolean);
  if (!staged.length) fail("Nothing to publish — the release matches the last commit.");
  const risky = staged.map((line) => line.slice(3)).filter((rel) => SECRET_PATHS.test(rel));
  if (risky.length) fail(`Secret-looking file in the change set:\n  ${risky.join("\n  ")}`);

  // Stage the allowlist only. `-A` is scoped to those paths, so a deletion
  // inside them is staged while unrelated files elsewhere are left alone.
  const stageable = INCLUDE.filter((entry) => existsSync(path.join(RELEASE_ROOT, entry)));
  git(["add", "-A", "--", ...stageable], { stdio: "inherit" });

  console.log("\nStaged for this release:");
  console.log(git(["diff", "--cached", "--name-status"]));
  const dirty = git(["status", "--porcelain"]).split("\n").filter((line) => line && !/^[AMDR] /.test(line));
  if (dirty.length) fail(`Unstaged changes remain, so the release would be incomplete:\n  ${dirty.join("\n  ")}`);

  git(["commit", "-m", message], { stdio: "inherit" });
  git(["push", "origin", "HEAD:main"], { stdio: "inherit" });

  const sha = git(["rev-parse", "HEAD"]);
  git(["tag", "-f", `release-${new Date().toISOString().slice(0, 10)}`, "-m", message], { stdio: "inherit" });
  appendFileSync(path.join(RELEASE_ROOT, ".release-log"), `${new Date().toISOString()} ${sha} ${message}\n`);
  console.log(`\n✓ Published ${sha}`);
}

if (flag("--checks")) checks();
else if (flag("--publish")) publish();
else sync();
