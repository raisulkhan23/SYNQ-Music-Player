/**
 * Which InnerTube clients can still resolve a bot-blocked video?
 *
 * `youtube:resolveStream` rotates 5 clients (ANDROID_VR, TV_EMBEDDED, ANDROID,
 * IOS, MWEB). If YouTube's bot-check is client-specific rather than blanket,
 * adding one more client fixes playback. If every client is refused, then the
 * block is about the IP and no client rotation can help.
 *
 * This answers that with evidence instead of another guess, and it is run from
 * THIS host, so treat the absolute result as indicative and the per-client
 * pattern as the real signal.
 *
 *   bun scripts/audit.playback.clients.ts [videoId ...]
 */

const KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const VIDEO = process.argv[2] ?? "kJQP7kiw5Fk";

type Client = {
  name: string;
  id: number;
  version: string;
  ua: string;
  /** Some clients only answer when an embed context is supplied. */
  thirdParty?: boolean;
};

const CLIENTS: Client[] = [
  {
    name: "ANDROID_VR",
    id: 28,
    version: "1.60.19",
    ua: "com.google.android.apps.youtube.vr.oculus/1.60.19",
  },
  {
    name: "TVHTML5_SIMPLY_EMBEDDED_PLAYER",
    id: 85,
    version: "2.0",
    ua: "Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15",
    thirdParty: true,
  },
  { name: "ANDROID", id: 3, version: "19.44.38", ua: "com.google.android.youtube/19.44.38" },
  { name: "IOS", id: 5, version: "19.45.4", ua: "com.google.ios.youtube/19.45.4" },
  {
    name: "MWEB",
    id: 2,
    version: "2.20240801.01.00",
    ua: "Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X)",
  },
  {
    name: "WEB",
    id: 1,
    version: "2.20240801.01.00",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  },
  {
    name: "WEB_EMBEDDED",
    id: 56,
    version: "1.20240801.01.00",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    thirdParty: true,
  },
  {
    name: "ANDROID_TESTSUITE",
    id: 30,
    version: "1.9",
    ua: "com.google.android.youtube/1.9",
  },
];

async function probe(c: Client): Promise<string> {
  const body: Record<string, unknown> = {
    context: {
      client: {
        clientName: c.name,
        clientVersion: c.version,
        hl: "en",
        gl: "US",
        androidSdkVersion: c.id === 3 ? 30 : undefined,
        userAgent: c.ua,
      },
    },
    videoId: VIDEO,
    contentCheckOk: true,
    racyCheckOk: true,
  };
  if (c.thirdParty) body.thirdParty = { embedUrl: "https://www.youtube.com" };

  const res = await fetch(
    `https://www.youtube.com/youtubei/v1/player?key=${KEY}&prettyPrint=false`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": c.ua,
        "X-Youtube-Client-Name": String(c.id),
        "X-Youtube-Client-Version": c.version,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    },
  );

  if (!res.ok) return `HTTP ${res.status}`;
  const data = (await res.json()) as {
    playabilityStatus?: { status?: string; reason?: string };
    streamingData?: {
      adaptiveFormats?: Array<{ url?: string; mimeType?: string }>;
      formats?: Array<{ url?: string; mimeType?: string }>;
    };
  };

  const status = data.playabilityStatus?.status ?? "?";
  if (status !== "OK") {
    return `${status} — ${(data.playabilityStatus?.reason ?? "").slice(0, 60)}`;
  }
  const fmts = [
    ...(data.streamingData?.adaptiveFormats ?? []),
    ...(data.streamingData?.formats ?? []),
  ].filter((f) => (f.mimeType ?? "").startsWith("audio/") && f.url);
  return `OK  audio formats=${fmts.length}`;
}

async function main() {
  console.log(`video ${VIDEO}\n`);
  let anyOk = false;
  for (const c of CLIENTS) {
    let line: string;
    try {
      line = await probe(c);
    } catch (e) {
      line = `threw: ${(e as Error).message}`;
    }
    if (line.startsWith("OK")) anyOk = true;
    console.log(`${c.name.padEnd(32)} ${line}`);
  }
  console.log(`\nat least one client worked: ${anyOk}`);
}

void main();
