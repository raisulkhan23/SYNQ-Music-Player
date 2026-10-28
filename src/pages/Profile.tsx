import { useState, useSyncExternalStore } from "react";
import { useMutation, useQuery } from "convex/react";
import { Link } from "react-router";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { usePlayerStore } from "@/store/player";
import { readPlayHistory, subscribePlayHistory } from "@/store/player";
import {
  BarChart3,
  Check,
  ChevronRight,
  Heart,
  ListMusic,
  Pencil,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";

export default function Profile() {
  const { user } = useAuth();
  const currentUser = useQuery(api.users.currentUser);
  const updateName = useMutation(api.users.updateName);
  const likedCount = usePlayerStore((s) => Object.keys(s.liked).length);
  // Subscribed (not a one-shot read) so the "Songs played" stat updates the
  // moment a track plays instead of only after a full remount.
  const history = useSyncExternalStore(
    subscribePlayHistory,
    readPlayHistory,
    readPlayHistory,
  );
  const playlists = useQuery(api.playlists.myPlaylists);
  // null = not an admin, so the admin link stays hidden for everyone else.
  const adminStatus = useQuery(api.admin.status);

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const displayName = user?.name ?? "Listener";
  const initials =
    displayName
      .split(/\s+/)
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() ?? "U";

  const save = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      await updateName({ name: name.trim() });
      toast.success("Name updated");
      setEditing(false);
    } catch {
      toast.error("Couldn't update your name");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-center gap-5">
        <div className="flex size-20 items-center justify-center overflow-hidden rounded-full bg-[rgb(var(--tint))] font-display text-2xl font-bold text-black ring-2 ring-white/10">
          {user?.image ? (
            <img
              src={user.image}
              alt="Your profile picture"
              className="size-full object-cover"
            />
          ) : (
            initials
          )}
        </div>
        <div className="min-w-0">
          {editing ? (
            <div className="flex items-center gap-2">
              <input
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && void save()}
                placeholder={displayName}
                className="h-9 w-56 rounded-full border border-white/10 bg-white/[0.05] px-4 text-sm outline-none focus:border-[rgb(var(--tint)_/_0.6)]"
              />
              <button
                type="button"
                aria-label="Save name"
                onClick={() => void save()}
                className="rounded-full bg-[rgb(var(--tint))] p-2 text-black"
              >
                <Check className="size-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
                {displayName}
              </h1>
              <button
                type="button"
                aria-label="Edit name"
                onClick={() => {
                  setName(displayName);
                  setEditing(true);
                }}
                className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
              >
                <Pencil className="size-4" />
              </button>
            </div>
          )}
          <p className="mt-1 text-sm text-muted-foreground">
            {user?.email ?? currentUser?.email ?? "SYNQ listener"}
          </p>
        </div>
      </header>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          to="/liked"
          icon={<Heart className="size-4" />}
          label="Liked songs"
          value={likedCount}
        />
        <StatCard
          to="/playlists"
          icon={<ListMusic className="size-4" />}
          label="Playlists"
          value={playlists?.length ?? 0}
        />
        <StatCard
          to="/recent"
          icon={<BarChart3 className="size-4" />}
          label="Songs played"
          value={history.length}
        />
        <StatCard
          to="/stats"
          icon={<BarChart3 className="size-4" />}
          label="Listening stats"
          value="View"
        />
      </section>

      {/* The sidebar (and its admin link) is `lg:`-only, so without this an
          admin on a phone had no way to reach the admin area at all. */}
      {adminStatus !== null && (
        <Link
          to="/admin"
          className="flex items-center gap-3 rounded-2xl border border-[rgb(var(--tint)_/_0.25)] bg-[rgb(var(--tint)_/_0.08)] px-4 py-3.5 transition-colors hover:bg-[rgb(var(--tint)_/_0.14)]"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-[rgb(var(--tint)_/_0.16)]">
            <ShieldCheck className="size-4 text-[rgb(var(--tint))]" />
          </span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold">Admin panel</span>
            <span className="block text-xs text-muted-foreground">
              Manage accounts, playlists and listening activity
            </span>
          </span>
          <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground" />
        </Link>
      )}
    </div>
  );
}

function StatCard({
  to,
  icon,
  label,
  value,
}: {
  to: string;
  icon: React.ReactNode;
  label: string;
  value: number | string;
}) {
  return (
    <Link
      to={to}
      className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-4 transition-all hover:border-[rgb(var(--tint)_/_0.35)] hover:bg-white/[0.05]"
    >
      <span className="flex size-8 items-center justify-center rounded-lg bg-[rgb(var(--tint)_/_0.14)] text-[rgb(var(--tint))]">
        {icon}
      </span>
      <p className="mt-2 font-display text-xl font-bold">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </Link>
  );
}
