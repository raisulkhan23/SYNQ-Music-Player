import { useAction } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Disc3,
  Loader2,
  RefreshCw,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { toPlayableYoutube } from "@/lib/playable";
import { usePlayerStore } from "@/store/player";
import type { JamendoTrack } from "@/lib/jamendo";
import { matchDiscovery } from "@/lib/jamendoDiscovery";
import type { ImportFailure } from "@/lib/importModel";

/**
 * Jamendo search results — a DISCOVERY index, not a playback source.
 *
 * Jamendo used to be wired in as a second playable provider: it returned
 * Creative Commons stream URLs and the player fed them straight to the
 * `<audio>` element. That path never worked for the listeners it was built
 * for — every Jamendo track came back silent, and a silent row teaches the
 * listener the app is broken rather than that one row is.
 *
 * What is worth keeping is what never touches the audio element: Jamendo is a
 * large index of independent, openly-licensed music that YouTube search does
 * not surface reliably. So a click here now asks YouTube for that specific
 * song and plays the upload it finds. Jamendo decides what is offered;
 * YouTube decides what plays. If no real match exists, the listener is told
 * so plainly instead of being handed silence.
 *
 * Self-contained on purpose: it owns its query, its request and every state it
 * can be in, so the search page's own loading/error logic is not extended with
 * a fourth case it would then have to keep in sync.
 *
 * The failure states are the point. Jamendo needs a free API key, and a
 * deployment without one must say so plainly instead of appearing broken; a
 * spent quota must say "try again shortly" rather than "something went wrong".
 */
export function JamendoResults({ query }: { query: string }) {
  const searchJamendo = useAction(api.jamendo.searchJamendo);
  const searchYoutube = useAction(api.youtube.searchYoutube);
  const playTrack = usePlayerStore((s) => s.playTrack);

  /**
   * One state object, tagged with the request that produced it.
   *
   * Storing `loading` as its own boolean means setting it synchronously when
   * the effect starts, which is a cascading render on every keystroke — the
   * same shape as the `Shelf` loop that used to hang this app. Deriving
   * "still loading" from "does the answer match the current query" removes the
   * setState-at-the-start entirely: the effect only ever writes state from a
   * promise callback, and the UI cannot get stuck showing a spinner because
   * there is no separate flag to forget to clear.
   */
  const [answer, setAnswer] = useState<{
    key: string;
    tracks: JamendoTrack[] | null;
    failure: ImportFailure | null;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  /** The row currently being resolved to a playable upload, by jamendoId. */
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  // Guards against a stale response overwriting a newer one when the listener
  // keeps typing: the last request wins, and the rest are dropped.
  const requestId = useRef(0);

  const trimmed = query.trim();
  const runnable = trimmed.length > 1;
  const key = `${trimmed}#${attempt}`;

  useEffect(() => {
    if (!runnable) return;
    const id = ++requestId.current;

    void searchJamendo({ query: trimmed, limit: 12 })
      .then((result) => {
        if (id !== requestId.current) return;
        setAnswer(
          result.ok
            ? { key, tracks: result.tracks, failure: null }
            : { key, tracks: null, failure: result.failure },
        );
      })
      .catch((error: unknown) => {
        if (id !== requestId.current) return;
        setAnswer({
          key,
          tracks: null,
          failure: {
            code: "unknown",
            message: "Jamendo search didn't finish.",
            retryable: true,
            hint:
              error instanceof Error && error.message
                ? error.message.slice(0, 200)
                : undefined,
          },
        });
      });
  }, [searchJamendo, trimmed, runnable, key]);

  // A stale answer is treated as no answer at all, so results from the
  // previous query never sit on screen under a new one.
  const fresh = answer?.key === key ? answer : null;
  const loading = runnable && fresh === null;
  const tracks = fresh?.tracks ?? null;
  const failure = fresh?.failure ?? null;

  /**
   * Play this Creative Commons release by finding its YouTube upload.
   *
   * `matchDiscovery` returns null unless the result really is the same song.
   * Playing "Unrelated Song" because its title matched would be worse than
   * saying nothing: the listener would hear music and conclude SYNQ works,
   * and would never learn their blocker is what is silencing the app.
   */
  const onPick = useCallback(
    async (track: JamendoTrack) => {
      if (resolvingId) return;
      setResolvingId(track.jamendoId);
      toast.loading(`Finding "${track.title}"…`, { id: "jamendo-play" });
      try {
        const { items } = await searchYoutube({
          query: `${track.title} ${track.artistName}`.trim(),
        });
        const results = items ?? [];
        const hit = matchDiscovery(track, results);
        const chosen = hit
          ? results.find((it) => it.id === hit.ytId)
          : undefined;
        if (!hit || !chosen) {
          toast.error(`No playable version of "${track.title}" was found`, {
            id: "jamendo-play",
          });
          return;
        }
        const others = results.filter((it) => it.id !== hit.ytId);
        // The chosen upload carries the Jamendo release id it was resolved
        // from: playback stays 100% YouTube, but the download pipeline needs
        // the licensed release to authorize against.
        const withProvenance: typeof chosen = { ...chosen, jamendoId: track.jamendoId };
        const playable = toPlayableYoutube(withProvenance, "", others, track.jamendoId);
        // The queue is the resolved upload plus its siblings, so "next" keeps
        // moving through the same results rather than stopping dead.
        playTrack(playable, [
          playable,
          ...others.map((it) => toPlayableYoutube(it, "", [])),
        ]);
        toast.success(`Playing "${track.title}"`, { id: "jamendo-play" });
      } catch {
        toast.error("Couldn't look that up — try again", {
          id: "jamendo-play",
        });
      } finally {
        setResolvingId(null);
      }
    },
    [resolvingId, searchYoutube, playTrack],
  );

  if (!runnable) return null;

  return (
    <section aria-labelledby="jamendo-heading" className="mt-6">
      <div className="mb-2 flex items-center gap-2">
        <Disc3 className="size-4 text-[rgb(var(--tint))]" />
        <h2
          id="jamendo-heading"
          className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase"
        >
          Independent & Creative Commons
        </h2>
        <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-muted-foreground">
          Jamendo
        </span>
      </div>

      {loading ? (
        <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Searching Jamendo…
        </p>
      ) : failure ? (
        <JamendoFailure
          failure={failure}
          onRetry={() => setAttempt((n) => n + 1)}
        />
      ) : tracks && tracks.length > 0 ? (
        <>
          <p className="mb-2 text-xs text-muted-foreground">
            Independent and Creative Commons licensed releases that YouTube
            search rarely surfaces. Picking one finds it on YouTube and plays it
            there.
          </p>
          <div className="flex flex-col gap-0.5">
            {tracks.map((track) => (
              <JamendoRow
                key={track.jamendoId}
                track={track}
                resolving={resolvingId === track.jamendoId}
                disabled={resolvingId !== null}
                onPlay={onPick}
              />
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

/**
 * Renders the three states that must never look like a crash.
 *
 * "Not configured" is styled as information, not as an error: it is a
 * deployment setting, and a red box would tell the listener their search broke
 * when nothing about their search is wrong.
 */
function JamendoFailure({
  failure,
  onRetry,
}: {
  failure: ImportFailure;
  onRetry: () => void;
}) {
  const isConfig = failure.code === "not-configured";
  const Icon = isConfig ? Sparkles : TriangleAlert;

  return (
    <div
      role="status"
      className="rounded-2xl border border-dashed border-white/10 px-4 py-5"
    >
      <p className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        {failure.message}
      </p>
      {failure.hint ? (
        <p className="mt-1.5 text-xs text-muted-foreground">{failure.hint}</p>
      ) : null}
      {failure.retryable ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-1.5 text-xs font-medium transition-colors hover:bg-white/[0.08]"
        >
          <RefreshCw className="size-3" />
          Try again
        </button>
      ) : null}
    </div>
  );
}

function JamendoRow({
  track,
  resolving,
  disabled,
  onPlay,
}: {
  track: JamendoTrack;
  resolving: boolean;
  disabled: boolean;
  onPlay: (track: JamendoTrack) => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onPlay(track)}
      className="group flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-white/[0.05] disabled:cursor-progress disabled:opacity-60"
    >
      {track.coverUrl ? (
        <img
          src={track.coverUrl}
          alt=""
          loading="lazy"
          className="size-10 shrink-0 rounded-lg object-cover"
        />
      ) : (
        <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-white/[0.05]">
          <Disc3 className="size-4 text-muted-foreground" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {track.title}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {track.artistName}
          {track.albumName ? ` · ${track.albumName}` : ""}
        </span>
      </span>
      {resolving ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : null}
      <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
        {formatDuration(track.duration)}
      </span>
    </button>
  );
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
