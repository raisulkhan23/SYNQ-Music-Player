/**
 * The shuffle button's three states, the way Spotify's works:
 *
 *   off  ->  shuffle  ->  smart shuffle  ->  off
 *
 * The toast, the accessible label and the badge were each derived from the
 * button's flags with an inline ternary, and the two copies drifted apart and
 * then went out of step with the action: the toast described the state BEFORE
 * the press rather than the one you landed in, so the first click announced
 * "Smart shuffle on" when it had only turned plain shuffle on.
 *
 * Deriving all three from one function keyed on the state you are leaving
 * makes that impossible to get wrong, and lets the table be unit tested as
 * behaviour instead of pattern-matched out of a component.
 */

export type ShuffleState = "off" | "shuffle" | "smart";

/** Which state the two store flags currently describe. */
export function shuffleStateOf(
  shuffle: boolean,
  smartShuffle: boolean,
): ShuffleState {
  // Smart is checked first because it implies shuffle, so `smartShuffle` alone
  // is the top state even if the two flags ever disagreed.
  if (smartShuffle) return "smart";
  if (shuffle) return "shuffle";
  return "off";
}

/** The state one press of the shuffle button moves to. */
export function nextShuffleState(state: ShuffleState): ShuffleState {
  switch (state) {
    case "off":
      return "shuffle";
    case "shuffle":
      return "smart";
    case "smart":
      return "off";
  }
}

/**
 * What to announce after pressing the button: the state just entered, not the
 * one just left.
 */
export function shuffleToastFor(state: ShuffleState): string {
  switch (nextShuffleState(state)) {
    case "shuffle":
      return "Shuffle on";
    case "smart":
      return "Smart shuffle on — avoiding repeats";
    case "off":
      return "Shuffle off";
  }
}

/**
 * The button's accessible name: the current state AND what the next press
 * will do, so it is never ambiguous about what a click means.
 */
export function shuffleLabelFor(state: ShuffleState): string {
  switch (state) {
    case "off":
      return "Shuffle off — turn on shuffle";
    case "shuffle":
      return "Shuffle on — turn on smart shuffle";
    case "smart":
      return "Smart shuffle on — turn shuffle off";
  }
}
