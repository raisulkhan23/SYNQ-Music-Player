import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { api } from "@/convex/_generated/api";
import { useMutation, useQuery } from "convex/react";
import { Loader2, Radio } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

/**
 * Listening Rooms — shared rooms where everyone who joins hears the same
 * queue in sync. Create a room, share the name, and listen together.
 */
export default function Social() {
  const me = useQuery(api.users.currentUser);
  const rooms = useQuery(api.social.listRooms);

  const create = useMutation(api.social.createRoom);
  const join = useMutation(api.social.joinRoom);
  const leave = useMutation(api.social.leaveRoom);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await create({ name: name.trim() });
      toast.success(`Room "${name.trim()}" created`);
      setName("");
    } catch {
      toast.error("Couldn't create the room");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-display flex items-center gap-2 text-2xl font-bold tracking-tight sm:text-3xl">
          <Radio className="size-6 text-[rgb(var(--tint))]" />
          Listening Rooms
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Create a room and everyone who joins hears what you're playing.
        </p>
      </header>

      {/* flex-wrap + min-w-0: the input is `w-full max-w-xs`, and next to the
          Create button that overran a 360px phone instead of wrapping. */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          placeholder="Name a new listening room…"
          className="min-w-0 flex-1 rounded-full border border-white/[0.08] bg-white/[0.04] px-4 py-2 text-sm outline-none placeholder:text-muted-foreground/60 focus:border-[rgb(var(--tint)_/_0.5)] sm:max-w-xs sm:flex-none"
        />
        <button
          type="button"
          onClick={handleCreate}
          disabled={busy || !name.trim()}
          className="flex items-center gap-2 rounded-full bg-[rgb(var(--tint))] px-4 py-2 text-sm font-semibold text-black transition-opacity disabled:opacity-40"
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Radio className="size-4" />
          )}
          Create room
        </button>
      </div>

      {rooms === undefined ? (
        <div className="h-24 animate-pulse rounded-2xl bg-white/[0.04]" />
      ) : rooms.length === 0 ? (
        <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-10 text-center">
          <Radio className="mx-auto size-10 text-muted-foreground/50" />
          <p className="mt-3 font-display text-lg font-semibold">
            No rooms open
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Create a room above — everyone who joins hears the host's queue in
            sync.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {rooms.map((r) => {
            const isMember = r.members?.some((m) => m.userId === me?._id);
            return (
              <div
                key={r._id}
                className="flex items-center gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.03] p-4"
              >
                <span className="flex size-10 items-center justify-center rounded-xl bg-[rgb(var(--tint)_/_0.14)] text-[rgb(var(--tint))]">
                  <Radio className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{r.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    Host {r.hostName ?? "unknown"} · {r.listenerCount} listening
                    {r.nowPlaying ? ` · ♪ ${r.nowPlaying}` : ""}
                  </p>
                </div>
                <Badge
                  variant="secondary"
                  className={cn(
                    "shrink-0",
                    r.nowPlaying
                      ? "bg-emerald-500/15 text-emerald-300"
                      : "bg-white/[0.05] text-muted-foreground",
                  )}
                >
                  {r.nowPlaying ? "Live" : "Idle"}
                </Badge>
                <button
                  type="button"
                  onClick={async () => {
                    try {
                      if (isMember) {
                        await leave({ roomId: r._id });
                        toast.success("Left the room");
                      } else {
                        await join({ roomId: r._id });
                        toast.success(`Joined "${r.name}"`);
                      }
                    } catch {
                      toast.error("Couldn't update — try again");
                    }
                  }}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
                    isMember
                      ? "border-white/10 text-muted-foreground hover:text-foreground"
                      : "border-[rgb(var(--tint)_/_0.4)] text-[rgb(var(--tint))] hover:bg-[rgb(var(--tint)_/_0.12)]",
                  )}
                >
                  {isMember ? "Leave" : "Join"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
