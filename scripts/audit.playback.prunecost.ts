/**
 * What did the pruned clients actually cost?
 *
 * Pruning is only worth claiming if the dead clients were really costing
 * time. They were tried in SEQUENCE, so each one added a full HTTPS round trip
 * to youtube.com before the next was attempted. This times a dead client
 * (ANDROID, refused with HTTP 400) against the live one (ANDROID_VR) so the
 * saving can be quoted as a measurement instead of a guess.
 *
 *   bun scripts/audit.playback.prunecost.ts [rounds]
 */

const KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const VIDEO = "kJQP7kiw5Fk";
const ROUNDS = Number(process.argv[2] ?? 4);

const DEAD = {
  name: "ANDROID",
  id: 3,
  version: "19.44.38",
  ua: "com.google.android.youtube/19.44.38 (Linux; U; Android 14) gzip",
  extra: { androidSdkVersion: 34 },
};
const LIVE = {
  name: "ANDROID_VR",
  id: 28,
  version: "1.60.19",
  ua: "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12; eureka-user Build/SQ3A.220605.009.A1) gzip",
  extra: { androidSdkVersion: 31, osName: "Android", osVersion: "12" },
};
type C = typeof DEAD;

async function time(c: C): Promise<{ ms: number; status: number }> {
  const t0 = Date.now();
  const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${KEY}&prettyPrint=false`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": c.ua,
      "X-Goog-Api-Key": KEY,
      "X-Youtube-Client-Name": String(c.id),
      "X-Youtube-Client-Version": c.version,
      Origin: "https://www.youtube.com",
      "X-Origin": "https://www.youtube.com",
    },
    body: JSON.stringify({
      context: { client: { hl: "en", gl: "US", userAgent: c.ua, clientName: c.name, clientVersion: c.version, ...c.extra } },
      videoId: VIDEO,
      contentCheckOk: true,
      racyCheckOk: true,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  await res.text().catch(() => "");
  return { ms: Date.now() - t0, status: res.status };
}

async function main() {
  console.log(`video ${VIDEO}, ${ROUNDS} rounds each\n`);
  const out: Record<string, number[]> = { dead: [], live: [] };
  let deadStatus = 0;
  let liveStatus = 0;

  for (let i = 0; i < ROUNDS; i++) {
    const d = await time(DEAD);
    deadStatus = d.status;
    out.dead.push(d.ms);
    const l = await time(LIVE);
    liveStatus = l.status;
    out.live.push(l.ms);
  }

  const avg = (a: number[]) => Math.round(a.reduce((x, y) => x + y, 0) / a.length);
  const deadAvg = avg(out.dead);
  const liveAvg = avg(out.live);

  console.log(`dead client ${DEAD.name.padEnd(11)} HTTP ${deadStatus}  avg ${deadAvg}ms  [${out.dead.join(", ")}]`);
  console.log(`live client ${LIVE.name.padEnd(11)} HTTP ${liveStatus}  avg ${liveAvg}ms  [${out.live.join(", ")}]`);
  console.log(`\nper dead client wasted: ~${deadAvg}ms`);
  console.log(`3 dead clients removed: ~${deadAvg * 3}ms saved per resolution`);
}

void main();
