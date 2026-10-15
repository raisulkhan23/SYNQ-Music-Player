/**
 * Tests for OFFLINE PLAYBACK of downloaded tracks.
 *
 * The feature under test: once a track's audio is in the Origin Private File
 * System, playing it must read from disk and must not depend on the network.
 *
 * The specific failure this guards against is the one that made downloads
 * useless even when they succeeded — the bytes were on disk but the player
 * still asked the network for a stream, so an offline listen got silence.
 *
 * OPFS and `URL.createObjectURL` do not exist in this runtime, so the module's
 * two collaborators are injected. That is deliberate: it lets the LOOKUP
 * DECISION be tested, which is the part with the logic, rather than testing
 * that a browser has a filesystem.
 *
 * Run: bun scripts/audit.offline.ts
 */

import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Load the real source with the browser APIs stubbed, so the shipped module is
// what runs here — not a copy of its logic.
// ---------------------------------------------------------------------------

const realOpfs = readFileSync("src/lib/opfsSink.ts", "utf8");

type FileEntry = { name: string; size: number };

const state = {
  /** Filename -> size, standing in for the OPFS directory. */
  files: new Map<string, number>(),
  /** Track ids the app believes are local. */
  prime: new Map<string, string | null>(),
  created: [] as string[],
  revoked: [] as string[],
};

const g = globalThis as unknown as Record<string, unknown>;

(g as any).__synqState = state;

g.navigator = {
  storage: { getDirectory: async () => ({}) },
};

g.URL = {
  createObjectURL: (file: { __size: number }) => {
    const url = `blob:synq/${state.created.length}`;
    state.created.push(url);
    return url;
  },
  revokeObjectURL: (url: string) => {
    state.revoked.push(url);
  },
};

// Strip the TS types so bun can evaluate the module body directly, then swap
// the private `dir()` helper for one backed by `state.files`.
const runnable = realOpfs
  .replace(/^import .*$/gm, "")
  .replace(/: FileSink/g, "")
  .replace(/private readonly /g, "")
  .replace(/private /g, "")
  .replace(/private static /g, "static ")
  .replace(/\): Promise<[^>]*>/g, ")")
  .replace(/\): File \| null/g, ")")
  .replace(/\): Promise<File \| null>/g, ")")
  .replace(/async function dir\(\) \{[\s\S]*?\n\}/,
    `async function dir() {
  const state = (globalThis as any).__synqState;
  return {
    async *entries() {
      for (const [name, size] of state.files) yield [name, { name, size }];
    },
    async getFileHandle(name) {
      const size = state.files.get(name);
      if (size === undefined) throw new Error("NotFoundError");
      return { name, getFile: async () => ({ size, lastModified: 1 }) };
    },
    async removeEntry(name) {
      state.files.delete(name);
    },
  };
}`);

const mod = await import(
  `data:text/javascript;base64,${Buffer.from(runnable).toString("base64")}`
);

const {
  localAudioUrl,
  openStoredTrack,
  isDownloaded,
  listStoredDownloads,
  parseStoredName,
} = mod as {
  localAudioUrl: (t: string) => Promise<string | null>;
  openStoredTrack: (t: string) => Promise<unknown>;
  isDownloaded: (t: string) => Promise<boolean>;
  listStoredDownloads: () => Promise<FileEntry[]>;
  parseStoredName: (n: string) => { id: string; filename: string };
};

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`PASS ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}`);
  }
}

const VIDEO = "dQw4w9WgXcQ";
const stored = `${VIDEO}__Artist - Song.m4a`;

async function main() {
  // ---- the file is findable by TRACK id ----
  state.files.set(stored, 1024);
  ok("finds a stored track by its video id", (await isDownloaded(VIDEO)) === true);
  ok(
    "unknown track is not downloaded",
    (await isDownloaded("someOtherId")) === false,
  );

  // ---- a blob url is produced, and it is a blob url ----
  const url = await localAudioUrl(VIDEO);
  ok("returns a playable blob url", typeof url === "string" && url.startsWith("blob:"));
  ok(
    "blob url is cached, not recreated per play",
    (await localAudioUrl(VIDEO)) === url,
  );

  // ---- partials are never treated as downloaded ----
  state.files.set(`${VIDEO}__partial.m4a.part`, 900);
  const listed = await listStoredDownloads();
  ok(
    "partial files are excluded from the library",
    listed.every((f) => !f.name.endsWith(".part")),
  );

  // ---- deleting from disk makes the track stream again ----
  state.files.delete(stored);
  ok("deleted file is no longer local", (await isDownloaded(VIDEO)) === false);
  ok(
    "a re-download is found again",
    (await (async () => {
      state.files.set(stored, 2048);
      return (await isDownloaded(VIDEO)) === true;
    })()),
  );

  // ---- zero-byte files must not masquerade as playable ----
  state.files.set(`${VIDEO}__Artist - Song.m4a`, 0);
  ok("empty file is not reported as downloaded", (await isDownloaded(VIDEO)) === false);

  // ---- object urls are revoked, so a long session cannot leak blobs ----
  state.files.clear();
  const many: string[] = [];
  for (let i = 0; i < 12; i++) {
    const t = `track${i}`;
    state.files.set(`${t}__f${i}.m4a`, 100);
    many.push(t);
    await localAudioUrl(t);
  }
  ok(
    "object urls are revoked past the cache bound",
    state.revoked.length > 0,
  );
  ok(
    "cached urls are bounded, not unbounded",
    state.created.length - state.revoked.length <= 8,
  );

  // ---- name parsing round-trips ----
  const parsed = parseStoredName(stored);
  ok("name parses back to id and filename", parsed.id === VIDEO && parsed.filename === "Artist - Song.m4a");

  console.log(`\nPASS ${pass}  FAIL ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();