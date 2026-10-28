import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Vitest configuration for environments without Bun.
 *
 * The tests are written for `bun:test`. Rather than rewriting 100+ files, the
 * `bun:test` specifier is aliased to `tests/helpers/bun-test-shim.ts`, which
 * re-exports vitest's equivalent API. Tests that rely on Bun-only features
 * (`mock.module`, `Bun.serve`, `Bun.sleep`) are out of scope for this runner
 * and are expected to be run with Bun.
 *
 * This config is only read by vitest. `vite build` keeps using
 * `vite.config.ts`, so production output is unaffected.
 */
export default defineConfig({
  resolve: {
    alias: {
      "bun:test": path.resolve(__dirname, "./tests/helpers/bun-test-shim.ts"),
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    include: ["tests/**/*.test.{js,ts}"],
    environment: "node",
    // The suite shares process-global fixtures (localStorage stubs, module
    // singletons); running files in one process matches how Bun runs them and
    // avoids cross-file interference.
    isolate: true,
  },
});
