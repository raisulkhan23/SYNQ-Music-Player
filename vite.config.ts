import { vlyPlugin } from "@vly-ai/integrations";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { configDefaults, defineConfig } from "vitest/config";

// https://vite.dev/config/
export default defineConfig({
  // Use a RELATIVE base so that assets load over file:// when the frontend is
  // packaged inside Electron's app.asar, and so that the build nests correctly
  // in Capacitor's WebView. A root-absolute base would drop the file:///D:/...
  // drive in Electron and make every chunk request 404 from a blank screen.
  //
  // THAT IS WRONG FOR THE WEB, and the desktop default must not be changed to
  // fix it: the app is served with `BrowserRouter`, so a direct hit on a nested
  // route such as `/p/<share-token>` resolves `./assets/index-*.js` against the
  // route path and requests `/p/assets/index-*.js`, which is a 404 and a blank
  // page. A share link is exactly the kind of URL people open directly, so the
  // web build opts into a root-absolute base with `SYNQ_WEB_BASE=1`. Everything
  // else — Electron, Capacitor, plain `npm run build` — keeps the relative
  // default unchanged.
  //
  // A FLAG, not the base path itself, and that is not arbitrary: this project
  // builds on Windows through Git Bash, where MSYS rewrites any environment
  // value that looks like a POSIX path before the process ever sees it. Passing
  // `/` produced a base of `/Git/` and a bundle that could not load its own
  // assets — a failure that is invisible locally and total in production.
  base: process.env.SYNQ_WEB_BASE ? "/" : "./",
  plugins: [react(), vlyPlugin(), tailwindcss()],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    // Force a single copy of React across all packages (including vlyPlugin).
    // Without this, @vly-ai/integrations can resolve its own React copy, which
    // triggers "Invalid hook call" errors at runtime.
    dedupe: ["react", "react/jsx-runtime", "react-dom", "react-dom/client"],
  },
  build: {
    // Enable source maps for better debugging (disable in production if needed)
    sourcemap: false,
    // Optimize chunk splitting
    rollupOptions: {
      output: {
        // Manual chunk splitting for better caching and lazy loading
        manualChunks: {
          // Vendor chunks for large libraries
          'react-vendor': ['react', 'react-dom', 'react-router'],
          // NOTE: there used to be a `'convex-vendor': ['convex']` entry here.
          // It never held anything: the app imports Convex through its
          // subpaths (`convex/react`, `convex/browser`), so the bare package
          // root resolved to nothing and Rollup emitted an empty 0-byte chunk
          // that every visitor still requested. Removed rather than left as
          // dead output.
          // Large UI library chunks
          'radix-ui': [
            '@radix-ui/react-accordion',
            '@radix-ui/react-alert-dialog',
            '@radix-ui/react-avatar',
            '@radix-ui/react-checkbox',
            '@radix-ui/react-collapsible',
            '@radix-ui/react-context-menu',
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-hover-card',
            '@radix-ui/react-label',
            '@radix-ui/react-menubar',
            '@radix-ui/react-navigation-menu',
            '@radix-ui/react-popover',
            '@radix-ui/react-progress',
            '@radix-ui/react-radio-group',
            '@radix-ui/react-scroll-area',
            '@radix-ui/react-select',
            '@radix-ui/react-separator',
            '@radix-ui/react-slider',
            '@radix-ui/react-switch',
            '@radix-ui/react-tabs',
            '@radix-ui/react-toggle',
            '@radix-ui/react-toggle-group',
            '@radix-ui/react-tooltip',
          ],
          // Heavy optional libraries - separate chunks for better lazy loading
          'framer-motion': ['framer-motion'],
          'charts': ['recharts'],
          'forms': ['react-hook-form', '@hookform/resolvers', 'zod'],
        },
        // Optimize chunk size
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
    // Increase chunk size warning limit for better chunking
    chunkSizeWarningLimit: 1000,
    // Target modern browsers for better optimization
    target: 'esnext',
    // Minify options - using esbuild (faster than terser)
    minify: 'esbuild',
  },
  // Optimize dependencies
  optimizeDeps: {
    // Only scan the app entry HTML; avoids crawling unrelated *.html files
    // if a legacy snapshot accidentally contains leaked package folders.
    entries: ['index.html'],
    include: [
      'react',
      'react/jsx-runtime',
      'react-dom',
      'react-dom/client',
      'react-router',
      '@convex-dev/auth/react',
      'framer-motion',
    ],
  },
  // Performance hints
  server: {
    // Bind to all interfaces so WebContainer's server-ready event fires.
    host: true,
    port: 5173,
    // Keep HMR on, but disable full-screen error overlay
    hmr: {
      overlay: false,
    },
    watch: {
      // Never watch build output.
      //
      // Packaging writes hundreds of MB into desktop-dist/ (Electron itself plus
      // the app), and Vite's watcher opens handles inside directories that
      // appear there. On Windows an open handle is enough to make a directory
      // rename fail, and electron-builder's very last packaging step IS a
      // rename (`win-unpacked.tmp` -> `win-unpacked`). With the dev server
      // running, `npm run desktop:win` therefore dies at that rename with
      // "EPERM: operation not permitted" — deterministically, not randomly.
      // Ignoring these paths removes the collision instead of asking people to
      // remember to stop the dev server first.
      ignored: [
        '**/desktop-dist/**',
        '**/dist/**',
        '**/release/**',
        '**/android/**',
        '**/.git/**',
      ],
    },
  },
  // The test suite. `defineConfig` is imported from `vitest/config` above so
  // that these options and the Vite ones live in ONE file — a separate
  // `vitest.config.ts` would take priority and silently drop the `@` alias and
  // the React plugin, which is exactly how `vi.mock("@/…")` stops resolving.
  test: {
    // The suite is plain Node: no jsdom. Every file that needs a DOM builds its
    // own happy-dom `Window` and installs it onto `globalThis` (see
    // tests/helpers/globals.js), which keeps the globals a test depends on
    // visible in the test.
    environment: "node",
    include: ["tests/**/*.test.js"],
    // Four files in tests/ are written for Node's own test runner
    // (`import test from "node:test"`) and are run by `npm run test:node`.
    // They cannot run here — vitest reports them as "No test suite found" —
    // and under `node --test` all 18 of their tests pass.
    exclude: [...configDefaults.exclude, "tests/node/**", "tests/desktop-oauth-deeplink.test.js", "tests/image-fallback.test.js", "tests/packaging-assets.test.js", "tests/public-asset-resolution.test.js"],
    // Several files render real components in a real DOM and wait for effects;
    // 5s (the default) is not enough for the page-render ones.
    testTimeout: 30_000,
  },
});
