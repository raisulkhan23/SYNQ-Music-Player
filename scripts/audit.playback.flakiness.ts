/**
 * Is the Convex resolver hard-blocked, or just flaky?
 *
 * The difference decides the fix:
 *   - a HARD block (0/N) means the provider is unusable from a Convex IP and
 *     the answer is a different resolution path entirely;
 *   - a FLAKY block (some succeed) means the existing path still works and
 *     the fix is to retry and rotate rather than to replace it.
 *
 * So this calls the deployed `youtube:resolveStream` repeatedly on the same
 * tracks and reports the per-video and overall hit rate.
 *
 *   bun scripts/audit.playback.flakiness.ts [deploymentUrl] [rounds]
 */

const BASE = (process.argv[2] ?? "https://impartial-ptarmigan-116.convex.cloud").replace(
  /\/$/,
  "",
);
const ROUNDS = Number(process.argv[3] ?? 6);
const IDS = ["dQw4w9WgXcQ", "kJQP7kiw5Fk", "9bZkp7q19f0", "JGwWNGJdvx8"];

async function once(videoId: string): Promise<{ ok: boolean; reason: string }> {
  try {
    const res = await fetch(`${BASE}/api/action`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "youtube:resolveStream",
        args: { videoId, quality: "high" },
        format: "json",
      }),
      signal: AbortSignal.timeout(25_000),
    });
    const body = (await res.json()) as {
      status?: string;
      value?: { url?: string | null; reason?: string };
    };
    const url = body.value?.url ?? null;
    return { ok: !!url, reason: url ? "ok" : body.value?.reason ?? "no url" };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

async function main() {
  const reasons = new Map<string, number>();
  let total = 0;
  let hits = 0;

  for (const id of IDS) {
    let ok = 0;
    for (let i = 0; i < ROUNDS; i++) {
      const r = await once(id);
      total++;
      if (r.ok) {
        ok++;
        hits++;
      } else {
        reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
      }
    }
    console.log(`${id}  ${ok}/${ROUNDS}`);
  }

  console.log(`\noverall ${hits}/${total} (${Math.round((hits / total) * 100)}%)`);
  console.log("failure reasons:");
  for (const [reason, n] of [...reasons].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n}x  ${reason.slice(0, 110)}`);
  }
  process.exit(hits === 0 ? 1 : 0);
}

void main();
