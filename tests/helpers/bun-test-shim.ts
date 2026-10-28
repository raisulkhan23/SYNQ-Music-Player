// ---------------------------------------------------------------------------
// `bun:test` compatibility shim.
//
// The suite is written against Bun's test runner (`import { test } from
// "bun:test"`), but Bun is not installed in every environment that has to
// verify SYNQ — this Windows checkout, for one. Vitest is already a
// devDependency, so `vitest.config.ts` aliases `bun:test` here and the same
// test files run unchanged.
//
// Scope: the assertion/lifecycle surface the suite actually uses. Bun-only
// features have deliberately no equivalent here and remain unsupported under
// vitest — `mock.module` (Bun's module mocking) and the `Bun.*` globals such as
// `Bun.serve`/`Bun.sleep`. Tests that need those still have to run under Bun;
// aliasing them to a fake would make them pass without testing anything.
// ---------------------------------------------------------------------------

export {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  test,
  vi as jest,
} from "vitest";
