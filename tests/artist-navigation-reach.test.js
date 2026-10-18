import { describe, expect, test } from "bun:test";
import { readSource } from "./helpers/tailwind-css.js";
import { artistPath } from "../src/lib/artistLinks.ts";

const main = readSource("src/main.tsx");
const row = readSource("src/components/tracks/RemoteTrackRow.tsx");

// Comments explain the bug and necessarily name the function that caused it,
// so every assertion here runs against code with comments stripped.
const code = main.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the app can never reload itself out from under the listener", () => {
  test("no automatic reload runs on mount", () => {
    // This shipped as a "fix" and was itself the bug. `FreshBundleOnBoot`
    // called `location.replace` on any load where its sessionStorage flag was
    // absent. In a preview iframe that gets recreated, the flag resets, so it
    // reloaded again — and the app sat in a reload loop where no click ever
    // registered. It guarded against a stale module graph, which no longer
    // exists now that routes are statically imported, so it is gone entirely
    // rather than merely tuned.
    expect(code).not.toContain("FreshBundleOnBoot");
    expect(code).not.toContain("location.replace");
    expect(code).not.toContain("synq:fresh-boot");
    expect(code).not.toContain('searchParams.set("_cb"');
  });

  test("the only reload left is the explicit one the listener asks for", () => {
    // A button press is fine; a timer or a mount effect is not.
    const reloads = code.match(/location\.reload\(\)/g) ?? [];
    expect(reloads).toHaveLength(1);
    expect(main).toContain("Reload SYNQ");
    expect(main).toMatch(/onClick=\{\(\) => window\.location\.reload\(\)\}/);
  });

  test("nothing in the app re-renders the page on a timer", () => {
    // A self-refresh loop can also come from a repeating effect.
    expect(code).not.toMatch(/setInterval\([^)]*location/);
    expect(code).not.toMatch(/setTimeout\([^)]*location\.reload/);
  });
});

describe("artist links exist on every surface a listener meets one", () => {
  test("list rows link the artist, not just render it as text", () => {
    // Search results and the queue are RemoteTrackRow. The artist name here
    // was the one place with no way through to the artist page at all.
    expect(row).toContain("const artistHref = artistPath(artistName)");
    expect(row).toContain("to={artistHref}");
  });

  test("the row link never triggers the row's own play action", () => {
    expect(row).toContain("onClick={(event) => event.stopPropagation()}");
  });

  test("an unusable artist name falls back to plain text", () => {
    // artistPath returns null for "Unknown artist" and blanks, so the line
    // must still render rather than producing a link to nowhere.
    expect(row).toContain("{artistHref ? (");
    expect(artistPath("Unknown artist")).toBeNull();
    expect(artistPath("")).toBeNull();
    expect(artistPath("   ")).toBeNull();
  });
});
