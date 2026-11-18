import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";

const http = httpRouter();

auth.addHttpRoutes(http);

/**
 * CORS-passthrough proxy for remote audio streams.
 *
 * The resolved stream hosts (googlevideo.com) send no CORS headers, so a
 * <audio crossOrigin="anonymous"> element cannot load them — which silently
 * kills every Web Audio effect (8D, bass boost, …) for those tracks.
 * This proxy forwards Range requests to the stream and adds the missing
 * CORS headers, letting the filter graph tap the audio.
 */
const STREAM_PROXY = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const target = url.searchParams.get("u");
  if (!target) {
    return new Response("Bad or missing stream url", { status: 400 });
  }
  // Validate the target is one of the media hosts this proxy exists for.
  // Check the parsed hostname, never a substring: `attacker.example/?x=cdn.com`
  // must not be able to turn an open CORS proxy into arbitrary SSRF.
  let upstreamUrl: URL;
  try {
    upstreamUrl = new URL(target);
  } catch {
    return new Response("Bad or missing stream url", { status: 400 });
  }
  const host = upstreamUrl.hostname.toLowerCase();
  const allowedHost =
    (host.endsWith("googlevideo.com") &&
      upstreamUrl.pathname === "/videoplayback") ||
    host === "odycdn.com" ||
    host.endsWith(".odycdn.com") ||
    host.startsWith("piped-proxy.") ||
    host === "sndcdn.com" ||
    host.endsWith(".sndcdn.com") ||
    host === "soundcloud.cloud" ||
    host.endsWith(".soundcloud.cloud");
  if (upstreamUrl.protocol !== "https:" || !allowedHost) {
    return new Response("Bad or missing stream url", { status: 400 });
  }

  const headers: Record<string, string> = {
    // Forward the range so seeking works without downloading the whole file.
    ...(request.headers.get("range")
      ? { Range: request.headers.get("range") as string }
      : {}),
  };

  const upstream = await fetch(target, { headers });
  const passthrough = new Headers();
  for (const name of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "cache-control",
  ]) {
    const v = upstream.headers.get(name);
    if (v) passthrough.set(name, v);
  }
  // The headers the browser actually needs for Web Audio access:
  passthrough.set("Access-Control-Allow-Origin", "*");
  passthrough.set(
    "Access-Control-Expose-Headers",
    "Content-Range, Content-Length, Accept-Ranges",
  );

  return new Response(upstream.body, {
    status: upstream.status, // 200 or 206 (partial content)
    headers: passthrough,
  });
});

// CORS preflight for the proxy.
http.route({
  path: "/audio-proxy",
  method: "OPTIONS",
  handler: httpAction(async () => {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Range",
        "Access-Control-Max-Age": "86400",
      },
    });
  }),
});

http.route({ path: "/audio-proxy", method: "GET", handler: STREAM_PROXY });

export default http;
