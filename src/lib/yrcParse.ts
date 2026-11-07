/**
 * Word-timed lyric parsers — the karaoke layer.
 *
 * Two sources carry per-WORD timings and both are parsed here, ported from the
 * melo player's server:
 *
 *  - NetEase YRC. One line per `[start,duration]` header, then the words as
 *    `(wordStart,wordDuration,0)characters` groups, all in milliseconds:
 *      [12345,6789](12345,120,0)你(12465,180,0)好
 *  - Enhanced LRC. Standard line stamps with inline word stamps in angle
 *    brackets, seconds:
 *      [01:23.45] <01:23.45> Words <01:24.10> follow
 *
 * WHY WORD TIMINGS ARE NEVER INFERRED. Spreading a line's words evenly over
 * its duration looks like karaoke and sings wrong: syllables land where the
 * melody isn't, and a wrong highlight is worse than a plain highlight because
 * it moves the listener's eye. Word highlighting exists ONLY when real word
 * timings came off the wire — the same honesty rule melo applies.
 *
 * PURE, so both parsers are testable without a network.
 */

/** One word inside a line. Times are SECONDS (floats). */
export interface LyricWord {
  text: string;
  /** Start, seconds from the top of the track. */
  t0: number;
  /** End, seconds. Always > t0 by at least a millisecond. */
  t1: number;
}

/** One line of word-timed lyrics. */
export interface WordLyricLine {
  /** Line start, seconds. */
  t: number;
  /** Line end, seconds (start + duration when the source gives one). */
  end: number;
  words: LyricWord[];
  /** The words joined — what a non-karaoke view would render. */
  text: string;
}

/** Parse one NetEase YRC payload ("j.yrc.lyric"). Malformed input → []. */
export function parseYrc(payload: string | null | undefined): WordLyricLine[] {
  if (!payload) return [];
  const lines: WordLyricLine[] = [];
  for (const rawLine of payload.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // Header: [startMs,durationMs]
    const header = /^\[(\d+),(\d+)\]/.exec(line);
    if (!header) continue;
    const t = Number(header[1]) / 1000;
    const dur = Number(header[2]) / 1000;
    if (!Number.isFinite(t)) continue;

    const words: LyricWord[] = [];
    // Word group: (startMs,durationMs,0)text — the trailing flag is ignored.
    const groupRe = /\((\d+),(\d+),\d+\)([^()]*)/g;
    for (const match of line.slice(header[0].length).matchAll(groupRe)) {
      const wStart = Number(match[1]) / 1000;
      const wDur = Number(match[2]) / 1000;
      const text = match[3];
      if (!text) continue;
      words.push({
        text,
        t0: wStart,
        t1: Math.max(wStart + Math.max(wDur, 0.001), wStart + 0.001),
      });
    }
    if (words.length === 0) continue;
    const text = words.map((w) => w.text).join("");
    if (!text.trim()) continue;
    lines.push({
      t,
      end: Math.max(t + dur, words[words.length - 1].t1),
      words,
      text,
    });
  }
  // Order matters for the active-line search: sources occasionally emit a
  // line out of order, and a binary search over unsorted data is a silent bug.
  return lines.sort((a, b) => a.t - b.t);
}

const ENHANCED_WORD_STAMP = /<(\d+):(\d+(?:\.\d+)?)>/g;

/**
 * Parse enhanced LRC — inline `<mm:ss.xx>` word stamps inside standard lines.
 * A line whose words carry no inline stamps falls back to one whole-line word,
 * so the karaoke view degrades to per-line fill instead of highlighting
 * nothing.
 */
export function parseEnhancedLrc(
  payload: string | null | undefined,
): WordLyricLine[] {
  if (!payload) return [];
  const lines: WordLyricLine[] = [];
  for (const rawLine of payload.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    // Standard line stamp(s); take the first.
    const lineStamp = /^\[(\d+):(\d+(?:\.\d+)?)\]/.exec(line);
    if (!lineStamp) continue;
    const t = Number(lineStamp[1]) * 60 + Number(lineStamp[2]);
    const body = line.slice(lineStamp[0].length);

    // Strip remaining metadata tags ([offset:], [ti:], …) and empty markers.
    const cleaned = body.replace(/^\[[^\]]*\]/, "").trim();
    if (!cleaned) continue;
    // A plain-text fallback marker is not a lyric line.
    if (/^\[(instrumental|interlude)\]$/i.test(cleaned)) continue;

    const words: LyricWord[] = [];
    // Split on word stamps, keeping each stamp with the text that follows it.
    const parts = cleaned.split(ENHANCED_WORD_STAMP);
    // split with capture groups yields: [pre, m1, s1, text1, m2, s2, text2, …]
    for (let i = 1; i < parts.length; i += 3) {
      const minutes = Number(parts[i]);
      const seconds = Number(parts[i + 1]);
      const text = (parts[i + 2] ?? "").trim();
      if (!text) continue;
      if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) continue;
      const wStart = minutes * 60 + seconds;
      words.push({ text, t0: wStart, t1: wStart + 0.001 });
    }
    if (words.length === 0) {
      // No inline stamps: one word covering the line, so the fill still works
      // at line granularity.
      lines.push({
        t,
        end: t + 5,
        words: [{ text: cleaned, t0: t, t1: t + 5 }],
        text: cleaned,
      });
      continue;
    }
    // Each word's end is the next word's start; the last word's end is
    // provisional (+5 s) and corrected below to the next line's start.
    for (let i = 0; i < words.length; i++) {
      const next = words[i + 1];
      words[i].t1 = next ? next.t0 : words[i].t0 + 5;
    }
    lines.push({
      t,
      end: words[words.length - 1].t1,
      words,
      text: words.map((w) => w.text).join(""),
    });
  }
  // Post-pass: the last word of each line ends where the NEXT line begins
  // (capped at a 5 s tail) — that is when a singer stops singing it, and a
  // fill that keeps running through the instrumental gap reads as wrong.
  for (let i = 0; i < lines.length; i++) {
    const next = lines[i + 1];
    const last = lines[i].words[lines[i].words.length - 1];
    if (next) {
      last.t1 = Math.min(next.t, last.t0 + 5);
    }
    lines[i].end = last.t1;
  }
  return lines.sort((a, b) => a.t - b.t);
}

/**
 * The active word inside a line at a given time: the last word whose t0 has
 * passed. -1 before the line starts.
 */
export function activeWordIndex(line: WordLyricLine, time: number): number {
  let idx = -1;
  for (let i = 0; i < line.words.length; i++) {
    if (line.words[i].t0 <= time) idx = i;
    else break;
  }
  return idx;
}

/** 0..1 progress through one word, for the karaoke fill. */
export function wordFill(word: LyricWord, time: number): number {
  if (time <= word.t0) return 0;
  if (time >= word.t1) return 1;
  const span = word.t1 - word.t0;
  return span > 0 ? (time - word.t0) / span : 1;
}
