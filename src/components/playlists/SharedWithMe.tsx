import { useMutation, useQuery } from "convex/react";
import { Link } from "react-router";
import { toast } from "sonner";
import {
  ListMusic,
  LogOut,
  Plus,
  Sparkles,
  UserRound,
} from "lucide-react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * The recipient side of playlist sharing, in the Library.
 *
 * Two truthful states, straight from the server:
 *  - `saved` shares render as real library cards — these are playlists the
 *    listener chose to keep.
 *  - Shares that were SENT but never added appear as a compact "new share"
 *    row instead: they are discoverable (so a share cannot get lost), but
 *    they don't clutter the library until the listener decides.
 *
 * Removing a library reference never touches the playlist itself — the
 * server turns the row's `saved` flag off and the owner keeps everything.
 * Revoking access remains the OWNER's action; the recipient can only drop
 * their own copy of the reference.
 */
export function SharedWithMe() {
  const shared = useQuery(api.sharing.sharedWithMe);
  const setSaved = useMutation(api.sharing.setSavedInLibrary);

  const removeFromLibrary = async (playlistId: Id<"playlists">) => {
    try {
      await setSaved({ playlistId, saved: false });
      toast("Removed from your library", {
        description: "The playlist itself still belongs to whoever shared it.",
      });
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Couldn't remove the playlist",
      );
    }
  };

  const addToLibrary = async (playlistId: Id<"playlists">) => {
    try {
      await setSaved({ playlistId, saved: true });
      toast.success("Added to your library");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Couldn't add the playlist",
      );
    }
  };

  if (shared === undefined || shared.length === 0) return null;

  const saved = shared.filter((item) => item.saved);
  const newlyShared = shared.filter((item) => !item.saved);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-lg font-bold tracking-tight">
          Shared with you
        </h2>
        <span className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {shared.length} {shared.length === 1 ? "playlist" : "playlists"}
        </span>
      </div>

      {newlyShared.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {newlyShared.map((item) => (
            <div
              key={item.playlistId}
              className="flex items-center gap-2 rounded-full border border-[rgb(var(--tint)_/_0.35)] bg-[rgb(var(--tint)_/_0.1)] py-1.5 pr-1.5 pl-3"
            >
              <Sparkles className="size-3.5 shrink-0 text-[rgb(var(--tint))]" />
              <Link
                to={`/playlist/${item.playlistId}`}
                className="max-w-52 truncate text-xs font-semibold"
              >
                {item.name}
              </Link>
              <button
                type="button"
                aria-label={`Add ${item.name} to your library`}
                onClick={() => void addToLibrary(item.playlistId)}
                className="flex size-6 shrink-0 items-center justify-center rounded-full bg-[rgb(var(--tint))] text-black transition-transform hover:scale-[1.05]"
              >
                <Plus className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {saved.map((item) => (
          <div
            key={item.playlistId}
            className="flex max-w-xs flex-col gap-1.5 rounded-2xl border border-white/[0.07] bg-white/[0.03] p-3"
          >
            <Link
              to={`/playlist/${item.playlistId}`}
              className="flex items-center gap-2"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[rgb(var(--tint)_/_0.14)]">
                <ListMusic className="size-4 text-[rgb(var(--tint))]" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">
                  {item.name}
                </span>
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <UserRound className="size-3" />
                  {item.ownerName}
                </span>
              </span>
            </Link>
            <button
              type="button"
              onClick={() => void removeFromLibrary(item.playlistId)}
              className="mt-1 flex w-fit items-center gap-1 rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:border-red-500/40 hover:text-red-300"
            >
              <LogOut className="size-3" />
              Remove from library
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
