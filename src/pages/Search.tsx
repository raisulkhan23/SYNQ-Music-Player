import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";

import { RemoteTrackRow } from "@/components/tracks/RemoteTrackRow";
import { SoundCloudResults } from "@/components/search/SoundCloudResults";
import { api } from "@/convex/_generated/api";
import { toPlayableYoutube } from "@/lib/playable";
import { cleanArtistName, type YtItem } from "@/lib/youtube";
import { usePlayerStore } from "@/store/player";
import { track as trackEvent } from "@/lib/analytics";
import { GravitySponsor } from "@/components/ads/GravitySponsor";
import { detectVersions, versionLabel, buildSuggestions } from "@/lib/searchRelevance";
import { useAction } from "convex/react";
import {
  Dices,
  Loader2,
  RefreshCw,
  Search as SearchIcon,
  SearchX,
  Globe,
  Music2,
  Play,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

const MOOD_CHIPS = [
  "Chill",
  "Happy",
  "Sad",
  "Energetic",
  "Focus",
  "Workout",
  "Party",
  "Sleep",
  "Romantic",
  "Nostalgic",
];

const GENRE_CHIPS = [
  "Pop",
  "Hip-hop",
  "Rock",
  "R&B",
  "Electronic",
  "Indie",
  "Jazz",
  "Classical",
  "Lo-fi",
  "Metal",
  "Country",
  "Reggaeton",
  "Afrobeats",
  "K-pop",
  "Ambient",
  "Funk",
];

/** Map a mood chip to a search query that surfaces matching music. */
const MOOD_QUERIES: Record<string, string> = {
  Chill: "chill songs",
  Happy: "happy songs",
  Sad: "sad songs",
  Energetic: "energetic songs",
  Focus: "focus songs",
  Workout: "workout songs",
  Party: "party songs",
  Sleep: "sleep songs",
  Romantic: "romantic songs",
  Nostalgic: "nostalgic songs",
};
/**
 * Curated mixes shown on the empty-search browse view. Each plays a live
 * queue built from a search across our music sources — one tap, no setup.
 */
const POPULAR_MIXES = [
  {
    id: "top-hits",
    title: "Today's Top Hits",
    desc: "The biggest songs on the planet right now.",
    query: "top hits today",
    gradient: "from-sky-500/30 via-blue-500/15 to-transparent",
  },
  {
    id: "rap-caviar",
    title: "RapCaviar",
    desc: "The hottest hip-hop and rap, updated constantly.",
    query: "hip hop rap hits",
    gradient: "from-red-500/30 via-orange-500/15 to-transparent",
  },
  {
    id: "chill",
    title: "Chill Vibes",
    desc: "Relaxed tracks to unwind, study, and drift to.",
    query: "chill relaxing songs",
    gradient: "from-teal-500/30 via-emerald-500/15 to-transparent",
  },
  {
    id: "party",
    title: "Party Starters",
    desc: "Certified bangers to get the room moving.",
    query: "party dance hits",
    gradient: "from-fuchsia-500/30 via-purple-500/15 to-transparent",
  },
  {
    id: "throwback",
    title: "All Out Throwbacks",
    desc: "Greatest hits of the 2000s and 2010s.",
    query: "2000s 2010s greatest hits",
    gradient: "from-amber-500/30 via-yellow-500/15 to-transparent",
  },
  {
    id: "indie",
    title: "Indie Pulse",
    desc: "Fresh indie sounds from rising voices.",
    query: "indie hits",
    gradient: "from-rose-500/30 via-pink-500/15 to-transparent",
  },
  {
    id: "lofi",
    title: "Late Night Lo-fi",
    desc: "Mellow beats for late nights and deep focus.",
    query: "lo-fi beats late night",
    gradient: "from-indigo-500/30 via-slate-500/15 to-transparent",
  },
  {
    id: "workout",
    title: "Beast Mode",
    desc: "High-energy tracks built for the gym.",
    query: "workout energy hits",
    gradient: "from-lime-500/30 via-green-500/15 to-transparent",
  },
  {
    id: "daily-discovery",
    title: "Daily Discovery",
    desc: "A fresh batch of songs worth hearing today.",
    query: "new music discoveries today",
    gradient: "from-cyan-500/30 via-sky-500/15 to-transparent",
  },
  {
    id: "global-vibes",
    title: "Global Sounds",
    desc: "Latin, African, Asian and worldwide favorites.",
    query: "worldwide music hits",
    gradient: "from-orange-500/30 via-rose-500/15 to-transparent",
  },
  {
    id: "deep-focus",
    title: "Deep Focus",
    desc: "Instrumental textures for concentration and flow.",
    query: "instrumental focus music",
    gradient: "from-blue-500/30 via-indigo-500/15 to-transparent",
  },
  {
    id: "after-hours",
    title: "After Hours",
    desc: "Smooth R&B and soul for the quiet hours.",
    query: "r&b soul after hours",
    gradient: "from-violet-500/30 via-purple-500/15 to-transparent",
  },
  {
    id: "acoustic-sunrise",
    title: "Acoustic Sunrise",
    desc: "Easy acoustic songs for starting the day.",
    query: "acoustic morning songs",
    gradient: "from-yellow-500/30 via-orange-500/15 to-transparent",
  },
  {
    id: "electronic-energy",
    title: "Electronic Energy",
    desc: "Fresh electronic sounds to move to right now.",
    query: "electronic dance music hits",
    gradient: "from-emerald-500/30 via-cyan-500/15 to-transparent",
  },
  {
    id: "retro-arcade",
    title: "Retro Arcade",
    desc: "Bright synths and nostalgic hooks on repeat.",
    query: "retro synth pop hits",
    gradient: "from-pink-500/30 via-fuchsia-500/15 to-transparent",
  },
  {
    id: "global-peace",
    title: "Peaceful World",
    desc: "Calm, expansive sounds for reset and reflection.",
    query: "calm ambient world music",
    gradient: "from-teal-500/30 via-blue-500/15 to-transparent",
  },
  {
    id: "viral",
    title: "Viral Right Now",
    desc: "The songs taking over every feed today.",
    query: "viral songs this week",
    gradient: "from-pink-500/30 via-rose-500/15 to-transparent",
  },
  {
    id: "rnb-vibes",
    title: "R&B After Dark",
    desc: "Smooth late-night R&B with a little bounce.",
    query: "r&b vibes after dark",
    gradient: "from-fuchsia-500/30 via-purple-500/15 to-transparent",
  },
  {
    id: "indie-discovery",
    title: "Indie Discovery",
    desc: "The next favorite artist is already here.",
    query: "new indie artists discovery",
    gradient: "from-lime-500/30 via-emerald-500/15 to-transparent",
  },
  {
    id: "dance-floor",
    title: "Dance Floor",
    desc: "Big hooks, bright lights, no warm-up needed.",
    query: "dance pop party hits",
    gradient: "from-cyan-500/30 via-blue-500/15 to-transparent",
  },
  {
    id: "acoustic-slow",
    title: "Acoustic Slowdown",
    desc: "Stripped-back songs for a softer pace.",
    query: "acoustic chill songs",
    gradient: "from-orange-500/30 via-amber-500/15 to-transparent",
  },
  {
    id: "90s",
    title: "90s Forever",
    desc: "The songs that still own the aux.",
    query: "90s hits classics",
    gradient: "from-purple-500/30 via-indigo-500/15 to-transparent",
  },
  {
    id: "00s",
    title: "00s Rewind",
    desc: "Early pop, R&B, and hip-hop essentials.",
    query: "2000s music hits",
    gradient: "from-blue-500/30 via-sky-500/15 to-transparent",
  },
  {
    id: "feel-good",
    title: "Feel Good Frequency",
    desc: "Instant mood-lifting songs, no skips.",
    query: "feel good upbeat songs",
    gradient: "from-yellow-500/30 via-orange-500/15 to-transparent",
  },
  {
    id: "global-pop",
    title: "Global Pop",
    desc: "Bright pop favorites from around the world.",
    query: "international pop hits",
    gradient: "from-cyan-500/30 via-teal-500/15 to-transparent",
  },
  {
    id: "soft-edges",
    title: "Soft Edges",
    desc: "Warm, hazy songs for the in-between moments.",
    query: "dreamy chill music",
    gradient: "from-violet-500/30 via-indigo-500/15 to-transparent",
  },
  {
    id: "new-music",
    title: "New Music Radar",
    desc: "Fresh tracks from the artists on the rise.",
    query: "best new music this week",
    gradient: "from-rose-500/30 via-pink-500/15 to-transparent",
  },
] as const;

const POPULAR_MIX_REFRESH_INTERVAL = 12 * 60 * 60 * 1000;
const POPULAR_MIX_REFRESH_KEY = "synq:popular-mixes-refreshed-at";
const POPULAR_MIX_COUNT = 10;
function popularMixCycle() {
  const now = Date.now();
  if (typeof window === "undefined")
    return Math.floor(now / POPULAR_MIX_REFRESH_INTERVAL);

  try {
    const stored = Number(window.localStorage.getItem(POPULAR_MIX_REFRESH_KEY));
    if (!stored || now - stored >= POPULAR_MIX_REFRESH_INTERVAL) {
      window.localStorage.setItem(POPULAR_MIX_REFRESH_KEY, String(now));
      return Math.floor(now / POPULAR_MIX_REFRESH_INTERVAL);
    }
    return Math.floor(stored / POPULAR_MIX_REFRESH_INTERVAL);
  } catch {
    return Math.floor(now / POPULAR_MIX_REFRESH_INTERVAL);
  }
}

function usePopularMixCycle() {
  const [cycle, setCycle] = useState(popularMixCycle);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setCycle(popularMixCycle());
    }, 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  return cycle;
}

function MixCard({ mix }: { mix: (typeof POPULAR_MIXES)[number] }) {
  const searchYt = useAction(api.youtube.searchYoutube);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const [loading, setLoading] = useState(false);

  const play = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const runSearch = async (candidate: string) => {
        try {
          return await searchYt({ query: candidate });
        } catch {
          return { items: [] as YtItem[], failed: true };
        }
      };
      // Each mix plays ITS OWN query and nothing else.
      //
      // This used to retry with the generic query "top songs" whenever the
      // mix's own query came back empty. That made every broken card converge
      // on one identical result — which is why unrelated mixes all started
      // "playing the same song" — and it hid the real reason a mix failed.
      // The backend already expands a broad mix query into several
      // artist-backed seeds, so the single query below is the whole request.
      const response = await runSearch(mix.query);
      const items = response.items;
      if (items.length === 0) {
        toast.error(
          response.failed
            ? "Couldn't reach our music sources — try again in a moment"
            : "Couldn't load this mix — try another one",
        );
        return;
      }
      const queue = items
        .slice(0, 15)
        .map((it, i) => toPlayableYoutube(it, it.id, items.slice(i + 1)));
      playTrack(queue[0], queue);
      toast.success(`Playing ${mix.title}`);
    } catch {
      toast.error("Couldn't load this mix — try again");
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void play()}
      className={cn(
        "group relative flex h-36 w-36 shrink-0 flex-col justify-end overflow-hidden rounded-2xl border border-white/20 bg-gradient-to-br p-3.5 text-left outline outline-1 outline-white/10 ring-1 ring-white/10 transition-[transform,border-color,outline-color,box-shadow] hover:scale-[1.03] hover:border-white/40 hover:outline-white/20 hover:ring-white/25 sm:w-44",
        mix.gradient,
      )}
    >
      <span className="absolute top-3 right-3 flex size-8 items-center justify-center rounded-full bg-black/50 text-foreground opacity-0 backdrop-blur transition-opacity group-hover:opacity-100">
        {loading ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Play className="size-4 fill-current" />
        )}
      </span>
      <span className="font-display text-sm font-bold tracking-tight sm:text-base">
        {mix.title}
      </span>
      <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
        {mix.desc}
      </span>
    </button>
  );
}

export default function Search() {
  // Shared links open with ?q=… pre-filled — share → open → play.
  const [searchParams, setSearchParams] = useSearchParams();
  const sharedQuery = searchParams.get("q");
  const [typedQuery, setTypedQuery] = useState("");
  /**
   * Adopt a query and clear the `?q=` it may have come from.
   *
   * The param used to be read once in a useState initialiser and then wiped
   * from the URL in an effect. That initializer only ever runs on mount, so a
   * `?q=` arriving while the page was ALREADY open was thrown away and then
   * erased — which is exactly what tapping the artist in the player bar does
   * when the user is on the search page. The query is now derived from the URL
   * on every render, so the link works from any page, any number of times.
   */
  const applyQuery = useCallback(
    (next: string) => {
      setTypedQuery(next);
      if (searchParams.has("q")) setSearchParams({}, { replace: true });
    },
    [searchParams, setSearchParams],
  );
  /** The URL wins while it is present, so a fresh link beats stale typing. */
  const query = sharedQuery ?? typedQuery;
  const [ytResults, setYtResults] = useState<YtItem[] | null>(null);
  // Kept separate from the primary Songs results by design. These uploads
  // must never be merged into the first result list or its radio queue.
  const [lyricResults, setLyricResults] = useState<YtItem[] | null>(null);
  const [lyricSearching, setLyricSearching] = useState(false);
  /**
   * True when the lyric/lo-fi lookup FAILED, as opposed to genuinely finding
   * nothing. These were collapsed into one case, and because the section is
   * hidden when empty, any transient error made the whole Lyric & lo-fi block
   * vanish with no message and no way to retry — which looks exactly like the
   * feature having been removed.
   */
  const [lyricFailed, setLyricFailed] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  // Drop ?q= from the URL after it has been consumed (no setState in effect).
  const startRadio = usePlayerStore((s) => s.startRadio);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const searchYt = useAction(api.youtube.searchYoutube);
  const searchLyricVideos = useAction(api.youtube.searchLyricVideos);

  const debouncedQuery = useDebounced(query, 450);

  // Search history — persisted locally, capped at 8 entries.
  const [searchHistory, setSearchHistory] = useState<string[]>(() => {
    try {
      return JSON.parse(
        localStorage.getItem("ss.searchHistory") ?? "[]",
      ) as string[];
    } catch {
      return [];
    }
  });
  /** Record a query in the local search history (called when a search runs). */
  const rememberQuery = useCallback((raw: string) => {
    const q = raw.trim();
    if (q.length < 2) return;
    setSearchHistory((prev) => {
      const next = [q, ...prev.filter((h) => h !== q)].slice(0, 8);
      try {
        localStorage.setItem("ss.searchHistory", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);
  const clearSearchHistory = () => {
    setSearchHistory([]);
    localStorage.removeItem("ss.searchHistory");
  };

  // Live YouTube search, debounced.
  useEffect(() => {
    const q = debouncedQuery.trim();
    const run = () => {
      if (!q) {
        setYtResults(null);
        setLyricResults(null);
        setLyricFailed(false);
        setSearchError(null);
        setSearching(false);
        setLyricSearching(false);
        return;
      }
      let cancelled = false;
      let retryTimer: number | undefined;
      setSearching(true);
      setLyricSearching(true);
      // Cleared up-front so a retry cannot leave the previous run's error
      // sitting next to fresh results.
      setLyricFailed(false);
      setSearchError(null);
      rememberQuery(q);
      trackEvent("search_performed", { query: q.slice(0, 120) });
      const requestPrimary = (attempt: number) => {
        // The user's query goes to the backend VERBATIM, always. An earlier
        // version silently retried with the generic query "top songs" whenever
        // a specific search came back empty — which is exactly how unrelated
        // popular tracks ended up on screen for a precise query like "we dont
        // talk anymore". The fallback is now a genuine relaxation of THIS
        // query, never a different one.
        searchYt({ query: q })
          .then(({ items, failed }) => {
            if (cancelled) return;
            // `failed` is checked FIRST, deliberately. When the music
            // catalogue is unreachable the backend may still return generic
            // "[Official Video]" uploads from the video fallback; showing
            // those as "Top matches" is exactly the wrong-answer behaviour
            // this ranking pass exists to stop.
            if (failed) {
              setYtResults([]);
              setSearching(false);
              setSearchError(
                "We couldn't reach our music catalogue just now, so this isn't a real answer about your search. Usually temporary — try again in a moment.",
              );
              trackEvent("search_results", {
                query: q.slice(0, 120),
                result_count: 0,
                failed: true,
              });
              return;
            }
            if (items.length > 0) {
              finish(items, false);
              return;
            }
            // Answered, and genuinely nothing matched. The backend has already
            // relaxed progressively over the pool it fetched, so there is
            // nothing further to try here — show the honest empty state
            // rather than substituting unrelated content.
            finish([], false);
          })
          .catch(() => {
            if (cancelled) return;
            if (attempt < 1) {
              retryTimer = window.setTimeout(() => requestPrimary(attempt + 1), 400);
              return;
            }
            setYtResults([]);
            setSearching(false);
            setSearchError(
              "Couldn't reach our music sources right now. Try again in a moment.",
            );
          });
      };
      const finish = (items: YtItem[], usedRelaxed: boolean) => {
        if (cancelled) return;
        setYtResults(items);
        setSearching(false);
        trackEvent("search_results", {
          query: q.slice(0, 120),
          result_count: items.length,
          used_fallback: usedRelaxed,
        });
      };
      requestPrimary(0);
      // The original query is sent unchanged. The backend derives its own
      // narrowly scoped lyric-video query and keeps these results separate.
      searchLyricVideos({ query: q })
        .then(({ items, failed }) => {
          if (cancelled) return;
          setLyricResults(items);
          setLyricFailed(failed);
        })
        .catch(() => {
          if (cancelled) return;
          setLyricResults([]);
          setLyricFailed(true);
        })
        .finally(() => {
          if (!cancelled) setLyricSearching(false);
        });
      return () => {
        cancelled = true;
        if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      };
    };
    run();
  }, [
    debouncedQuery,
    searchYt,
    searchLyricVideos,
    retryKey,
    rememberQuery,
  ]);

  const playRemote = useCallback(
    (item: YtItem) => {
      // Start the clicked song, then fill the queue with songs from the SAME
      // search (same genre/vibe) — never the raw result list, which is full
      // of duplicate uploads, and never generic "similar artist" filler.
      trackEvent("search_result_played", {
        query: (debouncedQuery || query).slice(0, 120),
        track_id: item.id,
        title: item.title.slice(0, 120),
        artist: cleanArtistName(item.artist, item.title).slice(0, 120),
      });
      void startRadio(
        toPlayableYoutube(item, item.id),
        debouncedQuery || query,
      );
    },
    [startRadio, debouncedQuery, query],
  );

  const hasQuery = query.trim().length > 0;
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  /**
   * Type-ahead suggestions drawn from metadata already in memory — loaded
   * result titles/artists plus this device's search history. Deliberately no
   * extra request per keystroke: the debounced search below already returns
   * exactly this metadata a moment later.
   */
  const suggestions = useMemo(() => {
    const typed = query.trim();
    if (typed.length < 2) return [] as string[];
    const candidates: string[] = [];
    for (const item of ytResults ?? []) {
      candidates.push(item.title);
      if (item.artist) candidates.push(item.artist);
    }
    for (const item of lyricResults ?? []) candidates.push(item.title);
    for (const entry of searchHistory) candidates.push(entry);
    return buildSuggestions(typed, candidates, 6);
  }, [query, ytResults, lyricResults, searchHistory]);
  const [surpriseLoading, setSurpriseLoading] = useState(false);
  const surpriseMe = async () => {
    if (surpriseLoading) return;
    const pick = MOOD_CHIPS[Math.floor(Math.random() * MOOD_CHIPS.length)];
    // Use the actual search phrase, not just the chip label. The label alone
    // used to leave the search view in a query state that could return no
    // catalog rows; the phrase is also what the discovery search understands.
    const surpriseQuery = MOOD_QUERIES[pick] ?? `${pick} songs`;
    applyQuery(surpriseQuery);
    // A repeated random pick can be the current query. Bump the retry key so
    // the effect still starts a fresh request instead of relying on a state
    // change that React may bail out of.
    setRetryKey((key) => key + 1);
    setSurpriseLoading(true);

    try {
      let items: YtItem[] = [];
      let playedQuery = surpriseQuery;
      // Search the chosen mood only. This used to fall back to the generic
      // query "top songs", which meant "Surprise me" kept picking the same
      // song and only claimed to be random.
      try {
        const result = await searchYt({ query: surpriseQuery });
        if (result.items.length > 0) {
          items = result.items;
          playedQuery = surpriseQuery;
        }
      } catch {
        // Fall through to the "no playable results" error below.
      }
      if (items.length === 0) throw new Error("No playable results");

      const queue = items
        .slice(0, 15)
        .map((item) => toPlayableYoutube(item, item.id));
      const selected = queue[Math.floor(Math.random() * queue.length)];
      trackEvent("surprise_played", {
        query: playedQuery,
        track_id: selected.id,
        title: selected.title.slice(0, 120),
      });
      playTrack(selected, queue);
      toast.success(`Playing ${pick}: ${selected.title}`);
    } catch {
      toast.error("Couldn't find a surprise track right now");
    } finally {
      setSurpriseLoading(false);
    }
  };
  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
            Search
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Find any song — search across all our music sources and stream it
            instantly.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void surpriseMe()}
          disabled={surpriseLoading}
          className="inline-flex w-fit items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:border-[rgb(var(--tint)_/_0.4)] hover:bg-[rgb(var(--tint)_/_0.1)] hover:text-foreground disabled:cursor-wait disabled:opacity-60"
        >
          {surpriseLoading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-[rgb(var(--tint))]" />
          ) : (
            <Dices className="h-3.5 w-3.5 text-[rgb(var(--tint))]" />
          )}
          Surprise me
        </button>
      </header>

      {/* search input. `z-20` puts the whole input + suggestions group above
          the results section, so no result row can ever paint over the open
          dropdown (result rows are themselves `relative`). */}
      <div className="relative z-20 max-w-xl">
        <SearchIcon className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-muted-foreground" />
        <input
          autoFocus
          value={query}
          role="combobox"
          aria-expanded={suggestOpen}
          aria-controls="synq-search-suggestions"
          aria-autocomplete="list"
          onChange={(e) => {
            setActiveSuggestion(-1);
            applyQuery(e.target.value);
          }}
          onFocus={() => setSuggestOpen(true)}
          onBlur={() => setSuggestOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setSuggestOpen(false);
              return;
            }
            if (!suggestions.length || !suggestOpen) return;
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActiveSuggestion((i) => (i + 1) % suggestions.length);
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActiveSuggestion((i) =>
                i <= 0 ? suggestions.length - 1 : i - 1,
              );
            } else if (e.key === "Enter" && activeSuggestion >= 0) {
              e.preventDefault();
              const pick = suggestions[activeSuggestion];
              setSuggestOpen(false);
              if (pick) applyQuery(pick);
            }
          }}
          placeholder="Search a song, artist or album…"
          className="h-12 w-full rounded-full border border-white/10 bg-white/[0.05] pr-12 pl-12 text-[15px] text-foreground placeholder:text-muted-foreground/70 focus:border-[rgb(var(--tint)_/_0.6)] focus:ring-2 focus:ring-[rgb(var(--tint)_/_0.25)] focus:outline-none"
        />
        {searching && (
          <Loader2 className="absolute top-1/2 right-4 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
        {!searching && hasQuery && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => applyQuery("")}
            className="absolute top-1/2 right-3 flex size-7 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
        {/* Suggestions are built from titles/artists already in memory, so
            they cost no extra request. `onMouseDown` prevents the default so
            the input does not blur before the click lands. */}
        {suggestOpen && suggestions.length > 0 && (
          <ul
            id="synq-search-suggestions"
            role="listbox"
            // This panel MUST be opaque. It used to ask for
            // `bg-[rgb(var(--panel))]`, but no `--panel` custom property is
            // defined anywhere in the theme — so the declaration was invalid,
            // the background silently fell back to transparent, and the whole
            // result list (titles, artist names, artwork) bled straight
            // through the open dropdown. `--panel` -> `bg-popover`, which is
            // an opaque theme token in every mode. `z-50` + `isolate` keep it
            // above the results section and out of the caller's stacking
            // context; the blur is gone because there is nothing to blur once
            // the surface is solid.
            className="isolate absolute top-full right-0 left-0 z-50 mt-1.5 overflow-hidden rounded-2xl border border-white/10 bg-popover py-1 shadow-2xl shadow-black/40 ring-1 ring-black/20"
          >
            {suggestions.map((suggestion, i) => (
              <li key={suggestion} role="option" aria-selected={i === activeSuggestion}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setSuggestOpen(false);
                    applyQuery(suggestion);
                  }}
                  onMouseEnter={() => setActiveSuggestion(i)}
                  className={cn(
                    "flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm transition-colors",
                    i === activeSuggestion
                      ? "bg-white/[0.08] text-foreground"
                      : "text-muted-foreground hover:bg-white/[0.05]",
                  )}
                >
                  <SearchIcon className="size-3.5 shrink-0 opacity-60" />
                  <span className="truncate">{suggestion}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {!hasQuery ? (
        <>
          {searchHistory.length > 0 && (
            <section>
              <div className="mb-2 flex items-center justify-between">
                <h2 className="font-display text-sm font-semibold tracking-widest text-muted-foreground uppercase">
                  Recent searches
                </h2>
                <button
                  type="button"
                  onClick={clearSearchHistory}
                  className="text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  Clear
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {searchHistory.map((h) => (
                  <button
                    key={h}
                    type="button"
                    onClick={() => applyQuery(h)}
                    className="rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-1.5 text-sm text-muted-foreground transition-colors hover:border-[rgb(var(--tint)_/_0.4)] hover:text-foreground"
                  >
                    {h}
                  </button>
                ))}
              </div>
            </section>
          )}
          <BrowseView onPick={applyQuery} />
        </>
      ) : (
        <div className="flex flex-col gap-10">
          <section>
            {/* Ranked matches, not "related" content. The old heading told the
                user these were loosely related when the list is in fact the
                ordered answer to their exact query. */}
            <div className="mb-2 flex items-center gap-2">
              <Globe className="size-4 text-[rgb(var(--tint))]" />
              <h2 className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
                {ytResults && ytResults.length > 0
                  ? `Top matches (${ytResults.length})`
                  : "Top matches"}
              </h2>
            </div>

            {searching ? (
              <div className="flex flex-col gap-0.5">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 rounded-xl px-3 py-2"
                  >
                    <div className="size-10 animate-pulse rounded-md bg-white/[0.05]" />
                    <div className="flex-1 space-y-2">
                      <div className="h-3.5 w-2/3 animate-pulse rounded bg-white/[0.05]" />
                      <div className="h-3 w-1/3 animate-pulse rounded bg-white/[0.05]" />
                    </div>
                  </div>
                ))}
              </div>
            ) : searchError ? (
              <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-white/10 py-12 text-center">
                <SearchX className="size-8 text-muted-foreground/40" />
                <p className="max-w-sm text-sm text-muted-foreground">
                  {searchError}
                </p>
                <button
                  type="button"
                  onClick={() => setRetryKey((k) => k + 1)}
                  className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium transition-colors hover:bg-white/[0.08]"
                >
                  <RefreshCw className="size-3.5" />
                  Try again
                </button>
              </div>
            ) : ytResults !== null && ytResults.length === 0 ? (
              /* An honest empty state. The old one asserted a single cause
                 ("try a different spelling") for what can be four different
                 problems, and gave the user no next action. */
              <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-white/10 px-6 py-12 text-center">
                <SearchX className="size-8 text-muted-foreground/40" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-foreground">
                    No results for “{query.trim()}”
                  </p>
                  <p className="text-sm text-muted-foreground">
                    We searched our music catalogue. Try:
                  </p>
                </div>
                <ul className="space-y-1 text-left text-sm text-muted-foreground">
                  <li>· Check the spelling</li>
                  <li>· Search the song title on its own</li>
                  <li>· Try the artist name instead</li>
                  <li>· Try fewer words</li>
                  <li>
                    · Add a version — “live”, “remix”, “cover”, “slowed” or
                    “lyrics”
                  </li>
                </ul>
              </div>
            ) : (
              <div className="flex flex-col gap-0.5">
                {/* Contextual sponsor slot: one clearly-labelled card, after
                    the third result, so it never crowds the first songs a
                    user is actually looking for. Renders nothing when unset. */}
                {ytResults?.map((item, i) => (
                  <div key={item.id}>
                    {i === 2 && hasQuery ? (
                      <GravitySponsor
                        context={query.trim()}
                        placement="search_results"
                        className="my-3"
                      />
                    ) : null}
                    <RemoteTrackRow
                      item={item}
                      index={i + 1}
                      onPlay={playRemote}
                      badge={
                        (() => {
                          const versions = detectVersions(item.title);
                          return versions.length > 0
                            ? versionLabel(versions[0])
                            : undefined;
                        })()
                      }
                    />
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* SoundCloud is a first-class playable source (unlike Jamendo, which
              stayed a discovery index): its rows play from SoundCloud's own
              progressive streams through the decks. Rendered whenever there is
              something to look for; it owns its loading and failure states. */}
          {hasQuery ? <SoundCloudResults query={query} /> : null}

          {/* Jamendo is intentionally NOT rendered here.
              Creative Commons discovery lives behind the header CC switch,
              which is server-verified against YouTube's licence field. Jamendo
              repeated a second licence story, a second empty state and a third
              silent-empty failure mode underneath the primary results. */}

          {/*
            Rendered whenever the lookup has SETTLED — not only when it found
            something. The old condition was
            `!lyricSearching && lyricResults?.length > 0`, so a failed lookup
            (which the backend reported as an empty list) removed the entire
            section with no explanation. Two genuinely different outcomes now
            get two genuinely different messages, and a failure offers a retry.
          */}
          {!lyricSearching && lyricResults !== null && (
            <section aria-labelledby="lyric-video-results-heading">
              <div className="mb-2 flex items-center gap-2">
                <Music2 className="size-4 text-[rgb(var(--tint))]" />
                <h2
                  id="lyric-video-results-heading"
                  className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase"
                >
                  Lyric & lo-fi videos
                </h2>
                <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-muted-foreground">
                  Separate uploads
                </span>
              </div>

              {lyricResults.length === 0 ? (
                lyricFailed ? (
                  <div className="flex flex-wrap items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5">
                    <p className="min-w-0 flex-1 text-xs text-muted-foreground">
                      Couldn&apos;t reach YouTube for lyric and lo-fi uploads.
                      The Songs results above are unaffected.
                    </p>
                    <button
                      type="button"
                      onClick={() => setRetryKey((k) => k + 1)}
                      className="shrink-0 rounded-full border border-white/10 px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
                    >
                      Try again
                    </button>
                  </div>
                ) : (
                  // Genuinely nothing matched the filter, which is a real and
                  // common answer — the filter is deliberately strict so these
                  // uploads never contaminate the Songs results.
                  <p className="text-xs text-muted-foreground">
                    No separate lyric or lo-fi uploads for this search. Only
                    closely matching uploads are listed here, so an empty result
                    is normal.
                  </p>
                )
              ) : (
                <>
                  <p className="mb-2 text-xs text-muted-foreground">
                    Carefully filtered music and lyric uploads. These are not
                    mixed into the Songs results above.
                  </p>
                  <div className="flex flex-col gap-0.5">
                    {lyricResults.map((item, i) => (
                      <RemoteTrackRow
                        key={`lyric-${item.id}`}
                        item={item}
                        index={i + 1}
                        onPlay={playRemote}
                      />
                    ))}
                  </div>
                </>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
}

/** Debounce a value with a trailing delay. */
function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

function BrowseView({ onPick }: { onPick: (q: string) => void }) {
  const mixCycle = usePopularMixCycle();
  const popularMixes = useMemo(() => {
    const start = (mixCycle * 3) % POPULAR_MIXES.length;
    return [
      ...POPULAR_MIXES.slice(start, start + POPULAR_MIX_COUNT),
      ...POPULAR_MIXES.slice(
        0,
        Math.max(0, start + POPULAR_MIX_COUNT - POPULAR_MIXES.length),
      ),
    ];
  }, [mixCycle]);

  return (
    <div className="flex flex-col gap-10">
      <section>
        <h2 className="mb-3 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
          Popular mixes
        </h2>
        {/* The visible scrollbar is 8px tall and lives INSIDE the element's
            padding box, so the old `pb-2` put the card bottoms flush against
            the scrollbar track and left the caption 8px below that. The
            padding now reserves a band for the scrollbar and the caption gets
            its own air, so nothing crowds anything. */}
        <div className="slider-rail -mx-4 flex gap-3 overflow-x-auto px-4 pt-0.5 pb-4">
          {popularMixes.map((mix) => (
            <MixCard key={mix.id} mix={mix} />
          ))}
        </div>
        <p className="mt-1 text-[10px] text-muted-foreground/70">
          Live from YouTube Music · picks rotate every 12 hours
        </p>
      </section>

      <section>
        <h2 className="mb-3 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
          Browse by mood
        </h2>
        <div className="flex flex-wrap gap-2">
          {MOOD_CHIPS.map((mood) => (
            <button
              key={mood}
              type="button"
              onClick={() => onPick(MOOD_QUERIES[mood] ?? mood)}
              className="rounded-full border border-white/20 bg-white/[0.06] px-4 py-1.5 text-sm font-medium text-foreground/90 outline outline-1 outline-white/10 transition-all hover:border-[rgb(var(--tint)_/_0.65)] hover:bg-[rgb(var(--tint)_/_0.12)] hover:outline-[rgb(var(--tint)_/_0.3)]"
            >
              {mood}
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
          Explore genres
        </h2>
        <div className="flex flex-wrap gap-2">
          {GENRE_CHIPS.map((genre) => (
            <button
              key={genre}
              type="button"
              onClick={() => onPick(`${genre} songs`)}
              className="rounded-full border border-white/20 bg-gradient-to-br from-white/[0.09] to-white/[0.025] px-4 py-1.5 text-sm font-medium text-foreground/90 outline outline-1 outline-white/10 transition-all hover:border-[rgb(var(--tint)_/_0.65)] hover:from-[rgb(var(--tint)_/_0.14)] hover:outline-[rgb(var(--tint)_/_0.3)]"
            >
              {genre}
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
