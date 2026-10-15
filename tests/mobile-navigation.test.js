import { describe, expect, test } from 'vitest';
import { readSource } from "./helpers/tailwind-css.js";

const shell = readSource("src/components/layout/AppShell.tsx");
const sidebar = readSource("src/components/layout/Sidebar.tsx");
const more = readSource("src/components/layout/MobileMoreMenu.tsx");
const playlists = readSource("src/pages/Playlists.tsx");
const social = readSource("src/pages/Social.tsx");
const css = readSource("src/index.css");

const flatMore = more.replace(/\s+/g, " ");
const flatPlaylists = playlists.replace(/\s+/g, " ");

// Every destination the `lg:`-only sidebar can reach. These are exactly the
// routes a phone listener had no way to open before the More sheet existed.
const SIDEBAR_ONLY_ROUTES = [
  "/liked",
  "/recent",
  "/social",
  "/stats",
  "/admin",
];

describe("mobile overflow navigation", () => {
  test("the phone bottom bar still has exactly four items", () => {
    const block = shell.slice(
      shell.indexOf("const MOBILE_NAV"),
      shell.indexOf("const DEFAULT_TINT"),
    );
    const entries = block.match(/to: "\/[^"]+"/g) ?? [];
    expect(entries).toHaveLength(4);
  });

  test("the bottom nav is still a four-column grid in CSS", () => {
    // The layout-critical grid is owned by index.css, not by inline styles or
    // utilities. The More sheet lives in the top bar, so the column count
    // must NOT have changed — a 5th bottom item would need a CSS edit here
    // and would shrink every tap target on a 360px phone.
    expect(css).toContain("grid-template-columns: repeat(4, minmax(0, 1fr))");
  });

  test("the More sheet is mounted in the mobile top bar, not the sidebar", () => {
    expect(shell).toContain("<MobileMoreMenu />");
    // It must live in the `lg:hidden` top bar, i.e. next to the Settings
    // button, so it disappears on desktop where the real sidebar is present.
    const topbar = shell.indexOf('className="mobile-topbar');
    const settings = shell.indexOf('aria-label="Settings"');
    const moreAt = shell.indexOf("<MobileMoreMenu />");
    expect(topbar).toBeGreaterThan(-1);
    expect(settings).toBeGreaterThan(topbar);
    expect(moreAt).toBeGreaterThan(topbar);
    expect(moreAt).toBeLessThan(settings);
    // And nowhere in the Sidebar component.
    expect(sidebar).not.toContain("MobileMoreMenu");
  });

  test("the More sheet is defined as its own component", () => {
    expect(more).toContain("export function MobileMoreMenu(");
    expect(more).toContain("SheetContent");
    expect(more).toContain('aria-label="More"');
  });

  test("the More sheet links every sidebar-only destination", () => {
    for (const route of SIDEBAR_ONLY_ROUTES) {
      // Four are table entries; /admin is a separately gated row, so accept
      // either shape — what matters is that the route string is reachable.
      expect(flatMore).toMatch(new RegExp(`(to: |go\\()"${route}"`));
    }
  });

  test("the More sheet keeps the labels the sidebar uses", () => {
    for (const label of [
      "Liked Songs",
      "Recently Played",
      "Listening Rooms",
      "Listening Stats",
    ]) {
      expect(flatMore).toContain(`label: "${label}"`);
    }
  });

  test("the admin row is gated on the same admin signal Profile uses", () => {
    // Unconditional, an admin panel link would be dead weight for everyone
    // else; and the gate must be the server-side status query, not a client
    // role the user could fake.
    expect(more).toContain("useQuery(api.admin.status)");
    expect(more).toContain("adminStatus !== null");
  });

  test("the More sheet closes before navigating", () => {
    // A sheet left open over the destination page traps the listener: the
    // nav bar sits underneath it and the next tap hits the overlay.
    expect(more).toMatch(
      /const go = \(to: string\) => \{\s*setOpen\(false\);\s*void navigate\(to\);/,
    );
  });

  test("the More sheet respects the phone safe areas", () => {
    expect(more).toContain("pt-[env(safe-area-inset-top)]");
    expect(more).toContain("pb-[env(safe-area-inset-bottom)]");
  });

  test("the More sheet marks itself active on its own destinations", () => {
    expect(flatMore).toContain(
      "EXTRA_DESTINATIONS.some((d) => d.to === location.pathname)",
    );
  });
});

describe("library page shortcuts", () => {
  test("the Library page links the destinations the grid used to hide", () => {
    for (const route of ["/recent", "/social", "/stats"]) {
      expect(flatPlaylists).toContain(`to: "${route}"`);
    }
  });

  test("the Library shortcuts are real links, not a dead-end row", () => {
    expect(playlists).toContain('import { Link } from "react-router"');
    expect(flatPlaylists).toContain("<Link key={to} to={to}");
  });

  test("Liked Songs is not duplicated in the shortcut row", () => {
    // It already has its own pinned card; a second entry is noise.
    const block = playlists.slice(
      playlists.indexOf("const LIBRARY_SHORTCUTS"),
      playlists.indexOf("export default function Playlists"),
    );
    expect(block).not.toContain('to: "/liked"');
    expect(playlists).toContain("<LikedSongsCard />");
  });

  test("the shortcut row reflows to one column on a phone", () => {
    expect(flatPlaylists).toContain(
      'className="grid grid-cols-1 gap-2 sm:grid-cols-3"',
    );
  });

  test("the shortcut row reflects the current route", () => {
    expect(playlists).toContain("useLocation");
    expect(flatPlaylists).toContain("location.pathname === to");
  });
});

describe("destination pages on small viewports", () => {
  test("the room-name input no longer overflows a 360px phone", () => {
    // `w-full max-w-xs` beside a button overran narrow viewports; the input
    // now takes the slack and the row wraps.
    expect(social).toContain('className="flex flex-wrap items-center gap-2"');
    expect(social).toContain("min-w-0 flex-1");
  });
});
