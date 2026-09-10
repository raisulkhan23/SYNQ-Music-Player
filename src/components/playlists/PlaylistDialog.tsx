import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

export function PlaylistDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate?: (id: Id<"playlists">) => void;
}) {
  const createPlaylist = useMutation(api.playlists.create);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      const id = await createPlaylist({ name: trimmed });
      toast.success(`Created "${trimmed}"`);
      setName("");
      onOpenChange(false);
      onCreate?.(id);
    } catch {
      toast.error("Could not create the playlist");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display">
            <span className="flex size-8 items-center justify-center rounded-lg bg-[rgb(var(--tint))] text-black">
              <Plus className="size-4" />
            </span>
            New playlist
          </DialogTitle>
          <DialogDescription>
            Give your playlist a name — you can add tracks to it from any song.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Late night drive"
            maxLength={80}
            className="mb-4"
          />
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!name.trim() || submitting}
              className="bg-[rgb(var(--tint))] text-black hover:bg-[rgb(var(--tint))]"
            >
              {submitting && <Loader2 className="size-4 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}