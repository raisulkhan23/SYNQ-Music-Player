import { describe, expect, test } from 'vitest';
import { readSource } from "./helpers/tailwind-css.js";

const storeSource = readSource("src/store/player.ts");
const volumeSource = readSource("src/components/player/VolumeControl.tsx");
const sleepSource = readSource("src/lib/sleepTimer.ts");
const fullscreenSource = readSource(
  "src/components/player/FullscreenPlayer.tsx",
);
const likedSource = readSource("src/pages/Liked.tsx");
const playlistSource = readSource("src/pages/PlaylistDetail.tsx");

describe("queue mutations survive a reload", () => {
  test("undoing a removal persists the restored queue", () => {
    // Removing a track persisted the new queue, but the undo only touched
    // memory. The track reappeared in the UI and vanished again on the next
    // reload, so "Undo" looked like it had half-worked.
    const undo = storeSource.slice(
      storeSource.indexOf("undoRemoveFromQueue: () =>"),
      storeSource.indexOf("insertInQueue: (track, index)"),
    );
    expect(undo).toContain("saveQueue(queue, queueIndex");
  });
});

describe("volume can be raised again while muted", () => {
  test("the slider shows the real volume, not a forced zero", () => {
    // Pinning the slider to 0 while muted meant that dragging it wrote 0 into
    // the store: the thumb snapped back and the user could not turn the sound
    // up without pressing the mute button first.
    expect(volumeSource).toMatch(/value=\{\[volume\]\}/);
    expect(volumeSource).not.toMatch(/value=\{\[muted/);
    // Unmuting still happens, but only when the user actually asks for sound.
    expect(volumeSource).toMatch(/if \(muted && v > 0\) toggleMute\(\);/);
    // The icon is what reports the muted state.
    expect(volumeSource).toMatch(
      /muted \|\| volume === 0 \s*\?\s*VolumeX : volume < 0\.5 \?\s*Volume1 : Volume2/,
    );
  });
});

describe("the sleep countdown cannot drift", () => {
  test("remaining time is recomputed every second", () => {
    // The countdown seeded `now` once at mount and only re-rendered when the
    // SECOND changed, so the label could lag behind the real remaining time —
    // and the 250ms interval kept firing renders four times a second for the
    // whole life of the timer.
    // The hook moved to src/lib/sleepTimer.ts when the player bar grew its
    // own countdown; the regression is about the hook, not where it lives.
    const hook = sleepSource.slice(
      sleepSource.indexOf("export function useSleepCountdown"),
      sleepSource.length,
    );
    expect(hook).toMatch(
      /setInterval\(\(\) => setNow\(Date\.now\(\)\), 1000\)/,
    );
    // The interval is torn down when the timer changes or is cleared.
    expect(hook).toMatch(/clearInterval\(id\)/);
    // Every surface that counts down shares this one implementation.
    expect(fullscreenSource).toMatch(
      /import \{ formatRemaining, useSleepCountdown \} from "@\/lib\/sleepTimer"/,
    );
  });
});

describe("the page-level shuffle buttons are safe on empty input", () => {
  test("liked songs cannot index past the end of the list", () => {
    // `totalCount` is `remoteLikes.length`, so the pick was safe today, but the
    // handler read fields off the result unguarded. The guard is on the array
    // actually being indexed, so an empty list is a no-op rather than a throw
    // inside a click handler (which the user sees as a dead button).
    const shuffle = likedSource.slice(
      likedSource.indexOf("const shuffleAll = () =>"),
      likedSource.indexOf("const total = totalSeconds"),
    );
    expect(shuffle).toContain("remoteLikes[Math.floor(");
    expect(shuffle).toMatch(/if \(!row\) return;/);
    // The button orders its own queue. It must not touch the app's shuffle
    // preference: that is a sticky, persisted mode, so a page button flipping
    // it left every other list playing in random order afterwards.
    expect(likedSource).not.toMatch(/startShuffle\(\)/);
    expect(likedSource).not.toMatch(/\.toggleShuffle\(\)/);
    expect(likedSource).toContain("playListOrdered");
  });

  test("playlists guard the fallback branch too", () => {
    // Only the direct-queue branch had a candidate check; the rows branch
    // indexed an array whose length was never tested, so an unresolved
    // playlist threw instead of doing nothing.
    const shuffle = playlistSource.slice(
      playlistSource.indexOf("const shuffleAll = () =>"),
      playlistSource.indexOf("const handleDelete"),
    );
    expect(shuffle).toMatch(/if \(rows\.length === 0\) return;/);
    expect(shuffle).toMatch(/if \(!candidate\) return;/);
    // Same rule as the Liked page: shuffle this queue, not the app setting.
    expect(shuffle).not.toMatch(/startShuffle\(\)/);
    expect(shuffle).not.toMatch(/\.toggleShuffle\(\)/);
    expect(shuffle).toContain("playListOrdered");
  });
});
