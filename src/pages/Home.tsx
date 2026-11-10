import { Link, useNavigate } from "react-router";
import { albumPath, artistPath } from "@/lib/artistLinks";
import { PlaylistCard } from "@/components/playlists/PlaylistCard";
import { MediaCard } from "@/components/tracks/MediaCard";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Shelf } from "@/components/core/shelf";
import { MixesRow } from "@/components/home/MixesRow";
import { api } from "@/convex/_generated/api";
import { explainReason, type RecoCandidate } from "@/lib/recommend";
import { allocateSections, recordingKey } from "@/lib/homeShelves";
import { capPerArtist } from "@/lib/recoBalance";
import type { BrowseRelease } from "@/lib/musicBrowse";
import { buildFavoritesItems, buildMixes, type Mix, type RemoteLike } from "@/lib/mixes";

import { greeting } from "@/lib/format";
import { toPlayableYoutube, type Playable } from "@/lib/playable";
import { shuffleList } from "@/lib/queueOrder";

import { cleanArtistName, type YtItem } from "@/lib/youtube";
import {
  usePlayerStore,
  peekResumePosition,
  forgetResumePosition,
} from "@/store/player";
import {
  readLastPlayed,
  readPlayHistory,
  subscribePlayHistory,
  type HistoryEntry,
  type LastPlayedSnapshot,
} from "@/store/player";
import { useAction, useMutation, useQuery } from "convex/react";
import { cn } from "@/lib/utils";
import {
  BarChart3,
  Compass,
  Dices,
  Disc3,
  Flame,
  Heart,
  History,
  ListMusic,
  Play,
  PlayCircle,
  RotateCw,
  X,
  Repeat2,
  Search,
  Sparkles,
  Sun,
  UsersRound,
} from "lucide-react";
import { toast } from "sonner";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";

type RemoteMap = Record<string, YtItem[] | undefined>;

/** One personalised Home row, as produced by the recommendation engine. */
interface RecoSection {
  id: string;
  title: string;
  subtitle: string;
  items: RecoCandidate[];
  personalised: boolean;
}

const DISCOVERY_REFRESH_INTERVAL = 24 * 60 * 60 * 1000;

/**
 * How many candidates one discovery query contributes to the pool.
 *
 * Larger than what a shelf shows on purpose: the allocator needs spare rows so
 * four sections can each get distinct songs instead of splitting one list.
 */
const HOME_POOL_SIZE = 24;

/** Cards a discovery shelf shows once allocation has run. */
const HOME_SECTION_SIZE = 10;

/** Pause between two discovery queries — see the effect that uses it. */
const HOME_SHELF_GAP_MS = 400;

/**
 * Discovery seeds — one GENRE per shelf, rotated daily.
 *
 * WHY SEEDS AND NOT FOUR SYNONYMS OF "POPULAR". The shelves used to ask four
 * near-identical questions ("new music friday", "latest hits", "evening music
 * hits", "fall hits"). Search ranks by popularity, not by recency, genre or
 * hour, so the provider answered all four with the same ten records: measured
 * 30 returned rows containing 11 distinct songs. The allocator then had to
 * drop three shelves rather than repeat a card, which is why Home looked
 * half-empty on a wide screen.
 *
 * A genre is a different question and gets a different answer: six genre
 * queries measured 50 rows with 50 distinct songs, so each shelf now has its
 * own pool and the allocator only has to catch genuine overlap.
 *
 * Everything here is a real provider search — no tracks are invented, and a
 * seed that returns nothing makes its shelf disappear rather than pad it.
 */
const DISCOVERY_SEEDS = [
  "indie folk essentials",
  "neo soul essentials",
  "dream pop essentials",
  "alt r&b essentials",
  "singer songwriter essentials",
  "shoegaze essentials",
  "bedroom pop essentials",
  "jazz fusion essentials",
  "bossa nova essentials",
  "modern folk essentials",
  "synthwave essentials",
  "americana essentials",
];

/** Time-of-day shelves, seeded per hour band so 9am ≠ 9pm. */
const TIME_SEEDS: Record<string, string[]> = {
  "late night": [
    "late night jazz",
    "ambient late night",
    "slow r&b late night",
    "lo-fi late night",
  ],
  morning: [
    "morning acoustic",
    "bright indie pop",
    "feel good soul morning",
    "acoustic folk morning",
  ],
  afternoon: [
    "afternoon indie rock",
    "upbeat funk afternoon",
    "sunlit pop afternoon",
    "alt rock afternoon",
  ],
  evening: [
    "evening jazz",
    "evening indie folk",
    "dinner party soul",
    "mellow electronic evening",
  ],
  night: [
    "night drive synth",
    "after hours r&b",
    "late night piano",
    "downtempo night",
  ],
};

/** Seasonal shelves, seeded per season. */
const SEASON_SEEDS: Record<string, string[]> = {
  winter: ["winter acoustic", "winter ambient", "winter indie folk"],
  spring: ["spring indie pop", "spring acoustic", "fresh folk spring"],
  summer: ["summer pop anthems", "summer indie", "sunset soul summer"],
  fall: [
    "autumn acoustic songs",
    "autumn indie folk",
    "fall singer songwriter",
    "autumn jazz",
  ],
};

/** Release-type labels, from the provider's own classification. */
const KIND_LABEL: Record<string, string> = {
  album: "Album",
  ep: "EP",
  single: "Single",
  live: "Live",
  compilation: "Compilation",
  soundtrack: "Soundtrack",
  other: "Release",
};

/** Rotates a seed list once per discovery cycle, so a shelf ages. */
function rotateSeed(list: readonly string[], rotation: number): string {
  return list[Math.abs(rotation) % list.length] ?? list[0] ?? "";
}
const DISCOVERY_REFRESH_KEY = "synq:discovery-refreshed-at";
const HOME_REQUEST_TIMEOUT_MS = 12_000;
/** Discovery ("random genre") searches fan out to several artist-backed
 *  lookups server-side, so they legitimately take longer than a shelf fetch. */
const DISCOVERY_REQUEST_TIMEOUT_MS = 30_000;

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs = HOME_REQUEST_TIMEOUT_MS,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error("Home shelf request timed out")),
      timeoutMs,
    );
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * The mood tiles, and the queries behind them.
 *
 * EVERY QUERY HERE WAS MEASURED against the live `youtube.searchYoutube`
 * action, not chosen for how it reads. The originals were natural-language
 * phrases — "focus concentration music", "high energy workout songs" — and
 * they were close to useless: the live search returned 0 results for
 * "focus concentration music", 0 for "acoustic morning", 0 for "deep focus",
 * 0 for "running music", 0 for "night drive", and 1 result for most of the
 * rest. Tapping "Focus" landed on an empty search page, which is the worst
 * possible outcome for the tile whose entire job is to be an easy way in.
 *
 * The replacements are the vocabulary YouTube actually has results for, and
 * each is annotated with the count it returned so a future edit can be checked
 * the same way. Note the pattern: short concrete GENRE NOUNS work, descriptive
 * English does not. Measured against the live search action:
 *
 *     "lofi"           10      "lofi hip hop"      3   ← too few
 *     "bengali hits"   10      "bengali lofi"      0   ← empty
 *     "80s hits"       10      "cheesy 80s love songs" 3   ← too few
 *     "jazz"           10      "focus concentration music" 0
 *
 * Three tiles used to point at the right-hand column and opened a search with
 * almost nothing in it. Every query below is one that measured at least five
 * results, and the count is recorded beside it.
 */
const MOOD_LAUNCHES = [
  {
    label: "Focus",
    query: "study lofi", // 9 results
    tone: "from-sky-500/25 to-cyan-500/5",
  },
  {
    label: "Slow morning",
    query: "acoustic lofi", // 10 results
    tone: "from-amber-500/25 to-orange-500/5",
  },
  {
    label: "Workout",
    query: "sport electronic", // 10 results
    tone: "from-rose-500/25 to-pink-500/5",
  },
  {
    label: "Late night",
    query: "midnight lofi", // 10 results
    tone: "from-violet-500/25 to-indigo-500/5",
  },
  {
    label: "Good vibes",
    query: "funk", // 10 results
    tone: "from-emerald-500/25 to-lime-500/5",
  },
  {
    // Guilty pleasures — SYNQ's playful take on "corny". It is a curated
    // SEARCH, not a taste model: SYNQ has no genre or mood metadata anywhere,
    // so calling a track "corny" by inference would be fiction. Running a real
    // query that returns real results on demand is the honest version, and it
    // is framed as fun rather than as a judgement about the music.
    label: "Guilty pleasures",
    query: "80s hits", // 10 results
    tone: "from-rose-500/25 to-fuchsia-500/5",
  },
  {
    label: "Bengali moods",
    query: "bengali hits", // 10 results
    tone: "from-teal-500/25 to-cyan-500/5",
  },
] as const;

function markDiscoveryRefreshed() {
  try {
    window.localStorage.setItem(DISCOVERY_REFRESH_KEY, String(Date.now()));
  } catch {
    // Storage can be unavailable in private browsing; the in-memory refresh
    // timer should still keep the current Home session fresh.
  }
}

export default function Home() {
  const navigate = useNavigate();
  const playTrack = usePlayerStore((s) => s.playTrack);
  const playListOrdered = usePlayerStore((s) => s.playListOrdered);
  const setQueueOpen = usePlayerStore((s) => s.setQueueOpen);
  const setPendingOrigin = usePlayerStore((s) => s.setPendingOrigin);
  const likedCount = usePlayerStore((s) => Object.keys(s.liked).length);
  const likedLoaded = usePlayerStore((s) => s.likedLoaded);
  const playlists = useQuery(api.playlists.myPlaylists);
  // Liked tracks with their metadata, for the Favorites Mix. Empty for a
  // signed-out visitor, which is why the mix simply does not appear for them.
  const likedRemote = useQuery(api.likes.myLikedRemote);
  const listeningStats = useQuery(api.history.listeningStats);
  const spotifyChart = useAction(api.spotify.spotifyChart);
  const searchYt = useAction(api.youtube.searchYoutube);

  const [resolvingId, setResolvingId] = useState<string | null>(null);
  // Bumped whenever a saved resume position is cleared, so the "Continue
  // listening" shelf recomputes even though nothing it reads from changed.
  const [resumeVersion, setResumeVersion] = useState(0);
  const [remote, setRemote] = useState<RemoteMap>({});
  const [remoteRefreshToken, setRemoteRefreshToken] = useState(0);
  /**
   * Search shelves whose queries all failed on this pass.
   *
   * A failed shelf used to be stored as `[]`, which is indistinguishable from
   * "the provider has nothing", so it was hidden — one throttled request and
   * Home silently lost a row for the rest of the visit. Failed is its own
   * state, and it renders a retry instead of nothing.
   */
  const [remoteFailures, setRemoteFailures] = useState<Record<string, boolean>>(
    {},
  );

  // --- personalised recommendations ---------------------------------------
  // Fetched once per Home visit, off the critical path: `null` means loading,
  // `[]` means the engine had nothing honest to show. A failure is NOT
  // surfaced as an error banner — Home simply renders its normal shelves,
  // because a broken recommendation must never look like a broken app.
  const forYou = useAction(api.recommend.forYou);
  const recordFeedback = useMutation(api.recommend.recordFeedback);
  const exploration = usePlayerStore((s) => s.exploration);
  const [recoSections, setRecoSections] = useState<RecoSection[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    // The exploration preference is part of the request, so moving the slider
    // re-ranks immediately — but only for a listener who actually has shelves
    // to re-rank.
    withTimeout(forYou({ exploration }), DISCOVERY_REQUEST_TIMEOUT_MS)
      .then(({ sections }) => {
        if (!cancelled) setRecoSections(sections);
      })
      .catch(() => {
        if (!cancelled) setRecoSections([]);
      });
    return () => {
      cancelled = true;
    };
  }, [forYou, exploration, remoteRefreshToken]);

  /**
   * Play a recommended track, tagging it so the engine learns from the outcome.
   *
   * The whole row becomes the queue, exactly like every other Home shelf — no
   * separate recommendation playback path exists.
   */
  const playRecommendation = (section: RecoSection, item: RecoCandidate) => {
    const rest = section.items.filter((entry) => entry.id !== item.id);
    setPendingOrigin("recommendation");
    void recordFeedback({
      trackId: item.id,
      outcome: "played",
      section: section.id,
      origin: "recommendation",
      title: item.title,
      artistName: item.artist,
      ...(item.album ? { albumName: item.album } : {}),
    }).catch(() => undefined);
    playRemoteItem(toYtItem(item), rest.map(toYtItem));
  };

  // Songs of the week — global chart, streamed live.
  const [trending, setTrending] = useState<YtItem[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    withTimeout(spotifyChart({}))
      .then(({ items }) => {
        if (!cancelled) setTrending(items);
      })
      .catch(() => {
        if (!cancelled) setTrending([]);
      });
    return () => {
      cancelled = true;
    };
  }, [spotifyChart, remoteRefreshToken]);

  const playTrending = (item: YtItem) => {
    setResolvingId(item.id);
    const primaryArtist = cleanArtistName(item.artist, item.title);
    withTimeout(searchYt({ query: `${item.title} ${primaryArtist}` }))
      .then(({ items }) => {
        const best = items[0];
        if (!best) {
          toast.error(`Couldn't load "${item.title}" — try another song`);
          return;
        }
        const playable = {
          ...toPlayableYoutube(
            item,
            `https://youtu.be/${best.id}`,
            items.slice(1),
          ),
          youtubeId: best.id,
        };
        playTrack(playable);
      })
      .catch(() => {
        toast.error("Playback failed — try again in a moment");
      })
      .finally(() => {
        setResolvingId(null);
      });
  };

  // Continue listening — the true last-played track from any source.
  // Read once during the first render: localStorage isn't reactive, and
  // set-state-in-effect here just triggers a cascading second render.
  const [lastPlayed] = useState<LastPlayedSnapshot | null>(() =>
    readLastPlayed(),
  );
  const continueTrack: Playable | null = useMemo(
    () =>
      lastPlayed && isPlayableSource(lastPlayed)
        ? snapshotToPlayable(lastPlayed)
        : null,
    [lastPlayed],
  );

  // Cross-source play history (all sources alike) — SUBSCRIBED, not snapshotted.
  // Reading it once at mount meant the listening pulse and the history shelves
  // stayed frozen at whatever was in localStorage when Home first rendered.
  const history = useSyncExternalStore(
    subscribePlayHistory,
    readPlayHistory,
    readPlayHistory,
  ) as HistoryEntry[];

  // Saved position for the continue-listening card (resume exactly where stopped).
  const continueResume = useMemo(
    () =>
      continueTrack
        ? peekResumePosition(continueTrack.id, continueTrack.duration)
        : 0,
    [continueTrack],
  );

  const historyItems: YtItem[] = useMemo(
    () =>
      history.map((h) => ({
        id: h.youtubeId ?? h.id,
        title: h.title,
        artist: cleanArtistName(h.artistName, h.title),
        duration: h.duration,
        thumbnail: h.coverUrl,
      })),
    [history],
  );
  // Recently played, minus whatever is already shown above it, so the top of
  // the page never repeats the same cover three times.
  const seenAtTop = useMemo(() => {
    const ids = new Set<string>();
    if (continueTrack) ids.add(continueTrack.youtubeId ?? continueTrack.id);
    for (const item of historyItems.slice(0, 1)) ids.add(item.id);
    return ids;
  }, [continueTrack, historyItems]);

  const recentItems = useMemo(
    () => usable(historyItems).filter((item) => !seenAtTop.has(item.id)),
    [historyItems, seenAtTop],
  );

  /**
   * The most-played track per artist, ranked by total plays.
   *
   * "On repeat" is deliberately NOT the flat most-played list: with a small
   * history that is just "Recently played" sorted differently, and the same four
   * covers turn up in both rows. Grouping by artist first means the row answers
   * a different question — *what do I keep coming back to* — and repeats only
   * what "Recently played" genuinely does not show.
   */
  const mostPlayedItems: YtItem[] = useMemo(() => {
    const byArtist = new Map<string, { item: YtItem; total: number }>();
    for (const item of historyItems) {
      const plays =
        history.find((h) => (h.youtubeId ?? h.id) === item.id)?.playCount ?? 0;
      const artist = item.artist || "";
      const existing = byArtist.get(artist);
      if (existing) {
        existing.total += plays;
        const existingPlays =
          history.find((h) => (h.youtubeId ?? h.id) === existing.item.id)
            ?.playCount ?? 0;
        if (plays > existingPlays) existing.item = item;
      } else {
        byArtist.set(artist, { item, total: plays });
      }
    }
    const recentIds = new Set(recentItems.map((item) => item.id));
    return [...byArtist.values()]
      .sort((a, b) => b.total - a.total)
      .map((entry) => entry.item)
      .filter((item) => !recentIds.has(item.id));
  }, [history, historyItems, recentItems]);

  // --- live remote fills for every section -----------------------------------
  const timeLabel = timeOfDayLabel();
  const [localTime, setLocalTime] = useState(() => formatLocalTime());
  useEffect(() => {
    const timer = window.setInterval(
      () => setLocalTime(formatLocalTime()),
      60_000,
    );
    return () => window.clearInterval(timer);
  }, []);
  const season = seasonLabel();

  /** Which day of the discovery cycle this is — the seed rotation index. */
  // eslint-disable-next-line react-hooks/purity -- daily bucket: constant within a render pass, steps only at the 24h refresh boundary
  const seedRotation = Math.floor(Date.now() / DISCOVERY_REFRESH_INTERVAL);

  const remoteQueries = useMemo(() => {
    // Only the shelves the redesigned page actually renders are fetched.
    // "topTracks", "because" and "artists" used to be queried here and then
    // either never rendered or duplicated a recommendation shelf — paid for
    // on every Home visit and thrown away.
    //
    // Each shelf asks a DIFFERENT question (see DISCOVERY_SEEDS): four phrasings
    // of "popular" returned one pool of ten songs four times over.
    const q: Array<{ key: string; query: string; fallback?: string }> = [
      {
        key: "discover",
        query: rotateSeed(DISCOVERY_SEEDS, seedRotation),
        fallback: rotateSeed(DISCOVERY_SEEDS, seedRotation + 5),
      },
      {
        key: "timeOfDay",
        query: rotateSeed(
          TIME_SEEDS[timeLabel] ?? DISCOVERY_SEEDS,
          seedRotation,
        ),
        fallback: rotateSeed(
          TIME_SEEDS[timeLabel] ?? DISCOVERY_SEEDS,
          seedRotation + 1,
        ),
      },
      {
        key: "seasonal",
        query: rotateSeed(SEASON_SEEDS[season] ?? DISCOVERY_SEEDS, seedRotation),
        fallback: rotateSeed(
          SEASON_SEEDS[season] ?? DISCOVERY_SEEDS,
          seedRotation + 1,
        ),
      },
    ];
    return q;
  }, [timeLabel, season, seedRotation]);

  // Remote shelves are live data, so refresh them once per day. The first
  // render always fetches current data; this timestamp makes the cadence
  // survive route changes and browser sessions instead of only living in
  // this mounted Home page.
  useEffect(() => {
    let lastRefresh = 0;
    try {
      lastRefresh =
        Number(window.localStorage.getItem(DISCOVERY_REFRESH_KEY)) || 0;
    } catch {
      // Ignore unavailable storage and use the in-memory timer below.
    }

    if (
      !lastRefresh ||
      Date.now() - lastRefresh >= DISCOVERY_REFRESH_INTERVAL
    ) {
      markDiscoveryRefreshed();
    }

    const timer = window.setInterval(() => {
      setRemote({});
      setTrending(null);
      setRemoteRefreshToken((value) => value + 1);
      markDiscoveryRefreshed();
    }, DISCOVERY_REFRESH_INTERVAL);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // SEQUENTIAL, not `Promise.all`.
    //
    // These four queries used to fire together. Concurrent InnerTube searches
    // from this deployment answer with an empty shelf (the throttling finding
    // recorded in src/convex/playlists.ts), which is how a section could come
    // back blank while the identical query worked a moment later. One at a
    // time, with a short gap, is the pattern that actually returns results.
    //
    // Each response keeps up to HOME_POOL_SIZE candidates: the allocator below
    // needs a real pool to give four sections distinct rows. Slicing to six
    // per section HERE was the other half of the repetition bug — every
    // section got the same six songs, then rendered all six.
    void (async () => {
      for (const [index, { key, query, fallback }] of remoteQueries.entries()) {
        if (cancelled) return;
        if (index > 0) await new Promise((r) => setTimeout(r, HOME_SHELF_GAP_MS));
        let settled = false;
        for (const q of [query, fallback]) {
          if (cancelled) return;
          if (settled) break;
          if (!q) continue;
          try {
            const { items } = await withTimeout(searchYt({ query: q }));
            if (cancelled) return;
            if (items.length > 0) {
              setRemote((prev) => ({
                ...prev,
                [key]: items.slice(0, HOME_POOL_SIZE),
              }));
              setRemoteFailures((prev) =>
                prev[key] ? { ...prev, [key]: false } : prev,
              );
              settled = true;
            }
          } catch {
            // Try the fallback query, then resolve the section below.
          }
        }
        if (!settled && !cancelled) {
          setRemote((prev) => ({ ...prev, [key]: [] }));
          setRemoteFailures((prev) => ({ ...prev, [key]: true }));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [remoteQueries, remoteRefreshToken, searchYt]);

  // ── New from the artists you listen to ────────────────────────────────────
  // The search shelves cannot answer "what is new": provider search ranks by
  // popularity and returns no release dates at all, so "new songs this week"
  // measured 0 rows and a recency label over those results would be a claim the
  // data cannot support. The artist catalogue CAN answer it — every release it
  // reports carries the provider's own year — so this shelf is built from the
  // top artists in the listener's real play history and sorted by that date.
  const resolveArtistAction = useAction(api.artistCatalog.resolveArtist);
  const fetchArtistReleases = useAction(api.artistCatalog.artistReleases);
  const [artistReleases, setArtistReleases] = useState<Array<{
    artist: string;
    release: BrowseRelease;
  }> | null>(null);

  /** Artists the listener actually plays, most-played first. */
  const topArtistNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of mostPlayedItems) {
      const name = item.artist;
      if (!name || name === "Unknown artist") continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name]) => name);
  }, [mostPlayedItems]);

  useEffect(() => {
    if (topArtistNames.length === 0) return;
    let cancelled = false;
    void (async () => {
      const rows: Array<{ artist: string; release: BrowseRelease }> = [];
      for (const name of topArtistNames) {
        if (cancelled) return;
        try {
          const identity = await resolveArtistAction({ name });
          if (!identity?.found || !identity.artistId) continue;
          const result = await fetchArtistReleases({
            artistId: identity.artistId,
          });
          for (const release of result?.releases ?? []) {
            // An undated release is not evidence of recency; it is left out
            // rather than sorted to the top by a guess.
            if (!release.year) continue;
            rows.push({
              artist: identity.name ?? name,
              release,
            });
          }
        } catch {
          // One artist failing must not empty the shelf for the others.
        }
      }
      if (cancelled) return;
      const seen = new Set<string>();
      setArtistReleases(
        rows
          .filter((row) => {
            const key = `${row.artist}|${row.release.id}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .sort(
            (a, b) => Number(b.release.year) - Number(a.release.year),
          )
          .slice(0, 12),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [topArtistNames, resolveArtistAction, fetchArtistReleases]);

  /** Re-ask every search shelf after a failure. */
  const retryShelves = useCallback(() => {
    setRemoteFailures({});
    setRemote({});
    setRemoteRefreshToken((value) => value + 1);
  }, []);

  /**
   * One row per recording across the whole page.
   *
   * The four discovery shelves used to be filled independently, so generic
   * queries returned the same hits and Home showed the same cover four times.
   * The allocator hands out distinct candidates and reserves anything already
   * visible above (history, chart, on-repeat, recommendations) so a song cannot
   * appear twice on one screen.
   */
  const discovery = useMemo(() => {
    const reserved = new Set<string>();
    for (const item of [
      ...historyItems,
      ...mostPlayedItems,
      ...usable(trending),
      ...(recoSections ?? []).flatMap((section) =>
        section.items.map((entry) => toYtItem(entry)),
      ),
    ]) {
      if (item?.id) reserved.add(item.id);
      // The album label is NOT reserved, because it is the one field that
      // drifts: history stores the album a track was played from while the
      // provider's search row may report a reissue, so the same recording came
      // back under a different album name and appeared on Home twice. Artist +
      // title is enough to say "already on this page"; within a discovery pool
      // the allocator still keeps "Willow" and "Willow (Live)" apart.
      if (item?.title && item?.artist) {
        reserved.add(recordingKey({ title: item.title, artist: item.artist }));
      }
    }
    const allocated = allocateSections(
      [
        // At most two per artist. The genre searches behind this row come
        // back artist-heavy often enough that one catalogue could fill it —
        // the fallback shelf has no profile to balance against, so the cap is
        // the only thing keeping it from reading as a single-artist row.
        { id: "discover", items: capPerArtist(usable(remote.discover), 2) },
        { id: "timeOfDay", items: capPerArtist(usable(remote.timeOfDay), 2) },
        { id: "seasonal", items: capPerArtist(usable(remote.seasonal), 2) },
      ],
      {
        perSection: HOME_SECTION_SIZE,
        reserved,
        // Rotate on every refresh so "New releases" is not a carbon copy of
        // the last visit even when the provider's ranking is identical.
        offset: remoteRefreshToken * 3,
      },
    );
    const byId = new Map(allocated.map((section) => [section.id, section.items]));
    return {
      discover: byId.get("discover") ?? [],
      timeOfDay: byId.get("timeOfDay") ?? [],
      seasonal: byId.get("seasonal") ?? [],
    };
  }, [historyItems, mostPlayedItems, recoSections, remote, remoteRefreshToken, trending]);

  /**
   * Does the recommendation engine already own the discovery row?
   *
   * Home used to render BOTH: the engine's "Discover something new" (built
   * from the listener) and this older generic one (a rotating genre search),
   * both under the same title. Two shelves with the same heading, ranked
   * independently, is exactly how the page ends up offering the same artist
   * twice under different names. The generic shelf is now the fallback for a
   * listener the engine cannot personalise — signed out, or before the first
   * settled play — rather than a second discovery row.
   */
  const engineHasDiscovery = Boolean(
    recoSections?.some((section) => section.id === "discover"),
  );

  const playRemoteItem = (item: YtItem, rest: YtItem[]) => {
    playTrack(
      toPlayableYoutube(
        item,
        `https://youtu.be/${item.id}`,
        rest.filter((r) => r.id !== item.id),
      ),
    );
  };

  // ── Your Mixes ────────────────────────────────────────────────────────────
  // Assembled from data this page has ALREADY fetched — the play history, the
  // most-played shelf, the recommendation sections and the live discovery
  // shelves. No extra network request, no second recommender, and nothing is
  // cached: a mix is recomputed from whatever the shelves currently hold, so
  // it is genuinely personal rather than a frozen snapshot.
  const mixes: Mix[] = useMemo(
    () =>
      buildMixes({
        // Favorites Mix is the one mix every signed-in listener should actually own,
        // so it gets the strongest possible source: liked tracks first, then the tracks
        // the listener has already played (history + most-played). When the catalog the
        // app can reach is thin that matters more than a narrower "only liked" source
        // that leaves the card empty.
        // FavoritesMix is the one mix every signed-in listener should actually own,
        // so it gets the strongest possible source: liked tracks first, then the tracks
        // the listener has already played (history + most-played). When the catalog the
        // app can reach is thin that matters more than a narrower "only liked" source
        // that leaves the card empty.
        favorites: buildFavoritesItems(
          likedRemote,
          historyItems,
          mostPlayedItems,
        ) as unknown as RemoteLike[],
        mostPlayed: mostPlayedItems,
        recent: historyItems,
        discovery: remote.discover,
        // The dated "new from your artists" shelf is the honest source for a
        // new-music mix; the chart is the fallback for a listener with no
        // play history yet.
        newMusic: trending ?? remote.discover ?? undefined,
        soundAlike: recoSections
          ?.find((section) => section.id === "sound_alike")
          ?.items.map(toYtItem),
        timeOfDay: remote.timeOfDay,
      }),
    [
      likedRemote,
      mostPlayedItems,
      historyItems,
      remote,
      trending,
      recoSections,
    ],
  );

  // Playing a mix is exactly playing a shelf: the whole mix becomes the queue,
  // so autoplay, repeat and shuffle all keep working through the existing player.
  // No separate mix engine exists.
  const playMix = (mix: Mix) => {
    const playable: Playable[] = mix.items.map(
      (item) =>
        toPlayableYoutube(item, `https://youtu.be/${item.id}`, []),
    );
    if (playable.length === 0) return;
    playTrack(playable[0], playable.slice(1));
  };

  // "Play something random" — random seed, random pick.
  const surpriseSeeds = [
    "indie pop",
    "synthwave",
    "lo-fi beats",
    "alternative rock",
    "dream pop",
    "electronic",
    "jazz",
    "funk",
    "soul",
    "ambient",
    "hip hop",
    "reggae",
    "classic rock",
    "house",
    "techno",
    "r&b",
    "folk",
    "punk",
    "k-pop",
    "afrobeats",
    "latin",
    "country",
    "metal",
    "disco",
    "blues",
  ];
  const [surprising, setSurprising] = useState(false);
  const surpriseMe = () => {
    if (surprising) return;
    setSurprising(true);
    const seed =
      surpriseSeeds[Math.floor(Math.random() * surpriseSeeds.length)];
    // Genre seeds go through the slower discovery search (several artist-backed
    // lookups), so they get a longer budget than the plain 12s shelf timeout.
    // A second, concrete seed is the fallback so one unlucky genre never leaves
    // the button dead.
    withTimeout(searchYt({ query: seed }), DISCOVERY_REQUEST_TIMEOUT_MS)
      .catch(() => searchYt({ query: "Taylor Swift songs" }))
      .then(({ items }) => {
        const pool = items.filter((i) => i.duration > 0);
        const pick = pool[Math.floor(Math.random() * pool.length)];
        if (!pick) {
          toast.error("No results — try again");
          return;
        }
        // Queue the whole result pool, not just the picked track. Passing only
        // the playable left the queue holding a SINGLE entry, so the button
        // whose entire job is to start music instantly played one song and
        // then sat in silence waiting on a background fetch to find the next
        // one. The search we already paid for is the queue.
        const queue = pool
          .slice(0, 15)
          .map((item) =>
            toPlayableYoutube(item, `https://youtu.be/${item.id}`),
          );
        const selected = queue.find((t) => t.id === pick.id) ?? queue[0];
        playTrack(selected, queue);
      })
      .catch(() => {
        toast.error("Couldn't reach our music sources — try again");
      })
      .finally(() => {
        setSurprising(false);
      });
  };

  // "I'm feeling lucky" — plays a hit matching the current time of day,
  // with shuffle-on so the whole queue becomes a lucky mix.
  const [luckyBusy, setLuckyBusy] = useState(false);
  const feelingLucky = () => {
    if (luckyBusy) return;
    setLuckyBusy(true);
    const seeds = [
      " Feel good hit",
      "guaranteed banger",
      "feel-good anthem",
      "crowd favorite",
      "legendary song",
      "timeless classic",
    ];
    const pick = seeds[Math.floor(Math.random() * seeds.length)];
    withTimeout(searchYt({ query: pick }), DISCOVERY_REQUEST_TIMEOUT_MS)
      .then(({ items }) => {
        const pool = items.filter((i) => i.duration > 0);
        const song = pool[Math.floor(Math.random() * pool.length)];
        if (!song) {
          toast.error("No luck this time — try again");
          return;
        }
        // Same fix as "Play something random": the picked track was passed on
        // its own, so the "lucky mix" was one song long. The queue is now
        // shuffled HERE and played with `playListOrdered`, rather than
        // switching the app's global shuffle preference on — a one-off button
        // press should not leave shuffle latched for the rest of the session.
        const queue = shuffleList(
          pool
            .slice(0, 15)
            .map((item) =>
              toPlayableYoutube(item, `https://youtu.be/${item.id}`),
            ),
        );
        const selected = queue.find((t) => t.id === song.id) ?? queue[0];
        if (!selected) return;
        playListOrdered(selected, queue);
      })
      .catch(() => toast.error("Couldn't reach our music sources — try again"))
      .finally(() => setLuckyBusy(false));
  };

  const quickLinks = [
    {
      to: "/liked",
      label: "Liked Songs",
      detail: likedLoaded
        ? `${likedCount} ${likedCount === 1 ? "song" : "songs"}`
        : "…",
      icon: Heart,
    },
    {
      to: "/playlists",
      label: "Playlists",
      detail:
        playlists === undefined
          ? "…"
          : `${playlists.length} ${playlists.length === 1 ? "playlist" : "playlists"}`,
      icon: ListMusic,
    },
    {
      to: "/search",
      label: "Search",
      detail: "Find any song across our sources",
      icon: Search,
    },
  ];

  const artistTrendList = useMemo(
    () => artistTrend(historyItems),
    [historyItems],
  );
  const listeningPulse = useMemo(() => {
    // Use signed-in server stats as the source of truth so the pulse remains
    // stable when navigating between Home and other routes. Local history is
    // retained only as a fallback while the query is loading.
    if (listeningStats) {
      const bars = listeningStats.dailyActivity
        .slice(-7)
        .map((day) => day.plays);
      const safeBars = bars.length > 0 ? bars : [1, 1, 1, 1, 1, 1, 1];
      const uniqueArtists = listeningStats.uniqueArtists;
      const topRepeat = listeningStats.topTracks.reduce(
        (max, track) => Math.max(max, track.playCount),
        0,
      );
      return {
        totalPlays: listeningStats.totalPlays,
        uniqueArtists,
        topRepeat,
        bars: safeBars,
        maxBar: Math.max(1, ...safeBars),
      };
    }

    const totalPlays = history.reduce((sum, entry) => sum + entry.playCount, 0);
    const uniqueArtists = new Set(
      history.map((entry) => cleanArtistName(entry.artistName, entry.title)),
    ).size;
    const topRepeat = history.reduce(
      (max, entry) => Math.max(max, entry.playCount),
      0,
    );
    const dayMs = 24 * 60 * 60 * 1000;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const bars = Array.from({ length: 7 }, (_, index) => {
      const start = today.getTime() - (6 - index) * dayMs;
      return history.reduce(
        (count, entry) =>
          count +
          (entry.at >= start && entry.at < start + dayMs ? entry.playCount : 0),
        0,
      );
    });
    return {
      totalPlays,
      uniqueArtists,
      topRepeat,
      bars: bars.some((count) => count > 0) ? bars : [1, 1, 1, 1, 1, 1, 1],
      maxBar: Math.max(1, ...bars),
    };
  }, [history, listeningStats]);


  // Continue listening: only tracks the app has a REAL saved position for.
  // Nothing is invented here — if there is no resume map entry, the track is
  // not shown as unfinished.
  //
  // `resumeVersion` exists because clearing a saved position writes to
  // localStorage, and `historyItems` does not change when that happens — so
  // without something to key the memo on, the card the listener just dismissed
  // would sit there until they reloaded the page. A dismissed card reappearing
  // is exactly the behaviour that makes a remove button feel broken.
  const resumableItems = useMemo(
    () =>
      usable(historyItems)
        .map((item) => ({
          item,
          at: peekResumePosition(item.id, item.duration),
        }))
        .filter(({ item, at }) => at > 0 && item.duration > 0),
    // `resumeVersion` is deliberately NOT read inside the memo. Clearing a
    // saved position writes to localStorage, which React cannot observe, so
    // this is a cache-busting key and nothing more — without it the card the
    // listener just dismissed stays on screen until a reload, which is exactly
    // what makes a remove button feel broken.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [historyItems, resumeVersion],
  );

  /**
   * Stop offering this track in "Continue listening".
   *
   * Only the saved position is cleared. The play history, the listening stats
   * and the recommendation signals are left alone — this is "don't show me
   * this in one shelf again", not "erase that I listened to it", and wiping
   * history would quietly poison the recommender that reads those same rows.
   */
  const dismissResume = useCallback((item: YtItem) => {
    const removed = forgetResumePosition(item.id);
    // Bump either way: on a storage failure the card stays, and saying so
    // honestly is better than leaving the user tapping a button that does
    // nothing.
    setResumeVersion((v) => v + 1);
    if (removed) {
      toast.success(`Removed "${item.title}" from Continue listening`);
    } else {
      toast.error("Couldn't remove that here — try clearing site data");
    }
  }, []);

  const playShelf = (item: YtItem) => {
    setResolvingId(item.id);
    withTimeout(searchYt({ query: `${item.title} ${item.artist}` }))
      .then(({ items: found }) => {
        const match =
          found.find(
            (entry) =>
              cleanArtistName(entry.artist, entry.title) ===
              cleanArtistName(item.artist, item.title),
          ) ?? found[0];
        if (!match) {
          toast.error(`Couldn't load "${item.title}" — try another song`);
          return;
        }
        const queue = [match, ...found.filter((entry) => entry.id !== match.id)]
          .slice(0, 12)
          .map((entry) =>
            toPlayableYoutube(entry, `https://youtu.be/${entry.id}`),
          );
        const head = queue[0];
        if (head)
          playTrack(
            {
              ...head,
              id: item.id,
              title: item.title,
              artistName: item.artist,
            },
            queue,
          );
      })
      .catch(() => toast.error("Playback failed — try again in a moment"))
      .finally(() => setResolvingId(null));
  };

  return (
    <div className="flex flex-col gap-9 sm:gap-12">
      {/* ── Hero. Greeting plus the one thing worth acting on immediately:
          the track that was interrupted. Compact on purpose — this is a
          listening surface, not a marketing banner. */}
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
          <div className="min-w-0">
            <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
              {greeting()}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {historyItems.length > 0
                ? "Pick up where you left off, or start something new."
                : "Start listening — everything below updates as you play."}
            </p>
          </div>
          <p className="text-xs text-muted-foreground">
            {capitalize(season)} · {listeningPulse.totalPlays} plays
          </p>
        </div>

        {continueTrack ? (
          <button
            type="button"
            onClick={() => playTrack(continueTrack)}
            className="group flex w-full items-center gap-4 rounded-2xl border border-white/[0.07] bg-white/[0.03] p-3 text-left transition-colors hover:border-[rgb(var(--tint)_/_0.3)] hover:bg-white/[0.06] sm:gap-5 sm:p-4"
          >
            {continueTrack.coverUrl ? (
              <img
                src={continueTrack.coverUrl}
                alt=""
                className="size-16 shrink-0 rounded-xl object-cover ring-1 ring-white/10 sm:size-20"
              />
            ) : (
              <span className="flex size-16 shrink-0 items-center justify-center rounded-xl bg-[rgb(var(--tint)_/_0.14)] text-[rgb(var(--tint))] sm:size-20">
                <Play className="size-5 fill-current" />
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block text-[10px] font-semibold tracking-[0.18em] text-[rgb(var(--tint))] uppercase">
                Continue listening
              </span>
              <span className="mt-0.5 block truncate font-display text-base font-bold sm:text-lg">
                {continueTrack.title}
              </span>
              <span className="block truncate text-sm text-muted-foreground">
                {continueTrack.artistName}
              </span>
              {continueTrack.duration > 0 ? (
                <span className="mt-2 flex items-center gap-2">
                  <span className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
                    <span
                      className="block h-full rounded-full bg-[rgb(var(--tint))]"
                      style={{
                        width: `${Math.min(
                          100,
                          Math.round(
                            (continueResume / continueTrack.duration) * 100,
                          ),
                        )}%`,
                      }}
                    />
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                    {formatClock(continueResume)} left
                  </span>
                </span>
              ) : null}
            </span>
            <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-[rgb(var(--tint))] text-black shadow-lg transition-transform group-hover:scale-105">
              <Play className="size-4 fill-current" />
            </span>
          </button>
        ) : null}
      </header>

      {/* ── Quick access. One tap to start listening or to jump somewhere. */}
      <section aria-label="Quick access">
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
          {quickLinks.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              className="flex items-center gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-3 transition-colors hover:border-[rgb(var(--tint)_/_0.3)] hover:bg-white/[0.06]"
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[rgb(var(--tint)_/_0.13)] text-[rgb(var(--tint))]">
                <Icon className="size-4" />
              </span>
              <span className="truncate text-sm font-semibold">{label}</span>
            </Link>
          ))}
          <button
            type="button"
            onClick={() => setQueueOpen(true)}
            className="flex items-center gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-3 text-left transition-colors hover:border-[rgb(var(--tint)_/_0.3)] hover:bg-white/[0.06]"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-violet-400/10 text-violet-300">
              <ListMusic className="size-4" />
            </span>
            <span className="truncate text-sm font-semibold">Queue</span>
          </button>
          <button
            type="button"
            onClick={surpriseMe}
            className="flex items-center gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-3 text-left transition-colors hover:border-[rgb(var(--tint)_/_0.3)] hover:bg-white/[0.06]"
          >
            <span
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-lg bg-[rgb(var(--tint)_/_0.13)] text-[rgb(var(--tint))]",
                surprising && "animate-pulse",
              )}
            >
              <Dices className="size-4" />
            </span>
            <span className="truncate text-sm font-semibold">Surprise me</span>
          </button>
          <button
            type="button"
            onClick={feelingLucky}
            className="flex items-center gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-3 text-left transition-colors hover:border-[rgb(var(--tint)_/_0.3)] hover:bg-white/[0.06]"
          >
            <span
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-lg bg-[rgb(var(--tint)_/_0.13)] text-[rgb(var(--tint))]",
                luckyBusy && "animate-pulse",
              )}
            >
              <Sparkles className="size-4" />
            </span>
            <span className="truncate text-sm font-semibold">
              Feeling lucky
            </span>
          </button>
        </div>
      </section>

      {/* ── Recently played. Real listening history, newest first. */}
      {recentItems.length > 0 ? (
        <Shelf
          id="shelf-recent"
          title="Recently played"
          action={{ to: "/recent", label: "See all" }}
          icon={<History className="size-4 text-[rgb(var(--tint))]" />}
        >
          {recentItems.slice(0, 14).map((item) => (
            <MediaCard
              key={item.id}
              item={item}
              onOpen={() => playShelf(item)}
              onPlay={() => playShelf(item)}
              resolving={resolvingId === item.id}
            />
          ))}
        </Shelf>
      ) : null}

      {/* ── Continue listening, as a shelf of genuinely unfinished tracks. */}
      {resumableItems.length > 0 ? (
        <Shelf
          id="shelf-continue"
          title="Continue listening"
          icon={<PlayCircle className="size-4 text-[rgb(var(--tint))]" />}
        >
          {resumableItems.slice(0, 12).map(({ item, at }) => (
            <MediaCard
              key={item.id}
              item={item}
              onOpen={() => playShelf(item)}
              onPlay={() => playShelf(item)}
              meta={`${Math.round((at / Math.max(1, item.duration)) * 100)}% played`}
              // A resume entry is an OFFER, not a record. Without a way to
              // decline it, a shelf of stale or unplayable tracks is
              // something the listener has to scroll past forever.
              menuItems={
                <DropdownMenuItem
                  className="gap-2"
                  onSelect={(event) => {
                    event.stopPropagation();
                    dismissResume(item);
                  }}
                >
                  <X className="size-4" />
                  Remove from Continue listening
                </DropdownMenuItem>
              }
            />
          ))}
        </Shelf>
      ) : null}

      {/* ── Your Mixes. Placed above the recommendation shelves because a
          press-to-play set is a faster way in than a row of single tracks. */}
      <MixesRow mixes={mixes} onPlay={playMix} />

      {/* ── The recommendation shelves. The engine already decided what is
          honest to show; this only decides how it looks. Skeleton while the
          action is in flight, nothing at all if it failed. */}
      {recoSections === null ? (
        <Shelf
          id="shelf-for-you"
          title="Recommended for you"
          icon={<Sparkles className="size-4 text-[rgb(var(--tint))]" />}
          skeleton
        >
          {null}
        </Shelf>
      ) : (
        recoSections.map((section) => (
          <Shelf
            key={section.id}
            id={`shelf-${section.id}`}
            title={section.title}
            icon={
              section.id === "for_you" ? (
                <Sparkles className="size-4 text-[rgb(var(--tint))]" />
              ) : undefined
            }
            subtitle={
              section.personalised
                ? undefined
                : section.id === "discover"
                  ? // Exploration material really is generic popularity.
                    "Popular picks while we learn"
                  : // The row was built from the listener's own plays — there
                    // are just too few of them to call the taste established,
                    // and the cards say which play they came from.
                    "From the few tracks we've heard so far"
            }
          >
            {section.items.slice(0, 14).map((item) => (
              <MediaCard
                key={item.id}
                item={toYtItem(item)}
                onOpen={() => playRecommendation(section, item)}
                onPlay={() => playRecommendation(section, item)}
                // "Why this song?" — the engine's own reason, resolved from
                // whichever signal actually scored highest. Absent when there
                // was no real signal, so a card never shows a fake rationale.
                meta={explainReason(item.reason) ?? undefined}
              />
            ))}
          </Shelf>
        ))
      )}

      {/* ── Your playlists, using the card the Playlists page already uses. */}
      {playlists && playlists.length > 0 ? (
        <Shelf
          id="shelf-playlists"
          title="Your playlists"
          action={{ to: "/playlists", label: "See all" }}
          icon={<ListMusic className="size-4 text-[rgb(var(--tint))]" />}
        >
          {playlists.slice(0, 14).map((playlist) => (
            <PlaylistCard key={playlist._id} playlist={playlist} />
          ))}
        </Shelf>
      ) : null}

      {/* ── Artists, from real play counts. */}
      {artistTrendList.length >= 2 ? (
        <Shelf
          id="shelf-artists"
          title="Artists you listen to"
          icon={<Disc3 className="size-4 text-[rgb(var(--tint))]" />}
        >
          {artistTrendList.slice(0, 14).map(({ artist, items }) => (
            <MediaCard
              key={artist}
              variant="artist"
              round
              item={
                items[0] ?? {
                  id: artist,
                  title: artist,
                  artist,
                  duration: 0,
                  thumbnail: "",
                }
              }
              // An artist card opens the artist. Playing the top track is
              // still one tap away, from the page it lands on.
              onOpen={() => navigate(artistPath(artist) ?? "/search")}
              meta={`${items.length} ${items.length === 1 ? "play" : "plays"}`}
            />
          ))}
        </Shelf>
      ) : null}

      {/* ── Your most played — frequency, which "Recently played" cannot show. */}
      {mostPlayedItems.length >= 2 ? (
        <Shelf
          id="shelf-most-played"
          title="On repeat"
          icon={<Repeat2 className="size-4 text-[rgb(var(--tint))]" />}
        >
          {mostPlayedItems.slice(0, 14).map((item) => (
            <MediaCard
              key={item.id}
              item={item}
              onOpen={() => playShelf(item)}
              onPlay={() => playShelf(item)}
              resolving={resolvingId === item.id}
              meta={`${history.find((h) => (h.youtubeId ?? h.id) === item.id)?.playCount ?? 1} plays`}
            />
          ))}
        </Shelf>
      ) : null}

      {/* ── Global context. Shown for everyone; it is the cold-start path. */}
      <Shelf
        id="shelf-chart"
        title="Songs of the week"
        subtitle="The most-played songs across the globe right now."
        icon={<Flame className="size-4 text-[rgb(var(--tint))]" />}
        skeleton={trending === null}
        hidden={trending !== null && trending.length === 0}
      >
        {usable(trending)
          .slice(0, 14)
          .map((item) => (
            <MediaCard
              key={item.id}
              item={item}
              onOpen={() => playTrending(item)}
              onPlay={() => playTrending(item)}
            />
          ))}
      </Shelf>

      {/* One row per recording: `discovery.*` is the allocator's output, not
          the raw per-section search result. A section the allocator could not
          fill is dropped instead of rendering a stub row. */}
      <Shelf
        id="shelf-discover"
        title="Discover something new"
        // The shelf says which genre it is showing. A rotation the listener
        // cannot see would look like the same unexplained row every day.
        subtitle={`${capitalize(
          rotateSeed(DISCOVERY_SEEDS, seedRotation).replace(
            /\s*essentials$/i,
            "",
          ),
        )} · rotates daily`}
        icon={<Compass className="size-4 text-[rgb(var(--tint))]" />}
        skeleton={remote.discover === undefined && !engineHasDiscovery}
        hidden={
          engineHasDiscovery ||
          (!remoteFailures.discover &&
            remote.discover !== undefined &&
            discovery.discover.length === 0)
        }
      >
        {remoteFailures.discover ? (
          <ShelfRetry onRetry={retryShelves} />
        ) : null}
        {discovery.discover.map((item) => (
          <MediaCard
            key={item.id}
            item={item}
            onOpen={() => playRemoteItem(item, discovery.discover)}
            onPlay={() => playRemoteItem(item, discovery.discover)}
          />
        ))}
      </Shelf>

      {/* Releases, not search rows: these carry the provider's own year, so
          the shelf can honestly be sorted by release date and can never show a
          song twice. Hidden while there is no play history to build it from. */}
      <Shelf
        id="shelf-new-from-artists"
        title="New from your artists"
        subtitle="Releases from the artists you play most"
        icon={<Disc3 className="size-4 text-[rgb(var(--tint))]" />}
        skeleton={artistReleases === null && topArtistNames.length > 0}
        hidden={(artistReleases?.length ?? 0) === 0}
      >
        {(artistReleases ?? []).map(({ artist, release }) => (
          <MediaCard
            key={`${artist}-${release.id}`}
            variant="playlist"
            item={{
              id: release.id,
              title: release.title,
              artist,
              duration: 0,
              thumbnail: release.thumbnail ?? "",
              album: release.title,
            }}
            meta={[release.year, KIND_LABEL[release.kind]].filter(Boolean).join(" · ")}
            onOpen={() => {
              const href = albumPath(artist, release.title);
              if (href) navigate(href);
            }}
          />
        ))}
      </Shelf>

      {/* These two used to share a two-column grid on large screens, which
          squeezed two carousels into a half width each — the empty space this
          page was criticised for. Full width, same rail as every other row. */}
      <Shelf
        id="shelf-time"
        title="Right now"
        subtitle={localTime}
        icon={<Sun className="size-4 text-[rgb(var(--tint))]" />}
        skeleton={remote.timeOfDay === undefined}
        hidden={
          !remoteFailures.timeOfDay &&
          remote.timeOfDay !== undefined &&
          discovery.timeOfDay.length === 0
        }
      >
        {remoteFailures.timeOfDay ? (
          <ShelfRetry onRetry={retryShelves} />
        ) : null}
        {discovery.timeOfDay.map((item) => (
          <MediaCard
            key={item.id}
            item={item}
            onOpen={() => playRemoteItem(item, discovery.timeOfDay)}
            onPlay={() => playRemoteItem(item, discovery.timeOfDay)}
          />
        ))}
      </Shelf>

      <Shelf
        id="shelf-season"
        title={`Sounds of ${capitalize(season)}`}
        icon={<Disc3 className="size-4 text-[rgb(var(--tint))]" />}
        skeleton={remote.seasonal === undefined}
        hidden={
          !remoteFailures.seasonal &&
          remote.seasonal !== undefined &&
          discovery.seasonal.length === 0
        }
      >
        {remoteFailures.seasonal ? (
          <ShelfRetry onRetry={retryShelves} />
        ) : null}
        {discovery.seasonal.map((item) => (
          <MediaCard
            key={item.id}
            item={item}
            onOpen={() => playRemoteItem(item, discovery.seasonal)}
            onPlay={() => playRemoteItem(item, discovery.seasonal)}
          />
        ))}
      </Shelf>

      {/* ── Mood launches: a fast way in without typing a search. */}
      <Shelf
        id="shelf-moods"
        title="Set the mood"
        action={{ to: "/search", label: "Browse all" }}
        icon={<Sparkles className="size-4 text-[rgb(var(--tint))]" />}
      >
        {MOOD_LAUNCHES.map(({ label, query, tone }) => (
          <Link
            key={label}
            to={`/search?q=${encodeURIComponent(query)}`}
            className={cn(
              // `relative` anchors the decorative glow below. Without it the
              // absolutely-positioned span resolves against some distant
              // positioned ancestor and the tile renders a stray blob.
              "group relative flex aspect-square w-32 shrink-0 snap-start flex-col justify-end overflow-hidden rounded-xl border border-white/[0.08] bg-gradient-to-br p-3 transition-ui hover:-translate-y-0.5 hover:border-[rgb(var(--tint)_/_0.35)] sm:w-40 lg:w-44",
              tone,
            )}
          >
            <span className="pointer-events-none absolute -top-5 -right-4 size-20 rounded-full bg-white/[0.06] blur-xl transition-transform duration-500 group-hover:scale-125" />
            <span className="relative text-sm font-semibold text-foreground">
              {label}
            </span>
            <span className="relative mt-0.5 text-[10px] text-muted-foreground">
              Open mix →
            </span>
          </Link>
        ))}
      </Shelf>

      {/* ── Listening pulse, kept last: it is a readout, not a way in. */}
      <section aria-labelledby="listening-pulse-title">
        <div className="glass-card relative overflow-hidden rounded-2xl p-4 sm:p-5">
          <div className="pointer-events-none absolute -top-24 -right-16 size-56 rounded-full bg-[rgb(var(--tint)_/_0.1)] blur-3xl" />
          <div className="relative flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
                <BarChart3 className="size-3.5 text-[rgb(var(--tint))]" />
                Listening pulse
              </div>
              <h2
                id="listening-pulse-title"
                className="mt-1 font-display text-lg font-bold tracking-tight sm:text-xl"
              >
                Your week in sound
              </h2>
            </div>
            <Link
              to="/stats"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:border-[rgb(var(--tint)_/_0.35)] hover:text-foreground"
            >
              Full stats <BarChart3 className="size-3.5" />
            </Link>
          </div>

          <div className="relative mt-4 grid grid-cols-3 gap-1.5 sm:gap-2">
            <div className="min-w-0 rounded-xl border border-white/[0.07] bg-black/10 p-2 sm:p-3">
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <Play className="size-3 shrink-0 text-[rgb(var(--tint))]" />
                <span className="truncate">Sessions</span>
              </div>
              <p className="mt-0.5 text-base font-bold tabular-nums sm:mt-1 sm:text-xl">
                {listeningPulse.totalPlays}
              </p>
            </div>
            <div className="min-w-0 rounded-xl border border-white/[0.07] bg-black/10 p-2 sm:p-3">
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <UsersRound className="size-3 shrink-0 text-[rgb(var(--tint))]" />
                <span className="truncate">Artists</span>
              </div>
              <p className="mt-0.5 text-base font-bold tabular-nums sm:mt-1 sm:text-xl">
                {listeningPulse.uniqueArtists}
              </p>
            </div>
            <div className="min-w-0 rounded-xl border border-white/[0.07] bg-black/10 p-2 sm:p-3">
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <Repeat2 className="size-3 shrink-0 text-[rgb(var(--tint))]" />
                <span className="truncate">Top repeat</span>
              </div>
              <p className="mt-0.5 text-base font-bold tabular-nums sm:mt-1 sm:text-xl">
                {listeningPulse.topRepeat}×
              </p>
            </div>
          </div>

          <div className="relative mt-4 flex h-14 items-end gap-1 overflow-hidden border-b border-white/[0.08] sm:h-16 sm:gap-1.5">
            {listeningPulse.bars.map((count, index) => (
              <div
                key={`${index}-${count}`}
                className="group/bar flex h-full min-w-0 flex-1 items-end"
              >
                <div
                  className="w-full rounded-t-md bg-gradient-to-t from-[rgb(var(--tint)_/_0.3)] to-[rgb(var(--tint))] opacity-65 transition-ui duration-300 group-hover/bar:opacity-100"
                  style={{
                    height: `${Math.max(12, (count / listeningPulse.maxBar) * 100)}%`,
                  }}
                  title={`${count} ${count === 1 ? "play" : "plays"}`}
                />
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * Engine candidates reuse the existing remote-row components, so they are
 * converted to the same `YtItem` shape every other Home shelf already renders.
 * No second track component, no second visual system.
 */
function toYtItem(candidate: RecoCandidate): YtItem {
  return {
    id: candidate.id,
    title: candidate.title,
    artist: candidate.artist,
    duration: candidate.duration,
    thumbnail: candidate.thumbnail,
    ...(candidate.album ? { album: candidate.album } : {}),
  };
}

/**
 * A search shelf whose queries all failed, shown as a retry instead of a gap.
 *
 * Hiding a failed shelf is worse than showing the failure: the listener sees a
 * row vanish and has no way to tell a throttled provider from an empty one, or
 * to ask again.
 */
function ShelfRetry({ onRetry }: { onRetry: () => void }) {
  return (
    <button
      type="button"
      onClick={onRetry}
      className="flex h-40 w-64 shrink-0 flex-col items-start justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-4 text-left transition-colors hover:border-[rgb(var(--tint)_/_0.4)] hover:bg-white/[0.06]"
    >
      <RotateCw className="size-4 text-[rgb(var(--tint))]" />
      <span className="text-sm font-semibold">
        The music source didn&apos;t answer
      </span>
      <span className="text-xs text-muted-foreground">
        Try this row again — nothing else on the page is affected.
      </span>
    </button>
  );
}

/**
 * Shelves are filtered once, by this, rather than inside every shelf: a shelf
 * that renders an unplayable row is worse than a shelf that renders fewer rows,
 * and the same filter has to apply to history, recommendations and live search
 * results alike.
 *
 * Module-level on purpose. As a `const` inside the component it was in the
 * temporal dead zone while the allocator memo above it ran, and the whole Home
 * page crashed with "Cannot access 'usable' before initialization" — a closure
 * TS accepts and the runtime does not.
 */
function usable(items: YtItem[] | undefined | null): YtItem[] {
  return Array.isArray(items) ? items.filter(isUsableRemoteItem) : [];
}

function isUsableRemoteItem(item: YtItem): boolean {
  return (
    !!item &&
    typeof item.id === "string" &&
    item.id.length > 0 &&
    typeof item.title === "string" &&
    typeof item.artist === "string"
  );
}

// --- helpers -----------------------------------------------------------------

function isPlayableSource(snap: LastPlayedSnapshot): boolean {
  return !!snap.youtubeId;
}

function snapshotToPlayable(snap: LastPlayedSnapshot): Playable {
  return {
    id: snap.id,
    title: snap.title,
    artistName: cleanArtistName(snap.artistName, snap.title),
    albumName: snap.albumName,
    coverUrl: snap.coverUrl,
    duration: snap.duration,
    source: "youtube",
    youtubeId: snap.youtubeId,
    audioUrl: snap.audioUrl,
  };
}

function formatLocalTime(date = new Date()): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(date);
}

function timeOfDayLabel(): string {
  const h = new Date().getHours();
  if (h < 6) return "late night";
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  if (h < 22) return "evening";
  return "night";
}

function seasonLabel(): string {
  const m = new Date().getMonth();
  if (m < 3) return "winter";
  if (m < 6) return "spring";
  if (m < 9) return "summer";
  return "fall";
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** m:ss for a playback position. */
function formatClock(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

// Group history items by artist name, sorted by entry count, for "Trending artists".
function artistTrend(
  items: YtItem[],
): Array<{ artist: string; items: YtItem[] }> {
  const byArtist = new Map<string, YtItem[]>();
  for (const item of items) {
    const key = cleanArtistName(item.artist, item.title);
    const list = byArtist.get(key) ?? [];
    list.push(item);
    byArtist.set(key, list);
  }
  return [...byArtist.entries()]
    .map(([artist, list]) => ({ artist, items: list }))
    .sort((a, b) => b.items.length - a.items.length);
}
