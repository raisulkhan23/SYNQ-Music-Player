/**
 * Playback honesty — PURE decision logic.
 *
 * This module used to decide which OTHER SOURCE to try when a track could not
 * play. That is gone. Jamendo was wired in as a second playable provider so a
 * listener whose blocker stops youtube.com would have something to hear, and
 * it did not work: Jamendo's streams were silent too. It is now a DISCOVERY
 * index (see `src/lib/jamendoDiscovery.ts`) and never a playback source, so
 * there is no second source to fall back to.
 *
 * What survives here is the part that was never about providers:
 *
 *  - `matchScore`, the rule for deciding whether two differently-spelled
 *    titles and credits are the same song. It is the single definition of
 *    "same song" in the app, and the discovery resolver depends on it.
 *  - `giveUpNotice`, so that running out of ways to play something produces
 *    an honest, actionable message instead of silence. Silence is the bug
 *    this whole area started from: a listener with every track muted and no
 *    idea why.
 *
 * PURE, so both are testable without a browser, a network or a deployment.
 */

/** Reduce a string for comparison: case, accents, punctuation, filler words. */
function key(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(
      /\((?:official|topic|audio|video|lyrics?|visualizer|hd|hq)[^)]*\)/g,
      " ",
    )
    .replace(/\b(feat|ft|featuring|with)\b[^,]*/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * How well a candidate matches what we were trying to play, 0..1.
 *
 * Deliberately conservative about the TITLE and lenient about the artist.
 * Titles are what a listener recognises; an artist credit is frequently
 * spelled differently between an upload and a catalogue release, and being
 * too strict there throws away the only playable option they have left.
 */
export function matchScore(
  wanted: { title: string; artist: string },
  candidate: { title: string; artist: string },
): number {
  const wTitle = key(wanted.title);
  const cTitle = key(candidate.title);
  if (!wTitle || !cTitle) return 0;
  const wArtist = key(wanted.artist);
  const cArtist = key(candidate.artist);

  let score =
    wTitle === cTitle
      ? 0.75
      : cTitle.includes(wTitle) || wTitle.includes(cTitle)
        ? 0.5
        : 0;
  if (score === 0) return 0;
  if (
    wArtist &&
    cArtist &&
    (wArtist === cArtist ||
      cArtist.includes(wArtist) ||
      wArtist.includes(cArtist))
  ) {
    score += 0.25;
  }
  return Math.min(1, score);
}

/**
 * What to tell the listener when EVERY rescue path for this track is dead.
 *
 * Naming a blocked provider is the whole point: it is the only thing the
 * listener can act on, and it is what was missing when playback was reported
 * as simply broken.
 */
export function giveUpNotice(options: {
  blockedProvider?: string | null;
  hasAlternatives?: boolean;
}): string {
  if (options.blockedProvider)
    return `Your blocker is blocking ${options.blockedProvider} — allow it to hear this song`;
  if (options.hasAlternatives)
    return "Every version of this song failed to play";
  return "Couldn't find a playable copy of this song";
}
