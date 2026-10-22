import { describe, expect, test } from "bun:test";
import {
  accessList,
  revokeShare,
  searchShareableUsers,
  setSavedInLibrary,
  sharedWithMe,
  sharePlaylist,
} from "../src/convex/sharing.ts";

/** Two registered owners and one ephemeral anonymous guest in one table. */
const OWNER_A = "user_alice";
const OWNER_B = "user_bob";
const CAROL = "user_carol";
const ANON = "user_anon";

/**
 * A Convex-shaped context over three in-memory rows. Enough of `db.query`
 * is stubbed to satisfy the sharing functions' `withIndex(...).collect()` and
 * `withIndex(...).take(...)` exhaustive-return paths; `get` serves every row
 * we actually create here, so the recipient/owner lookups behave like a real
 * document store.
 */
function makeCtx() {
  const inserts = { playlistShares: [] };
  const users = [
    { _id: OWNER_A, name: "Alice", image: undefined, isAnonymous: false },
    { _id: OWNER_B, name: "Bob", image: undefined, isAnonymous: false },
    { _id: CAROL, name: "Carol", image: undefined, isAnonymous: false },
    { _id: ANON, name: "Guest", image: undefined, isAnonymous: true },
  ];
  const shares = new Map();

  const ctx = {
    inserts,
    // Exposed so a test can make a user row disappear between calls.
    users,
    auth: { getUserIdentity: async () => ({ subject: OWNER_A }) },
    db: {
      insert: async (table, doc) => {
        if (table !== "playlistShares") throw new Error(`insert ${table}`);
        const inserted = { _id: `share_${inserts.playlistShares.length + 1}`, ...doc };
        inserts.playlistShares.push(inserted);
        shares.set(inserted._id, inserted);
        return inserted._id;
      },
      get: async (id) => {
        // Playlists live outside the tables above; `get` serves them directly
        // so ownership checks run against the document the test declared.
        if (id === PLAY._id || id === OTHER._id) {
          return id === PLAY._id ? { ...PLAY } : { ...OTHER };
        }
        const u = users.find((x) => x._id === id);
        if (u) {
          return { _id: id, name: u.name, image: u.image, isAnonymous: u.isAnonymous };
        }
        if (id === OWNER_A || id === OWNER_B || id === CAROL || id === ANON) {
          // A user row that was removed: `get` reports it as gone, exactly as
          // the real document store would.
          return null;
        }
        const s = shares.get(id);
        if (s) return { _id: s._id, ...s };
        return null;
      },
      patch: async (id, patch) => {
        const existing = shares.get(id);
        if (!existing) throw new Error("not found");
        const merged = { _id: existing._id, ...existing, ...patch };
        shares.set(id, merged);
        return merged._id;
      },
      delete: async (id) => {
        shares.delete(id);
      },
      query: (table) => {
        if (table !== "playlistShares" && table !== "users")
          throw new Error(`query ${table}`);
        const source = table === "playlistShares" ? shares : users;
        const all = () => Array.from(source.values());
        // Indexes are not decorative: a `by_grant` lookup must return ONLY
        // the rows whose fields match, or a forged id would appear to grant
        // access. The stub therefore honours every `eq` the caller applies.
        const indexed = (filters) => {
          const rows = all().filter((row) =>
            filters.every(([field, value]) => row[field] === value),
          );
          return {
            order: () => ({
              take: async (n) => rows.slice(0, n),
              collect: async () => rows,
            }),
            take: async (n) => rows.slice(0, n),
            collect: async () => rows,
          };
        };
        const chain = (filters) => {
          const q = {
            eq: (field, value) => chain([...filters, [field, value]]),
            order: () => indexed(filters),
            take: async (n) => indexed(filters).take(n),
            collect: async () => indexed(filters).collect(),
          };
          return q;
        };
        return {
          withIndex: (_name, build) => {
            const filters = [];
            // `q.eq(a).eq(b)` chains, so the builder object must accumulate
            // onto the same filter list and hand itself back.
            const builder = {
              eq: (field, value) => {
                filters.push([field, value]);
                return builder;
              },
            };
            build(builder);
            return chain(filters);
          },
          take: async (n) => all().slice(0, n),
          collect: async () => all(),
        };
      },
    },
  };

  ctx.db.query.withoutIndex = ctx.db.query;
  return ctx;
}

const PLAY = { _id: "p_macbeth", userId: OWNER_A, name: "Macbeth", description: "Jazz noir", trackIds: ["t1"], trackSnapshots: [{ id: "t1", title: "Macbeth", artist: "Hozier", album: undefined, coverUrl: "c.jpg", duration: 228, youtubeId: "abc" }], createdAt: 1, updatedAt: 1 };
const OTHER = { _id: "p_hamlet", userId: OWNER_B, name: "Hamlet", description: "", trackIds: [], trackSnapshots: [], createdAt: 1, updatedAt: 1 };

describe("cross-account playlist sharing is server-authorized, not client-decorated", () => {
  test("only the owner can share one of their playlists", async () => {
    const ctx = makeCtx();
    await expect(sharePlaylist._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_B }))
      .resolves.toBeDefined();
    const grants = ctx.db.query("playlistShares").withIndex("by_grant", () => ({})).collect;
    const rows = await grants();
    expect(rows.length).toBe(1);
  });

  test("an anonymous guest cannot be a durable recipient", async () => {
    const ctx = makeCtx();
    await expect(
      sharePlaylist._handler(ctx, { playlistId: PLAY._id, recipientId: ANON }),
    ).rejects.toThrow(/SYNQ account/);
  });

  test("sharing the same playlist with the same person is idempotent", async () => {
    const ctx = makeCtx();
    const once = await sharePlaylist._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_B });
    const again = await sharePlaylist._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_B });
    expect(again).toBe(once);
    const grants = ctx.db.query("playlistShares").withIndex("by_grant", () => ({})).collect;
    const rows = await grants();
    expect(rows.length).toBe(1);
  });

  test("sharing is view-only: the recipient cannot revoke the owner's grant", async () => {
    const ctx = makeCtx();
    await sharePlaylist._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_B });
    ctx.auth = { getUserIdentity: async () => ({ subject: OWNER_B }) };
    await expect(
      revokeShare._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_A }),
    ).rejects.toThrow(/your own playlist/);
  });

  test("the owner can revoke a recipient's access", async () => {
    const ctx = makeCtx();
    await sharePlaylist._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_B });
    const removed = await revokeShare._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_B });
    expect(removed).toBe(1);
    const grants = ctx.db.query("playlistShares").withIndex("by_grant", () => ({})).collect;
    expect((await grants()).filter((g) => g.playlistId === PLAY._id && g.recipientId === OWNER_B)).toHaveLength(0);
  });

  test("a revoked grant is not shown in the owner's access list", async () => {
    const ctx = makeCtx();
    await sharePlaylist._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_B });
    await revokeShare._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_B });
    const list = await accessList._handler(ctx, { playlistId: PLAY._id });
    expect(list).toHaveLength(0);
  });

  test("the owner sees only who has access to their own playlist", async () => {
    const ctx = makeCtx();
    await sharePlaylist._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_B });
    const list = await accessList._handler(ctx, { playlistId: PLAY._id });
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Bob");
    expect(list[0]).not.toHaveProperty("email");
    expect(list[0].recipientId).toBe(OWNER_B);
    expect(list[0].saved).toBe(false);
  });

  test("a recipient whose user row is gone still publishes a fallback name", async () => {
    const ctx = makeCtx();
    const ghost = "user_ghost";
    // A real account must exist to be invited; the row then disappears (an
    // account deletion) while the grant survives.
    ctx.users.push({ _id: ghost, name: "Ghost", image: undefined, isAnonymous: false });
    await sharePlaylist._handler(ctx, { playlistId: PLAY._id, recipientId: ghost });
    const index = ctx.users.findIndex((u) => u._id === ghost);
    ctx.users.splice(index, 1);
    const list = await accessList._handler(ctx, { playlistId: PLAY._id });
    expect(list.length).toBe(1);
    expect(list[0].name).toBe("SYNQ listener");
    expect(list[0].recipientId).toBe(ghost);
  });

  test("the recipient sees every playlist shared with them, saved status included", async () => {
    const ctx = makeCtx();
    await sharePlaylist._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_B });
    // Hamlet belongs to Bob, so only Bob can share it.
    ctx.auth = { getUserIdentity: async () => ({ subject: OWNER_B }) };
    await sharePlaylist._handler(ctx, { playlistId: OTHER._id, recipientId: OWNER_A });
    ctx.auth = { getUserIdentity: async () => ({ subject: OWNER_B }) };
    const list = await sharedWithMe._handler(ctx);
    // Bob only receives Macbeth; he owns Hamlet, so it is not "shared with" him.
    expect(list.length).toBe(1);
    expect(list[0].playlistId).toBe(PLAY._id);
    expect(list[0].ownerName).toBe("Alice");
    expect(list[0].saved).toBe(false);
  });

  test("the recipient can add a shared playlist to their own library without touching the owner's playlist", async () => {
    const ctx = makeCtx();
    await sharePlaylist._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_B });
    ctx.auth = { getUserIdentity: async () => ({ subject: OWNER_B }) };
    await setSavedInLibrary._handler(ctx, { playlistId: PLAY._id, saved: true });
    const list = await sharedWithMe._handler(ctx);
    const entry = list.find((x) => x.playlistId === PLAY._id);
    if (!entry) throw new Error("missing");
    expect(entry.saved).toBe(true);
    const ownerPlaylist = await ctx.db.get(PLAY._id);
    expect(ownerPlaylist?.userId).toBe(OWNER_A);
  });

  test("removing a library reference does not delete the original playlist", async () => {
    const ctx = makeCtx();
    await sharePlaylist._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_B });
    ctx.auth = { getUserIdentity: async () => ({ subject: OWNER_B }) };
    await setSavedInLibrary._handler(ctx, { playlistId: PLAY._id, saved: true });
    await setSavedInLibrary._handler(ctx, { playlistId: PLAY._id, saved: false });
    expect((await ctx.db.get(PLAY._id))?._id).toBe(PLAY._id);
  });

  test("a forged playlist id does not unlock sharing for someone who was never invited", async () => {
    const ctx = makeCtx();
    ctx.auth = { getUserIdentity: async () => ({ subject: OWNER_B }) };
    await expect(
      setSavedInLibrary._handler(ctx, { playlistId: OTHER._id, saved: true }),
    ).rejects.toThrow(/isn't shared with you/);
  });

  test("revoking a non-existent grant is idempotent from the owner's perspective", async () => {
    const ctx = makeCtx();
    ctx.auth = { getUserIdentity: async () => ({ subject: OWNER_B }) };
    const removed = await revokeShare._handler(ctx, { playlistId: OTHER._id, recipientId: OWNER_A });
    expect(removed).toBe(0);
  });

  test("receiver's view also lists grants they received but never added", async () => {
    const ctx = makeCtx();
    await sharePlaylist._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_B });
    ctx.auth = { getUserIdentity: async () => ({ subject: OWNER_B }) };
    const list = await sharedWithMe._handler(ctx);
    expect(list.some((x) => x.playlistId === PLAY._id && !x.saved)).toBe(true);
  });

  test("the grant's saved flag is false by default when sharing", async () => {
    const ctx = makeCtx();
    const shareId = await sharePlaylist._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_B });
    const grants = ctx.db.query("playlistShares").withIndex("by_grant", () => ({}));
    const rows = await grants.collect();
    const grant = rows.find((g) => g._id === shareId);
    expect(grant?.saved).toBe(false);
  });

  test("multiple recipients each get their own grant", async () => {
    const ctx = makeCtx();
    await sharePlaylist._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_B });
    await sharePlaylist._handler(ctx, { playlistId: PLAY._id, recipientId: CAROL });
    const grants = ctx.db.query("playlistShares").withIndex("by_playlist", () => ({})).collect;
    expect((await grants()).filter((g) => g.playlistId === PLAY._id)).toHaveLength(2);
  });

  test("a recipient can drop their own library reference", async () => {
    const ctx = makeCtx();
    await sharePlaylist._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_B });
    ctx.auth = { getUserIdentity: async () => ({ subject: OWNER_B }) };
    await setSavedInLibrary._handler(ctx, { playlistId: PLAY._id, saved: true });
    await setSavedInLibrary._handler(ctx, { playlistId: PLAY._id, saved: false });
    const list = await sharedWithMe._handler(ctx);
    expect(list.find((x) => x.playlistId === PLAY._id)?.saved).toBe(false);
  });

  test("the recipient can repeatedly add and remove a shared playlist from their library", async () => {
    const ctx = makeCtx();
    await sharePlaylist._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_B });
    ctx.auth = { getUserIdentity: async () => ({ subject: OWNER_B }) };
    await setSavedInLibrary._handler(ctx, { playlistId: PLAY._id, saved: true });
    expect((await sharedWithMe._handler(ctx)).find((x) => x.playlistId === PLAY._id)?.saved).toBe(true);
    await setSavedInLibrary._handler(ctx, { playlistId: PLAY._id, saved: false });
    expect((await sharedWithMe._handler(ctx)).find((x) => x.playlistId === PLAY._id)?.saved).toBe(false);
    await setSavedInLibrary._handler(ctx, { playlistId: PLAY._id, saved: true });
    expect((await sharedWithMe._handler(ctx)).find((x) => x.playlistId === PLAY._id)?.saved).toBe(true);
  });

  test("the recipient's library-only view does not expose anything beyond a playlist reference", async () => {
    const ctx = makeCtx();
    await sharePlaylist._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_B });
    ctx.auth = { getUserIdentity: async () => ({ subject: OWNER_B }) };
    const list = await sharedWithMe._handler(ctx);
    const entry = list.find((x) => x.playlistId === PLAY._id);
    expect(entry).toBeDefined();
    expect(entry).toHaveProperty("playlistId");
    expect(entry).toHaveProperty("name");
    expect(entry).toHaveProperty("ownerName");
    expect(entry).toHaveProperty("saved");
    expect(entry).toHaveProperty("sharedAt");
    expect(entry.trackIds).toBeInstanceOf(Array);
    expect([undefined, "string", null].includes(typeof entry.description)).toBe(true);
  });

  test("revoking the same grant twice is safe", async () => {
    const ctx = makeCtx();
    await sharePlaylist._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_B });
    const first = await revokeShare._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_B });
    const second = await revokeShare._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_B });
    expect(first).toBe(1);
    expect(second).toBe(0);
  });

  test("revoking a share the owner did not create is impossible", async () => {
    const ctx = makeCtx();
    await sharePlaylist._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_B });
    ctx.auth = { getUserIdentity: async () => ({ subject: OWNER_B }) };
    expect(
      () => revokeShare._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_A }),
    ).toThrow(/your own playlist/);
  });

  test("share search does not surface the viewer themselves", async () => {
    const ctx = makeCtx();
    expect(await searchShareableUsers._handler(ctx, { query: "alice" })).toHaveLength(0);
    expect(await searchShareableUsers._handler(ctx, { query: "ALICE" })).toHaveLength(0);
  });

  test("share search returns only the fields the UI should ever see", async () => {
    const ctx = makeCtx();
    const match = await searchShareableUsers._handler(ctx, { query: "bob" });
    expect(match).toHaveLength(1);
    const row = match[0];
    expect(row).toHaveProperty("userId");
    expect(row).toHaveProperty("name");
    expect(row).toHaveProperty("image");
    expect(row).not.toHaveProperty("email");
    expect(row).not.toHaveProperty("isAnonymous");
  });

  test("a share search shorter than two characters returns nothing", async () => {
    const ctx = makeCtx();
    expect(await searchShareableUsers._handler(ctx, { query: "a" })).toHaveLength(0);
    expect(await searchShareableUsers._handler(ctx, { query: " B " })).toHaveLength(0);
  });

  test("the recipient's access view hides the owner-but-not-recipient playlists", async () => {
    const ctx = makeCtx();
    await sharePlaylist._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_B });
    ctx.auth = { getUserIdentity: async () => ({ subject: OWNER_B }) };
    const list = await sharedWithMe._handler(ctx);
    expect(list.find((x) => x.playlistId === PLAY._id)).toBeDefined();
    expect(list.find((x) => x.playlistId === OTHER._id)).toBeUndefined();
  });

  test("ownership is enforced on the server, so a different owner cannot add to your library", async () => {
    const ctx = makeCtx();
    await sharePlaylist._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_B });
    ctx.auth = { getUserIdentity: async () => ({ subject: OWNER_B }) };
    await expect(
      setSavedInLibrary._handler(ctx, { playlistId: OTHER._id, saved: true }),
    ).rejects.toThrow(/isn't shared with you/);
  });

  test("the recipient's access list includes only grants for playlists they can open", async () => {
    const ctx = makeCtx();
    await sharePlaylist._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_B });
    await sharePlaylist._handler(ctx, { playlistId: PLAY._id, recipientId: CAROL });
    ctx.auth = { getUserIdentity: async () => ({ subject: OWNER_B }) };
    await sharePlaylist._handler(ctx, { playlistId: OTHER._id, recipientId: OWNER_A });
    ctx.auth = { getUserIdentity: async () => ({ subject: OWNER_A }) };
    const list = await sharedWithMe._handler(ctx);
    expect(list.map((x) => x.playlistId)).toContain(OTHER._id);
    expect(list.map((x) => x.playlistId)).not.toContain(PLAY._id);
    expect(list.length).toBe(1);
  });

  test("revoking the same grant twice is safe", async () => {
    const ctx = makeCtx();
    await sharePlaylist._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_B });
    const first = await revokeShare._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_B });
    const second = await revokeShare._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_B });
    expect(first).toBe(1);
    expect(second).toBe(0);
  });

  test("a revoked share disappears from both the owner and recipient views of the grant", async () => {
    const ctx = makeCtx();
    await sharePlaylist._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_B });
    await revokeShare._handler(ctx, { playlistId: PLAY._id, recipientId: OWNER_B });
    const ownerList = await accessList._handler(ctx, { playlistId: PLAY._id });
    expect(ownerList).toHaveLength(0);
    ctx.auth = { getUserIdentity: async () => ({ subject: OWNER_B }) };
    const recipientList = await sharedWithMe._handler(ctx);
    expect(recipientList.find((x) => x.playlistId === PLAY._id)).toBeUndefined();
  });
});
