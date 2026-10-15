#!/usr/bin/env node
/**
 * Create the Android release signing key for SYNQ, and the untracked
 * `android/keystore.properties` that `android/app/build.gradle` reads.
 *
 * ## Why a script and not just a README line
 *
 * Four separate things have to agree for a release build to be signed — the
 * keystore type, the alias, the two passwords and the path in the properties
 * file — and each of them produces a different, unhelpful error when it is
 * wrong ("Keystore was tampered with, or password was incorrect", or a silent
 * `app-release-unsigned.apk`). Running `keytool` by hand also invites the one
 * mistake that cannot be undone: a weak or reused password on the key that
 * identifies the app forever.
 *
 * So this picks sensible parameters (PKCS12, RSA 4096, 10000 days), generates a
 * strong password when you do not supply one, writes the properties file, and
 * then READS THE KEYSTORE BACK to prove the alias and password actually work.
 *
 * ## Treat the output as irreplaceable
 *
 * Losing this key means you can never update the same Play listing again.
 * Committing it means anyone can publish as you. Back up the `.jks` and the
 * password somewhere that is not this working copy; both are gitignored.
 *
 * ## Usage
 *
 *   node scripts/create-release-keystore.cjs
 *   node scripts/create-release-keystore.cjs --name my-key --alias my-alias
 *   SYNQ_KEYSTORE_PASSWORD='…' node scripts/create-release-keystore.cjs
 *   node scripts/create-release-keystore.cjs --password '…' --force
 *
 * The password is only ever printed when this script generated it, because that
 * is the one time you cannot know it any other way.
 */
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const ANDROID_DIR = path.resolve(__dirname, "..", "android");
const PROPERTIES_PATH = path.join(ANDROID_DIR, "keystore.properties");

function parseArgs(argv) {
  const args = { name: "synq-release", alias: "synq", validity: "10000", force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => argv[++i];
    if (arg === "--name") args.name = take();
    else if (arg === "--alias") args.alias = take();
    else if (arg === "--validity") args.validity = take();
    else if (arg === "--password") args.password = take();
    else if (arg === "--force") args.force = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

/** The keytool that belongs to the JDK Gradle will actually use. */
function keytool() {
  const candidates = [
    process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, "bin", "keytool"),
    process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, "bin", "keytool.exe"),
    "keytool",
  ].filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["-help"], { stdio: "ignore" });
    // keytool exits 0 for -help on some JDKs and 1 on others; either proves it
    // runs at all.
    if (!probe.error) return candidate;
  }
  throw new Error("keytool not found — install a JDK or set JAVA_HOME");
}

/**
 * A password that is strong, printable, and safe inside a properties file.
 *
 * `Properties` treats `=`, `:` and a leading `#`/`!` as syntax, so the alphabet
 * is deliberately narrowed to characters that cannot be mistaken for any of
 * them. 24 bytes of entropy is far beyond what matters here; the realistic
 * threat is not brute force but a blank or guessable password.
 */
function generatePassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_";
  const bytes = crypto.randomBytes(32);
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(command)} exited ${result.status}\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      "usage: node scripts/create-release-keystore.cjs [--name synq-release] [--alias synq] [--validity 10000] [--password '…'] [--force]",
    );
    return;
  }

  const keystorePath = path.join(ANDROID_DIR, `${args.name}.jks`);
  const relativeStoreFile = `${args.name}.jks`;

  if (!args.force) {
    for (const existing of [keystorePath, PROPERTIES_PATH]) {
      if (fs.existsSync(existing)) {
        throw new Error(
          `${path.relative(process.cwd(), existing)} already exists. Re-running would either overwrite a signing key (unrecoverable for a published app) or clobber working credentials. Move it aside, or pass --force if you are certain it is disposable.`,
        );
      }
    }
  }

  const supplied = args.password || process.env.SYNQ_KEYSTORE_PASSWORD;
  const password = supplied || generatePassword();
  const tool = keytool();

  console.log(`Creating ${path.relative(process.cwd(), keystorePath)} …`);
  run(tool, [
    "-genkeypair",
    "-v",
    "-keystore",
    keystorePath,
    "-storetype",
    "PKCS12",
    "-alias",
    args.alias,
    "-keyalg",
    "RSA",
    "-keysize",
    "4096",
    "-validity",
    String(args.validity),
    "-dname",
    "CN=SYNQ, O=SYNQ, C=US",
    "-storepass",
    password,
    "-keypass",
    password,
  ]);

  // Read it back before writing a properties file that claims it works. A
  // properties file pointing at a keystore whose password is wrong fails much
  // later, in a place that explains nothing.
  const listing = run(tool, [
    "-list",
    "-v",
    "-keystore",
    keystorePath,
    "-storepass",
    password,
    "-alias",
    args.alias,
  ]);
  if (!listingHasAlias(listing, args.alias)) {
    throw new Error(
      `the keystore was created but alias "${args.alias}" is not readable — not writing keystore.properties`,
    );
  }

  fs.writeFileSync(
    PROPERTIES_PATH,
    [
      "# Generated by scripts/create-release-keystore.cjs — DO NOT COMMIT.",
      "# Gitignored. Back up this file's password and the keystore itself:",
      "# losing them means the app can never be updated on Google Play again.",
      `storeFile=${relativeStoreFile}`,
      `storePassword=${password}`,
      `keyAlias=${args.alias}`,
      `keyPassword=${password}`,
      "",
    ].join(os.EOL),
    "utf8",
  );

  console.log(`Wrote ${path.relative(process.cwd(), PROPERTIES_PATH)}`);
  console.log(`Alias: ${args.alias}`);
  if (!supplied) {
    console.log(`\nStore/key password (save this now — it is not stored anywhere else):\n  ${password}\n`);
  } else {
    console.log("Password taken from " + (args.password ? "--password" : "SYNQ_KEYSTORE_PASSWORD") + " (not printed).");
  }
  console.log(
    [
      "",
      "Next:",
      "  1. Back up android/" + relativeStoreFile + " and the password somewhere that is not this working copy.",
      "  2. npm run build && node scripts/strip-downloads-from-dist.cjs && npx cap sync android",
      "  3. (cd android && ./gradlew assembleRelease)   # now produces a SIGNED app-release.apk",
      "  4. (cd android && ./gradlew bundleRelease)     # the .aab Google Play actually wants",
    ].join(os.EOL),
  );
}

/** keytool names the alias in its `-list -alias` output; anything else is a failure. */
function listingHasAlias(output, alias) {
  return output.includes(alias);
}

try {
  main();
} catch (error) {
  console.error(`create-release-keystore: ${error.message}`);
  process.exit(1);
}
