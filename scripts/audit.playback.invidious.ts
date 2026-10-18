/**
 * Does an Invidious-resolved stream ACTUALLY play?
 *
 * `invidious.f5.si` returns real audio itags, but a googlevideo URL is
 * IP-locked to whoever requested it. If that lock is real, a URL minted on
 * Invidious's IP cannot be played from the listener's browser, and the whole
 * idea is dead on arrival. So this does not stop at "the JSON parsed":
 *
 *   1. resolve a track that the Convex resolver is known to bot-block
 *   2. take the best audio itag
 *   3. ranged GET it directly
 *   4. ranged GET it through /audio-proxy (the path playback actually uses)
 *
 *   bun scripts/audit.playback.invidious.ts [instance] [videoId]
 */

const INSTANCE = (process.argv[2] ?? "https://invidious.f5.si").replace(
  /\/$/,
  "",
);
const VIDEO = process.argv[3] ?? "kJQP7kiw5Fk";
const SITE = "https://frugal-lobster-91.convex.site";
const ALLOW =
  /^https:\/\/rr[0-9a-z-]*---sn-[a-z0-9-]+\.googlevideo\.com\/videoplayback\?/;

type Fmt = {
  url?: string;
  itag?: string | number;
  type?: string;
  mimeType?: string;
  bitrate?: string | number;
};

async function main() {
  console.log(`instance ${INSTANCE}\nvideo    ${VIDEO}\n`);

  const res = await fetch(`${INSTANCE}/api/v1/videos/${VIDEO}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  console.log(`resolve  HTTP ${res.status}`);
  if (!res.ok) {
    console.log("FAIL  instance did not return data");
    process.exit(1);
  }

  const data = (await res.json()) as {
    adaptiveFormats?: Fmt[];
    formatStreams?: Fmt[];
    error?: string;
  };
  if (data.error) {
    console.log(`FAIL  instance error: ${data.error}`);
    process.exit(1);
  }

  const all = [...(data.adaptiveFormats ?? []), ...(data.formatStreams ?? [])];
  const audio = all
    .filter((f) => (f.type ?? f.mimeType ?? "").startsWith("audio/") && f.url)
    .sort((a, b) => Number(b.bitrate ?? 0) - Number(a.bitrate ?? 0));
  console.log(`audio   ${audio.length} audio format(s) offered`);
  if (!audio.length) {
    console.log("FAIL  no audio formats");
    process.exit(1);
  }

  const best = audio[0]!;
  console.log(`best    itag ${best.itag} ${best.type ?? best.mimeType}`);

  if (!ALLOW.test(best.url!)) {
    console.log("FAIL  url would be REJECTED by the /audio-proxy allow-list");
    process.exit(1);
  }
  console.log("allow   ok, passes the proxy allow-list");

  let bad = 0;

  try {
    const r = await fetch(best.url!, {
      headers: { Range: "bytes=0-2047" },
      signal: AbortSignal.timeout(15_000),
    });
    const len = (await r.arrayBuffer()).byteLength;
    const ok = r.status === 206 || r.status === 200;
    console.log(
      `direct  ${ok ? "ok  " : "FAIL"} HTTP ${r.status} ${r.headers.get("content-range") ?? ""} bytes=${len} ${r.headers.get("content-type") ?? ""}`,
    );
    if (!ok) bad++;
  } catch (e) {
    console.log(`direct  FAIL threw: ${(e as Error).message}`);
    bad++;
  }

  try {
    const proxied = `${SITE}/audio-proxy?u=${encodeURIComponent(best.url!)}`;
    const r = await fetch(proxied, {
      headers: { Range: "bytes=0-2047" },
      signal: AbortSignal.timeout(20_000),
    });
    const len = (await r.arrayBuffer()).byteLength;
    const ok = r.status === 206 || r.status === 200;
    console.log(
      `proxy   ${ok ? "ok  " : "FAIL"} HTTP ${r.status} ${r.headers.get("content-range") ?? ""} bytes=${len} ${r.headers.get("content-type") ?? ""}`,
    );
    if (!ok) bad++;
  } catch (e) {
    console.log(`proxy   FAIL threw: ${(e as Error).message}`);
    bad++;
  }

  console.log(`\nfailed ${bad}`);
  process.exit(bad ? 1 : 0);
}

void main();
