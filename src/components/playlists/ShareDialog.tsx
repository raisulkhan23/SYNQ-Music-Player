import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import {
  Loader2,
  Search,
  ShieldCheck,
  UserPlus,
  X,
} from "lucide-react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Who a playlist is shared with — and who to share it with next.
 *
 * Every action talks to the server-authorized functions in
 * `src/convex/sharing.ts`; the UI is convenience, not the security boundary.
 * The dialog works from one faithful state: the live access list. Sharing a
 * user already in the list is a server-side no-op (duplicate invitations
 * collapse into the existing grant), and revoking is the owner's decision
 * only — the button is only rendered for the owner, and the backend would
 * refuse it for anyone else regardless.
 *
 * Privacy: the search API returns display names and avatars ONLY. There is
 * deliberately no way to reach email addresses or account metadata from
 * this surface.
 */
export function ShareDialog({
  playlistId,
  playlistName,
  isOwner,
  open,
  onOpenChange,
}: {
  playlistId: Id<"playlists">;
  playlistName: string;
  isOwner: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [needle, setNeedle] = useState("");
  const search = useQuery(
    api.sharing.searchShareableUsers,
    open && isOwner && needle.trim().length >= 2 ? { query: needle } : "skip",
  );
  const access = useQuery(
    api.sharing.accessList,
    open ? { playlistId } : "skip",
  );
  const share = useMutation(api.sharing.sharePlaylist);
  const revoke = useMutation(api.sharing.revokeShare);

  const handleShare = async (recipientId: Id<"users">, name: string) => {
    try {
      await share({ playlistId, recipientId });
      toast.success(`Shared “${playlistName}” with ${name}`, {
        description: "They can open it from their library.",
      });
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Couldn't share the playlist",
      );
    }
  };

  const handleRevoke = async (recipientId: Id<"users">, name: string) => {
    try {
      await revoke({ playlistId, recipientId });
      toast(`Removed ${name}'s access to “${playlistName}”`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Couldn't remove access",
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md rounded-3xl border-white/10 bg-[#11131A] p-5">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display text-lg font-bold">
            <ShieldCheck className="size-5 text-[rgb(var(--tint))]" />
            Share “{playlistName}”
          </DialogTitle>
          <DialogDescription>
            People you share with can play this playlist and see its songs.
            Only you can change or delete it.
          </DialogDescription>
        </DialogHeader>

        {isOwner ? (
          <div className="flex flex-col gap-3">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={needle}
                onChange={(event) => setNeedle(event.target.value)}
                placeholder="Find a listener by name…"
                aria-label="Find a listener by name"
                minLength={2}
                className="h-10 w-full rounded-full border border-white/10 bg-white/[0.05] pr-4 pl-9 text-sm outline-none placeholder:text-muted-foreground/60 focus:border-[rgb(var(--tint)_/_0.6)]"
              />
            </div>

            {needle.trim().length >= 2 ? (
              <div className="flex flex-col gap-1">
                {search === undefined ? (
                  <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" />
                    Looking…
                  </div>
                ) : search.length === 0 ? (
                  <p className="px-2 py-2 text-xs text-muted-foreground">
                    No listener matches that name.
                  </p>
                ) : (
                  search.map((match) => (
                    <div
                      key={match.userId}
                      className={cn(
                        "flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.03] p-2.5",
                      )}
                    >
                      {match.image ? (
                        <img
                          src={match.image}
                          alt=""
                          className="size-8 rounded-full object-cover"
                        />
                      ) : (
                        <span className="flex size-8 items-center justify-center rounded-full bg-[rgb(var(--tint)_/_0.14)] text-sm font-semibold text-[rgb(var(--tint))]">
                          {match.name.slice(0, 1).toUpperCase()}
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                        {match.name}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleShare(match.userId, match.name)}
                        className="flex shrink-0 items-center gap-1 rounded-full bg-[rgb(var(--tint))] px-3 py-1.5 text-xs font-semibold text-black transition-transform hover:scale-[1.03]"
                      >
                        <UserPlus className="size-3.5" />
                        Share
                      </button>
                    </div>
                  ))
                )}
              </div>
            ) : null}

            {access && access.length > 0 ? (
              <div className="flex flex-col gap-2">
                <p className="px-1 text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
                  Who has access · {access.length}
                </p>
                {access.map((entry) => (
                  <div
                    key={entry.recipientId}
                    className="flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.03] p-2.5"
                  >
                    {entry.image ? (
                      <img
                        src={entry.image}
                        alt=""
                        className="size-8 rounded-full object-cover"
                      />
                    ) : (
                      <span className="flex size-8 items-center justify-center rounded-full bg-[rgb(var(--tint)_/_0.14)] text-sm font-semibold text-[rgb(var(--tint))]">
                        {entry.name.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">
                        {entry.name}
                      </span>
                      <span className="block text-[11px] text-muted-foreground">
                        {entry.saved ? "In their library" : "Sent · not added"}
                      </span>
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove ${entry.name}'s access`}
                      onClick={() =>
                        void handleRevoke(entry.recipientId, entry.name)
                      }
                      className="flex size-8 shrink-0 items-center justify-center rounded-full border border-white/10 text-muted-foreground transition-colors hover:border-red-500/40 hover:text-red-300"
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                ))}
              </div>
            ) : access && access.length === 0 && needle.trim().length < 2 ? (
              <p className="text-xs text-muted-foreground">
                Nobody yet. Search for a listener above.
              </p>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
