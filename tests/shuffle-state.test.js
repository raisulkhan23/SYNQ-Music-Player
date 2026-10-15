import { describe, expect, test } from 'vitest';
import {
  nextShuffleState,
  shuffleLabelFor,
  shuffleStateOf,
  shuffleToastFor,
} from "../src/lib/shuffleState";
import { readSource } from "./helpers/tailwind-css.js";

const transportSource = readSource(
  "src/components/player/TransportControls.tsx",
);
const shellSource = readSource("src/components/layout/AppShell.tsx");

describe("the shuffle button announces the state you land in, not the one you left", () => {
  test("the cycle is off -> shuffle -> smart shuffle -> off", () => {
    // This is the bug that was reported: the toast was derived from the flags
    // BEFORE the press, so the very first click announced "Smart shuffle on"
    // when it had only turned plain shuffle on, and the second click announced
    // "Shuffle off" when it had actually turned smart shuffle on.
    expect(nextShuffleState("off")).toBe("shuffle");
    expect(nextShuffleState("shuffle")).toBe("smart");
    expect(nextShuffleState("smart")).toBe("off");

    expect(shuffleToastFor("off")).toBe("Shuffle on");
    expect(shuffleToastFor("shuffle")).toBe(
      "Smart shuffle on — avoiding repeats",
    );
    expect(shuffleToastFor("smart")).toBe("Shuffle off");
  });

  test("the store flags map to exactly one state", () => {
    expect(shuffleStateOf(false, false)).toBe("off");
    expect(shuffleStateOf(true, false)).toBe("shuffle");
    expect(shuffleStateOf(true, true)).toBe("smart");
    // Smart implies shuffle, so it has to win even if the flags disagree.
    expect(shuffleStateOf(false, true)).toBe("smart");
  });

  test("three clicks end where they started", () => {
    // Guards the cycle against a table that drifts out of a loop.
    let state = shuffleStateOf(false, false);
    for (let i = 0; i < 3; i += 1) state = nextShuffleState(state);
    expect(state).toBe("off");
  });

  test("the label names the current state and the next press", () => {
    expect(shuffleLabelFor("off")).toBe("Shuffle off — turn on shuffle");
    expect(shuffleLabelFor("shuffle")).toBe(
      "Shuffle on — turn on smart shuffle",
    );
    expect(shuffleLabelFor("smart")).toBe(
      "Smart shuffle on — turn shuffle off",
    );
  });
});

describe("there is exactly one copy of the shuffle table", () => {
  test("the button and the S shortcut both derive from it", () => {
    // A second hand-written ternary is how the two drifted apart in the first
    // place, so neither component may build the message itself.
    expect(transportSource).toMatch(/toast\(shuffleToastFor\(shuffleState\)\)/);
    expect(transportSource).toMatch(
      /label=\{shuffleLabelFor\(shuffleState\)\}/,
    );
    expect(transportSource).not.toContain("avoiding repeats");
    expect(shellSource).toMatch(
      /toast\(shuffleToastFor\(shuffleStateOf\(s\.shuffle, s\.smartShuffle\)\)\)/,
    );
    expect(shellSource).not.toContain("avoiding repeats");
  });

  test("the badge shows only in the smart state", () => {
    // Smart shuffle has no icon of its own, so the badge is the only way to
    // tell the second state from the third.
    expect(transportSource).toMatch(/shuffleState === "smart" &&/);
    expect(transportSource).not.toMatch(/shuffle && smartShuffle &&/);
  });
});
