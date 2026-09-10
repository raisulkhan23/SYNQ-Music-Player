import { useState } from "react";
import { PlaylistDialog } from "@/components/playlists/PlaylistDialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { Track } from "@/lib/catalog";
import { cn } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import { ListMusic, ListPlus, Plus } from "lucide-react";
import { toast } from "sonner";

export function AddToPlaylistMenu({
  track,
  className,
}: {
  track: Track;
  className?: string;
}) {
  const playlists = useQuery(api.playlists.myPlaylists);
  const addTrack = useMutation(api.playlists.addTrack);
  const [dialogOpen, setDialogOpen] = useState(false);

  const handleAdd = (playlistId: Id<"playlists">, name: string) => {
    void addTrack({ playlistId, trackId: track.id });
    toast.success(`Added to ${name}`);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`Add ${track.title} to a playlist`}
            className={cn(
              "rounded-full p-1.5 text-muted-foreground/70 transition-colors hover:bg-white/10 hover:text-foreground",
              className,
            )}
          >
            <ListPlus className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-h-80 w-56">
          <DropdownMenuLabel className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
            Add to playlist
          </DropdownMenuLabel>
          {playlists && playlists.length > 0 ? (
            playlists.slice(0, 10).map((p) => (
              <DropdownMenuItem
                key={p._id}
                onSelect={() => handleAdd(p._id, p.name)}
                className="pr-8"
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
          <DropdownMenuItem onSelect={() => setDialogOpen(true)}>
            <Plus className="size-4" />
            New playlist
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <PlaylistDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreate={(id) => handleAdd(id, "new playlist")}
      />
    </>
  );
}