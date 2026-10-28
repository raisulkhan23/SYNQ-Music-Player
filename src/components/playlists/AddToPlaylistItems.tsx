import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useAddToPlaylist } from "@/components/playlists/useAddToPlaylist";
import type { Playable } from "@/lib/playable";
import { ListMusic, Plus } from "lucide-react";

/**
 * Playlist picker rendered as a section of an existing dropdown menu (e.g. the
 * track row's overflow menu) rather than a nested menu of its own.
 *
 * The "New playlist" dialog is intentionally NOT rendered here: dropdown
 * content unmounts as soon as an item is selected, which would tear the dialog
 * down with it. The menu owner hosts the dialog and passes `onNewPlaylist`.
 */
export function AddToPlaylistItems({
  track,
  onNewPlaylist,
}: {
  track: Playable;
  onNewPlaylist: () => void;
}) {
  const { playlists, addTo } = useAddToPlaylist(track);

  return (
    <>
      <DropdownMenuLabel className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
        Add to playlist
      </DropdownMenuLabel>
      {playlists === undefined ? (
        /* `useQuery` returns undefined until the first response arrives. Saying
           "No playlists yet" during that window is a lie, and it made the menu
           flash before the real list appeared. */
        <p className="px-2 py-1.5 text-xs text-muted-foreground">
          Loading playlists…
        </p>
      ) : playlists.length > 0 ? (
        /* Every playlist is listed. The previous `slice(0, 8)` silently hid the
           rest with no "more" affordance, so a 9th playlist was unreachable. */
        playlists.map((p) => (
          <DropdownMenuItem
            key={p._id}
            onSelect={() => void addTo(p._id, p.name)}
            className="max-w-[16rem] pr-8"
          >
            <ListMusic className="size-4" />
            <span className="truncate">{p.name}</span>
          </DropdownMenuItem>
        ))
      ) : (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">
          No playlists yet — create one below.
        </p>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => onNewPlaylist()}>
        <Plus className="size-4" />
        New playlist
      </DropdownMenuItem>
    </>
  );
}
