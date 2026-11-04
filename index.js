import { serveStatic } from "@cloudflare/workers-types";

const ASSETS = serveStatic({
  root: "./dist",
  fallback: "/index.html",
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const distPath = path === "/" ? "/index.html" : path;

    if (
      distPath.endsWith(".ico") ||
      distPath.endsWith(".png") ||
      distPath.endsWith(".svg") ||
      distPath.endsWith(".webmanifest")
    ) {
      const tenDays = 10 * 24 * 60 * 60;
      const response = await ASSETS.fetch(request);
      if (response.ok) {
        return new Response(response.body, {
          headers: {
            ...Object.fromEntries(response.headers.entries()),
            "Cache-Control": `public, max-age=${tenDays}, immutable`,
          },
        });
      }
    }

    return ASSETS.fetch(request);
  },
};
