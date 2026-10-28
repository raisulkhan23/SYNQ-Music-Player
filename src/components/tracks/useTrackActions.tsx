import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";

import { AddToPlaylistItems } from "@/components/playlists/AddToPlaylistItems";
import { PlaylistDialog } from "@/components/playlists/PlaylistDialog";
import { useAddToPlaylist } from "@/components/playlists/useAddToPlaylist";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { buildTrackShareUrl } from "@/lib/shareLink";
import { copyText } from "@/lib/clipboard";
import { toPlayableYoutube } from "@/lib/playable";
import { downloadAvailability, downloadTargetId } from "@/lib/downloadAuth";
import { requestAuthorizedDownload } from "@/lib/authorizedDownload";
import { useAction } from "convex/react";
import { cleanArtistName, cleanTrackTitle, type YtItem } from "@/lib/youtube";
import { usePlayerStore } from "@/store/player";
import {
  Download,
  Heart,
  ListEnd,
  ListMusic,
  ListStart,
  MoreVertical,
  ThumbsDown,
  UserX,
} from "lucide-react";

/**
 * The actions every track surface offers — play next, add to queue, like,
 * add to playlist, copy link.
 *
 * This exists so a track's affordances are defined ONCE. `RemoteTrackRow`
 * (lists, search, playlists) and `MediaCard` (the Home shelves) render
 * completely different chrome around the same artwork and the same title, but
 * they must never disagree about what "Play next" does or which menu entry
 * copies the link.
 */
export function useTrackActions(
  item: YtItem,
  source: "youtube" | "spotify" = "youtube",
) {
  const liked = usePlayerStore((s) => s.liked);
  const toggleLike = usePlayerStore((s) => s.toggleLike);
  const isLiked = liked[item.id] !== undefined;
  const title = cleanTrackTitle(item.title);
  const artistName = cleanArtistName(item.artist, item.title);

  // The menu can create a playlist, so the dialog has to live outside the
  // dropdown content — that unmounts the moment an item is selected.
  const [playlistDialogOpen, setPlaylistDialogOpen] = useState(false);

  const track = useMemo(() => {
    const playable = toPlayableYoutube(item, "");
    return source === "youtube"
      ? playable
      : { ...playable, youtubeId: undefined };
  }, [item, source]);
  const { addTo } = useAddToPlaylist(track);

  const markNotInterested = useMutation(api.notInterested.markNotInterested);
  const unmarkNotInterested = useMutation(
    api.notInterested.unmarkNotInterested,
  );
  const invalidateRecommendCache = useMutation(api.recommend.invalidateCache);

  /**
   * Like / unlike. Unliking offers an Undo, because the heart is the one
   * control a listener taps fast and by reflex — a mis-tap that silently
   * removed a saved song was the whole reason this toast exists. The undo is a
   * second toggle of the same track with the same snapshot, so it restores the
   * row (metadata included) exactly as it was.
   */
  const likeThis = () => {
    const wasLiked = isLiked;
    const snapshot = {
      title,
      artistName,
      coverUrl: item.thumbnail,
      duration: item.duration,
      youtubeId: item.id,
      source,
    };
    toggleLike(item.id, snapshot);
    if (wasLiked) {
      toast(`Removed “${title}” from liked songs`, {
        action: { label: "Undo", onClick: () => toggleLike(item.id, snapshot) },
      });
    }
  };

  const playNext = () => {
    const state = usePlayerStore.getState();
    const at =
      state.queueIndex >= 0 ? state.queueIndex + 1 : state.queue.length;
    state.insertInQueue(track, at);
    toast.success(`Playing "${title}" next`);
  };

  const addQueued = () => {
    usePlayerStore.getState().addToQueue(track);
    toast.success("Added to queue");
  };

  /**
   * "Not interested" — the deliberate negative signal.
   *
   * Two things make this feel trustworthy rather than ignored, and both were
   * the obvious failure modes:
   *
   * 1. THE CACHE IS DROPPED. Home payloads are cached for ten minutes. Writing
   *    the exclusion without invalidating would leave the listener staring at
   *    the song they just rejected, on a row that refreshes by itself, which
   *    reads as a broken button rather than a slow one.
   * 2. THERE IS AN UNDO. A one-tap permanent exclusion with no way back is a
   *    trap — a mis-tap silently removes an artist forever. The toast carries
   *    the reversal, and undo ALSO restores the cache state by invalidating
   *    again rather than trying to surgically re-insert a payload.
   *
   * If the write fails, the listener is told so rather than being left to
   * believe a preference was saved.
   *
   * The queue is deliberately NOT touched, and the current track is not
   * skipped. "Not interested" is a statement about what to be shown next, not a
   * stop button: silently cutting off audio mid-listen is a surprise, and the
   * one thing this feature must never be is destructive.
   */
  const notInterested = async () => {
    try {
      await markNotInterested({
        scope: "track",
        trackId: item.id,
        artistName,
      });
      await invalidateRecommendCache();
      toast.success(`Hidden "${title}"`, {
        description: artistName
          ? `We'll stop recommending it.`
          : "We'll stop recommending it.",
        action: {
          label: "Undo",
          onClick: () => {
            void undoNotInterested();
          },
        },
      });
    } catch {
      toast.error("Couldn't save that — try again");
    }
  };

  /** Not interested in the whole artist, not just this song. */
  const notInterestedInArtist = async () => {
    try {
      await markNotInterested({
        scope: "artist",
        trackId: item.id,
        artistName,
      });
      await invalidateRecommendCache();
      toast.success(`No more ${artistName}`, {
        description: "We'll stop recommending this artist.",
        action: {
          label: "Undo",
          onClick: () => {
            void undoNotInterested("artist");
          },
        },
      });
    } catch {
      toast.error("Couldn't save that — try again");
    }
  };

  const undoNotInterested = async (scope: "track" | "artist" = "track") => {
    try {
      await unmarkNotInterested({
        scope,
        trackId: item.id,
        artistName,
      });
      await invalidateRecommendCache();
      toast.success("Restored");
    } catch {
      toast.error("Couldn't undo that");
    }
  };

  return {
    track,
    title,
    artistName,
    isLiked,
    likeThis,
    playNext,
    addQueued,
    notInterested,
    notInterestedInArtist,
    playlistDialogOpen,
    setPlaylistDialogOpen,
    renderPlaylistDialog: (
      <PlaylistDialog
        open={playlistDialogOpen}
        onOpenChange={setPlaylistDialogOpen}
        onCreate={(id, name) => void addTo(id, name)}
      />
    ),
  };
}

/**
 * The overflow menu for a track. Shared by every surface that renders one, so
 * the set of actions is identical everywhere the user meets a song.
 */
export function TrackActionsMenu({
  item,
  source = "youtube",
  extraItems,
  triggerClassName,
  contentClassName,
}: {
  item: YtItem;
  source?: "youtube" | "spotify";
  /** Page-specific entries appended before "Add to playlist". */
  extraItems?: React.ReactNode;
  triggerClassName?: string;
  contentClassName?: string;
}) {
  const actions = useTrackActions(item, source);
  const navigate = useNavigate();
  const authorizeDownload = useAction(api.downloads.authorizeDownload);
  const { title } = actions;
  /**
   * Whether this track can be saved at all.
   *
   * A playable audioUrl is not permission to make a copy: almost everything
   * SYNQ plays is a stream it may only PLAY. The Download action is therefore
   * rendered only for tracks from an authorized source, and the server
   * independently re-checks that flag on every request.
   */
  const availability = downloadAvailability(item.id, item.jamendoId);

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`More options for ${title}`}
            className={triggerClassName}
          >
            <MoreVertical className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={contentClassName ?? "w-56"}>
          <DropdownMenuItem
            className="gap-2"
            onSelect={(event) => {
              event.stopPropagation();
              actions.playNext();
            }}
          >
            <ListStart className="size-4" />
            Play next
          </DropdownMenuItem>
          <DropdownMenuItem
            className="gap-2"
            onSelect={(event) => {
              event.stopPropagation();
              actions.addQueued();
            }}
          >
            <ListEnd className="size-4" />
            Add to queue
          </DropdownMenuItem>
          <DropdownMenuItem
            className="gap-2"
            onSelect={() => {
              void copyText(
                buildTrackShareUrl(window.location.origin, actions.track),
              ).then((ok) => {
                if (ok) toast.success("Song link copied");
                else toast.error("Couldn't copy the link");
              });
            }}
          >
            <ListMusic className="size-4" />
            Copy song link
          </DropdownMenuItem>
          {/*
            Download.

            This is a real action, not a disabled placeholder. It asks the
            download hub what it can do with THIS track and then does that:
            if the source licenses download, the transfer starts and the hub
            opens showing live progress; if it does not, the user is told the
            actual reason and taken to the hub, which reports the same truth.

            The alternative — omitting the item until a rights-granting source
            exists — would leave every track menu looking identical to how it
            did before downloads existed, with no way to discover the feature.
          */}
          {/*
            Download.

            Rendered ONLY for tracks SYNQ is authorized to distribute as files.
            The previous version sent the listener's own resolved stream URL to
            the download engine for every track, which meant pressing Download
            on an ordinary YouTube track tried to save a copy SYNQ had no right
            to make. There is no disabled placeholder here on purpose: an action
            that is always unavailable is noise, and its absence is the honest
            answer.
          */}
          {availability.allowed ? (
            <DropdownMenuItem
              className="gap-2"
              onSelect={() => {
                void (async () => {
                  const result = await requestAuthorizedDownload(
                    authorizeDownload,
                    downloadTargetId(item.id, item.jamendoId) ?? item.id,
                    // The copy is stored under the PLAYABLE's id (the YouTube
                    // upload offline playback looks up), while authorization
                    // is granted for the licensed Jamendo release. The row's
                    // own metadata travels with it so the saved file can
                    // describe itself with the network switched off.
                    {
                      storageKey: item.id,
                      meta: {
                        title,
                        artistName: actions.artistName,
                        albumName: item.album,
                        coverUrl: item.thumbnail,
                        duration: item.duration,
                      },
                    },
                  );
                  if (result.started) {
                    toast.success("Download started");
                  } else if (result.refusal.retryable) {
                    toast.error(result.refusal.message, {
                      description: "Try again in a moment.",
                    });
                  } else {
                    toast.error(result.refusal.message);
                  }
                  navigate("/downloads");
                })();
              }}
            >
              <Download className="size-4" />
              Download
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            className="gap-2"
            onSelect={(event) => {
              event.stopPropagation();
              actions.likeThis();
            }}
          >
            <Heart
              className={
                actions.isLiked
                  ? "size-4 fill-current text-[rgb(var(--tint))]"
                  : "size-4"
              }
            />
            {actions.isLiked ? "Remove from liked songs" : "Add to liked songs"}
          </DropdownMenuItem>
          {/* The deliberate negative signal. Its own submenu because "not this
              song" and "not this artist" are different decisions, and burying
              the artist one behind a long-press would mean it never gets used. */}
          <DropdownMenuItem
            className="gap-2"
            onSelect={(event) => {
              event.stopPropagation();
              void actions.notInterested();
            }}
          >
            <ThumbsDown className="size-4" />
            Not interested in this
          </DropdownMenuItem>
          <DropdownMenuItem
            className="gap-2"
            onSelect={(event) => {
              event.stopPropagation();
              void actions.notInterestedInArtist();
            }}
          >
            <UserX className="size-4" />
            Not interested in {actions.artistName}
          </DropdownMenuItem>
          {extraItems ? (
            <>
              <DropdownMenuSeparator />
              {extraItems}
            </>
          ) : null}
          <DropdownMenuSeparator />
          <AddToPlaylistItems
            track={actions.track}
            onNewPlaylist={() => actions.setPlaylistDialogOpen(true)}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      {actions.renderPlaylistDialog}
    </>
  );
}
