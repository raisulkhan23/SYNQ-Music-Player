import { useAction } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePlayerStore } from "@/store/player";
import { api } from "@/convex/_generated/api";

/** One line of lyrics. `blank` marks a section break, not a word. */
export interface TrackLyricLine {
  t: number;
  text: string;
  blank?: boolean;
}

export interface UseTrackLyrics {
  lines: TrackLyricLine[] | null;
  /** False when the timings are guesses spread over the track, not real. */
  synced: boolean;
  loading: boolean;
  /** Index of the line being sung right now, or -1. Never a blank. */
  activeIndex: number;
  /** The text of that line, or "" before the first line is reached. */
  activeLine: string;
  /** The line before / after it, skipping section breaks. "" at the edges. */
  prevLine: string;
  nextLine: string;
  /** Attach to the scrolling panel so the active line can follow along. */
  containerRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * YouTube titles/channel names don't match lyrics databases directly — strip
 * the noise ("(Official Video)", "- Topic", "VEVO", ...) before lookup.
 *
 * This moved here with the fetch. It is NOT a cosmetic helper: lyrics
 * providers key on the song name, and "Song Name (Official Video)" misses
 * where "Song Name" hits.
 */
function cleanLyricsQuery(raw: string | null | undefined): string {
  return (raw ?? "")
    .replace(/\s*[-–]\s*(Topic|VEVO|Official)\s*$/i, "")
    .replace(
      /\s*\([^)]*(official|video|audio|lyrics|hd|hq|mv|visualizer|remaster|lyric)[^)]*\)/gi,
      "",
    )
    .replace(
      /\s*\[[^\]]*(official|video|audio|lyrics|hd|hq|mv|visualizer|remaster|lyric)[^\]]*\]/gi,
      "",
    )
    .replace(/\s*【[^】]*】/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Lyrics for the currently loaded track, plus which line is playing now.
 *
 * This used to live inside `LyricsPanel`, which meant the fetch only happened
 * once the panel was already open. The fullscreen player now shows the current
 * line in the gap between the artwork and the title, so the lyrics have to be
 * available before the panel is ever opened — and both surfaces must share ONE
 * fetch. Two components each calling the action would double every request and
 * could disagree about which line is active for a few frames.
 *
 * `enabled` is not an optimisation, it is the whole reason this is safe to call
 * from the player: `FullscreenPlayer` is mounted permanently at the shell
 * level and simply renders nothing when closed. Without the gate, every track
 * change would fire a lyrics lookup for users who never open the player at all.
 */
export function useTrackLyrics(
  enabled: boolean,
  /**
   * Whether the scrolling panel is currently mounted.
   *
   * Needed because the panel only renders once it is opened, so the ref
   * attaches AFTER the hook's effects for this track already ran. Without
   * this signal the panel opened scrolled to the top of the song no matter
   * where playback actually was, and then lurched down to the current line a
   * few seconds later when the next lyric arrived. That jump-on-open is what
   * read as the panel "bugging out".
   */
  panelOpen = false,
): UseTrackLyrics {
  const current = usePlayerStore((s) => s.current);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const fetchLyrics = useAction(api.lyrics.fetchLyrics);

  const [lines, setLines] = useState<TrackLyricLine[] | null>(null);
  const [synced, setSynced] = useState(true);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  /** True once the panel has been centred on the active line for this open. */
  const hasCentredRef = useRef(false);

  const key = current
    ? `${current.title}|${current.artistName}|${current.albumName}`
    : "";

  // Reset the previous track's result whenever the identity changes. Derived
  // purely from deps, so it is safe outside the fetch effect.
  useEffect(() => {
    if (!enabled || !key) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when a new track loads
    setLines(null);
    // The flag belongs to the previous track's result; leaving it behind would
    // make the next track claim to be unsynced before it has loaded.
    setSynced(true);
    setLoading(true);
  }, [enabled, key]);

  useEffect(() => {
    if (!enabled || !current) return;
    let cancelled = false;
    fetchLyrics({
      title: cleanLyricsQuery(current.title),
      artist: cleanLyricsQuery(current.artistName),
      album: current.albumName ? cleanLyricsQuery(current.albumName) : undefined,
      duration: current.duration,
    })
      .then((res) => {
        if (cancelled) return;
        // A cached miss comes back empty rather than null.
        setLines(res && res.lines.length > 0 ? res.lines : null);
        setSynced(res?.synced ?? true);
      })
      .catch(() => {
        if (!cancelled) setLines(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `key` is the track identity (title|artist|album) and is what makes this
    // run per song. It must stay in the deps: without it the state reset above
    // cleared the lines on a track change and nothing ever refetched, so every
    // song after the first sat on "loading" forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, fetchLyrics, key]);

  const activeIndex = useMemo(() => {
    if (!lines) return -1;
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      // A section break is not a lyric. Highlighting it would flash an empty
      // gap between two words.
      if (lines[i].blank) continue;
      if (lines[i].t <= currentTime + 0.2) idx = i;
      else break;
    }
    return idx;
  }, [lines, currentTime]);

  const activeLine =
    activeIndex >= 0 && lines ? (lines[activeIndex]?.text ?? "") : "";

  // The lines either side of the current one, for the player's three-line
  // stack. Section breaks are skipped in both directions: showing an empty
  // gap where a word should be is worse than showing nothing.
  const { prevLine, nextLine } = useMemo(() => {
    if (!lines || activeIndex < 0) return { prevLine: "", nextLine: "" };
    let p = activeIndex - 1;
    while (p >= 0 && lines[p]?.blank) p--;
    let n = activeIndex + 1;
    while (n < lines.length && lines[n]?.blank) n++;
    return {
      prevLine: p >= 0 ? (lines[p]?.text ?? "") : "",
      nextLine: n < lines.length ? (lines[n]?.text ?? "") : "",
    };
  }, [lines, activeIndex]);

  // Follow the active line in the scrolling panel. Skipped for unsynced
  // lyrics: their timings are guesses spread across the track, so following
  // them drifts a line at a time through the song and reads as broken.
  //
  // The FIRST scroll after the panel opens is instant, not smooth. Opening
  // the panel mid-song means jumping from the top of the lyrics to the middle
  // of the song; animating that move is a visible fly-through of a dozen
  // lines, which is exactly the "it bugged out" lurch. Only the subsequent
  // line-to-line follow is animated, where a short glide is the point.
  useEffect(() => {
    if (!panelOpen) {
      // Re-arm for the next time the panel is opened.
      hasCentredRef.current = false;
      return;
    }
    if (!enabled || !synced) return;
    const el = containerRef.current?.querySelector<HTMLElement>(
      "[data-active='true']",
    );
    if (!el) return;
    const first = !hasCentredRef.current;
    hasCentredRef.current = true;
    if (first) {
      el.scrollIntoView({ block: "center", behavior: "auto" });
      return;
    }
    const smooth =
      typeof window === "undefined" ||
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
  }, [enabled, panelOpen, activeIndex, synced]);

  return {
    lines,
    synced,
    loading,
    activeIndex,
    activeLine,
    prevLine,
    nextLine,
    containerRef,
  };
}