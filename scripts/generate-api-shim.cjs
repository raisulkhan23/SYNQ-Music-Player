const fs = require("node:fs");
const path = require("node:path");

const CONVEX_DIR = path.resolve(__dirname, "../src/convex");
const OUT_FILE = path.resolve(__dirname, "../src/convex/_generated/api.ts");

const SKIP = new Set([
  "auth.config.ts",
  "auth.ts",
  "schema.ts",
  "convexVectorStore.ts",
  "lyricsProviders.ts",
  "http.ts",
  "providerCache.ts",
]);

function detectKind(text, name) {
  const re = new RegExp(
    `(?:export\\s+(?:async\\s+)?(?:function\\s+)?)(?:const|let|var)\\s+${name}\\b[\\s\\S]*?=\\s*(query|mutation|action|internalQuery|internalMutation|internalAction)\\s*\\(`,
  );
  const m = text.match(re);
  if (!m) return "Query";
  const k = m[1];
  if (k.startsWith("action")) return "Action";
  if (k.startsWith("mutation")) return "Mutation";
  return "Query";
}

function exportedDefs(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const defs = [];
  const re = /(?:export\s+(?:async\s+)?(?:function\s+)?)(?:const|let|var)\s+(\w+)\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    defs.push({ name: m[1], kind: detectKind(text, m[1]) });
  }
  return defs;
}

function moduleName(file) {
  return file.replace(/\.ts$/, "");
}

const modules = fs.readdirSync(CONVEX_DIR)
  .filter((f) => f.endsWith(".ts") && !SKIP.has(f))
  .sort();

const shape = modules.map((file) => {
  const mod = moduleName(file);
  const defs = exportedDefs(path.join(CONVEX_DIR, file));
  return { mod, defs };
});

const lines = [];
lines.push(
  "// Minimal stand-in for `convex/_generated/api`.",
  "//",
  "// Generated from the convex function exports present in src/convex/*.ts so the",
  "// packaged frontend build compiles when no Convex deployment is configured in",
  "// this checkout.",
  "//",
  "// A real deployment should be pointed at by VITE_CONVEX_URL at runtime. When",
  "// that env is empty/invalid the app degrades gracefully (the player store and",
  "// Convex client calls are all wrapped in try/catch and fall through to",
  "// alternate paths where applicable).",
  "//",
  "// Regenerate with the real Convex CLI (`npx convex codegen`) when a deployment",
  "// is available; do not hand-edit.",
  "",
  'import type { FunctionReference, FunctionReturnType } from "convex/server";',
  "",
  "// The generated API value is typed as `any` so Convex's typed hooks",
  "// (useQuery/useAction/useMutation) accept it and Convex query results are",
  "// `any` without a live deployment. The member list below is informational.",
  "export const api: any = {};",
  "export type AnyApi = any;",
  "type ApiShape = any;",
  "",
  "// The members below are informational only; the value is typed as any.",
);
for (const { mod, defs } of shape) {
  if (defs.length === 0) {
    lines.push(`// ${mod}: (no exported callables detected)`);
    continue;
  }
  const summary = defs.map((d) => `${d.name}:${d.kind}`).join(", ");
  lines.push(`// ${mod}: { ${summary} }`);
}
lines.push("");

fs.writeFileSync(OUT_FILE, lines.join("\n"));
console.log("wrote", OUT_FILE, "with", shape.length, "modules");
