/**
 * Classify Piped instances so the mirror list is pruned on evidence.
 *
 * The distinction that matters is NOT "did it resolve a stream for me":
 *
 *   ALIVE     the host answers and speaks the Piped API. It may still be
 *             bot-blocked from a datacenter IP, but a listener on a
 *             residential connection resolves through it fine. KEEP.
 *   BLOCKED   same, but answered YouTube's bot-check. KEEP — that is an
 *             IP-reputation verdict about ME, not proof the host is dead.
 *   DEAD      no DNS, no connection, or a non-API response. Gone for EVERYONE,
 *             including residential users. PRUNE.
 *
 * An earlier version of this script mis-plumbed its verdict field and reported
 * every instance as DEAD, including two that demonstrably return JSON. That
 * output was wrong and no pruning was done on the strength of it.
 *
 *   bun scripts/audit.piped.instances.ts
 */

const IN_APP = [
  "https://api.piped.private.coffee",
  "https://pipedapi.ducks.party",
  "https://pipedapi.adminforge.de",
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.reallyaweso.me",
  "https://pipedapi.leptons.xyz",
];

const EXTRA = [
  "https://pipedapi.nosebs.ru",
  "https://pipedapi-libre.kavin.rocks",
  "https://piped-api.privacy.com.de",
  "https://api.piped.yt",
  "https://pipedapi.drgns.space",
  "https://pipedapi.owo.si",
  "https://piped-api.codespace.cz",
  "https://pipedapi.darkness.services",
  "https://pipedapi.orangenet.cc",
];

const VIDEO = "dQw4w9WgXcQ";

type Verdict = "ALIVE" | "BLOCKED" | "DEAD";
type Row = { base: string; inApp: boolean; verdict: Verdict; detail: string };

/** Best-effort human reason for a thrown fetch, including DNS/TCP codes. */
function why(err: unknown): string {
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string } };
  const code = e?.code ?? e?.cause?.code;
  const name = e?.name === "TimeoutError" ? "timeout" : e?.name;
  const msg = (e?.message ?? "").slice(0, 48);
  return [code, name, msg].filter(Boolean).join("/") || String(err).slice(0, 48);
}

async function classify(base: string): Promise<{ verdict: Verdict; detail: string }> {
  let res: Response;
  const started = Date.now();
  try {
    res = await fetch(`${base}/streams/${VIDEO}`, {
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    });
  } catch (e) {
    return { verdict: "DEAD", detail: why(e) };
  }
  const ms = Date.now() - started;

  let text = "";
  try {
    text = await res.text();
  } catch (e) {
    return { verdict: "DEAD", detail: `body: ${why(e)}` };
  }

  if (!text.trim()) return { verdict: "DEAD", detail: `HTTP ${res.status} empty body` };

  let data: { audioStreams?: unknown[]; videoStreams?: unknown[]; error?: string };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    const head = text.replace(/\s+/g, " ").slice(0, 40);
    return { verdict: "DEAD", detail: `HTTP ${res.status} not JSON: ${head}` };
  }

  if (typeof data.error === "string" && data.error) {
    const bot = /SignInConfirmNotBot|not a bot|confirm you/i.test(data.error);
    return {
      verdict: bot ? "BLOCKED" : "DEAD",
      detail: bot ? `bot-check from my IP (${ms}ms)` : `err: ${data.error.slice(0, 40)}`,
    };
  }
  if (Array.isArray(data.audioStreams) && data.audioStreams.length) {
    return { verdict: "ALIVE", detail: `HTTP ${res.status} audio=${data.audioStreams.length} (${ms}ms)` };
  }
  if (Array.isArray(data.videoStreams) && data.videoStreams.length) {
    return { verdict: "ALIVE", detail: `HTTP ${res.status} muxed=${data.videoStreams.length} (${ms}ms)` };
  }
  return { verdict: "DEAD", detail: `HTTP ${res.status} empty stream lists` };
}

async function main() {
  const rows: Row[] = [];
  for (const [list, inApp] of [
    [IN_APP, true],
    [EXTRA, false],
  ] as Array<[string[], boolean]>) {
    for (const base of list) {
      const r = await classify(base);
      rows.push({ base, inApp, verdict: r.verdict, detail: r.detail });
    }
  }

  for (const r of rows) {
    const host = r.base.replace(/^https:\/\//, "");
    console.log(
      `${r.inApp ? "IN-APP" : "extra "} ${host.padEnd(33)} ${r.verdict.padEnd(7)} ${r.detail}`,
    );
  }

  const inAppKeep = rows.filter((r) => r.inApp && r.verdict !== "DEAD");
  const inAppDead = rows.filter((r) => r.inApp && r.verdict === "DEAD");
  const extraKeep = rows.filter((r) => !r.inApp && r.verdict !== "DEAD");

  console.log(`\nIN-APP  keep ${inAppKeep.length} / prune ${inAppDead.length}`);
  for (const r of inAppKeep) console.log(`  KEEP  ${r.base}  ${r.verdict}`);
  for (const r of inAppDead) console.log(`  PRUNE ${r.base}  (${r.detail})`);
  console.log(`\nreachable but not in the app: ${extraKeep.length}`);
  for (const r of extraKeep) console.log(`  ADD?  ${r.base}  ${r.verdict}`);
}

void main();
