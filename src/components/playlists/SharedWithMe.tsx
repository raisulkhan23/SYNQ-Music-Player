import { useMutation, useQuery } from "convex/react";
import { Link } from "react-router";
import { Loader2, Music2, Users, X } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * Playlists other people have shared with the signed-in listener.
 *
 * NO COPY OF THE TRACKS LIVES HERE. `sharedWithMe` reads each entry straight off
 * the OWNER's playlist document, so an edit they make is visible on the next
 * render — there is no second copy to keep in sync, no polling, and no chance of
 * the recipient's view drifting from the owner's. Opening a card routes to the
 * same detail screen through `playlists.get`, which resolves the caller's role
 * server-side.
 *
 * Removing one hides the grant for this account only. The owner's playlist and
 * their own share list are untouched, which is the whole point: a recipient
 * clearing their Library must never be able to delete somebody else's playlist.
 */
export function SharedWithMe() {
  const shared = useQuery(api.playlistSharing.sharedWithMe);
  const removeFromLibrary = useMutation(api.playlistSharing.removeFromLibrary);
  const restoreToLibrary = useMutation(api.playlistSharing.restoreToLibrary);

  // Renders nothing rather than an empty section: a listener who has been
  // shared nothing should not get a permanent "nothing here" heading taking up
  // room in their library.
  if (!shared || shared.length === 0) return null;

  const visible = shared.filter((entry) => !entry.hidden);
  const hidden = shared.filter((entry) => entry.hidden);
  if (visible.length === 0 && hidden.length === 0) return null;

  const handleRemove = async (playlistId: string, name: string) => {
    try {
      await removeFromLibrary({ playlistId: playlistId as Id<"playlists"> });
      toast(`${name} removed from your library`, {
        action: {
          label: "Undo",
          onClick: () => {
            void restoreToLibrary({
              playlistId: playlistId as Id<"playlists">,
            }).catch(() => toast.error("Couldn't put it back"));
          },
        },
      });
    } catch {
      toast.error("Couldn't remove that playlist");
    }
  };

  const handleRestore = async (playlistId: string) => {
    try {
      await restoreToLibrary({ playlistId: playlistId as Id<"playlists"> });
    } catch {
      toast.error("Couldn't restore that playlist");
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Users className="size-4 text-[rgb(var(--tint))]" />
        <h2 className="font-display text-sm font-bold tracking-tight">
          Shared with you
        </h2>
        <span className="text-xs text-muted-foreground">
          {visible.length}
        </span>
      </div>

      {visible.length === 0 ? (
        <div className="flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.03] px-4 py-3">
          <Loader2 className="size-4 shrink-0 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            Nothing shared right now.
            {hidden.length > 0 &&
              ` ${hidden.length} hidden ${
                hidden.length === 1 ? "playlist" : "playlists"
              } can be restored below.`}
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {visible.map((entry) => (
            <li
              key={entry.playlistId}
              className="group relative flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.03] px-3 py-3 transition-colors hover:border-[rgb(var(--tint)_/_0.35)] hover:bg-white/[0.05]"
            >
              {/* An unavailable entry — the owner deleted their playlist — is
                  shown and removable rather than silently vanishing. */}
              {entry.unavailable ? (
                <>
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white/[0.05]">
                    <Music2 className="size-4 text-muted-foreground/60" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-muted-foreground">
                      Playlist unavailable
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      Its owner removed it
                    </span>
                  </span>
                </>
              ) : (
                <>
                  <Link
                    to={`/playlist/${entry.playlistId}`}
                    className="flex min-w-0 flex-1 items-center gap-3 focus-visible:outline-none"
                  >
                    {entry.coverUrl ? (
                      <img
                        src={entry.coverUrl}
                        alt=""
                        width={44}
                        height={44}
                        loading="lazy"
                        className="size-11 shrink-0 rounded-xl object-cover ring-1 ring-white/10"
                      />
                    ) : (
                      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white/[0.05] ring-1 ring-white/10">
                        <Music2 className="size-4 text-muted-foreground/60" />
                      </span>
                    )}
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold">
                        {entry.name}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {entry.ownerName} · {entry.trackCount}{" "}
                        {entry.trackCount === 1 ? "song" : "songs"}
                        {entry.role === "editor" && " · can edit"}
                      </span>
                    </span>
                  </Link>
                  <button
                    type="button"
                    aria-label={`Remove ${entry.name} from your library`}
                    onClick={() => void handleRemove(entry.playlistId, entry.name)}
                    className="shrink-0 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground focus-visible:ring-2 focus-visible:ring-[rgb(var(--tint))] focus-visible:outline-none"
                  >
                    <X className="size-4" />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {hidden.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {hidden.map((entry) => (
            <li key={entry.playlistId}>
              <button
                type="button"
                onClick={() => void handleRestore(entry.playlistId)}
                className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-[rgb(var(--tint)_/_0.5)] hover:text-foreground"
              >
                Restore “{entry.name || "playlist"}”
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
