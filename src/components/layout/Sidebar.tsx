import { useState } from "react";
import { Logo } from "@/components/brand/Logo";
import { PlaylistDialog } from "@/components/playlists/PlaylistDialog";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { useQuery } from "convex/react";
import {
  Heart,
  House,
  LibraryBig,
  ListMusic,
  LogOut,
  Plus,
  Search,
} from "lucide-react";
import { NavLink, useNavigate } from "react-router";

const NAV = [
  { to: "/home", label: "Home", icon: House },
  { to: "/search", label: "Search", icon: Search },
  { to: "/library", label: "Library", icon: LibraryBig },
  { to: "/liked", label: "Liked Songs", icon: Heart },
];

export function Sidebar() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const playlists = useQuery(api.playlists.myPlaylists);
  const [dialogOpen, setDialogOpen] = useState(false);

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  const initials =
    user?.name
      ?.split(/\s+/)
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() ?? "U";

  return (
    <aside className="glass hidden w-60 shrink-0 flex-col border-r border-white/[0.06] lg:flex">
      <div className="flex h-16 items-center px-5">
        <Logo to="/home" />
      </div>

      <nav className="flex flex-col gap-0.5 px-3">
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-white/[0.07] text-foreground"
                  : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
              )
            }
          >
            <Icon className="size-[18px]" />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="mt-6 flex items-center justify-between px-5">
        <p className="text-[11px] font-semibold tracking-widest text-muted-foreground/70 uppercase">
          Playlists
        </p>
        <button
          type="button"
          aria-label="New playlist"
          onClick={() => setDialogOpen(true)}
          className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
        >
          <Plus className="size-4" />
        </button>
      </div>

      <div className="mt-1 flex-1 overflow-y-auto px-3 pb-4">
        <NavLink
          to="/playlists"
          className={({ isActive }) =>
            cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              isActive
                ? "bg-white/[0.07] text-foreground"
                : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
            )
          }
        >
          <ListMusic className="size-[18px]" />
          All playlists
        </NavLink>
        {playlists === undefined && (
          <div className="space-y-1 px-3 py-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-4 animate-pulse rounded bg-white/[0.06]" />
            ))}
          </div>
        )}
        {playlists?.map((p) => (
          <NavLink
            key={p._id}
            to={`/playlist/${p._id}`}
            className={({ isActive }) =>
              cn(
                "flex items-center gap-3 rounded-lg px-3 py-1.5 text-sm transition-colors",
                isActive
                  ? "bg-white/[0.07] font-medium text-foreground"
                  : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
              )
            }
          >
            <span className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] bg-white/[0.07]">
              <ListMusic className="size-3 text-muted-foreground/70" />
            </span>
            <span className="truncate">{p.name}</span>
          </NavLink>
        ))}
        {playlists !== undefined && playlists.length === 0 && (
          <p className="px-3 py-2 text-xs leading-5 text-muted-foreground/70">
            Playlists you create appear here.
          </p>
        )}
      </div>

      <div className="flex items-center gap-2.5 border-t border-white/[0.06] px-4 py-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[rgb(var(--tint))] text-sm font-bold text-black">
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">
            {user?.name ?? (user?.isAnonymous ? "Guest" : "Listener")}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {user?.email ?? "Anonymous session"}
          </p>
        </div>
        <button
          type="button"
          aria-label="Sign out"
          onClick={handleSignOut}
          className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
        >
          <LogOut className="size-4" />
        </button>
      </div>

      <PlaylistDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </aside>
  );
}