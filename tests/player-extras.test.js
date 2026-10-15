import { describe, expect, test } from 'vitest';
import { readSource } from "./helpers/tailwind-css.js";

const bar = readSource("src/components/player/PlayerBar.tsx");
const fullscreen = readSource("src/components/player/FullscreenPlayer.tsx");
const sleep = readSource("src/lib/sleepTimer.ts");
const shell = readSource("src/components/layout/AppShell.tsx");
const settings = readSource("src/components/settings/SettingsDialog.tsx");
const me = readSource("src/convex/me.ts");
const download = readSource("src/lib/download.ts");

describe("the sleep timer is visible and cancellable from the bar", () => {
  test("the countdown lives in one shared module", () => {
    // It used to sit inside the fullscreen player, so the timer was invisible
    // everywhere else — including on the phone layout, where the bar is the
    // only chrome.
    expect(sleep).toMatch(
      /export function formatRemaining\(ms: number\): string/,
    );
    expect(sleep).toMatch(
      /export function useSleepCountdown\(sleepEndsAt: number \| null\): number/,
    );
    expect(fullscreen).toMatch(
      /import \{ formatRemaining, useSleepCountdown \} from "@\/lib\/sleepTimer"/,
    );
    expect(fullscreen).not.toMatch(/^function useSleepCountdown/m);
  });

  test("the countdown ticks once a second, not four times", () => {
    expect(sleep).toMatch(
      /setInterval\(\(\) => setNow\(Date\.now\(\)\), 1000\)/,
    );
  });

  test("the chip shows the remaining time and offers a cancel", () => {
    expect(bar).toMatch(/<SleepTimerChip \/>/);
    expect(bar).toMatch(/aria-label="Cancel sleep timer"/);
    expect(bar).toMatch(/setSleepTimer\(null\)/);
    // Nothing on screen when no timer is armed — including the queue-end arm,
    // which is a third way to have a timer running with no countdown.
    expect(bar).toMatch(
      /if \(sleepEndsAt === null && !sleepAtSongEnd && !sleepAtQueueEnd\) return null;/,
    );
  });

  test("'after this song' reads as a state, not a missing countdown", () => {
    expect(bar).toMatch(/"end of song"/);
  });

  test("the settings preset highlight follows the ticking clock", () => {
    // It compared against a Date.now() captured during render, so a timer that
    // counted down into the next bucket kept the old button lit.
    expect(settings).toMatch(
      /const sleepNow = useSleepCountdown\(sleepEndsAt\);/,
    );
    expect(settings).toMatch(/sleepEndsAt - sleepNow >/);
    expect(settings).not.toMatch(/sleepEndsAt - Date\.now\(\)/);
  });
});

describe("the artist in the bar is a way into more of the same", () => {
  test("tapping it searches that artist", () => {
    expect(bar).toMatch(/\/search\?q=\$\{encodeURIComponent\(/);
    // `artistSearchQuery` wraps `cleanArtistName` with a fallback: the raw
    // cleaner returns "Unknown artist" for placeholder names, which used to
    // send the tap to an empty search that read as a broken button.
    expect(bar).toMatch(
      /artistSearchQuery\(current\?\.artistName, current\?\.title\)/,
    );
  });

  test("it is a real button, not decorative text", () => {
    expect(bar).toMatch(/hover:underline/);
    expect(bar).toMatch(/const navigate = useNavigate\(\);/);
  });
});

describe("a listener can take their data with them", () => {
  test("the export is scoped to the caller's own account", () => {
    // A data export must never be able to reach another account's rows.
    const calls = me.match(
      /withIndex\("by_user", \(q\) => q\.eq\("userId", userId\)\)/g,
    );
    expect(calls?.length).toBe(4);
    expect(me).toMatch(/const userId = await getAuthUserId\(ctx\);/);
    expect(me).toMatch(/if \(userId === null\) return null;/);
  });

  test("it carries the four things a listener would miss", () => {
    for (const key of [
      "profile:",
      "likes:",
      "likedRemote:",
      "playlists:",
      "history:",
    ]) {
      expect(me).toContain(key);
    }
  });

  test("remote likes keep their metadata, not just ids", () => {
    // A library of bare video ids is not a usable export.
    expect(me).toMatch(/likedRemote\.map\(\(l\) => \(\{/);
    expect(me).toMatch(/title: h\.title \?\? null/);
  });

  test("the JSON is pretty-printed and the row only mounts on demand", () => {
    expect(download).toMatch(/JSON\.stringify\(value, null, 2\)/);
    expect(settings).toMatch(/function DataExportRow\(/);
    // Opening Settings must not fire the query for everyone.
    expect(settings).toMatch(
      /\{exporting \? \(\s*\n\s*<DataExportRow onDone=\{\(\) => setExporting\(false\)\} \/>/,
    );
  });
});

describe("the player tells a screen reader what is playing", () => {
  test("a polite live region announces track and transport changes", () => {
    expect(shell).toMatch(/<NowPlayingAnnouncer \/>/);
    expect(shell).toMatch(/aria-live="polite"/);
    expect(shell).toMatch(/aria-atomic="true"/);
    expect(shell).toMatch(
      /`\$\{isPlaying \? "Playing" : "Paused"\}: \$\{current\.title\} by \$\{current\.artistName\}`/,
    );
  });

  test("it is invisible and silent when nothing is playing", () => {
    expect(shell).toMatch(/: "";/);
    expect(shell).toMatch(/className="sr-only"/);
  });
});
