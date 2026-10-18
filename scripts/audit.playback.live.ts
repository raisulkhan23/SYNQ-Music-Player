/**
 * Live end-to-end playback diagnosis.
 *
 * Plays the exact chain the browser plays, in order, and reports where it
 * breaks:
 *
 *   1. `youtube:resolveStream` on the deployed backend -> does it return a url?
 *   2. that url against the /audio-proxy allow-list    -> would we 400 it?
 *   3. GET the real /audio-proxy?u=...                 -> what status comes back?
 *   4. a direct ranged GET of the upstream url         -> is the source alive?
 *
 * Every step prints PASS/FAIL so the break is located, not guessed at.
 *
 *   bun scripts/audit.playback.live.ts [deploymentUrl] [videoId ...]
 */

const BASE = (process.argv[2] ?? "https://frugal-lobster-91.convex.cloud").replace,
  /\/$/,
  "",
);
const SITE = BASE.replace(".cloud", ".site");
const ENDPOINT = `${BASE}/api/action`;
const IDS = process.argv.slice(3).length
  ? process.argv.slice(3)
  : ["kJQP7kiw5Fk", "dQw4w9WgXcQ", "9bZkp7q19f0", "JGwWNGJdvx8", "fJ9rUzIMcZQ"];

/**
 * The allow-list in src/convex/http.ts, verbatim. Copied rather than imported
 * because the proxy is a plain Response handler, not a unit, and importing the
 * router would drag the whole Convex runtime into the script.
 */
const PROXY_ALLOW =
  /^https:\/\/rr[0-9a-z-]*---sn-[a-z0-9-]+\.googlevideo\.com\/videoplayback\?/;

async function resolveStream(videoId: string): Promise<string | null> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "youtube:resolveStream",
      args: { videoId, quality: "high" },
      format: "json",
    }),
  });
  const body = (await res.json()) as {
    status?: string;
    value?: { url?: string } | null;
  };
  if (body.status !== "success") return null;
  return body.value?.url ?? null;
}

async function main() {
  console.log(`backend ${BASE}\nsite    ${SITE}\n`);
  let ok = 0;
  let bad = 0;

  for (const id of IDS) {
    console.log(`--- ${id}`);
    let url: string | null = null;
    try {
      url = await resolveStream(id);
    } catch (err) {
      console.log(`  FAIL  resolveStream threw: ${(err as Error).message}`);
    }

    if (!url) {
      console.log("  FAIL  step1 resolveStream returned NO url");
      bad++;
      continue;
    }
    const host = new URL(url).host;
    console.log(`  ok    step1 resolveStream -> ${host}`);
    ok++;

    if (!PROXY_ALLOW.test(url)) {
      console.log(`  FAIL  step2 proxy allow-list REJECTS this url (${host})`);
      console.log("        => /audio-proxy answers 400 and playback dies here.");
      bad++;
    } else {
      console.log("  ok    step2 proxy allow-list accepts it");
      ok++;
    }

    const proxied = `${SITE}/audio-proxy?u=${encodeURIComponent(url)}`;
    try {
      const res = await fetch(proxied, { headers: { Range: "bytes=0-1023" } });
      const type = res.headers.get("content-type");
      console.log(
        `  ${res.ok ? "ok   " : "FAIL "} step3 GET /audio-proxy -> ${res.status} ${res.headers.get("content-range") ?? ""} ${type ?? ""}`,
      );
      if (res.ok) ok++;
      else bad++;
      await res.arrayBuffer();
    } catch (err) {
      console.log(`  FAIL  step3 proxy threw: ${(err as Error).message}`);
      bad++;
    }

    try {
      const res = await fetch(url, { headers: { Range: "bytes=0-1023" } });
      console.log(`  ${res.ok ? "ok   " : "FAIL "} step4 direct upstream -> ${res.status}`);
      if (res.ok) ok++;
      else bad++;
      await res.arrayBuffer();
    } catch (err) {
      console.log(`  FAIL  step4 upstream threw: ${(err as Error).message}`);
      bad++;
    }
    console.log("");
  }

  console.log(`passed ${ok}  failed ${bad}`);
  process.exit(bad ? 1 : 0);
}

void main();
