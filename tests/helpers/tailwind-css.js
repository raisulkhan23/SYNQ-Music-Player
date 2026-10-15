import fs from "node:fs";
import path from "node:path";
import { compile } from "tailwindcss";
import { transform } from "lightningcss";

// `import.meta.dirname` (Node ≥20.11 / vitest), NOT `import.meta.dir`, which
// only exists in Bun — reading it here made every path join throw
// "The \"paths[0]\" argument must be of type string. Received undefined".
const root = path.resolve(import.meta.dirname, "..", "..");

/** Compiles candidate class names through the project's real Tailwind build and
 *  returns the emitted CSS. `build([])` emits nothing, so an empty result
 *  genuinely means "these utilities do not exist" — the license comment that
 *  `build()` always returns is filtered out by matching declarations only.
 *
 *  `loadStylesheet` is REQUIRED: `src/index.css` starts with
 *  `@import "tailwindcss"`, and without a resolver `compile()` throws
 *  "No `loadStylesheet` function provided to `compile`" before any utility is
 *  considered.
 *
 *  Deliberately NOT wrapped in try/catch. An earlier version returned `""`
 *  from a catch, which turned every failure of this helper into "the class does
 *  not exist" — so a broken resolver read as six passing-looking assertions
 *  about the performance mode holding no CSS at all. A compile failure has to
 *  be loud. */
export async function compileClasses(candidates) {
  const compiler = await compile(
    fs.readFileSync(path.join(root, "src/index.css"), "utf8"),
    {
      base: root,
      loadStylesheet: async (id, baseDir) => {
        const target = id.startsWith(".")
          ? path.resolve(baseDir, id.replace(/^\.\//, ""))
          : path.join(root, "node_modules", id, "index.css");
        if (!fs.existsSync(target)) {
          return { path: target, base: path.dirname(target), content: "" };
        }
        return {
          path: target,
          base: path.dirname(target),
          content: fs.readFileSync(target, "utf8"),
        };
      },
    },
  );
  return transform({
    filename: "out.css",
    code: Buffer.from(compiler.build(candidates)),
    minify: true,
  }).code.toString();
}

/** Read a project source file as text, with LF line endings.
 *
 * The normalisation is the point. This checkout has CRLF in every tracked
 * source file (`core.autocrlf`), while assertions are written the way a person
 * reads the code: `/cycleShuffle,\n/`. Against CRLF that pattern never matches,
 * because there is a `\r` between the comma and the newline — so a source-shape
 * test fails for the line endings the file happens to be checked out with,
 * which tells nobody anything about SYNQ. Normalising to LF here keeps those
 * assertions about the code and not about the checkout. */
export function readSource(rel) {
  const p = path.join(root, rel);
  try {
    return fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  } catch (e) {
    throw new Error(`readSource(${rel}) failed: ${e.message}`);
  }
}
