import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Logo } from "@/components/brand/Logo";
import { PlaylistDialog } from "@/components/playlists/PlaylistDialog";

import { CommandPaletteHint } from "@/components/core/CommandPalette";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { usePlayerStore } from "@/store/player";
import { cn } from "@/lib/utils";
import { useQuery } from "convex/react";
import {
  ArrowRightFromLine,
  ArrowRightToLine,
  BarChart3,
  Heart,
  History,
  House,
  Library,
  ListMusic,
  Plus,
  Radio,
  Search,
  Settings,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { Link, NavLink, useNavigate } from "react-router";
import { AccountMenu } from "@/components/layout/AccountMenu";

type Filter = "playlists" | "liked" | "recent";

export function Sidebar() {
  const { user } = useAuth();
  const hideEmail = usePlayerStore((s) => s.hideSidebarEmail);
  const collapsed = usePlayerStore((s) => s.sidebarCollapsed);
  const toggleCollapsed = usePlayerStore((s) => s.toggleSidebarCollapsed);
  const navigate = useNavigate();
  const playlists = useQuery(api.playlists.myPlaylists);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [filter, setFilter] = useState<Filter | "all">("all");

  // The Playlists / Liked / Recent chips are pure navigation, so the playlist
  // list must NOT depend on them. It used to: `filter` of "liked" or "recent"
  // made this `[]`, so clicking either chip made the user's entire playlist
  // list vanish from the sidebar until they clicked again.
  const visiblePlaylists = playlists;

  const linkCls = ({ isActive }: { isActive: boolean }) =>
    cn(
      "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
      isActive
        ? "bg-white/[0.07] text-foreground"
        : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
    );

  return (
    <AnimatePresence mode="popLayout" initial={false}>
      {collapsed ? (
        <motion.aside
          key="collapsed"
          initial={{ width: 240, opacity: 0 }}
          animate={{ width: 72, opacity: 1 }}
          exit={{ width: 240, opacity: 0 }}
          transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
          className="liquid-glass hidden w-[72px] shrink-0 flex-col items-center overflow-hidden border-r border-white/[0.06] py-3 lg:flex"
        >
          <Logo
            to="/home"
            iconOnly
            className="mb-2 flex size-10 items-center justify-center rounded-lg hover:bg-white/[0.05]"
            onToggle={toggleCollapsed}
          />
          {[
            { to: "/home", label: "Home", icon: House },
            { to: "/search", label: "Search", icon: Search },
            { to: "/playlists", label: "Your Library", icon: Library },
            { to: "/liked", label: "Liked Songs", icon: Heart },
            { to: "/recent", label: "Recently Played", icon: History },
            { to: "/social", label: "Listening Rooms", icon: Radio },
            { to: "/downloads", label: "Downloads", icon: ArrowRightToLine },
          ].map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to + label}
              to={to}
              title={label}
              aria-label={label}
              className={({ isActive }) =>
                cn(
                  "mb-0.5 flex size-10 items-center justify-center rounded-lg transition-colors",
                  isActive
                    ? "bg-white/[0.07] text-foreground"
                    : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
                )
              }
            >
              <Icon className="size-[20px]" />
            </NavLink>
          ))}
          {user?.role === "admin" && (
            <NavLink
              to="/admin"
              title="Admin"
              className={({ isActive }) =>
                cn(
                  "mb-0.5 flex size-10 items-center justify-center rounded-lg transition-colors",
                  isActive
                    ? "bg-white/[0.07] text-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )
              }
            >
              <ShieldCheck className="size-[20px] text-[rgb(var(--tint))]" />
            </NavLink>
          )}

          <div className="my-2 h-px w-8 bg-white/[0.06]" />

          <button
            type="button"
            aria-label="New playlist"
            title="New playlist"
            onClick={() => setDialogOpen(true)}
            className="mb-0.5 flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground"
          >
            <Plus className="size-[20px]" />
          </button>
          <Link
            to="/playlists"
            title="All playlists"
            className="mb-0.5 flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground"
          >
            <ListMusic className="size-[20px]" />
          </Link>

          {/* playlist covers, Spotify collapsed style */}
          <div className="mt-2 flex w-full flex-1 flex-col items-center gap-2 overflow-y-auto pb-2">
            {playlists?.slice(0, 12).map((p) => (
              <Link
                key={p._id}
                to={`/playlist/${p._id}`}
                title={p.name}
                className="size-10 shrink-0 overflow-hidden rounded-md ring-1 ring-white/10 transition-transform hover:scale-105"
              >
                <span
                  className="size-10 shrink-0 overflow-hidden rounded-md ring-1 ring-white/10 transition-transform hover:scale-105"
                  style={{
                    background:
                      "linear-gradient(135deg, rgb(var(--tint) / 0.35), rgb(var(--tint) / 0.1))",
                  }}
                >
                  <span className="flex size-full items-center justify-center">
                    <ListMusic className="size-4 text-[rgb(var(--tint))]" />
                  </span>
                </span>
              </Link>
            ))}
          </div>

          <button
            type="button"
            aria-label="Expand sidebar"
            title="Expand sidebar"
            onClick={toggleCollapsed}
            className="flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground"
          >
            <ArrowRightFromLine className="size-[18px]" />
          </button>

          <div className="mt-2 flex flex-col items-center gap-1 border-t border-white/[0.06] pt-3">
            {/* The avatar is the account control, not just a profile link:
                this is where sign-out and switching accounts live. */}
            <AccountMenu variant="collapsed" />
            <button
              type="button"
              aria-label="Settings"
              title="Settings"
              onClick={() => void navigate("/settings")}
              className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground"
            >
              <Settings className="size-4" />
            </button>
            {/* Makes the ⌘K palette discoverable. A shortcut nobody can find
                is not a shortcut, and this drives the same store the hotkey
                does, so the two can never disagree. `compact` because the
                rail is 72px: the full `⌕ Search ⌘K` pill is ~110px and was
                overflowing and being clipped here. */}
            <CommandPaletteHint compact />
          </div>

          <PlaylistDialog open={dialogOpen} onOpenChange={setDialogOpen} />
          {/* The SettingsDialog that used to sit here was unreachable
              (`settingsOpen` was never set to true) and carried its own
              sign-out that skipped the listening-session reset. Settings is a
              route now, and account actions come from `useAccountActions`. */}
        </motion.aside>
      ) : (
        <motion.aside
          key="expanded"
          initial={{ width: 72, opacity: 0 }}
          animate={{ width: 240, opacity: 1 }}
          exit={{ width: 72, opacity: 0 }}
          transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
          className="liquid-glass hidden w-60 shrink-0 flex-col border-r border-white/[0.06] lg:flex"
        >
          <div className="flex h-16 items-center justify-between px-5">
            <Logo to="/home" />
            <button
              type="button"
              aria-label="Collapse sidebar"
              title="Collapse sidebar"
              onClick={toggleCollapsed}
              className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
            >
              <ArrowRightToLine className="size-4" />
            </button>
          </div>

          <nav className="flex flex-col gap-0.5 px-3">
            {[
              { to: "/home", label: "Home", icon: House },
              { to: "/search", label: "Search", icon: Search },
              { to: "/social", label: "Listening Rooms", icon: Radio },
            { to: "/downloads", label: "Downloads", icon: ArrowRightToLine },
            ].map(({ to, label, icon: Icon }) => (
              <NavLink key={to + label} to={to} className={linkCls}>
                <Icon className="size-[18px]" />
                {label}
              </NavLink>
            ))}
            {user?.role === "admin" && (
              <NavLink to="/admin" className={linkCls}>
                <ShieldCheck className="size-[18px] text-[rgb(var(--tint))]" />
                Admin
              </NavLink>
            )}
          </nav>

          {/* The ⌘K hint lives in BOTH rails, in the form that actually fits
              each. It used to exist only in the collapsed 72px rail, where a
              ~110px pill could only ever overflow and get clipped. */}
          <div className="px-3 pt-3">
            <CommandPaletteHint />
          </div>

          {/* Spotify-style Library card */}
          <div className="glass-card mx-3 mt-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl">
            <div className="flex items-center justify-between px-4 py-3">
              <button
                type="button"
                onClick={() => navigate("/playlists")}
                className="flex items-center gap-2 text-sm font-semibold text-foreground transition-colors hover:text-[rgb(var(--tint))]"
              >
                <Library className="size-[18px]" />
                Your Library
              </button>
              <button
                type="button"
                aria-label="New playlist"
                title="Create playlist"
                onClick={() => setDialogOpen(true)}
                className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
              >
                <Plus className="size-4" />
              </button>
            </div>

            {/* filter chips */}
            <div className="grid grid-cols-3 gap-1 px-3 pb-2">
              {(
                [
                  { id: "playlists", label: "Playlists" },
                  { id: "liked", label: "Liked" },
                  { id: "recent", label: "Recent" },
                ] as const
              ).map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  onClick={() => {
                    setFilter(filter === chip.id ? "all" : chip.id);
                    if (chip.id === "liked") navigate("/liked");
                    if (chip.id === "recent") navigate("/recent");
                    if (chip.id === "playlists") navigate("/playlists");
                  }}
                  className={cn(
                    "min-w-0 rounded-lg px-2 py-1 text-[11px] font-medium transition-colors",
                    filter === chip.id
                      ? "bg-foreground text-background"
                      : "bg-white/[0.06] text-muted-foreground hover:bg-white/[0.1]",
                  )}
                >
                  {chip.label}
                </button>
              ))}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              <NavLink
                to="/liked"
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-3 rounded-lg px-2 py-2 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-white/[0.07] text-foreground"
                      : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
                  )
                }
              >
                <span className="relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-white/10 bg-[#111b1b]">
                  <span className="absolute -left-2 -top-2 size-8 rounded-full bg-[rgb(var(--tint)/0.5)] blur-md" />
                  <span className="absolute -bottom-3 -right-2 size-9 rounded-full bg-emerald-400/20 blur-md" />
                  <Heart className="relative z-10 size-4 text-[rgb(var(--tint))]" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate">Liked Songs</span>
                  <span className="block text-xs text-muted-foreground">
                    Playlist
                  </span>
                </span>
              </NavLink>

              <NavLink
                to="/recent"
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-3 rounded-lg px-2 py-2 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-white/[0.07] text-foreground"
                      : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
                  )
                }
              >
                <span className="relative flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-white/10 bg-[#17151e]">
                  <span className="absolute -right-2 -top-2 size-8 rounded-full bg-violet-400/25 blur-md" />
                  <span className="absolute -bottom-3 -left-2 size-9 rounded-full bg-amber-300/20 blur-md" />
                  <History className="relative z-10 size-4 text-violet-200" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate">Recently Played</span>
                  <span className="block text-xs text-muted-foreground">
                    History
                  </span>
                </span>
              </NavLink>

              {playlists === undefined && (
                <div className="space-y-2 px-2 py-2">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="flex items-center gap-3 px-2">
                      <div className="size-10 animate-pulse rounded-md bg-white/[0.06]" />
                      <div className="flex-1 space-y-1.5">
                        <div className="h-3 w-3/4 animate-pulse rounded bg-white/[0.06]" />
                        <div className="h-2.5 w-1/2 animate-pulse rounded bg-white/[0.06]" />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {visiblePlaylists?.map((p) => (
                <NavLink
                  key={p._id}
                  to={`/playlist/${p._id}`}
                  className={({ isActive }) =>
                    cn(
                      "group flex items-center gap-3 rounded-lg px-2 py-2 text-sm transition-colors",
                      isActive
                        ? "bg-white/[0.07] font-medium text-foreground"
                        : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
                    )
                  }
                >
                  <span
                    className="size-10 shrink-0 overflow-hidden rounded-md ring-1 ring-white/10"
                    style={{
                      background:
                        "linear-gradient(135deg, rgb(var(--tint) / 0.35), rgb(var(--tint) / 0.1))",
                    }}
                  >
                    <span className="flex size-full items-center justify-center">
                      <ListMusic className="size-4 text-[rgb(var(--tint))]" />
                    </span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-foreground group-hover:text-foreground">
                      {p.name}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      Playlist
                    </span>
                  </span>
                </NavLink>
              ))}

              {playlists !== undefined && playlists.length === 0 && (
                <p className="px-2 py-3 text-xs leading-5 text-muted-foreground/70">
                  Playlists you create appear here.
                </p>
              )}
            </div>
          </div>

          <p className="px-5 pb-2 text-[10px] tracking-wide text-muted-foreground/50">
            Currently in beta
          </p>

          <div className="flex items-center gap-2.5 border-t border-white/[0.06] px-4 py-3">
            <AccountMenu
              variant="expanded"
              hideEmail={hideEmail}
              className="min-w-0 flex-1"
            />
            <button
              type="button"
              aria-label="Settings"
              title="Settings"
              onClick={() => void navigate("/settings")}
              className="rounded-full p-2 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
            >
              <Settings className="size-4" />
            </button>
            <NavLink
              to="/profile"
              aria-label="Profile"
              title="Profile"
              className={({ isActive }) =>
                cn(
                  "rounded-full p-2 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground",
                  isActive && "text-[rgb(var(--tint))]",
                )
              }
            >
              <UserRound className="size-4" />
            </NavLink>
            <NavLink
              to="/stats"
              aria-label="Your stats"
              title="Your stats"
              className={({ isActive }) =>
                cn(
                  "rounded-full p-2 text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground",
                  isActive && "text-[rgb(var(--tint))]",
                )
              }
            >
              <BarChart3 className="size-4" />
            </NavLink>
          </div>

          <PlaylistDialog open={dialogOpen} onOpenChange={setDialogOpen} />
          {/* The SettingsDialog that used to sit here was unreachable
              (`settingsOpen` was never set to true) and carried its own
              sign-out that skipped the listening-session reset. Settings is a
              route now, and account actions come from `useAccountActions`. */}
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
