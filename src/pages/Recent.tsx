import { useMemo, useState, useSyncExternalStore } from "react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { RemoteTrackRow } from "@/components/tracks/RemoteTrackRow";
import { toPlayableYoutube, type Playable } from "@/lib/playable";
import { cleanArtistName, type YtItem } from "@/lib/youtube";
import {
  clearSingleHistoryEntry,
  readPlayHistory,
  subscribePlayHistory,
  usePlayerStore,
  type HistoryEntry,
} from "@/store/player";
import { Dices, History, Loader2, Play, Shuffle, X } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { shuffleList } from "@/lib/queueOrder";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";

const FILTERS = ["All", "Today", "This week"] as const;

function timeAgo(ts?: number): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function entryToItem(h: HistoryEntry): YtItem {
  return {
    id: h.youtubeId ?? h.id,
    title: h.title,
    artist: cleanArtistName(h.artistName, h.title),
    duration: h.duration,
    thumbnail: h.coverUrl,
  };
}

export default function Recent() {
  // Subscribing replaces the old manual `historyVersion` counter: removes AND
  // new plays both push a fresh history snapshot now.
  const history = useSyncExternalStore(
    subscribePlayHistory,
    readPlayHistory,
    readPlayHistory,
  );
  const playTrack = usePlayerStore((s) => s.playTrack);
  const playListOrdered = usePlayerStore((s) => s.playListOrdered);
  const searchYt = useAction(api.youtube.searchYoutube);
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("All");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    // Date.now() inside a memo is intentional: the "Today"/"This week"
    // filters are relative to right now.
    // eslint-disable-next-line react-hooks/purity
    const now = Date.now();
    return history.filter((h) => {
      if (filter === "Today" && (!h.at || now - h.at > 86400_000)) return false;
      if (filter === "This week" && (!h.at || now - h.at > 7 * 86400_000))
        return false;
      if (query) {
        const q = query.toLowerCase();
        return (
          h.title.toLowerCase().includes(q) ||
          cleanArtistName(h.artistName, h.title).toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [history, filter, query]);

  const items = filtered.map(entryToItem);

  const play = (item: YtItem, rest: YtItem[], ordered = false) => {
    const entry = history.find((h) => (h.youtubeId ?? h.id) === item.id);
    // `ordered` plays the list exactly as handed over. The page's Play all /
    // Shuffle all use it so they never inherit (or set) the app's global
    // shuffle preference — otherwise pressing "Shuffle all" once left shuffle
    // on, and the "Play all" button beside it played in random order forever
    // after.
    const start = ordered ? playListOrdered : playTrack;
    // The rest of the list is the QUEUE.
    //
    // It used to be passed as the track's `alternatives` instead, and that
    // third argument is NOT the queue: the store only reaches for alternatives
    // when playback FAILS, to swap in another upload of the same song. So the
    // search path built a one-track queue, and the other history rows came out
    // as random error-recovery swaps — the exact "play all just plays random
    // shit from my history" symptom.
    const queue = rest.filter((r) => r.id !== item.id).map(toPlayableFromItem);
    if (entry?.audioUrl) {
      start(snapshotToPlayable(entry), queue);
      return;
    }
    setResolvingId(item.id);
    const primaryArtist = cleanArtistName(item.artist, item.title);
    searchYt({ query: `${item.title} ${primaryArtist}` })
      .then(({ items: found }) => {
        const best = found.find((f) => f.id === item.id) ?? found[0];
        if (!best) {
          toast.error(`Couldn't play "${item.title}"`);
          return;
        }
        // Alternatives are other uploads of THIS song, which is what the
        // recovery path needs — not the other rows of the history list.
        const alternatives = found.filter((f) => f.id !== best.id);
        start(
          toPlayableYoutube(best, `https://youtu.be/${best.id}`, alternatives),
          queue,
        );
      })
      .catch(() => toast.error("Playback failed — try again"))
      .finally(() => setResolvingId(null));
  };

  const removeFromHistory = (id: string) => {
    // clearSingleHistoryEntry notifies subscribers, so the list repaints on
    // its own — no manual version bump needed.
    clearSingleHistoryEntry(id);
    toast.success("Removed from recently played");
  };

  // "I'm feeling lucky" — random pick from this history, resolves via live search.
  const feelingLucky = () => {
    if (history.length === 0) {
      toast.error("Play a few songs first — then try your luck");
      return;
    }
    const pick = history[Math.floor(Math.random() * history.length)];
    if (pick.audioUrl) {
      playTrack(snapshotToPlayable(pick));
      toast.success(`🎲 ${pick.title}`);
      return;
    }
    setResolvingId(pick.youtubeId ?? pick.id);
    const primaryArtist = cleanArtistName(pick.artistName, pick.title);
    searchYt({ query: `${pick.title} ${primaryArtist}` })
      .then(({ items: found }) => {
        const best = found.find((f) => f.id === pick.youtubeId) ?? found[0];
        if (!best) {
          toast.error("Couldn't find a playable version");
          return;
        }
        playTrack(toPlayableYoutube(best, `https://youtu.be/${best.id}`, []));
        toast.success(`🎲 ${best.title}`);
      })
      .catch(() => toast.error("Playback failed — try again"))
      .finally(() => setResolvingId(null));
  };

  // "Play all" / "Shuffle all" — the page had a random pick and row-level
  // play, but no way to hand the whole (filtered) history to the player as a
  // queue, so a listener who wanted a session from it had to press play on
  // every row.
  const playAll = (shuffled: boolean) => {
    if (items.length === 0) {
      toast.error("No plays match this filter");
      return;
    }
    // Shuffle the WHOLE list, head included. Shuffling only the tail left the
    // most recent song always playing first, which is not what "Shuffle all"
    // means to anyone pressing it.
    const ordered = shuffled ? shuffleList(items) : items;
    const head = ordered[0];
    if (!head) return;
    play(head, ordered.slice(1), true);
    if (shuffled) toast.success("Shuffling your recently played");
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display flex items-center gap-2 text-2xl font-bold tracking-tight sm:text-3xl">
            <History className="size-6 text-[rgb(var(--tint))]" />
            Recently Played
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Everything you've listened to, most recent first.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => playAll(false)}
            disabled={items.length === 0}
            className="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.03] px-4 py-2.5 text-sm font-semibold transition-all hover:border-[rgb(var(--tint)_/_0.35)] hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Play className="size-4 text-[rgb(var(--tint))]" />
            Play all
          </button>
          <button
            type="button"
            onClick={() => playAll(true)}
            disabled={items.length === 0}
            className="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.03] px-4 py-2.5 text-sm font-semibold transition-all hover:border-[rgb(var(--tint)_/_0.35)] hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Shuffle className="size-4 text-[rgb(var(--tint))]" />
            Shuffle all
          </button>
          <button
            type="button"
            onClick={feelingLucky}
            className="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.03] px-4 py-2.5 text-sm font-semibold transition-all hover:border-[rgb(var(--tint)_/_0.35)] hover:bg-white/[0.05]"
          >
            <Dices className="size-4 text-[rgb(var(--tint))]" />
            I&apos;m feeling lucky
            {resolvingId && (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            )}
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              "rounded-full px-3.5 py-1.5 text-xs font-semibold transition-colors",
              filter === f
                ? "bg-[rgb(var(--tint))] text-black"
                : "bg-white/[0.05] text-muted-foreground hover:text-foreground",
            )}
          >
            {f}
          </button>
        ))}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter this history…"
          className="ml-auto w-48 rounded-full border border-white/[0.08] bg-white/[0.04] px-4 py-1.5 text-xs outline-none placeholder:text-muted-foreground/60 focus:border-[rgb(var(--tint)_/_0.5)]"
        />
      </div>

      {history.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-10 text-center">
          <History className="mx-auto size-10 text-muted-foreground/50" />
          <p className="mt-3 font-display text-lg font-semibold">
            Nothing here yet
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Songs you play will show up here with when you last heard them.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <p className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-8 text-center text-sm text-muted-foreground">
          No plays match this filter.
        </p>
      ) : (
        <div className="flex flex-col gap-0.5">
          {items.map((item, i) => {
            const entry = filtered[i];
            return (
              <div key={`${item.id}-${i}`} className="relative">
                <RemoteTrackRow
                  item={item}
                  index={i + 1}
                  onPlay={(it) => play(it, items)}
                  resolving={resolvingId === item.id}
                  source="youtube"
                  trailing={
                    <span className="hidden text-[11px] text-muted-foreground/70 lg:block">
                      {entry.playCount > 1 ? `${entry.playCount} plays · ` : ""}
                      {timeAgo(entry.at)}
                    </span>
                  }
                  menuItems={
                    <DropdownMenuItem
                      className="gap-2"
                      onSelect={(event) => {
                        event.stopPropagation();
                        removeFromHistory(entry.id);
                      }}
                    >
                      <X className="size-4" />
                      Remove from recently played
                    </DropdownMenuItem>
                  }
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function snapshotToPlayable(s: HistoryEntry): Playable {
  return {
    id: s.id,
    title: s.title,
    artistName: cleanArtistName(s.artistName, s.title),
    albumName: s.albumName,
    coverUrl: s.coverUrl,
    duration: s.duration,
    source: "youtube",
    youtubeId: s.youtubeId,
    audioUrl: s.audioUrl,
  };
}

function toPlayableFromItem(item: YtItem): Playable {
  return toPlayableYoutube(item, `https://youtu.be/${item.id}`, []);
}
