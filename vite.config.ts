import { vlyPlugin } from "@vly-ai/integrations";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
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
        // Manual chunking by matched PATH, not by package name.
        //
        // The earlier object form — `{ 'convex-vendor': ['convex'], 'forms':
        // ['react-hook-form', ...] }` — resolves each entry to a single module
        // id, so it only ever matched the bare `convex` and `react-hook-form`
        // roots. The app imports `convex/react`, `convex/browser` and
        // `@convex-dev/auth/react`, whose ids are DIFFERENT modules, so none of
        // them matched: the build emitted `convex-vendor` at 0.00 kB and
        // `forms` at 0.04 kB while the real Convex + form code sat inside the
        // 1.2 MB entry chunk. The function form matches by path prefix, so it
        // catches every subpath and actually moves these libraries out.
        //
        // Only node_modules are routed; app source keeps Rollup's default
        // graph-based grouping.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return;
          // Shared UI utilities FIRST. `clsx` and `tailwind-merge` are depended
          // on by BOTH the app's `cn()` helper (used by nearly every component)
          // and by recharts. If they are left to Rollup's default chunking they
          // get co-located into the heavy `charts` chunk, which makes the entry
          // statically import all 357 kB of recharts just to render one class
          // name. Pinning them to a tiny chunk keeps the chart library lazily
          // reachable only from the Stats route.
          if (/node_modules\/(clsx|tailwind-merge|class-variance-authority)/.test(id))
            return 'ui-utils';
          if (/node_modules\/(react|react-dom|scheduler|react-router)/.test(id))
            return 'react-vendor';
          if (/node_modules\/(convex|@convex-dev)/.test(id)) return 'convex-vendor';
          if (/node_modules\/@radix-ui/.test(id)) return 'radix-ui';
          if (/node_modules\/(framer-motion|motion-dom|motion-utils|popmotion)/.test(id))
            return 'motion';
          if (/node_modules\/(recharts|d3-|victory-vendor)/.test(id)) return 'charts';
          if (/node_modules\/(react-hook-form|@hookform|zod)/.test(id)) return 'forms';
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
  },
});
