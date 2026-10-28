import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import {
  ListFilter,
  Pencil,
  Play,
  Plus,
  Trash2,
  Wand2,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import { usePlayerStore } from "@/store/player";
import { cn } from "@/lib/utils";
import {
  SMART_SORTS,
  SMART_SOURCES,
  defaultSmartName,
  describeSmartRules,
  normalizeSmartRules,
  type SmartRules,
  type SmartSort,
  type SmartSource,
} from "@/lib/smartPlaylists";

interface ResolvedSmart {
  _id: string;
  name: string;
  rules: SmartRules;
  description: string;
  trackCount: number;
  tracks: Array<{
    trackId: string;
    title: string;
    artistName: string;
    coverUrl: string;
    duration: number;
  }>;
}

/** Build a queueable Playable from a resolved smart-track row. */
function toPlayable(track: ResolvedSmart["tracks"][number]) {
  return {
    id: track.trackId,
    title: track.title,
    artistName: track.artistName,
    albumName: "",
    coverUrl: track.coverUrl,
    audioUrl: "",
    duration: track.duration,
    source: "youtube" as const,
    youtubeId: track.trackId,
  };
}

const inputClass =
  "w-full rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm outline-none transition-colors focus:border-[rgb(var(--tint)_/_0.5)]";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

/**
 * The builder. Rules map 1:1 onto lib/smartPlaylists SmartRules, and every
 * control is limited to signals SYNQ actually stores — no genre, mood or year
 * filter is offered because that metadata does not exist.
 */
function SmartPlaylistDialog({
  open,
  onOpenChange,
  initial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial?: { playlistId: string; name: string; rules: SmartRules };
}) {
  const create = useMutation(api.smartPlaylists.create);
  const update = useMutation(api.smartPlaylists.update);
  const [name, setName] = useState(initial?.name ?? "");
  const [rules, setRules] = useState<SmartRules>(normalizeSmartRules(initial?.rules));
  const [saving, setSaving] = useState(false);

  if (!open) return null;
  const patch = (next: Partial<SmartRules>) =>
    setRules((prev) => normalizeSmartRules({ ...prev, ...next }));

  const save = async () => {
    setSaving(true);
    try {
      if (initial) {
        await update({ playlistId: initial.playlistId as never, name, rules });
        toast.success("Smart playlist updated");
      } else {
        await create({ name, rules });
        toast.success("Smart playlist created");
      }
      onOpenChange(false);
    } catch {
      toast.error("Couldn't save this smart playlist");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4">
      <div className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-3xl border border-white/10 bg-[rgb(20_20_24)] p-5 sm:rounded-3xl">
        <div className="flex items-center gap-2">
          <Wand2 className="size-5 text-[rgb(var(--tint))]" />
          <h2 className="font-display text-lg font-bold">
            {initial ? "Edit smart playlist" : "New smart playlist"}
          </h2>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {describeSmartRules(rules)}
        </p>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field label="Name (optional)">
              <input
                className={inputClass}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={defaultSmartName(rules)}
                maxLength={60}
              />
            </Field>
          </div>
          <Field label="Where tracks come from">
            <select
              className={inputClass}
              value={rules.source}
              onChange={(e) => patch({ source: e.target.value as SmartSource })}
            >
              {SMART_SOURCES.map((s) => (
                <option key={s.id} value={s.id} className="bg-neutral-900">
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Order">
            <select
              className={inputClass}
              value={rules.sort}
              onChange={(e) => patch({ sort: e.target.value as SmartSort })}
            >
              {SMART_SORTS.map((s) => (
                <option key={s.id} value={s.id} className="bg-neutral-900">
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Played at least (times)">
            <input
              type="number"
              min={0}
              className={inputClass}
              value={rules.minPlays}
              onChange={(e) => patch({ minPlays: Number(e.target.value) })}
            />
          </Field>
          <Field label="Played at most (times, 0 = any)">
            <input
              type="number"
              min={0}
              className={inputClass}
              value={rules.maxPlays}
              onChange={(e) => patch({ maxPlays: Number(e.target.value) })}
            />
          </Field>
          <Field label="Played within (days, 0 = any)">
            <input
              type="number"
              min={0}
              className={inputClass}
              value={rules.withinDays}
              onChange={(e) => patch({ withinDays: Number(e.target.value) })}
            />
          </Field>
          <Field label="Not played for (days, 0 = any)">
            <input
              type="number"
              min={0}
              className={inputClass}
              value={rules.notWithinDays}
              onChange={(e) => patch({ notWithinDays: Number(e.target.value) })}
            />
          </Field>
          <Field label="Artist contains">
            <input
              className={inputClass}
              value={rules.artist}
              onChange={(e) => patch({ artist: e.target.value })}
              placeholder="e.g. Adele"
            />
          </Field>
          <Field label="Title contains">
            <input
              className={inputClass}
              value={rules.title}
              onChange={(e) => patch({ title: e.target.value })}
              placeholder="e.g. love"
            />
          </Field>
          <Field label="Max tracks">
            <input
              type="number"
              min={5}
              max={200}
              className={inputClass}
              value={rules.limit}
              onChange={(e) => patch({ limit: Number(e.target.value) })}
            />
          </Field>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-full border border-white/10 px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded-full bg-[rgb(var(--tint))] px-5 py-2 text-sm font-semibold text-black disabled:opacity-60"
          >
            {saving ? "Saving…" : initial ? "Save changes" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SmartCard({
  playlist,
  onPlay,
  onEdit,
  onDelete,
}: {
  playlist: ResolvedSmart;
  onPlay: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const cover = playlist.tracks.find((t) => t.coverUrl)?.coverUrl;
  return (
    <div className="group relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4">
      <div className="flex items-start gap-3">
        <div className="size-14 shrink-0 overflow-hidden rounded-xl bg-white/[0.06]">
          {cover ? (
            <img src={cover} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <ListFilter className="size-5 text-muted-foreground" />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold">{playlist.name}</p>
          <p className="line-clamp-2 text-xs text-muted-foreground">
            {playlist.description}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground/70">
            {playlist.trackCount} {playlist.trackCount === 1 ? "track" : "tracks"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Edit ${playlist.name}`}
            className="rounded-full p-2 text-muted-foreground hover:bg-white/[0.06] hover:text-foreground"
          >
            <Pencil className="size-4" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Delete ${playlist.name}`}
            className="rounded-full p-2 text-muted-foreground hover:bg-white/[0.06] hover:text-rose-300"
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      </div>
      <button
        type="button"
        onClick={onPlay}
        disabled={playlist.trackCount === 0}
        className={cn(
          "mt-3 flex w-full items-center justify-center gap-2 rounded-full py-2 text-sm font-semibold transition-colors",
          playlist.trackCount === 0
            ? "cursor-not-allowed bg-white/[0.05] text-muted-foreground"
            : "bg-[rgb(var(--tint))] text-black hover:scale-[1.01]",
        )}
      >
        <Play className="size-4" />
        {playlist.trackCount === 0 ? "No matching tracks" : "Play"}
      </button>
    </div>
  );
}

/**
 * The smart-playlist strip on the Library page. Recomputes live from the
 * listener's library; nothing here is a stored track list.
 */
export function SmartPlaylists() {
  const playlists = useQuery(api.smartPlaylists.mySmartPlaylistsResolved) as
    | ResolvedSmart[]
    | undefined;
  const remove = useMutation(api.smartPlaylists.remove);
  const create = useMutation(api.smartPlaylists.create);
  const playTrack = usePlayerStore((s) => s.playTrack);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<
    { playlistId: string; name: string; rules: SmartRules } | undefined
  >();

  const openNew = () => {
    setEditing(undefined);
    setDialogOpen(true);
  };
  const openEdit = (p: ResolvedSmart) => {
    setEditing({ playlistId: p._id, name: p.name, rules: p.rules });
    setDialogOpen(true);
  };

  const play = (p: ResolvedSmart) => {
    if (p.tracks.length === 0) return;
    const queue = p.tracks.map(toPlayable);
    playTrack(queue[0]!, queue);
  };

  const del = async (p: ResolvedSmart) => {
    try {
      await remove({ playlistId: p._id as never });
      // Undo re-creates the playlist from its rules — a smart playlist holds no
      // track list, so the stored rules are all that is needed to rebuild it
      // exactly. Matches the undo the plain playlist card already offers.
      toast.success(`Deleted “${p.name}”`, {
        action: {
          label: "Undo",
          onClick: () => {
            void create({ name: p.name, rules: p.rules })
              .then(() => toast.success("Smart playlist restored"))
              .catch(() => toast.error("Couldn't restore the smart playlist"));
          },
        },
      });
    } catch {
      toast.error("Couldn't delete that smart playlist");
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Wand2 className="size-4 text-[rgb(var(--tint))]" />
          <h2 className="font-display text-lg font-semibold">Smart playlists</h2>
        </div>
        <button
          type="button"
          onClick={openNew}
          className="flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:border-[rgb(var(--tint)_/_0.4)] hover:text-foreground"
        >
          <Plus className="size-4" />
          New smart playlist
        </button>
      </div>
      <p className="text-xs text-muted-foreground">
        Rules that rebuild themselves from your likes and listening — always up to date.
      </p>

      {playlists === undefined ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1].map((i) => (
            <div key={i} className="h-32 animate-pulse rounded-2xl bg-white/[0.05]" />
          ))}
        </div>
      ) : playlists.length === 0 ? (
        <button
          type="button"
          onClick={openNew}
          className="flex items-center gap-3 rounded-2xl border border-dashed border-white/10 px-4 py-5 text-left transition-colors hover:border-[rgb(var(--tint)_/_0.4)]"
        >
          <span className="flex size-10 items-center justify-center rounded-xl bg-[rgb(var(--tint)_/_0.12)]">
            <ListFilter className="size-5 text-[rgb(var(--tint))]" />
          </span>
          <span>
            <span className="block text-sm font-semibold">Create your first smart playlist</span>
            <span className="block text-xs text-muted-foreground">
              e.g. “Liked songs I haven't played in a month”
            </span>
          </span>
        </button>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {playlists.map((p) => (
            <SmartCard
              key={p._id}
              playlist={p}
              onPlay={() => play(p)}
              onEdit={() => openEdit(p)}
              onDelete={() => void del(p)}
            />
          ))}
        </div>
      )}

      <SmartPlaylistDialog
        key={editing?.playlistId ?? "new"}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        {...(editing ? { initial: editing } : {})}
      />
    </section>
  );
}
