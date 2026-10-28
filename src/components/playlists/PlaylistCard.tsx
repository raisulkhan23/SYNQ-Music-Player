import { useState, type MouseEvent } from "react";
import { useNavigate } from "react-router";
import { useMutation } from "convex/react";
import { ListMusic, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Doc } from "@/convex/_generated/dataModel";
import { cn } from "@/lib/utils";

export function PlaylistCard({ playlist }: { playlist: Doc<"playlists"> }) {
  const navigate = useNavigate();
  const removePlaylist = useMutation(api.playlists.remove);
  const createPlaylist = useMutation(api.playlists.create);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const open = () => navigate(`/playlist/${playlist._id}`);

  const runDelete = async () => {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setDeleting(true);
    try {
      await removePlaylist({ playlistId: playlist._id });
      // Undo re-creates the playlist from the snapshot we already hold: the
      // name, the description and (when the playlist was saved with them) the
      // track snapshots. It is a NEW row rather than a resurrection of the old
      // id, but the listener gets their playlist back either way. A legacy
      // id-only playlist restores empty rather than with fabricated tracks.
      const snapshots = playlist.trackSnapshots;
      toast.success(`Deleted "${playlist.name}"`, {
        action: {
          label: "Undo",
          onClick: () => {
            void createPlaylist({
              name: playlist.name,
              ...(playlist.description
                ? { description: playlist.description }
                : {}),
              ...(snapshots && snapshots.length > 0 ? { tracks: snapshots } : {}),
            })
              .then(() => toast.success("Playlist restored"))
              .catch(() => toast.error("Couldn't restore the playlist"));
          },
        },
      });
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message
          : "Unknown error";
      toast.error("Could not delete the playlist", { description: message });
    } finally {
      setDeleting(false);
      setConfirming(false);
    }
  };

  const handleDeleteClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    event.preventDefault();
    void runDelete();
  };

  return (
    // `snap-start` lets the card align to the same scroll stops as the track
    // cards in a Home shelf, so a mixed shelf still snaps cleanly.
    <div className="group relative w-32 shrink-0 snap-start cursor-pointer sm:w-36 lg:w-40">
      <div
        role="button"
        tabIndex={0}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
          }
        }}
        className="w-full"
      >
        <div className="relative aspect-square overflow-hidden rounded-xl ring-1 ring-white/10">
          <div className="flex size-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-white/[0.09] to-white/[0.03]">
            <ListMusic className="size-8 text-muted-foreground/50" />
          </div>
          <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
        </div>
        <div className="mt-2.5 px-0.5">
          <p className="truncate text-sm font-semibold">{playlist.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {playlist.trackIds.length}{" "}
            {playlist.trackIds.length === 1 ? "song" : "songs"}
          </p>
        </div>
      </div>

      {/* Delete lives on the card (not the row click) so an empty playlist —
          which has no detail-page action bar — can still be removed. */}
      <button
        type="button"
        aria-label={
          confirming
            ? `Confirm delete ${playlist.name}`
            : `Delete ${playlist.name}`
        }
        title={confirming ? "Click again to confirm" : "Delete playlist"}
        disabled={deleting}
        onClick={handleDeleteClick}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            event.stopPropagation();
            void runDelete();
          }
        }}
        className={cn(
          "absolute top-1.5 right-1.5 rounded-full p-1.5 opacity-0 shadow-lg backdrop-blur transition-all",
          "group-hover:opacity-100 focus-visible:opacity-100",
          "disabled:opacity-60",
          confirming
            ? "bg-red-500/90 text-white opacity-100"
            : "bg-black/55 text-muted-foreground hover:bg-red-500/90 hover:text-white",
        )}
      >
        {confirming ? (
          <span className="block px-1 text-[10px] font-bold tracking-wide uppercase">
            Sure?
          </span>
        ) : (
          <Trash2 className="size-3.5" />
        )}
      </button>
    </div>
  );
}
