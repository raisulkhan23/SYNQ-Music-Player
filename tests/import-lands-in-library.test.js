import { describe, expect, test } from 'vitest';
import { saveImported } from "../src/convex/playlists.ts";
import { readSource } from "./helpers/tailwind-css.js";

/**
 * An import has to land in the library.
 *
 * The bug: `saveImported` wrote only to `importedPlaylists`, while "Your
 * library" renders `playlists.myPlaylists`, which reads the `playlists` table.
 * So the import reported success, showed a green toast, and appeared nowhere —
 * and `myImportedPlaylists` existed the whole time with no caller, which is
 * what made it look like a missing feature rather than a broken wire.
 *
 * These drive the real mutation with a stubbed context, so they cover the
 * actual database writes rather than asserting that a function name appears in
 * a file. That distinction matters: a source-text test for this bug would
 * happily have stayed green while the import went nowhere.
 */

const USER = "user_123";

/**
 * A Convex-shaped context that records what was inserted where.
 *
 * `getAuthUserId` reads the auth token, which a stub context cannot supply, so
 * it is stubbed to return the user. Everything else is real logic from the
 * module under test.
 */
function makeCtx() {
  const inserts = { importedPlaylists: [], playlists: [] };
  const ctx = {
    inserts,
    auth: { getUserIdentity: async () => ({ subject: USER }) },
    db: {
      insert: async (table, doc) => {
        inserts[table]?.push(doc);
        return `${table}_1`;
      },
      get: async () => null,
      query: () => ({
        withIndex: () => ({ order: () => ({ take: async () => [] }) }),
      }),
    },
  };
  return ctx;
}

const TRACKS = [
  { title: "Hyperballad", artist: "Björk", duration: 312 },
  { title: "Army of Me", artist: "Björk", duration: 240 },
  { title: "Jóga", artist: "Björk", duration: 305 },
];

describe("an import creates a real playlist in the library", () => {
  test("it writes to `playlists`, which is the table the library renders", async () => {
    const ctx = makeCtx();
    await saveImported._handler(ctx, {
      name: "Best of Björk",
      origin: "Spotify",
      tracks: TRACKS,
    });
    // The single assertion this whole bug turns on.
    expect(ctx.inserts.playlists).toHaveLength(1);
  });

  test("it still writes the import record, so nothing existing is broken", async () => {
    const ctx = makeCtx();
    await saveImported._handler(ctx, {
      name: "Best of Björk",
      origin: "Spotify",
      tracks: TRACKS,
    });
    // The admin Imports tab reads this table. Removing it would have "fixed"
    // the library and deleted the import history along with it.
    expect(ctx.inserts.importedPlaylists).toHaveLength(1);
  });

  test("the library row carries every track, with the playlist's name", async () => {
    const ctx = makeCtx();
    await saveImported._handler(ctx, {
      name: "Best of Björk",
      origin: "Spotify",
      tracks: TRACKS,
    });
    const row = ctx.inserts.playlists[0];
    expect(row.name).toBe("Best of Björk");
    expect(row.userId).toBe(USER);
    expect(row.trackIds).toHaveLength(3);
    // Every id must be backed by a snapshot, or the detail page renders
    // "Playlist song" for the whole thing.
    expect(row.trackSnapshots).toHaveLength(3);
    for (const id of row.trackIds) {
      expect(row.trackSnapshots.some((s) => s.id === id)).toBe(true);
    }
  });

  test("it records where the playlist came from, without inventing an album", async () => {
    const ctx = makeCtx();
    await saveImported._handler(ctx, {
      name: "Best of Björk",
      origin: "Spotify",
      tracks: TRACKS,
    });
    const row = ctx.inserts.playlists[0];
    expect(row.description).toContain("Spotify");
    for (const snapshot of row.trackSnapshots) {
      // The import supplied no album. "Imported" as an album name would render
      // in the detail view as though the data existed.
      expect(snapshot.album).toBeUndefined();
    }
  });

  test("imported ids are namespaced, so they cannot collide with a video id", async () => {
    const ctx = makeCtx();
    await saveImported._handler(ctx, {
      name: "x",
      origin: "Spotify",
      tracks: TRACKS,
    });
    for (const id of ctx.inserts.playlists[0].trackIds) {
      expect(id.startsWith("import:")).toBe(true);
    }
  });

  test("re-importing the same file produces the same ids, so it de-duplicates", async () => {
    const a = makeCtx();
    const b = makeCtx();
    await saveImported._handler(a, {
      name: "x",
      origin: "Spotify",
      tracks: TRACKS,
    });
    await saveImported._handler(b, {
      name: "x",
      origin: "Spotify",
      tracks: TRACKS,
    });
    expect(a.inserts.playlists[0].trackIds).toEqual(
      b.inserts.playlists[0].trackIds,
    );
  });

  test("a repeated track inside one import is stored once", async () => {
    const ctx = makeCtx();
    await saveImported._handler(ctx, {
      name: "x",
      origin: "Spotify",
      tracks: [TRACKS[0], TRACKS[0], TRACKS[1]],
    });
    expect(ctx.inserts.playlists[0].trackIds).toHaveLength(2);
  });

  test("a blank track title is skipped rather than stored as a nameless row", async () => {
    const ctx = makeCtx();
    await saveImported._handler(ctx, {
      name: "x",
      origin: "CSV",
      tracks: [{ title: "   ", artist: "Nobody" }, TRACKS[0]],
    });
    const row = ctx.inserts.playlists[0];
    expect(row.trackIds).toHaveLength(1);
    expect(row.trackSnapshots[0].title).toBe("Hyperballad");
  });

  test("an empty import still fails loudly, as it did before", async () => {
    const ctx = makeCtx();
    await expect(
      saveImported._handler(ctx, { name: "x", origin: "CSV", tracks: [] }),
    ).rejects.toThrow();
    expect(ctx.inserts.playlists).toHaveLength(0);
  });
});

describe("an imported track is not mistaken for a playable video", () => {
  // The second half of the bug. `directPlayable` used to accept any row with a
  // snapshot and fall back to `row.id` as the YouTube id. An imported row has
  // a synthetic `import:…` id and no `youtubeId`, so the player was handed
  // something that is not a video id: a row that looks playable, is playable,
  // and plays nothing. Because this check runs first in `resolveLegacyRow`, the
  // search fallback was never reached for imported tracks either.
  const detail = readSource("src/pages/PlaylistDetail.tsx");

  test("direct playback requires a real youtubeId", () => {
    const fn = detail.slice(
      detail.indexOf("const directPlayable"),
      detail.indexOf("const directQueue"),
    );
    expect(fn).toContain("!row.youtubeId");
  });

  test("it no longer substitutes the row id for a missing youtubeId", () => {
    const fn = detail.slice(
      detail.indexOf("const directPlayable"),
      detail.indexOf("const directQueue"),
    );
    expect(fn).not.toContain("row.youtubeId ?? row.id");
  });

  test("the search fallback is still reachable for those rows", () => {
    // Without this the fix would trade "silent dead row" for "no playback".
    const fn = detail.slice(
      detail.indexOf("const resolveLegacyRow"),
      detail.indexOf("const playRow"),
    );
    expect(fn).toContain("searchYt(");
    expect(fn).toContain("directPlayable");
  });
});

describe("the confirmation tells the listener where the playlist went", () => {
  test("the toast names the destination, not just the count", () => {
    const section = readSource("src/components/settings/ImportSection.tsx");
    // A green toast with no destination is what made the import look broken.
    expect(section).toContain("Added to Your library");
  });
});
