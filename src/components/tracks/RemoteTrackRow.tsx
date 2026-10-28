import type { YtItem } from "@/lib/youtube";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Link } from "react-router";
import { artistPath } from "@/lib/artistLinks";
import {
  TrackActionsMenu,
  useTrackActions,
} from "@/components/tracks/useTrackActions";
import { usePlayerStore } from "@/store/player";
import { Heart, Loader2, Music4, Pause, Play, Radio } from "lucide-react";
import type { ReactNode } from "react";

const isRowActionTarget = (target: EventTarget | null) =>
  target instanceof Element &&
  Boolean(target.closest("button, [role='menuitem']"));

export function RemoteTrackRow({
  item,
  index,
  onPlay,
  resolving,
  source = "youtube",
  /** Optional extra content rendered before the like button (e.g. remove action). Pointer devices only. */
  trailing,
  /** Optional extra entries rendered inside the overflow menu (e.g. remove from playlist). */
  menuItems,
  /** Short label shown after the title (e.g. "Live", "Remix", "Lyrics"). */
  badge,
}: {
  item: YtItem;
  index: number;
  onPlay: (item: YtItem) => void;
  resolving?: boolean;
  /** Which provider the chart row came from (affects badge + link-out). */
  source?: "youtube" | "spotify";
  trailing?: ReactNode;
  menuItems?: ReactNode;
  /** Short label shown after the title (e.g. "Live", "Remix", "Lyrics"). */
  badge?: ReactNode;
}) {
  const currentId = usePlayerStore((s) => s.current?.id);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const startRadio = usePlayerStore((s) => s.startRadio);
  const isCurrent = currentId === item.id;

  // Actions live in one shared hook so this row and the Home media cards can
  // never disagree about what "Play next" or "Copy song link" does.
  const {
    title: displayTitle,
    artistName,
    isLiked,
    likeThis,
    renderPlaylistDialog,
  } = useTrackActions(item, source);
  const artistHref = artistPath(artistName);

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={(e) => {
          // Dropdown menu items render in a portal, but the trigger and its
          // controls still live inside this row. Never let an action button
          // activate the row and start playback as a side effect.
          if (isRowActionTarget(e.target)) return;
          onPlay(item);
        }}
        onKeyDown={(e) => {
          // Only the row itself owns Enter/Space. Buttons and menu controls
          // handle their own keyboard activation.
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onPlay(item);
          }
        }}
        className={cn(
          // Touch layout: taller, roomier row so a thumb tap is easy and the
          // text never feels squeezed. Pointer devices keep the dense list row.
          "group relative flex min-h-14 select-none items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-white/[0.05] active:bg-white/[0.08] sm:min-h-0 sm:py-1.5",
          isCurrent && "bg-white/[0.04]",
        )}
      >
        {/* Rank / hover-to-play is pointless on touch and only adds clutter. */}
        <div className="relative hidden shrink-0 items-center justify-center sm:flex">
          {resolving ? (
            <Loader2 className="size-4 animate-spin text-[rgb(var(--tint))]" />
          ) : (
            <span className="text-sm tabular-nums text-muted-foreground/60">
              {index}
            </span>
          )}
          {!resolving && (
            <button
              type="button"
              aria-label={`Play ${displayTitle}`}
              onClick={(e) => {
                e.stopPropagation();
                onPlay(item);
              }}
              className="absolute inset-0 hidden items-center justify-center group-hover:flex"
            >
              {isCurrent && isPlaying ? (
                <Pause className="size-4 fill-current text-foreground" />
              ) : (
                <Play className="ml-0.5 size-4 fill-current text-foreground" />
              )}
            </button>
          )}
        </div>

        {resolving && (
          <Loader2 className="size-4 shrink-0 animate-spin text-[rgb(var(--tint))] sm:hidden" />
        )}

        {/* Artwork stays on every screen size — it's the one non-interactive
            element that earns its space in a touch row. */}
        <div className="relative size-11 shrink-0 overflow-hidden rounded-lg ring-1 ring-white/10 sm:size-10 sm:rounded-md">
          {/* A row with no artwork used to render `<img src="">`, which paints
              an empty transparent box — a grid of black squares that read as a
              broken app rather than as a track we haven't got art for yet.
              This is every surface a remote row renders on, so the fallback
              belongs here and not in each caller. */}
          {item.thumbnail ? (
            <img
              src={item.thumbnail}
              alt=""
              className="size-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex size-full items-center justify-center bg-gradient-to-br from-white/[0.09] to-white/[0.03]">
              <Music4 className="size-4 text-white/35" />
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "truncate text-[0.9375rem] leading-tight font-medium sm:text-sm",
              isCurrent && "text-[rgb(var(--tint))]",
            )}
          >
            {displayTitle}
            {/* Version marker ("Live", "Remix", "Lyrics", "Slowed"). Without
                it every upload of a song reads as the same track, which is
                precisely why users could not tell the canonical song from a
                lyric video or a slowed upload. */}
            {badge ? (
              <span className="ml-2 align-middle rounded border border-white/10 bg-white/[0.05] px-1.5 py-px text-[10px] font-medium tracking-wide text-muted-foreground">
                {badge}
              </span>
            ) : null}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {/* A row's artist has a real page, so it is a link rather than
                dead text. This is the surface most people meet an artist on —
                search results and the queue — and until now the artist name
                here was the one place they could not click through from.
                `artistPath` returns null for an unusable name, in which case
                this stays plain text. */}
            {artistHref ? (
              <Link
                to={artistHref}
                onClick={(event) => event.stopPropagation()}
                className="underline-offset-2 transition-colors hover:text-foreground hover:underline"
              >
                {artistName}
              </Link>
            ) : (
              artistName
            )}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-1 sm:ml-auto sm:gap-2">
          {trailing ? (
            <div className="hidden shrink-0 items-center gap-2 sm:flex">
              {trailing}
            </div>
          ) : null}
          {/* Secondary controls live in the overflow menu on touch devices. */}
          <button
            type="button"
            aria-label={`Start ${displayTitle} radio`}
            title="Start radio — endless related mix"
            onClick={(e) => {
              e.stopPropagation();
              startRadio({
                id: item.id,
                title: displayTitle,
                artistName,
                albumName: "",
                coverUrl: item.thumbnail,
                audioUrl: "",
                duration: item.duration,
                source: "youtube",
                youtubeId: item.id,
              });
            }}
            className="hidden rounded-full p-1.5 text-muted-foreground/70 transition-colors hover:bg-white/10 hover:text-foreground sm:inline-flex"
          >
            <Radio className="size-4" />
          </button>
          <TrackActionsMenu
            item={item}
            source={source}
            extraItems={menuItems}
            triggerClassName="rounded-full p-2 text-muted-foreground/70 transition-colors hover:bg-white/10 hover:text-foreground sm:p-1.5"
          />
          <button
            type="button"
            aria-label={
              isLiked ? "Remove from liked songs" : "Add to liked songs"
            }
            onClick={(e) => {
              e.stopPropagation();
              likeThis();
            }}
            className={cn(
              "hidden rounded-full p-1.5 transition-colors sm:inline-flex",
              isLiked
                ? "text-[rgb(var(--tint))]"
                : "text-muted-foreground/70 hover:bg-white/10 hover:text-foreground",
            )}
          >
            <Heart className={cn("size-4", isLiked && "fill-current")} />
          </button>
          <span className="ml-1 text-xs tabular-nums text-muted-foreground/70 sm:ml-0 sm:text-sm">
            {formatDuration(item.duration)}
          </span>
        </div>
      </div>
      {renderPlaylistDialog}
    </>
  );
}
