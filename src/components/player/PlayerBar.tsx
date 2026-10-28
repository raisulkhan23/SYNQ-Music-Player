import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { SeekBar } from "@/components/player/SeekBar";
import { TransportControls } from "@/components/player/TransportControls";
import { VolumeControl } from "@/components/player/VolumeControl";
import { accentFromString, dominantColor } from "@/lib/covers";
import { formatTime } from "@/lib/format";
import { toPlayableYoutube } from "@/lib/playable";
import { giveUpNotice, matchScore } from "@/lib/playbackFallback";
import { artistSearchQuery, cleanTrackTitle } from "@/lib/youtube";
import { getAudio } from "@/lib/audio";
import {
  publishPlaybackState,
  publishPosition,
  publishTrackMetadata,
} from "@/lib/mediaSession";
import { formatRemaining, useSleepCountdown } from "@/lib/sleepTimer";
import { formatSkipped } from "@/lib/introTrim";
import { usePlayerStore } from "@/store/player";
import {
  Heart,
  House,
  ListMusic,
  Loader2,
  Maximize2,
  Minimize2,
  Moon,
  Scissors,
  Search,
  Undo2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type SessionLayout = "off" | "study" | "work" | "sleep";

const SESSION_LABELS: Record<Exclude<SessionLayout, "off">, string> = {
  study: "Study session",
  work: "Work session",
  sleep: "Sleep session",
};

function isSessionLayout(value: string | null): value is SessionLayout {
  return (
    value === "off" ||
    value === "study" ||
    value === "work" ||
    value === "sleep"
  );
}

/**
 * Live sleep-timer chip.
 *
 * The timer could previously only be seen (or cancelled) from the fullscreen
 * player, which is one tap away and not even reachable on the layouts where
 * the bar covers the screen. Arming a 30-minute timer and never seeing it again
 * meant people forgot it was running and wondered why the music stopped.
 */
function SleepTimerChip() {
  const sleepEndsAt = usePlayerStore((s) => s.sleepEndsAt);
  const sleepAtSongEnd = usePlayerStore((s) => s.sleepAtSongEnd);
  const sleepAtQueueEnd = usePlayerStore((s) => s.sleepAtQueueEnd);
  const setSleepTimer = usePlayerStore((s) => s.setSleepTimer);
  const now = useSleepCountdown(sleepEndsAt);

  if (sleepEndsAt === null && !sleepAtSongEnd && !sleepAtQueueEnd) return null;

  return (
    <div className="hidden shrink-0 items-center gap-1 rounded-full bg-white/[0.07] py-1 pr-0.5 pl-2 text-[10px] font-semibold text-muted-foreground sm:flex">
      <Moon className="size-3 text-[rgb(var(--tint))]" aria-hidden="true" />
      <span className="tabular-nums">
        {sleepEndsAt !== null
          ? formatRemaining(sleepEndsAt - now)
          : sleepAtSongEnd
            ? "end of song"
            : "end of queue"}
      </span>
      <button
        type="button"
        aria-label="Cancel sleep timer"
        title="Cancel sleep timer"
        onClick={() => {
          setSleepTimer(null);
          toast.success("Sleep timer cancelled");
        }}
        className="rounded-full p-0.5 transition-colors hover:bg-white/10 hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

/**
 * Smart intro trim control.
 *
 * Appears once the setting is on, and whenever a trim has actually been
 * applied. The automatic probe can only see tracks whose audio flows through
 * the Web Audio graph, so the manual button is the escape hatch for everything
 * else — a cinematic upload playing through the YouTube engine, or a listener
 * who simply knows the intro is dead.
 */
function IntroTrimChip() {
  const introTrim = usePlayerStore((s) => s.introTrim);
  const skipped = usePlayerStore((s) => s.introTrimSkipped);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const hasTrack = usePlayerStore((s) => s.current !== null);
  const skipIntro = usePlayerStore((s) => s.skipIntro);
  const undoIntroTrim = usePlayerStore((s) => s.undoIntroTrim);
  const toggleIntroTrim = usePlayerStore((s) => s.toggleIntroTrim);

  // Once a trim has landed the playhead is past the intro, so the button has
  // nothing left to do — the undo affordance replaces it.
  const inIntro = hasTrack && currentTime <= 60;
  if (skipped !== null) {
    return (
      // Icon-only for the same reason as the skip button below: this chip sits
      // in the one row that has no slack, and "Trimmed 12s" was wide enough to
      // squeeze the transport controls. The figure is still reachable, on
      // hover and to a screen reader, via the label.
      <div className="hidden shrink-0 items-center rounded-full bg-white/[0.07] p-1 sm:flex">
        <span
          className="grid size-6 place-items-center text-[rgb(var(--tint))]"
          title={`Trimmed ${formatSkipped(skipped)}`}
          aria-label={`Intro trimmed by ${formatSkipped(skipped)}`}
          role="img"
        >
          <Scissors className="size-3" aria-hidden="true" />
        </span>
        <button
          type="button"
          aria-label="Undo intro trim"
          title="Undo intro trim"
          onClick={() => {
            undoIntroTrim();
            toast("Intro restored");
          }}
          className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
        >
          <Undo2 className="size-3" />
        </button>
      </div>
    );
  }
  // The icon is ALWAYS present while a track is loaded.
  //
  // It used to render only when smart intro trim was enabled AND the playhead
  // was inside the first 60s — and smart trim defaults to off. So for anyone
  // who had not turned it on, there was no control at all, which reads as the
  // button having been deleted rather than as a setting being unavailable.
  // The label is gone (as asked); the icon is not.
  if (!hasTrack) return null;

  // Smart trim off: the same icon turns it on. This mirrors the fullscreen
  // control, which is a trigger when disabled and a skip when enabled, so the
  // two surfaces cannot disagree about what the button is for.
  if (!introTrim) {
    return (
      <button
        type="button"
        aria-label="Turn on smart intro trim"
        title="Turn on smart intro trim"
        onClick={() => {
          toggleIntroTrim();
          toast("Smart intro trim on", {
            description: "SYNQ will skip a silent lead-in automatically.",
          });
        }}
        className="hidden shrink-0 items-center rounded-full p-2 text-muted-foreground/70 transition-colors hover:bg-white/[0.06] hover:text-foreground sm:flex lg:p-1.5"
      >
        <Scissors className="size-3.5" aria-hidden="true" />
      </button>
    );
  }

  // On but nothing left to skip on this track: keep the icon visible and
  // legible as "this is on" rather than making the control appear and vanish
  // part-way through a song.
  if (!inIntro) {
    return (
      <button
        type="button"
        aria-label="Smart intro trim is on"
        title="Smart intro trim is on"
        onClick={() => {
          toggleIntroTrim();
          toast("Smart intro trim off");
        }}
        className="hidden shrink-0 items-center rounded-full p-2 text-[rgb(var(--tint))]/60 transition-colors hover:bg-white/[0.06] sm:flex lg:p-1.5"
      >
        <Scissors className="size-3.5" aria-hidden="true" />
      </button>
    );
  }

  return (
    <button
      type="button"
      aria-label="Skip ahead past a slow intro"
      onClick={() => {
        const applied = skipIntro();
        if (applied > 0)
          toast(`Skipped ${formatSkipped(applied)} of intro`, {
            description: "Undo it any time from here.",
          });
      }}
      title="Skip ahead past a slow intro"
      // ICON ONLY, deliberately. This used to read "Skip intro" in a pill, and
      // the player bar is the one row with no horizontal slack — the pill
      // squeezed the transport and could visibly jam the layout. The label
      // moved to `aria-label`/`title` so nothing is lost, and the footprint
      // now matches the queue button beside it.
      className="hidden shrink-0 items-center rounded-full bg-white/[0.07] p-2 text-muted-foreground transition-colors hover:bg-white/[0.12] hover:text-foreground sm:flex lg:p-1.5"
    >
      <Scissors className="size-3.5" aria-hidden="true" />
    </button>
  );
}

function ReadingSessionNav() {
  const navigate = useNavigate();
  const [layout, setLayout] = useState<SessionLayout>(() => {
    const saved = localStorage.getItem("ss.focusLayout");
    return isSessionLayout(saved)
      ? saved
      : localStorage.getItem("ss.focusMode") === "1"
        ? "study"
        : "off";
  });

  useEffect(() => {
    const onLayoutChange = (event: Event) => {
      const next = (event as CustomEvent<string>).detail;
      if (isSessionLayout(next)) setLayout(next);
    };
    window.addEventListener("synq:focus-layout-change", onLayoutChange);
    return () =>
      window.removeEventListener("synq:focus-layout-change", onLayoutChange);
  }, []);

  if (layout === "off") return null;

  const exitSession = () => {
    localStorage.setItem("ss.focusLayout", "off");
    localStorage.setItem("ss.focusMode", "0");
    window.dispatchEvent(
      new CustomEvent("synq:focus-layout-change", { detail: "off" }),
    );
  };

  return (
    <div className="fixed top-3 right-3 z-[60] flex max-w-[calc(100vw-1.5rem)] items-center gap-1 rounded-2xl border border-white/10 bg-[#101218]/90 p-1.5 shadow-2xl backdrop-blur-xl sm:right-4">
      <span className="hidden px-2 text-[10px] font-semibold tracking-[0.14em] text-brand uppercase sm:inline">
        {SESSION_LABELS[layout]}
      </span>
      <button
        type="button"
        onClick={() => void navigate("/home")}
        className="flex items-center gap-1.5 rounded-xl px-2.5 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:bg-white/8 hover:text-foreground"
        title="Go home"
      >
        <House className="size-3.5" />
        <span className="hidden md:inline">Home</span>
      </button>
      <button
        type="button"
        onClick={() => void navigate("/search")}
        className="flex items-center gap-1.5 rounded-xl px-2.5 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:bg-white/8 hover:text-foreground"
        title="Search music"
      >
        <Search className="size-3.5" />
        <span className="hidden md:inline">Search</span>
      </button>
      <button
        type="button"
        onClick={() => usePlayerStore.getState().setQueueOpen(true)}
        className="flex items-center gap-1.5 rounded-xl px-2.5 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:bg-white/8 hover:text-foreground"
        title="Open queue"
      >
        <ListMusic className="size-3.5" />
        <span className="hidden md:inline">Queue</span>
      </button>
      <button
        type="button"
        onClick={exitSession}
        className="flex items-center gap-1.5 rounded-xl bg-brand px-2.5 py-2 text-xs font-semibold text-brand-foreground transition-transform hover:scale-[1.02]"
        title="End listening session"
      >
        <Minimize2 className="size-3.5" />
        <span>End session</span>
      </button>
    </div>
  );
}

export function PlayerBar({ compact = false }: { compact?: boolean }) {
  const navigate = useNavigate();
  const current = usePlayerStore((s) => s.current);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const isBuffering = usePlayerStore((s) => s.isBuffering);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const duration = usePlayerStore((s) => s.duration);
  const liked = usePlayerStore((s) => s.liked);
  // null ⇒ the track has no usable artist, so the name renders as plain text.
  const artistQuery = useMemo(
    () => artistSearchQuery(current?.artistName, current?.title),
    [current?.artistName, current?.title],
  );
  // Animated like heart — declared with the other hooks so the hook order
  // never changes (it used to live after an early return, which broke React's
  // rules of hooks and could crash the player bar).
  const [likePulse, setLikePulse] = useState(false);
  const toggleLike = usePlayerStore((s) => s.toggleLike);
  const queueOpen = usePlayerStore((s) => s.queueOpen);
  const setQueueOpen = usePlayerStore((s) => s.setQueueOpen);
  const setFullscreen = usePlayerStore((s) => s.setFullscreen);
  const setAccent = usePlayerStore((s) => s.setAccent);
  const errorNonce = usePlayerStore((s) => s.errorNonce);
  // Non-null only while AutoMix is mixing this boundary; a chip is the whole
  // indicator, because a beat-aligned blend is otherwise indistinguishable
  // from a long crossfade.
  const autoMixIndicator = usePlayerStore((s) => s.autoMixIndicator);
  const replaceCurrentStream = usePlayerStore((s) => s.replaceCurrentStream);
  const playViaStream = usePlayerStore((s) => s.playViaStream);
  const searchSameSong = useAction(api.youtube.searchYoutube);
  // Sample the current artwork and tint the whole app with its dominant color.
  // Remote (YouTube) art can't be sampled cross-origin, so derive a stable,
  // pleasant accent from the track instead.
  useEffect(() => {
    if (!current) {
      setAccent(null);
      return;
    }
    let cancelled = false;

    // Start with a deterministic track color so every song gets its own theme
    // immediately. If same-origin artwork can be sampled, replace that seed
    // with the cover's dominant color when extraction finishes.
    const seededAccent = accentFromString(
      `${current.title} ${current.artistName}`,
    );
    setAccent(seededAccent);
    if (current.coverUrl) {
      // Artwork extraction is a secondary enhancement. Keep it off the
      // critical path and avoid starting another decode for every quick
      // track change; the deterministic accent is already immediate.
      const timer = window.setTimeout(() => {
        void dominantColor(current.coverUrl).then((c) => {
          if (!cancelled && c) setAccent(c);
        });
      }, 180);
      return () => {
        cancelled = true;
        window.clearTimeout(timer);
      };
    }

    return () => {
      cancelled = true;
    };
  }, [current, setAccent]);

  // Auto-fallback: if a YouTube video can't play (embed disabled, removed,
  // etc.), automatically try the next search result. Manual switching is also
  // available in the queue panel.
  const attempts = useRef(0);
  const rescueExhausted = useRef(false);
  const lastErrorTrack = useRef<string | null>(null);
  // Session-wide cap on rescue swaps. Each re-searched upload looks like a
  // NEW track (so `lastErrorTrack` resets `attempts` below), which means an
  // environment where YouTube embeds never play (network blocker, bot-check)
  // looped load → rescue → different upload → load forever. After this many
  // total swaps the chain stops and says so instead of repeating.
  const totalSwaps = useRef(0);
  const MAX_TOTAL_SWAPS = 3;
  useEffect(() => {
    if (errorNonce === 0) return;
    const s = usePlayerStore.getState();
    const track = s.current;
    if (!track) return;

    if (lastErrorTrack.current !== track.id) {
      lastErrorTrack.current = track.id;
      attempts.current = 0;
      rescueExhausted.current = false;
    }
    if (totalSwaps.current >= MAX_TOTAL_SWAPS) {
      rescueExhausted.current = true;
      toast.error(
        giveUpNotice({
          // A blocker is named ONLY from `isApiBlocked()` (youtube.com's own
          // script never loaded). Every other failure report its real cause
          // instead: "embed-refused" is YouTube rejecting the embed (often a
          // missing referrer), which happens with no blocker at all.
          blockedProvider: s.blockedProvider,
          failure: s.failureKind,
          hasAlternatives: (track.alternatives ?? []).length > 0,
        }),
        { id: "yt-fallback" },
      );
      return;
    }
    const alternatives = track.alternatives ?? [];
    // NOTE: don't bail out just because `alternatives` is empty — the rescue
    // (stream) and re-search paths below don't need alternatives. Only give
    // up once we've already exhausted both rescue attempts AND alternatives.
    if (
      attempts.current >= alternatives.length &&
      track.audioUrl &&
      attempts.current > 0 &&
      rescueExhausted.current
    ) {
      toast.error(
        giveUpNotice({
          blockedProvider: s.blockedProvider,
          failure: s.failureKind,
          hasAlternatives: alternatives.length > 0,
        }),
        { id: "yt-fallback" },
      );
      return;
    }
    // First failure for this track: try to rescue the SAME song through the
    // resolved direct stream (the proxy path) — this covers videos that are
    // embed-restricted or region-blocked in the iframe but still streamable.
    if (!track.audioUrl) {
      rescueExhausted.current = true;
      toast.loading(`Finding a way to play "${track.title}"…`, {
        id: "yt-fallback",
      });
      // playViaStream resolves asynchronously. Clear the loading toast when
      // the shared audio element actually starts, rather than leaving it
      // stuck after a successful rescue.
      const audio = getAudio();
      const cleanup = () => {
        audio.removeEventListener("playing", onPlaying);
        window.clearTimeout(timeout);
        toast.dismiss("yt-fallback");
      };
      const onPlaying = () => cleanup();
      const timeout = window.setTimeout(cleanup, 15_000);
      audio.addEventListener("playing", onPlaying, { once: true });
      playViaStream(track);
      return;
    }

    // Stream also failed (e.g. YouTube's bot-check blocked this upload).
    // Before abandoning the song, re-search for the SAME song title and try a
    // different upload of it. Only when every upload fails do we give up.
    if (attempts.current === 0) {
      attempts.current = 1;
      toast.loading(`Looking for another upload of "${track.title}"…`, {
        id: "yt-fallback",
      });
      const artist = track.artistName.split(",")[0]?.trim() ?? "";
      void searchSameSong({ query: `${track.title} ${artist}`.trim() })
        .then(({ items }) => {
          // The replacement must be the SAME SONG. Taking the first upload that
          // merely shared a word swapped "Loser" (Tame Impala) for "Loser Song
          // (From \"I'M Game\")" and kept playing, while the toast still named
          // the song the listener chose — a substitution that is worse than
          // silence because it sounds like it worked. `matchScore` is the
          // app's single rule for "same song": 0.75 is an exact title (artist
          // spelling is deliberately lenient), 0.5 is a partial title that only
          // counts alongside a matching artist, and 0 is a different song.
          const candidate = items
            .filter(
              (it) =>
                it.id !== track.id &&
                it.id !== track.youtubeId &&
                !(track.alternatives ?? []).some((a) => a.id === it.id) &&
                (it.duration === 0 ||
                  (it.duration >= 30 && it.duration <= 900)),
            )
            .map((it) => ({
              it,
              score: matchScore(
                { title: track.title, artist: track.artistName },
                { title: it.title, artist: it.artist ?? "" },
              ),
            }))
            .filter((c) => c.score >= 0.75)
            .sort((a, b) => b.score - a.score)[0]?.it;
          if (!candidate) {
            toast.error(giveUpNotice({ hasAlternatives: true }), {
              id: "yt-fallback",
            });
            return;
          }
          replaceCurrentStream(
            toPlayableYoutube(
              candidate,
              candidate.id,
              items.filter((i) => i.id !== candidate.id),
            ),
          );
          totalSwaps.current += 1;
          // Name the upload that is actually playing, not the song that
          // failed: the two can be different versions.
          toast.success(`Playing "${cleanTrackTitle(candidate.title)}"`, {
            id: "yt-fallback",
          });
        })
        .catch(() =>
          toast.error("Playback failed — try another song", {
            id: "yt-fallback",
          }),
        );
      return;
    }

    const next = alternatives[attempts.current - 1];
    if (!next) {
      // Every upload of this song has been tried and none of them play. Jamendo
      // used to be the last resort here, but its streams are silent for a
      // blocked listener, so trying it only bought more silence — it is now a
      // DISCOVERY index (it feeds recommendations and search) and never a
      // playback source. The honest end of the chain is to say what happened.
      toast.error(
        giveUpNotice({
          blockedProvider: s.blockedProvider,
          failure: s.failureKind,
          hasAlternatives: alternatives.length > 0,
        }),
        { id: "yt-fallback" },
      );
      return;
    }
    attempts.current += 1;
    toast.loading(`Finding another way to play "${track.title}"…`, {
      id: "yt-fallback",
    });
    // The IFrame engine plays by video id — just swap the current track.
    replaceCurrentStream(toPlayableYoutube(next, next.id, alternatives));
    totalSwaps.current += 1;
    toast.success("Playing a matching version", { id: "yt-fallback" });
  }, [errorNonce, replaceCurrentStream, playViaStream, searchSameSong]);

  // AirPods and other Bluetooth media remotes dispatch Media Session actions
  // rather than key events. Registering the handlers makes a double tap send
  // `nexttrack`, while also supporting play, pause, seek and previous track.
  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    type SessionAction =
      | "play"
      | "pause"
      | "playpause"
      | "nexttrack"
      | "previoustrack"
      | "seekbackward"
      | "seekforward";
    type SessionWithActions = MediaSession & {
      setMediaSessionActionHandler: (
        action: SessionAction,
        handler: ((details: MediaSessionActionDetails) => void) | null,
      ) => void;
    };
    const session = navigator.mediaSession as SessionWithActions;
    const register = (
      action: SessionAction,
      handler: (details: MediaSessionActionDetails) => void,
    ) => {
      try {
        session.setMediaSessionActionHandler(action, handler);
      } catch {
        // Older Safari builds expose Media Session but reject individual
        // actions. Unsupported controls should never affect playback.
      }
    };

    register("play", () => {
      const player = usePlayerStore.getState();
      if (player.current && !player.isPlaying) player.togglePlay();
    });
    register("pause", () => {
      const player = usePlayerStore.getState();
      if (player.current && player.isPlaying) player.togglePlay();
    });
    register("playpause", () => {
      const player = usePlayerStore.getState();
      if (player.current) player.togglePlay();
    });
    register("nexttrack", () => {
      const player = usePlayerStore.getState();
      if (player.current) player.next();
    });
    register("previoustrack", () => {
      const player = usePlayerStore.getState();
      if (player.current) player.prev();
    });
    register("seekbackward", (details) => {
      const player = usePlayerStore.getState();
      const requestedOffset = details.seekOffset;
      const offset =
        typeof requestedOffset === "number" && Number.isFinite(requestedOffset)
          ? requestedOffset
          : 10;
      player.seek(Math.max(0, player.currentTime - offset));
    });
    register("seekforward", (details) => {
      const player = usePlayerStore.getState();
      const requestedOffset = details.seekOffset;
      const offset =
        typeof requestedOffset === "number" && Number.isFinite(requestedOffset)
          ? requestedOffset
          : 10;
      const end =
        player.duration > 0 ? player.duration : Number.POSITIVE_INFINITY;
      player.seek(Math.min(end, player.currentTime + offset));
    });

    return () => {
      const actions: SessionAction[] = [
        "play",
        "pause",
        "playpause",
        "nexttrack",
        "previoustrack",
        "seekbackward",
        "seekforward",
      ];
      actions.forEach((action) => {
        try {
          session.setMediaSessionActionHandler(action, null);
        } catch {
          /* ignore unsupported cleanup */
        }
      });
    };
  }, []);

  // Publish now-playing metadata so iOS/Safari can show SYNQ in Control Center
  // and expose the app as the active AirPods media session. The write goes
  // through `@/lib/mediaSession`, the one place for it — this effect is keyed
  // on the same inputs it always was, while the store's own per-track reminder
  // covers the case where the bar is not mounted at all (e.g. a desktop
  // shutdown). The library deduplicates what it last sent, so double-writing
  // never produces a duplicate OS session.
  useEffect(() => {
    publishTrackMetadata(
      current
        ? {
            title: current.title,
            artistName: current.artistName,
            albumName: current.albumName ?? "SYNQ",
            coverUrl: current.coverUrl ?? null,
          }
        : null,
    );
  }, [current]);

  // Keep lock-screen / headphone scrubber state synchronized with playback.
  useEffect(() => {
    publishPlaybackState(current ? (isPlaying ? "playing" : "paused") : "none");
    if (!current) return;

    const player = usePlayerStore.getState();
    const mediaDuration = duration || current.duration || player.duration;
    if (!Number.isFinite(mediaDuration) || mediaDuration <= 0) return;
    const safeTime = Math.min(
      mediaDuration,
      Math.max(0, Number.isFinite(currentTime) ? currentTime : 0),
    );
    const playbackRate =
      Number.isFinite(player.rate) && player.rate > 0 ? player.rate : 1;
    publishPosition({
      duration: mediaDuration,
      position: safeTime,
      rate: playbackRate,
    });
  }, [current, currentTime, duration, isPlaying]);

  if (!current) return <ReadingSessionNav />;

  const isLiked = liked[current.id] !== undefined;
  const rawDuration = duration || current.duration;
  const playbackDuration =
    Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
  const safeCurrentTime = Number.isFinite(currentTime)
    ? Math.max(0, currentTime)
    : 0;
  const playbackProgress =
    playbackDuration > 0
      ? Math.min(100, (safeCurrentTime / playbackDuration) * 100)
      : 0;

  return (
    <>
      <ReadingSessionNav />
      <footer
        data-playing={isPlaying}
        className={cn(
          /* `my-3` (not `sm:mb-0 sm:mt-3`) keeps the gap above the player equal to
           the gap below it at every breakpoint. Asymmetric margins made the top
           edge sit flush against the content above on tablets, and the 8px
           mobile gap was swallowed by the player's outer glow. */
          "mobile-player liquid-glass dynamic-island isolate z-40 mx-auto my-3 flex h-[68px] w-full min-w-0 max-w-[28rem] shrink-0 items-center gap-2 self-center overflow-hidden rounded-[1.6rem] border border-white/[0.1] px-2.5 transition-all duration-300 sm:h-auto sm:w-auto sm:max-w-none sm:rounded-none sm:border-x-0 sm:border-b-0 sm:px-4 sm:gap-3 lg:w-[min(92vw,760px)] lg:rounded-[2rem] lg:border lg:border-white/10 lg:px-3 lg:py-2 lg:shadow-[0_18px_60px_rgba(0,0,0,0.38)] lg:hover:scale-[1.01]",
          compact
            ? "sm:min-h-[60px] lg:min-h-[52px] lg:py-1"
            : "sm:min-h-[76px] lg:min-h-[68px] lg:py-2",
        )}
      >
        <div
          className="mobile-island-aura pointer-events-none absolute inset-0"
          aria-hidden="true"
        />

        {/* now playing */}
        <div className="relative z-10 flex min-w-0 flex-1 items-center gap-2 sm:max-w-[34%] sm:gap-3 lg:max-w-[230px] lg:flex-none lg:basis-[230px]">
          {/* The artwork IS the expand target on a phone. Tapping the cover to
              open the now-playing view is the gesture people already reach for,
              and a 40px cover is a far larger hit area than the small maximize
              button on the other side of the island. It is a real button, so it
              is also reachable by keyboard and announced by a screen reader. */}
          <button
            type="button"
            aria-label="Open full-screen player"
            onClick={() => setFullscreen(true)}
            className="mobile-player-art touch-manipulation relative size-10 shrink-0 overflow-hidden rounded-[0.9rem] shadow-lg ring-1 ring-white/15 transition-transform active:scale-95 sm:size-11 lg:size-10 lg:rounded-md"
          >
            <img
              src={current.coverUrl}
              alt=""
              className="size-full object-cover"
            />
            {isBuffering && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                <Loader2 className="size-4 animate-spin text-white" />
              </div>
            )}
          </button>
          <div className="min-w-0 flex-1 overflow-hidden">
            <div className="flex min-w-0 items-center gap-1.5">
              <p
                className={cn(
                  "min-w-0 flex-1 truncate text-sm font-semibold",
                  isPlaying && "text-[rgb(var(--tint))]",
                )}
              >
                {current.title}
              </p>
              <span className="mobile-live-cue" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
            </div>
            {autoMixIndicator && (
              <span
                className="mt-0.5 hidden max-w-full truncate rounded-full border border-[rgb(var(--tint)_/_0.35)] bg-[rgb(var(--tint)_/_0.12)] px-1.5 py-px text-[10px] font-semibold tracking-wide text-[rgb(var(--tint))] sm:inline-block"
                title={autoMixIndicator}
              >
                {autoMixIndicator}
              </span>
            )}
            <p className="block truncate text-xs text-muted-foreground">
              {/* Tapping the artist is the fastest route to more of the same.
                It was static text, so finding an artist's other songs meant
                going back to search and typing the name by hand. Renders as
                plain text when the track has no usable artist, rather than a
                link that dead-ends into an empty result list. */}
              {artistQuery ? (
                <button
                  type="button"
                  onClick={() =>
                    void navigate(
                      `/search?q=${encodeURIComponent(artistQuery)}`,
                    )
                  }
                  className="block max-w-full truncate text-left transition-colors hover:text-foreground hover:underline"
                >
                  {current.artistName}
                </button>
              ) : (
                <span className="block max-w-full truncate">
                  {current.artistName}
                </span>
              )}
            </p>
          </div>
          {/* Like lives in the fullscreen player — the mobile bar only needs
            play controls; keeping it here squeezed the title into the
            transport buttons and they collided on small screens. */}
          <button
            type="button"
            aria-label={
              isLiked ? "Remove from liked songs" : "Add to liked songs"
            }
            onClick={() => {
              toggleLike(current.id);
              setLikePulse(true);
              setTimeout(() => setLikePulse(false), 400);
            }}
            className={cn(
              "hidden shrink-0 rounded-full p-1.5 transition-all hover:scale-110 lg:block",
              isLiked
                ? "text-[rgb(var(--tint))]"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Heart
              className={cn(
                "size-4 transition-transform duration-300",
                isLiked && "fill-current scale-110",
                likePulse && "animate-ping-once",
              )}
            />
          </button>
        </div>

        {/* transport + seek — timestamps are desktop-only; on mobile the
            seekbar sits alone so prev/play/next never collide with them */}
        <div className="relative z-10 flex w-auto shrink-0 flex-col items-center gap-0.5 sm:min-w-0 sm:flex-1 sm:basis-0 lg:min-w-0">
          <TransportControls className="sm:hidden" compact />
          <TransportControls className="hidden sm:grid" />
          <div className="hidden w-full max-w-xl items-center gap-2 sm:flex">
            <span className="w-11 shrink-0 text-right text-[10px] font-medium tabular-nums text-muted-foreground">
              {formatTime(currentTime)}
            </span>
            <SeekBar className="min-w-0 flex-1" />
            <span className="w-11 shrink-0 text-[10px] font-medium tabular-nums text-muted-foreground">
              {formatTime(duration || current.duration)}
            </span>
          </div>
        </div>

        {/* right cluster — desktop keeps the status chips + queue + volume +
            expand. The mobile bar is a 68px island holding art, title, the
            transport and the expand chevron, and the footer clips overflow:
            the sleep and intro-trim chips are wide text pills, so with both
            armed they pushed the transport out from under them. They are
            hidden below `sm` and both controls have a home in the fullscreen
            player, which is one tap away on a phone. */}
        <div className="relative z-10 flex w-auto shrink-0 items-center justify-end gap-0.5">
          <SleepTimerChip />
          <IntroTrimChip />
          <button
            type="button"
            aria-label="Open queue"
            onClick={() => setQueueOpen(!queueOpen)}
            className={cn(
              "hidden rounded-full p-2 transition-colors hover:bg-white/[0.06] sm:block lg:p-1.5",
              queueOpen
                ? "text-[rgb(var(--tint))]"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <ListMusic className="size-4" />
          </button>
          <VolumeControl className="hidden md:flex lg:scale-90 lg:origin-right" />
          <button
            type="button"
            aria-label="Open full-screen player"
            onClick={() => setFullscreen(true)}
            className="mobile-expand-button touch-manipulation rounded-full p-2 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground active:scale-90"
          >
            <Maximize2 className="size-4" />
          </button>
        </div>

        <div
          className="mobile-player-progress"
          role="progressbar"
          aria-label="Playback progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(playbackProgress)}
          aria-valuetext={`${formatTime(safeCurrentTime)} of ${formatTime(playbackDuration)}`}
        >
          <span style={{ transform: `scaleX(${playbackProgress / 100})` }} />
        </div>
      </footer>
    </>
  );
}
