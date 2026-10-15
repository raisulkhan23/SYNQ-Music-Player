/**
 * Authorisation on the vector database admin actions.
 *
 * `requireAdmin` used to be authentication wearing an authorisation name: it
 * proved you were signed in and then waved you through. Since `ingestVectors`
 * and `deleteVectors` write across every listener's records, any account that
 * had completed sign-up could wipe the index. These tests drive the real
 * Convex handlers (Convex exposes the inner function as `_handler`) so the
 * gate is proven by behaviour rather than by reading the source.
 */
import { describe, expect, test } from 'vitest';
import {
  deleteVectors,
  myRole,
  upsertVectors,
  vectorStats,
} from "../src/convex/musicVectorDb";

/** A signed-in caller with a given role, and nothing else. */
function fakeCtx(role) {
  return {
    auth: {
      getUserIdentity: async () => ({ subject: "user_abc123" }),
    },
    db: { get: async () => ({ _id: "user_abc123", role }) },
    runQuery: async () => role,
  };
}

const ANON = {
  auth: { getUserIdentity: async () => null },
  runQuery: async () => null,
};

describe("vector admin authorisation", () => {
  const adminActions = [
    ["upsertVectors", upsertVectors, { items: [] }],
    ["deleteVectors", deleteVectors, { ids: ["a"] }],
    ["vectorStats", vectorStats, {}],
  ];

  for (const [name, fn, args] of adminActions) {
    test(`${name} refuses a signed-in non-admin`, async () => {
      await expect(fn._handler(fakeCtx("user"), args)).rejects.toThrow(
        /admin/i,
      );
    });

    test(`${name} refuses a caller with no role at all`, async () => {
      await expect(fn._handler(fakeCtx(null), args)).rejects.toThrow(/admin/i);
    });

    test(`${name} refuses an anonymous caller`, async () => {
      await expect(fn._handler(ANON, args)).rejects.toThrow(
        /not authenticated/i,
      );
    });
  }

  test("an admin gets through to the store", async () => {
    // Proof the gate is a gate and not a blanket denial: the same call that
    // threw above now reaches the engine and returns.
    const report = await upsertVectors._handler(fakeCtx("admin"), {
      items: [],
    });
    expect(report).toBeDefined();
  });

  test("myRole reads the session, not a table scan", async () => {
    const role = await myRole._handler(fakeCtx("admin"));
    expect(role).toBe("admin");
  });

  test("myRole is null when signed out", async () => {
    const role = await myRole._handler({
      auth: { getUserIdentity: async () => null },
      db: { get: async () => null },
    });
    expect(role).toBeNull();
  });
});
