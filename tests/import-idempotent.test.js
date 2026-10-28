import { describe, expect, test } from "bun:test";
import { saveImported } from "../src/convex/playlists.ts";

/**
 * Re-importing the same playlist must not create a second library row.
 *
 * THE BUG. `saveImported` used to insert unconditionally. Importing a
 * playlist, deciding you wanted it again (or re-running a failed retry),
 * produced two identical entries under the same name — and nothing in the
 * library grouped them, because each is an independent document. §3.7 of the
 * recovery plan makes idempotent imports a requirement, and the ids are
 * already deterministic (`import:origin|artist|title`), so the same source
 * re-imported is detectable and skippable.
 *
 * These tests drive the real mutation handler with a stricter context stub
 * than `import-lands-in-library.test.js`: the duplicate check needs the
 * `by_user` query to RETURN existing rows, which that file's stub does not
 * model (`take()` always answers `[]` there, which is exactly why the
 * duplicate check is invisible to those tests).
 */
const USER = "user_123";

/** A saved playlist row as the duplicate finder reads it. */
function playlistRow(id, name, origin, trackIds) {
  return {
    _id: id,
    userId: USER,
    name,
    description: `Imported from ${origin}`,
    trackIds,
  };
}

function makeCtx(existing = []) {
  const inserts = { importedPlaylists: [], playlists: [] };
  return {
    inserts,
    auth: { getUserIdentity: async () => ({ subject: USER }) },
    db: {
      insert: async (table, doc) => {
        inserts[table]?.push(doc);
        return `${table}_new`;
      },
      get: async () => null,
      query: () => ({
        withIndex: () => ({
          order: () => ({
            take: async () => existing,
          }),
        }),
      }),
    },
  };
}

const TRACKS = [
  { title: "Hyperballad", artist: "Björk", duration: 312 },
  { title: "Army of Me", artist: "Björk", duration: 240 },
  { title: "Jóga", artist: "Björk", duration: 305 },
];

/** The ids `saveImported` derives from TRACKS, computed once by saving into an empty context. */
async function expectedIds(tracks = TRACKS) {
  const ctx = makeCtx();
  const best = await offerDirect(ctx, tracks);
  return {
    ctx,
    ids: best.inserts.playlists[0]?.trackIds ?? [],
    playlistDoc: best.inserts.playlists[0],
  };
}

/** Save into a context and return the context, awaiting the handler first. */
async function offerDirect(ctx, tracks) {
  await saveImported._handler(ctx, {
    name: "Best of Björk",
    origin: "Spotify",
    tracks,
  });
  return ctx;
}

describe("an import of the same source twice creates one playlist", () => {
  test("the second identical import inserts nothing new and returns the existing row", async () => {
    const first = await expectedIds();
    if (first.ids.length === 0) throw new Error("first import stored nothing");
    const second = makeCtx([
      playlistRow("playlist_existing", "Best of Björk", "Spotify", first.ids),
    ]);

    const result = await saveImported._handler(second, {
      name: "Best of Björk",
      origin: "Spotify",
      tracks: TRACKS,
    });

    expect(result.duplicate).toBe(true);
    expect(result.playlistId).toBe("playlist_existing");
    // THIS is the regression: no second library entry, and no duplicate
    // import-record row either.
    expect(second.inserts.playlists).toHaveLength(0);
    expect(second.inserts.importedPlaylists).toHaveLength(0);
  });

  test("an import whose content changed still creates a fresh playlist (never overwrites)", async () => {
    const first = await expectedIds();
    const second = makeCtx([
      playlistRow("playlist_existing", "Best of Björk", "Spotify", first.ids),
    ]);
    const changed = [...TRACKS, { title: "Venus as a Boy", artist: "Björk" }];

    const result = await saveImported._handler(second, {
      name: "Best of Björk",
      origin: "Spotify",
      tracks: changed,
    });

    expect(result.duplicate).toBeUndefined();
    expect(second.inserts.playlists).toHaveLength(1);
  });

  test("the same name from a DIFFERENT service is not a duplicate", async () => {
    const first = await expectedIds();
    const second = makeCtx([
      playlistRow("playlist_existing", "Best of Björk", "Apple Music", first.ids),
    ]);
    const result = await saveImported._handler(second, {
      name: "Best of Björk",
      origin: "Spotify",
      tracks: TRACKS,
    });
    expect(result.duplicate).toBeUndefined();
    expect(second.inserts.playlists).toHaveLength(1);
  });

  test("a hand-made playlist with the same name is not swallowed by an import", async () => {
    // A user-created playlist has a different description, so the import
    // proceeds even though the names collide.
    const second = makeCtx([
      playlistRow("playlist_mine", "Best of Björk", "hand-made", ["some_id"]),
    ]);
    // Build ids the way the import will, without colliding with the handmade row.
    const result = await saveImported._handler(second, {
      name: "Best of Björk",
      origin: "Spotify",
      tracks: TRACKS,
    });
    expect(result.duplicate).toBeUndefined();
    expect(second.inserts.playlists).toHaveLength(1);
  });

  test("a playlist the same length but different songs is a new import", async () => {
    const first = await expectedIds();
    const lookIn = makeCtx([
      playlistRow(
        "playlist_existing",
        "Best of Björk",
        "Spotify",
        first.ids.map((id, i) => (i === 0 ? "import:spotify|bjork|debut" : id)),
      ),
    ]);
    const result = await saveImported._handler(lookIn, {
      name: "Best of Björk",
      origin: "Spotify",
      tracks: TRACKS,
    });
    expect(result.duplicate).toBeUndefined();
    expect(lookIn.inserts.playlists).toHaveLength(1);
  });
});
