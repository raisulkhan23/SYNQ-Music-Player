import { describe, expect, test } from 'vitest';
import { readSource } from "./helpers/tailwind-css.js";

/**
 * Assorted "random stuff breaks" fixes.
 *
 * Each block is one defect found by reviewing the project, kept separate so a
 * future change that reintroduces any of them fails loudly.
 */

const playerBar = readSource("src/components/player/PlayerBar.tsx");
const fullscreen = readSource("src/components/player/FullscreenPlayer.tsx");
const probe = readSource("src/components/player/useIntroTrim.ts");
const social = readSource("src/convex/social.ts");
const schema = readSource("src/convex/schema.ts");
const admin = readSource("src/convex/admin.ts");

const tight = (s) => s.replace(/\s+/g, "");

/** The comment explaining a class of bug necessarily names the bug. */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

describe("the status chips cannot collide with the miniplayer", () => {
  test("the sleep chip is hidden on the mobile bar", () => {
    // The bar is a 68px island with `overflow-hidden`, and the chip is a wide
    // text pill. With the trim chip also on, the pair pushed the transport out
    // from under them.
    const chip = playerBar.slice(
      playerBar.indexOf("function SleepTimerChip()"),
      playerBar.indexOf("function IntroTrimChip()"),
    );
    expect(chip).toMatch(/hidden[^\n]*\bsm:flex/);
  });

  test("every trim state is hidden on the mobile bar", () => {
    const chip = playerBar.slice(
      playerBar.indexOf("function IntroTrimChip()"),
      playerBar.indexOf("function ReadingSessionNav()"),
    );
    const hidden = chip.match(/hidden[^\n]*\bsm:flex/g) ?? [];
    // Four states now: trimmed + undo, trim off (icon turns it on), on but
    // past the intro, and the live skip. The icon is always present so the
    // control cannot appear to have been deleted, but every one of them still
    // yields to the 68px mobile island, which has its own home for this in the
    // fullscreen player.
    expect(hidden.length).toBe(4);
    // The point of the assertion: no state may be a bare always-visible pill.
    const unconditional = chip.match(/className="flex shrink-0/g) ?? [];
    expect(unconditional).toHaveLength(0);
  });

  test("neither chip may be a bare, always-visible pill", () => {
    const chip = playerBar.slice(
      playerBar.indexOf("function IntroTrimChip()"),
      playerBar.indexOf("function ReadingSessionNav()"),
    );
    expect(chip).not.toMatch(/className="flex shrink-0/);
  });

  test("the trim chip is icon-only, never a text pill", () => {
    // The bar is the one row with no horizontal slack. "Skip intro" and
    // "Trimmed 12s" were wide enough to squeeze the transport controls and
    // jam the layout, so the visible text is gone from the bar. The fullscreen
    // player keeps its labels — it has the room.
    const chip = stripComments(
      playerBar.slice(
        playerBar.indexOf("function IntroTrimChip()"),
        playerBar.indexOf("function ReadingSessionNav()"),
      ),
    );
    expect(chip).not.toContain("Skip intro");
    expect(chip).not.toMatch(/Trimmed \{formatSkipped/);
    // ...and the affordance is still named for pointer and screen-reader users.
    expect(chip).toContain('aria-label="Skip ahead past a slow intro"');
  });

  test("the fullscreen player keeps both controls, so nothing is lost", () => {
    expect(fullscreen).toContain("function IntroTrimControl()");
    expect(fullscreen).toContain("<IntroTrimControl />");
    expect(fullscreen).toContain("skipIntro()");
    expect(fullscreen).toContain("undoIntroTrim()");
  });

  test("the fullscreen control can also turn the setting on", () => {
    // A phone user who never opens Settings still needs to reach it.
    expect(fullscreen).toContain("toggleIntroTrim()");
  });
});

describe("the intro-trim probe does not churn audio resources", () => {
  test("it never builds the Web Audio graph itself", () => {
    // `createMediaElementSource` permanently reroutes the shared audio
    // element, and an effect has no user gesture to justify that. The graph is
    // built where the click happens.
    expect(probe).not.toContain("ensureGraph()");
  });

  test("it stops the timer once the analyser stays unavailable", () => {
    // `ensureGraph` resets its context to null on failure, so retrying from a
    // 250ms timer churned AudioContexts for the whole track.
    const tick = probe.slice(probe.indexOf("const level = getSignalLevel()"));
    expect(tick).toContain("window.clearInterval(timer)");
    expect(tick).toContain("GRAPH_GRACE_MS");
  });

  test("the user is told once, not every tick", () => {
    expect(probe).toContain("if (!warned)");
    expect(probe).toContain('id: "intro-trim-graph"');
  });
});

describe("listening rooms cannot pile up forever", () => {
  test("rooms were only ever deleted on an explicit leave", () => {
    // Closing a tab is not leaving, so every abandoned room survived and
    // `listRooms` collected the whole table on every refresh.
    expect(social).toContain("export const ROOM_STALE_MS");
    expect(social).toContain("export const ROOM_SCAN_LIMIT");
  });

  test("the directory is bounded and index-filtered", () => {
    const fn = social.slice(
      social.indexOf("export const listRooms"),
      social.indexOf("export const createRoom"),
    );
    expect(fn).toContain('.withIndex("by_updatedAt"');
    expect(fn).toContain('q.gte("updatedAt", cutoff)');
    expect(fn).toContain("ROOM_SCAN_LIMIT");
    expect(fn).toContain("ROOM_LIST_LIMIT");
    // An unbounded collect is exactly what this replaced.
    expect(fn).not.toMatch(/\.collect\(\)/);
  });

  test("the schema has the index the query relies on", () => {
    expect(schema).toContain('.index("by_updatedAt", ["updatedAt"])');
  });

  test("empty rooms are filtered and reclaimed", () => {
    const list = social.slice(
      social.indexOf("export const listRooms"),
      social.indexOf("export const createRoom"),
    );
    expect(list).toContain("(r.members ?? []).length > 0");
    const create = social.slice(
      social.indexOf("export const createRoom"),
      social.indexOf("export const joinRoom"),
    );
    expect(create).toContain("ctx.db.delete(room._id)");
  });

  test("the table is capped so it cannot run away", () => {
    expect(social).toContain("export const ROOM_HARD_LIMIT");
    const create = social.slice(
      social.indexOf("export const createRoom"),
      social.indexOf("export const joinRoom"),
    );
    expect(create).toContain("live.length >= ROOM_HARD_LIMIT");
  });
});

describe("the admin panel cannot fall off a cliff", () => {
  test("no admin view does an unbounded collect any more", () => {
    // Convex enforces a read budget, so a bare `.collect()` meant the whole
    // panel — and the accounts list behind the CSV export — stopped loading.
    const bare =
      admin.match(/ctx\.db\.query\("[a-zA-Z]+"\)\.collect\(\)/g) ?? [];
    expect(bare).toEqual([]);
  });

  test("every scan goes through the bounded reader", () => {
    expect(admin).toContain("export const ADMIN_SCAN_LIMIT = 2000");
    expect(tight(admin)).toContain(
      "functionscanAll<T>(reader:{take:(n:number)=>Promise<T[]>;}):Promise<T[]>{",
    );
    const calls = admin.match(/scanAll\(ctx\.db\.query\(/g) ?? [];
    expect(calls.length).toBeGreaterThan(15);
  });

  test("per-user activity is tallied in one pass, not one pass per user", () => {
    const start = admin.indexOf("export const userActivity");
    // Slice to the end of this function, and drop comments first: the
    // explanatory comment quotes the old `history.filter(...).reduce(...)`
    // form, so a naive substring check matches the fix's own description.
    const fn = admin.slice(start, admin.indexOf("\n});", start));
    const flat = tight(
      fn.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""),
    );
    // The nested form was O(users x rows) — the page crawled to a halt.
    expect(flat).not.toContain("likes.filter(");
    expect(flat).not.toContain("playlists.filter(");
    expect(flat).not.toContain("history.filter(");
    expect(flat).not.toContain("lastPlayedAt:history");
    expect(flat).toContain("constlikeCount=newMap");
    expect(flat).toContain("constplaylistCount=newMap");
    expect(flat).toContain("constplayCount=newMap");
    expect(flat).toContain("constlastPlayedAt=newMap");
    expect(flat).toContain("likes:likeCount.get(u._id)??0");
    expect(flat).toContain("playlists:playlistCount.get(u._id)??0");
    expect(flat).toContain("plays:playCount.get(u._id)??0");
    expect(flat).toContain("lastPlayedAt:lastPlayedAt.get(u._id)??0");
  });
});

describe("layout guards", () => {
  test("the player bar's right cluster is a distinct, non-shrinking block", () => {
    // `overflow-hidden` on the footer means anything wider than the bar is
    // simply cut off, which reads as a broken control rather than a layout
    // problem.
    const match =
      /<div className="relative z-10 flex w-auto shrink-0 items-center justify-end[^"]*"/.exec(
        playerBar,
      );
    expect(match).not.toBeNull();
    expect(match[0]).toContain("shrink-0");
  });

  test("the mobile footer clips its overflow", () => {
    // Documents why the chips have to be hidden rather than merely narrowed.
    const footer = playerBar.slice(
      playerBar.indexOf("mobile-player liquid-glass"),
    );
    expect(footer.slice(0, 2000)).toContain("overflow-hidden");
  });
});
