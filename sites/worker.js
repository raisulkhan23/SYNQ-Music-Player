/**
 * SYNQ web deployment worker.
 *
 * The app itself is a static Vite build: every page, every API call and the
 * whole music catalog are handled by the browser and by the Convex deployment
 * (`VITE_CONVEX_URL`), which is a hosted service. So this worker has exactly one
 * job — serve the built assets — and it deliberately has no routes of its own.
 * Adding server endpoints here would create a second, competing backend for a
 * project whose backend is already somewhere else.
 *
 * WHAT IT DOES HAVE TO DO is the SPA fallback. SYNQ serves `BrowserRouter`
 * routes like `/playlist/abc` and `/p/<share-token>`; those paths do not exist
 * as files, so a direct visit (or a refresh, or a shared link — which is the
 * whole point of a share link) must return `index.html` and let the app route
 * it. Without this, every deep URL 404s on reload while working fine when
 * clicked from inside the app, which is the classic SPA deployment bug.
 */
export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);

    // Only serve the shell for a MISSING page, and only when the browser asked
    // for a document. A missing script, image or API call must keep its 404: a
    // chunk that failed to load would otherwise be answered with HTML, which
    // surfaces as a confusing MIME-type error instead of the real problem.
    if (response.status !== 404) return response;

    const accept = request.headers.get("Accept") ?? "";
    if (!accept.includes("text/html")) return response;

    const url = new URL(request.url);
    url.pathname = "/index.html";
    url.search = "";
    return env.ASSETS.fetch(new Request(url.toString(), request));
  },
};
