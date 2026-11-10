import { useAction } from "convex/react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Cloud,
  ExternalLink,
  Heart,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { toPlayableSoundcloud } from "@/lib/playable";
import { usePlayerStore } from "@/store/player";
import type { ScTrack } from "@/convex/soundcloud";

/**
 * SoundCloud search results — a FIRST-CLASS PLAYABLE SOURCE.
 *
 * Unlike the Jamendo section above it (a discovery index resolved to YouTube
 * on click), a SoundCloud row plays FROM SoundCloud: the Convex action
 * resolves the upload's own progressive MP3 and the decks stream it through
 * /audio-proxy, so the EQ, crossfade and gapless hand-off all apply. SNIP
 * previews and HLS-only uploads are refused server-side; a row that cannot
 * play says so at click time instead of starting a silent element.
 *
 * Self-contained like `JamendoResults`: it owns its query, its request and
 * every state it can be in, so the search page's logic is not extended.
 */
export function SoundCloudResults({ query }: { query: string }) {
  const searchSoundcloud = useAction(api.soundcloud.searchSoundcloud);
  const playTrack = usePlayerStore((s) => s.playTrack);

  const [answer, setAnswer] = useState<{
    key: string;
    tracks: ScTrack[] | null;
    failure: string | null;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const requestId = useRef(0);

  const trimmed = query.trim();
  const runnable = trimmed.length > 1;
  const key = `${trimmed}#${attempt}`;

  useEffect(() => {
    if (!runnable) return;
    const id = ++requestId.current;

    void searchSoundcloud({ query: trimmed, limit: 12 })
      .then((tracks) => {
        if (id !== requestId.current) return;
        setAnswer({ key, tracks, failure: null });
      })
      .catch((error: unknown) => {
        if (id !== requestId.current) return;
        setAnswer({
          key,
          tracks: null,
          failure:
            error instanceof Error && error.message
              ? error.message
              : "SoundCloud search didn't finish.",
        });
      });
  }, [searchSoundcloud, trimmed, runnable, key]);

  const fresh = answer?.key === key ? answer : null;
  const loading = runnable && fresh === null;
  const tracks = fresh?.tracks ?? null;
  const failure = fresh?.failure ?? null;

  const onPick = useCallback(
    (track: ScTrack) => {
      const playable = toPlayableSoundcloud(track);
      // The queue is the result list in order, so "next" keeps moving through
      // the SoundCloud section instead of stopping dead. Every row carries
      // its own id, so each one resolves itself when it starts.
      const queue = (tracks ?? [track]).map(toPlayableSoundcloud);
      playTrack(playable, queue);
      toast.success(`Playing "${track.title}" from SoundCloud`);
    },
    [tracks, playTrack],
  );

  if (!runnable) return null;

  return (
    <section aria-labelledby="soundcloud-heading" className="mt-6">
      <div className="mb-2 flex items-center gap-2">
        <Cloud className="size-4 text-[rgb(var(--tint))]" />
        <h2
          id="soundcloud-heading"
          className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase"
        >
          On SoundCloud
        </h2>
        <span className="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] text-muted-foreground">
          SoundCloud
        </span>
      </div>

      {loading ? (
        <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Searching SoundCloud…
        </p>
      ) : failure ? (
        <div
          role="status"
          className="rounded-2xl border border-dashed border-white/10 px-4 py-5"
        >
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            <TriangleAlert className="size-4 shrink-0 text-muted-foreground" />
            {failure}
          </p>
          <button
            type="button"
            onClick={() => setAttempt((n) => n + 1)}
            className="mt-3 flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-1.5 text-xs font-medium transition-colors hover:bg-white/[0.08]"
          >
            <RefreshCw className="size-3" />
            Try again
          </button>
        </div>
      ) : tracks && tracks.length > 0 ? (
        <>
          <p className="mb-2 text-xs text-muted-foreground">
            Uploads from SoundCloud, played from SoundCloud. Remixes, sets and
            indie releases YouTube does not surface.
          </p>
          <div className="flex flex-col gap-0.5">
            {tracks.map((track) => (
              <SoundCloudRow
                key={track.id}
                track={track}
                onPlay={onPick}
              />
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

function SoundCloudRow({
  track,
  onPlay,
}: {
  track: ScTrack;
  onPlay: (track: ScTrack) => void;
}) {
  const liked = usePlayerStore((s) => s.liked);
  const toggleLike = usePlayerStore((s) => s.toggleLike);
  const playable = toPlayableSoundcloud(track);
  const isLiked = liked[playable.id] !== undefined;

  return (
    <div className="group flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors hover:bg-white/[0.05]">
      <button
        type="button"
        onClick={() => onPlay(track)}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        title={`Play ${track.title}`}
      >
        {track.artwork ? (
          <img
            src={track.artwork}
            alt=""
            loading="lazy"
            className="size-10 shrink-0 rounded-lg object-cover"
          />
        ) : (
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-white/[0.05]">
            <Cloud className="size-4 text-muted-foreground" />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {track.title}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {track.artist}
            {track.explicit ? " · E" : ""}
          </span>
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
          {formatDuration(track.durationMs / 1000)}
        </span>
      </button>
      <button
        type="button"
        aria-label={
          isLiked ? "Remove from liked songs" : "Add to liked songs"
        }
        aria-pressed={isLiked}
        title={isLiked ? "Remove from liked songs" : "Add to liked songs"}
        onClick={() =>
          // The snapshot is what lets Liked Songs render and replay this
          // upload: SoundCloud tracks are not in any catalog, so a bare id
          // would come back as an empty row.
          toggleLike(playable.id, {
            title: track.title,
            artistName: track.artist,
            coverUrl: track.artwork ?? "",
            duration: playable.duration,
            source: "soundcloud",
          })
        }
        className="shrink-0 rounded-full p-1.5 transition-colors hover:scale-110"
      >
        <Heart
          className={
            isLiked
              ? "size-3.5 fill-current text-[rgb(var(--tint))]"
              : "size-3.5 text-muted-foreground hover:text-foreground"
          }
        />
      </button>
      {track.permalinkUrl ? (
        <a
          href={track.permalinkUrl}
          target="_blank"
          rel="noreferrer"
          title="Open on SoundCloud"
          className="shrink-0 rounded-full border border-white/10 p-1.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
        >
          <ExternalLink className="size-3.5" />
        </a>
      ) : null}
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "--:--";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
