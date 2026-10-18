import fs from "node:fs";
import path from "node:path";
import { compile } from "tailwindcss";
import { transform } from "lightningcss";

const root = path.resolve(import.meta.dir, "..", "..");

/** Compiles candidate class names through the project's real Tailwind build and
 *  returns the emitted CSS. `build([])` emits nothing, so an empty result
 *  genuinely means "these utilities do not exist" — the license comment that
 *  `build()` always returns is filtered out by matching declarations only. */
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

export function readSource(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

export { root };
