import { useNavigate } from "react-router";
import { RemoteTrackRow } from "@/components/tracks/RemoteTrackRow";
import { api } from "@/convex/_generated/api";
import { formatTime } from "@/lib/format";
import { toPlayableSoundcloud, toPlayableYoutube } from "@/lib/playable";
import type { Playable } from "@/lib/playable";
import { cleanArtistName, type YtItem } from "@/lib/youtube";
import { toast } from "sonner";
import { usePlayerStore } from "@/store/player";
import { useAction, useQuery } from "convex/react";
import { Heart, Loader2, Play, Shuffle } from "lucide-react";
import { shuffleList } from "@/lib/queueOrder";
import { useState } from "react";

export default function Liked() {
  const navigate = useNavigate();
  const likedLoaded = usePlayerStore((s) => s.likedLoaded);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const playListOrdered = usePlayerStore((s) => s.playListOrdered);
  const searchYt = useAction(api.youtube.searchYoutube);

  const [resolvingRemoteId, setResolvingRemoteId] = useState<string | null>(
    null,
  );
  const remoteQuery = useQuery(api.likes.myLikedRemote);
  const remoteLikes = remoteQuery ?? [];

  const totalCount = remoteLikes.length;
  const totalSeconds = remoteLikes.reduce((sum, r) => sum + r.duration, 0);

  const playRemoteLike = (
    row: (typeof remoteLikes)[number],
    options?: { shuffle?: boolean },
  ) => {
    if (resolvingRemoteId) return;
    // `shuffle` orders this one call's queue. It is deliberately NOT the
    // app's global shuffle preference: reaching for that switch made a
    // one-off button press sticky, so the plain "Play all" beside it played
    // in random order from then on and the transport's shuffle light stayed
    // on. Pass `shuffle` to get a shuffled session, nothing else to change it.
    const start = options?.shuffle ? playListOrdered : playTrack;
    const queueFor = (first: Playable, firstIsRemote?: string) => {
      const list = buildLikedQueue(first, firstIsRemote);
      return options?.shuffle ? shuffleList(list) : list;
    };

    // A SoundCloud like is the upload itself, not a search for it: replay it
    // from SoundCloud instead of resolving a YouTube match that may be a
    // different recording (a remix, a sped-up edit, a cover).
    if (row.source === "soundcloud") {
      const playable = toPlayableSoundcloud({
        id: row.trackId.replace(/^sc:/, ""),
        title: row.title,
        artist: cleanArtistName(row.artistName, row.title),
        durationMs: Math.round(row.duration * 1000),
        artwork: row.coverUrl,
        permalinkUrl: "",
        explicit: false,
      });
      start(playable, queueFor(playable, row.trackId));
      return;
    }

    // Liked remote rows already carry the resolved YouTube id. Use it
    // directly instead of making the user wait for a second search request.
    const knownYoutubeId =
      row.youtubeId ?? (row.source === "youtube" ? row.trackId : undefined);
    if (knownYoutubeId) {
      const item: YtItem = {
        id: row.trackId,
        title: row.title,
        artist: cleanArtistName(row.artistName, row.title),
        thumbnail: row.coverUrl,
        duration: row.duration,
      };
      const playable: Playable = {
        ...toPlayableYoutube(item, `https://youtu.be/${knownYoutubeId}`),
        youtubeId: knownYoutubeId,
      };
      start(playable, queueFor(playable, row.trackId));
      return;
    }

    setResolvingRemoteId(row.trackId);
    searchYt({
      query: `${row.title} ${cleanArtistName(row.artistName, row.title)}`,
    })
      .then(({ items }) => {
        const best = items[0];
        if (!best) {
          toast.error(`Couldn't load "${row.title}" — try another song`);
          return;
        }
        const item: YtItem = {
          id: row.trackId,
          title: row.title,
          artist: cleanArtistName(row.artistName, row.title),
          thumbnail: row.coverUrl,
          duration: row.duration,
        };
        const playable = {
          ...toPlayableYoutube(
            item,
            `https://youtu.be/${best.id}`,
            items.slice(1),
          ),
          youtubeId: best.id,
        };
        start(playable, queueFor(playable));
      })
      .catch(() => toast.error("Playback failed — try again in a moment"))
      .finally(() => setResolvingRemoteId(null));
  };

  /**
   * Resolve the full Liked Songs list into a playable queue. Remote likes
   * resolve through live search; placeholder stream entries are auto-rescued
   * by the player when they come up in the queue.
   */
  const buildLikedQueue = (
    firstPlayable: Playable,
    firstIsRemote?: string,
  ): Playable[] => {
    const out: Playable[] = [];
    let firstInserted = false;
    for (const row of remoteLikes) {
      if (firstIsRemote === row.trackId) {
        out.push(firstPlayable);
        firstInserted = true;
        continue;
      }
      if (row.source === "soundcloud") {
        out.push(
          toPlayableSoundcloud({
            id: row.trackId.replace(/^sc:/, ""),
            title: row.title,
            artist: cleanArtistName(row.artistName, row.title),
            durationMs: Math.round(row.duration * 1000),
            artwork: row.coverUrl,
            permalinkUrl: "",
            explicit: false,
          }),
        );
        continue;
      }
      const item: YtItem = {
        id: row.trackId,
        title: row.title,
        artist: cleanArtistName(row.artistName, row.title),
        thumbnail: row.coverUrl,
        duration: row.duration,
      };
      out.push({
        ...toPlayableYoutube(item, row.youtubeId ?? item.id),
        youtubeId: row.youtubeId ?? undefined,
      });
    }
    void firstInserted;
    return out;
  };

  const playAll = () => {
    if (totalCount === 0) return;
    const first = remoteLikes[0];
    playRemoteLike(first);
  };

  const shuffleAll = () => {
    if (totalCount === 0) return;
    const row = remoteLikes[Math.floor(Math.random() * remoteLikes.length)];
    // `totalCount` IS `remoteLikes.length`, but the guard has to be on the
    // array actually being indexed: picking from an empty list yields
    // `undefined`, and every field read off it below throws inside the click
    // handler, which reads to the user as the button doing nothing at all.
    if (!row) return;
    playRemoteLike(row, { shuffle: true });
    toast.success("Shuffling your liked songs");
  };

  const total = totalSeconds;

  return (
    <div className="flex flex-col gap-6">
      {/* header */}
      <div className="relative overflow-hidden rounded-3xl p-6 sm:p-8">
        <div className="absolute inset-0 bg-gradient-to-br from-rose-500/25 via-fuchsia-500/10 to-transparent" />
        <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-transparent opacity-70" />
        <div className="relative flex items-end gap-5">
          <div className="relative flex size-24 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-[#111b1b] shadow-2xl sm:size-32">
            <span className="absolute -left-8 -top-8 size-24 rounded-full bg-[rgb(var(--tint)/0.5)] blur-2xl" />
            <span className="absolute -bottom-10 -right-6 size-28 rounded-full bg-emerald-400/20 blur-2xl" />
            <Heart className="relative z-10 size-12 text-[rgb(var(--tint))] sm:size-16" />
          </div>
          <div className="min-w-0">
            <p className="text-[11px] font-semibold tracking-[0.2em] text-white/60 uppercase">
              Playlist
            </p>
            <h1 className="mt-1 truncate font-display text-3xl font-bold tracking-tight sm:text-4xl">
              Liked Songs
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {likedLoaded
                ? totalCount > 0
                  ? `${totalCount} ${totalCount === 1 ? "song" : "songs"} · ${formatTime(total)}`
                  : "Nothing here yet"
                : "Loading…"}
            </p>
          </div>
        </div>
      </div>

      {totalCount > 0 ? (
        <>
          <div className="flex items-center gap-3 px-2">
            <button
              type="button"
              onClick={playAll}
              disabled={resolvingRemoteId !== null}
              className="flex shrink-0 items-center gap-2 rounded-full bg-[rgb(var(--tint))] px-5 py-2.5 text-sm font-semibold text-black shadow-[0_8px_30px_rgb(var(--tint)/0.35)] transition-all hover:scale-[1.03] active:scale-95 disabled:opacity-60"
            >
              <Play className="size-4 fill-current" />
              Play all
            </button>
            <button
              type="button"
              onClick={shuffleAll}
              disabled={resolvingRemoteId !== null}
              className="flex shrink-0 items-center gap-2 rounded-full border border-white/15 bg-white/[0.05] px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-white/[0.1] disabled:opacity-60"
            >
              {resolvingRemoteId !== null ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Shuffle className="size-4" />
              )}
              Shuffle
            </button>
          </div>
          <div className="flex flex-col gap-0.5">
            {remoteLikes.map((row, i) => (
              <RemoteTrackRow
                key={row.trackId}
                item={{
                  id: row.trackId,
                  title: row.title,
                  artist: cleanArtistName(row.artistName, row.title),
                  thumbnail: row.coverUrl,
                  duration: row.duration,
                }}
                index={i + 1}
                resolving={resolvingRemoteId === row.trackId}
                onPlay={() => playRemoteLike(row)}
                source={row.source === "spotify" ? "spotify" : "youtube"}
              />
            ))}
          </div>
        </>
      ) : likedLoaded ? (
        <div className="flex flex-col items-center gap-4 py-16 text-center">
          <Heart className="size-10 text-muted-foreground/30" />
          <div>
            <p className="font-display text-lg font-semibold">
              No liked songs yet
            </p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Tap the heart on any track to save it here for quick playback.
            </p>
          </div>
          <button
            type="button"
            onClick={() => navigate("/search")}
            className="mt-1 rounded-full bg-[rgb(var(--tint))] px-5 py-2.5 text-sm font-semibold text-black shadow-[0_8px_30px_rgb(var(--tint)/0.35)] transition-transform hover:scale-[1.03]"
          >
            Find music
          </button>
        </div>
      ) : null}
    </div>
  );
}
