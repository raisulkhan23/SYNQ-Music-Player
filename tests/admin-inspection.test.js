import { describe, expect, test } from "bun:test";
import { readSource } from "./helpers/tailwind-css.js";

/**
 * The admin surface has to be usable by the person running it.
 *
 * Two defects, both of the same kind: the backend was returning the data and
 * the page was not showing it. "Most played across the deployment" rendered a
 * wall of raw track ids (`wpKqN3Ny_P0`), which an admin cannot act on, search
 * for or recognise — and the playlists table gave a track COUNT with no way to
 * see the contents at all, so handling a report or a copyright complaint meant
 * asking the user to screenshot their playlist.
 *
 * The snapshots needed for both already existed in the database. `playHistory`
 * carries optional title/artistName/coverUrl, and `playlists` carries optional
 * `trackSnapshots`. Nothing was reading them.
 */

const adminSrc = readSource("src/convex/admin.ts");
const page = readSource("src/pages/Admin.tsx");

const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

const adminCode = stripComments(adminSrc);
const pageCode = stripComments(page);

function bodyOf(code, name) {
  const start = Math.max(
    code.indexOf(`\nfunction ${name}(`),
    code.indexOf(`\nasync function ${name}(`),
  );
  if (start === -1) throw new Error(`no top-level function ${name}`);
  const next = code.indexOf("\nfunction ", start + 1);
  const altNext = code.indexOf("\nasync function ", start + 1);
  const ends = [next, altNext].filter((i) => i !== -1);
  return code.slice(start, ends.length ? Math.min(...ends) : code.length);
}

/**
 * Body of one `export const name = query({...})` / `mutation({...})`.
 *
 * Convex functions are object literals assigned to a const, not declarations,
 * so they need their own extractor. Bounded by the next top-level `export` so
 * a missing match yields a loud throw rather than a silently empty string —
 * which is how a test starts asserting on nothing.
 */
function convexFn(code, name) {
  const start = code.indexOf(`export const ${name} = `);
  if (start === -1) throw new Error(`no exported Convex function ${name}`);
  const next = code.indexOf("\nexport const ", start + 1);
  return code.slice(start, next === -1 ? code.length : next);
}

describe("most-played tracks are named, not identified by id", () => {
  const q = convexFn(adminCode, "globalTopTracks");
  expect(q.length).toBeGreaterThan(200);

  test("the query still tallies plays and distinct listeners per track", () => {
    expect(q).toMatch(/entry\.plays \+= h\.playCount;/);
    expect(q).toMatch(/entry\.listeners\.add\(h\.userId\);/);
    expect(q).toMatch(/listeners: v\.listeners\.size/);
  });

  test("it returns the title alongside the id", () => {
    // This is the whole fix: the id was already there, the name was not.
    expect(q).toMatch(/title: v\.title,/);
    expect(q).toMatch(/artistName: v\.artistName,/);
  });

  test("a missing title stays null rather than being invented", () => {
    // playHistory's snapshot fields are optional and genuinely absent on rows
    // written before they existed. Reporting null is honest; substituting the
    // id as if it were a name would not be.
    expect(q).toMatch(/title: string \| null;/);
    expect(q).toMatch(/title: null,/);
  });

  test("the newest snapshot for a track wins", () => {
    // A track first played before titles were recorded still resolves as soon
    // as anyone replays it, instead of staying anonymous forever.
    expect(q).toMatch(/if \(h\.title\) \{/);
    expect(q).toMatch(/entry\.title = h\.title;/);
  });

  test("it stays admin-only", () => {
    expect(q).toMatch(/await getAdminUser\(ctx\);/);
  });

  test("the page renders the title, not the raw id", () => {
    const list = pageCode.slice(
      pageCode.indexOf("Most played across the deployment"),
      pageCode.indexOf('TabsContent value="insights"'),
    );
    expect(list).toMatch(/\{t\.title \?\? \(/);
    // The exact broken markup: the id was the entire label.
    expect(list).not.toMatch(
      /className="min-w-0 flex-1 truncate">\{t\.trackId\}/,
    );
    // The id now appears in exactly two places: the React key, and inside the
    // explicit no-title fallback. A third would mean it is being rendered as
    // a label again.
    const idUsages = list.match(/\{t\.trackId\}/g) ?? [];
    expect(idUsages).toHaveLength(2);
    expect(list).toMatch(/key=\{t\.trackId\}/);
    expect(list).toMatch(/title not recorded/);
  });

  test("the artist is shown next to the title when known", () => {
    const list = pageCode.slice(
      pageCode.indexOf("Most played across the deployment"),
      pageCode.indexOf('TabsContent value="insights"'),
    );
    expect(list).toMatch(/t\.title && t\.artistName/);
    expect(list).toMatch(/\{t\.artistName\}/);
  });
});

describe("admins can read a playlist's contents", () => {
  const q = convexFn(adminCode, "playlistDetail");
  expect(q.length).toBeGreaterThan(200);

  test("a detail query exists and is admin-only", () => {
    expect(adminSrc).toMatch(/export const playlistDetail = query\(\{/);
    expect(q).toMatch(/await getAdminUser\(ctx\);/);
    expect(q).toMatch(/args: \{ playlistId: v\.id\("playlists"\) \}/);
  });

  test("a missing playlist is an error, not an empty list", () => {
    // An admin who opened a row that has since been deleted should be told,
    // not shown a plausible-looking empty playlist.
    expect(q).toMatch(/throw new ConvexError\("Playlist not found"\);/);
  });

  test("it returns the owner, so the row is self-contained", () => {
    expect(q).toMatch(/const owner = await ctx\.db\.get\(playlist\.userId\);/);
    expect(q).toMatch(/ownerName: owner\?\.name \?\? null,/);
    expect(q).toMatch(/ownerEmail: owner\?\.email \?\? null,/);
  });

  test("it returns every track in order, not a sample", () => {
    // An inspection that silently capped the list would read as "that is
    // everything in the playlist" and be wrong.
    expect(q).toMatch(/playlist\.trackIds\.map\(\(trackId, i\) =>/);
    expect(q).toMatch(/tracks,/);
  });

  test("it reads the playlist's own snapshots rather than re-deriving them", () => {
    expect(q).toMatch(/const snapshots = playlist\.trackSnapshots \?\? \[\];/);
    expect(q).toMatch(/title: snap\?\.title \?\? null,/);
    expect(q).toMatch(/artist: snap\?\.artist \?\? null,/);
  });

  test("it indexes defensively instead of assuming the arrays line up", () => {
    // A playlist edited by an older client can have more ids than snapshots.
    // Zipping them by index without a guard mislabels every track after the
    // first missing one.
    expect(q).toMatch(/const snap = snapshots\[i\];/);
    expect(q).toMatch(/known: snap !== undefined,/);
  });

  test("it reports how many tracks it could actually identify", () => {
    // "40 tracks, 32 identified" is the honest answer, and usually the
    // interesting part of a moderation question.
    expect(q).toMatch(
      /knownTracks: tracks\.filter\(\(t\) => t\.known\)\.length,/,
    );
  });

  test("it does not resolve streams or start playback", () => {
    // Inspection is reading, not listening. Resolving a stream or calling
    // playIndex would write to the admin's own history and queue.
    expect(q).not.toMatch(/ytResolve|resolveStream|playIndex/);
    expect(page).toMatch(/function PlaylistInspector/);
  });
});

describe("the inspection UI is reachable and honest", () => {
  test("each playlist row offers an Inspect action", () => {
    expect(page).toMatch(
      /aria-label=\{`Inspect the tracks in \$\{playlist\.name\}`\}/,
    );
    expect(page).toMatch(/onClick=\{\(\) => setInspecting\(playlist\._id\)\}/);
  });

  test("the query is skipped rather than run with a null id", () => {
    // A null id would be a Convex argument error on every render of the page.
    expect(page).toMatch(
      /useQuery\(\s*api\.admin\.playlistDetail,\s*inspecting \? \{ playlistId: inspecting \} : "skip",\s*\)/,
    );
  });

  test("the inspector renders nothing until a playlist is opened", () => {
    const c = bodyOf(pageCode, "PlaylistInspector");
    expect(c).toMatch(/if \(detail === undefined\) return null;/);
  });

  test("it shows the track count, the owner and the numbers", () => {
    const c = bodyOf(pageCode, "PlaylistInspector");
    expect(c).toMatch(
      /detail\.ownerName \?\? detail\.ownerEmail \?\? "Unknown owner"/,
    );
    expect(c).toMatch(/\{detail\.tracks\.length\}/);
    expect(c).toMatch(/track\.title \?\? \(/);
  });

  test("tracks with no saved details are labelled, not blank", () => {
    // A blank cell would read as "the admin has nothing", not "this playlist
    // entry has no metadata".
    const c = bodyOf(pageCode, "PlaylistInspector");
    expect(c).toMatch(/details not saved/);
    expect(c).toMatch(/\{track\.artist \?\? "--"\}/);
  });

  test("the count of unidentified tracks is surfaced", () => {
    const c = bodyOf(pageCode, "PlaylistInspector");
    expect(c).toMatch(
      /const unknown = detail\.tracks\.length - detail\.knownTracks;/,
    );
    expect(c).toMatch(/without saved details/);
  });

  test("an empty playlist says so instead of rendering a bare table", () => {
    const c = bodyOf(pageCode, "PlaylistInspector");
    expect(c).toMatch(/This playlist is empty\./);
  });

  test("it can be closed", () => {
    const c = bodyOf(pageCode, "PlaylistInspector");
    expect(c).toMatch(/onClick=\{onClose\}/);
    expect(page).toMatch(/onClose=\{\(\) => setInspecting\(null\)\}/);
  });

  test("a length is only claimed when one is known", () => {
    // A missing duration must not render as "0:00", which reads as a real
    // zero-length track.
    const f = bodyOf(pageCode, "formatTrackDuration");
    expect(f).toMatch(/return "--:--";/);
  });
});
