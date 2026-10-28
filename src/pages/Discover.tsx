import { useEffect, useRef, useState } from "react";
import { useAction, useConvexAuth, useQuery } from "convex/react";
import { Compass, Loader2, Search, Sparkles, Wand2 } from "lucide-react";

import { api } from "@/convex/_generated/api";
import { toPlayableYoutube, type Playable } from "@/lib/playable";
import { cleanArtistName, type YtItem } from "@/lib/youtube";
import { usePlayerStore } from "@/store/player";

/**
 * Discover — natural-language search over the listener's OWN library.
 *
 * The rest of the app searches the wider music world through live sources.
 * This is the opposite and deliberately so: it searches the tracks this
 * listener has actually liked, played and saved, ranked by meaning rather than
 * by keyword. "Something quiet for the drive home" returns their own music.
 *
 * It is a separate surface on purpose. The existing recommendation and search
 * paths work from live provider data and are good at what they do; adding
 * vectors to them would make their results worse, not better. So this page
 * owns the vector path end to end and touches nothing else in the app.
 *
 * Everything here is read-only except the index button, and the index is
 * built from data the listener already has. No external service, no keys.
 */

type Result = {
  track_id: string;
  title: string;
  artist: string;
  album: string;
  cover_url: string;
  duration: number;
  youtube_id?: string;
  score: number;
  match_reasons: string[];
};

const EXAMPLES = [
  "something quiet for the drive home",
  "the songs I keep coming back to",
  "late night and a bit sad",
  "loud enough to wake up to",
];

export default function Discover() {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<Result[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [indexing, setIndexing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // `indexStatus` calls `requireOwner`, which THROWS rather than returning an
  // empty result when there is no session. Convex re-throws that during render,
  // so a signed-out visitor who reaches this page from the ⌘K palette got the
  // route error card — "This page didn't load" — instead of the page. Both
  // actions below are already try/caught, so the query is the only unguarded
  // one. Skipping it while unauthenticated leaves `status` undefined, which
  // `indexed = status?.indexed ?? 0` below already renders as an empty state.
  // Same "skip" convention `usePreferencesSync` and `ShareDialog` use.
  const { isAuthenticated } = useConvexAuth();
  const status = useQuery(
    api.libraryVectors.indexStatus,
    isAuthenticated ? {} : "skip",
  );
  const discover = useAction(api.libraryVectors.discover);
  const syncLibrary = useAction(api.libraryVectors.syncLibrary);
  const searchYt = useAction(api.youtube.searchYoutube);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const resolvingRef = useRef<string | null>(null);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  // A guard against a slow action landing after the listener has typed
  // something else. Without it the results shown belong to the previous query,
  // which reads as "the search is broken" rather than "it was slow".
  const latestRequest = useRef(0);

  useEffect(() => {
    return () => {
      resolvingRef.current = null;
    };
  }, []);

  async function runSearch(query: string) {
    const text = query.trim();
    if (!text) return;
    const requestId = latestRequest.current + 1;
    latestRequest.current = requestId;
    setBusy(true);
    setNotice(null);
    try {
      const response = await discover({ query: text, limit: 25 });
      if (latestRequest.current !== requestId) return;
      setResults(response.results as Result[]);
      if (response.needs_sync) {
        setNotice("Index your library first to search it.");
      } else if (response.results.length === 0) {
        setNotice("Nothing in your library matched that.");
      }
    } catch {
      if (latestRequest.current !== requestId) return;
      setNotice("Search failed. Try again in a moment.");
    } finally {
      if (latestRequest.current === requestId) setBusy(false);
    }
  }

  async function indexLibrary() {
    setIndexing(true);
    setNotice(null);
    try {
      let cursor: number | null = 0;
      let indexed = 0;
      let considered = 0;
      // Walk the cursor rather than indexing once, so a large library is
      // indexed progressively instead of timing out as a single request.
      do {
        const report = await syncLibrary({ cursor: cursor ?? undefined });
        indexed += report.indexed;
        considered = report.considered;
        cursor = report.cursor;
      } while (cursor !== null && cursor !== undefined);

      setNotice(
        indexed > 0
          ? `Indexed ${indexed} of ${considered} tracks from your library.`
          : "Your library is already up to date.",
      );
    } catch {
      setNotice("Could not index your library. Try again in a moment.");
    } finally {
      setIndexing(false);
    }
  }

  async function play(result: Result) {
    const item: YtItem = {
      id: result.track_id,
      title: result.title,
      artist: cleanArtistName(result.artist, result.title),
      thumbnail: result.cover_url,
      duration: result.duration,
    };

    if (result.youtube_id) {
      const playable: Playable = {
        ...toPlayableYoutube(item, `https://youtu.be/${result.youtube_id}`),
        youtubeId: result.youtube_id,
      };
      playTrack(playable, [playable]);
      return;
    }

    // No known stream, so resolve one the same way the rest of the app does.
    // One in-flight lookup at a time: two buttons resolving at once would race
    // and play whichever answer arrived last.
    if (resolvingRef.current) return;
    resolvingRef.current = result.track_id;
    setResolvingId(result.track_id);
    try {
      const response = await searchYt({
        query: `${result.title} ${cleanArtistName(result.artist, result.title)}`,
      });
      const found = response?.items?.[0];
      if (found) {
        const playable = toPlayableYoutube(
          found,
          `https://youtu.be/${found.id}`,
          [item],
        );
        playTrack(playable, [playable]);
      } else {
        setNotice(`No playable version of "${result.title}" was found.`);
      }
    } catch {
      setNotice(`Could not play "${result.title}".`);
    } finally {
      resolvingRef.current = null;
      setResolvingId(null);
    }
  }

  const indexed = status?.indexed ?? 0;

  return (
    <div className="mx-auto w-full max-w-3xl px-1 py-6">
      <header className="mb-6">
        <p className="flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          <Compass className="size-4 text-[rgb(var(--tint))]" />
          Discover
        </p>
        <h1 className="font-display mt-2 text-2xl font-bold sm:text-3xl">
          Search your library by meaning
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Describe what you want to hear. It ranks{" "}
          <span className="text-foreground">
            the {indexed > 0 ? indexed : ""} tracks you already like, played and
            saved
          </span>{" "}
          — not the whole internet.
        </p>
      </header>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch(term);
        }}
        className="flex items-center gap-2"
      >
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="sad songs for a rainy night"
            aria-label="Describe the music you want"
            className="h-11 w-full rounded-full border border-white/10 bg-white/[0.04] pr-4 pl-9 text-sm outline-none placeholder:text-muted-foreground focus:border-[rgb(var(--tint))]/50"
          />
        </div>
        <button
          type="submit"
          disabled={busy || term.trim().length === 0}
          className="flex h-11 items-center gap-2 rounded-full bg-[rgb(var(--tint))] px-4 text-sm font-semibold text-black disabled:opacity-40"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : null}
          Search
        </button>
      </form>

      {indexed === 0 ? (
        <section className="mt-6 rounded-2xl border border-dashed border-white/10 px-6 py-10 text-center">
          <Wand2 className="mx-auto size-6 text-[rgb(var(--tint))]" />
          <p className="font-display mt-3 font-semibold">
            Your library isn't indexed yet
          </p>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            Indexing reads the tracks you've liked, played and saved so they can
            be searched by meaning. Nothing is uploaded anywhere.
          </p>
          <button
            type="button"
            onClick={() => void indexLibrary()}
            disabled={indexing}
            className="mt-4 inline-flex h-10 items-center gap-2 rounded-full bg-[rgb(var(--tint))] px-5 text-sm font-semibold text-black disabled:opacity-40"
          >
            {indexing ? <Loader2 className="size-4 animate-spin" /> : null}
            {indexing ? "Indexing…" : "Index my library"}
          </button>
        </section>
      ) : null}

      {indexed > 0 && results === null ? (
        <section className="mt-6">
          <p className="mb-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Try one of these
          </p>
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => {
                  setTerm(example);
                  void runSearch(example);
                }}
                className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground"
              >
                {example}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {notice ? (
        <p className="mt-6 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-muted-foreground">
          {notice}
        </p>
      ) : null}

      {results !== null && results.length > 0 ? (
        <section className="mt-6">
          <p className="mb-3 flex items-center gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            <Sparkles className="size-3.5 text-[rgb(var(--tint))]" />
            {results.length} {results.length === 1 ? "track" : "tracks"}
          </p>
          <ul className="flex flex-col gap-1">
            {results.map((result) => (
              <li key={result.track_id}>
                <div className="flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-white/[0.05]">
                  <img
                    src={result.cover_url}
                    alt=""
                    loading="lazy"
                    className="size-11 shrink-0 rounded-lg object-cover ring-1 ring-white/10"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {result.title}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {result.artist}
                      {result.album ? ` · ${result.album}` : ""}
                    </p>
                    {result.match_reasons.length > 0 ? (
                      <p className="mt-0.5 truncate text-[11px] text-muted-foreground/70">
                        {result.match_reasons.slice(0, 2).join(" · ")}
                      </p>
                    ) : null}
                  </div>
                  <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/70">
                    {Math.round(result.score * 100)}%
                  </span>
                  <button
                    type="button"
                    onClick={() => void play(result)}
                    disabled={resolvingId === result.track_id}
                    aria-label={`Play ${result.title}`}
                    className="flex size-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-muted-foreground transition-colors hover:bg-white/[0.1] hover:text-foreground disabled:opacity-40"
                  >
                    {resolvingId === result.track_id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <svg viewBox="0 0 24 24" className="size-4 fill-current">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    )}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
