import { describe, expect, test } from 'vitest';
import { readSource } from "./helpers/tailwind-css.js";

const storeSource = readSource("src/store/player.ts");
const transportSource = readSource(
  "src/components/player/TransportControls.tsx",
);
const playerBarSource = readSource("src/components/player/PlayerBar.tsx");
const fullscreenSource = readSource(
  "src/components/player/FullscreenPlayer.tsx",
);
const shellSource = readSource("src/components/layout/AppShell.tsx");
const likedSource = readSource("src/pages/Liked.tsx");
const playlistSource = readSource("src/pages/PlaylistDetail.tsx");

describe("the shuffle button is a three-state cycle, like Spotify's", () => {
  test("one action owns off -> shuffle -> smart shuffle -> off", () => {
    // Smart shuffle used to be a second switch living in the queue panel and
    // Settings, so the mode that avoids repeats was invisible and had to be
    // hunted for. One control now cycles through all three states.
    expect(storeSource).toMatch(/const cycleShuffle = \(\) => \{/);
    expect(storeSource).toMatch(
      /\/\*\* Transport-button shuffle: off -> shuffle -> smart shuffle -> off\. \*\//,
    );

    // State 1: off -> plain shuffle. Nothing else moves.
    const body = storeSource.slice(
      storeSource.indexOf("const cycleShuffle = () => {"),
      storeSource.indexOf("const startShuffle = () => {"),
    );
    expect(body).toMatch(
      /if \(!s\.shuffle && !s\.smartShuffle\) \{\s*\n\s*toggleShuffle\(\);\s*\n\s*return;/,
    );
    // State 2: shuffle -> smart shuffle. This must NOT re-run the queue
    // reorder: the queue is already shuffled, and re-shuffling would throw away
    // the order the listener is part-way through.
    expect(body).toMatch(
      /if \(s\.shuffle && !s\.smartShuffle\) \{[\s\S]*?set\(\{ smartShuffle: true \}\);/,
    );
    // Bounded to the branch's OWN block (non-greedy up to its closing brace),
    // otherwise the pattern runs past it and matches the third branch's
    // legitimate toggleShuffle() instead of catching a real regression.
    expect(body).not.toMatch(
      /if \(s\.shuffle && !s\.smartShuffle\) \{\s*\n\s*toggleShuffle\(\);/,
    );
    // State 3: everything off, and the original queue order comes back. Only
    // this transition (and the first) may reorder, via the existing action.
    expect(body).toMatch(
      /toggleShuffle\(\);\s*\n\s*writeSetting\("ss\.smartShuffle", "0"\);\s*\n\s*set\(\{ smartShuffle: false \}\);/,
    );
    // Registered on the store, and the old two-mode action is gone.
    expect(storeSource).toMatch(/cycleShuffle: \(\) => void;/);
    expect(storeSource).toMatch(/\n\s*cycleShuffle,\n/);
    expect(storeSource).not.toContain("toggleShuffleSmart");
  });

  test("both the mini player and the maximized player use it", () => {
    // There is one TransportControls component, rendered by both surfaces, so
    // the button behaviour cannot differ between them.
    expect(transportSource).toMatch(
      /const cycleShuffle = usePlayerStore\(\(s\) => s\.cycleShuffle\);/,
    );
    expect(playerBarSource).toMatch(/<TransportControls/);
    expect(fullscreenSource).toMatch(/<TransportControls \/>/);
  });

  test("the second and third states are told apart", () => {
    // The toast and label wording itself is covered behaviourally in
    // tests/shuffle-state.test.js, against the one table both call sites
    // share. What matters here is that neither component hardcodes it again.
    expect(transportSource).toMatch(/shuffleState === "smart" &&/);
    expect(transportSource).toMatch(/sr-only">Smart shuffle on/);
  });

  test("the S shortcut runs the same cycle as the button", () => {
    // Two different actions behind one button and one key is exactly how the
    // button ends up showing a mode the queue is not in.
    expect(shellSource).toMatch(/s\.cycleShuffle\(\);/);
    expect(shellSource).not.toMatch(/s\.toggleShuffleSmart\(\);/);
  });

  test("page-level shuffle buttons shuffle the list, not the app setting", () => {
    // "Shuffle" on the Liked Songs or a playlist page is an ACTION: it starts
    // a shuffled session. It used to reach for the app's global preference,
    // which is a sticky, persisted mode — one press left shuffle on and every
    // other list played in random order afterwards. Each page now orders its
    // own queue and leaves the preference exactly as the listener set it.
    expect(storeSource).toMatch(/const startShuffle = \(\) => \{/);
    expect(storeSource).toMatch(
      /const startShuffle = \(\) => \{\s*\n\s*if \(get\(\)\.shuffle\) return;\s*\n\s*toggleShuffle\(\);/,
    );
    // It leaves smart shuffle exactly as the listener set it.
    const start = storeSource.slice(
      storeSource.indexOf("const startShuffle = () => {"),
      storeSource.indexOf("const toggleSmartShuffle = () => {"),
    );
    expect(start).not.toContain("smartShuffle");

    for (const [name, source] of [
      ["liked", likedSource],
      ["playlist", playlistSource],
    ]) {
      expect(source).not.toMatch(/startShuffle\(\)/);
      expect(source).not.toMatch(/cycleShuffle\(\)/);
      expect(source).not.toMatch(/toggleShuffleSmart/);
      // …and the shuffle is real: the queue is reordered before it is handed
      // over, then played through the ordered entry point.
      expect(source).toMatch(/shuffleList\(/);
      expect(source).toMatch(/playListOrdered/);
      expect(name).toBeTruthy();
    }
  });
});
