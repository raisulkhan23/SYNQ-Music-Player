import { useEffect } from "react";
import { Outlet, NavLink } from "react-router";
import { FullscreenPlayer } from "@/components/player/FullscreenPlayer";
import { PlayerBar } from "@/components/player/PlayerBar";
import { QueuePanel } from "@/components/player/QueuePanel";
import { Sidebar } from "@/components/layout/Sidebar";
import { Logo } from "@/components/brand/Logo";
import { api } from "@/convex/_generated/api";
import { cn } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import { Heart, House, LibraryBig, Search } from "lucide-react";
import { usePlayerStore } from "@/store/player";

const MOBILE_NAV = [
  { to: "/home", label: "Home", icon: House },
  { to: "/search", label: "Search", icon: Search },
  { to: "/library", label: "Library", icon: LibraryBig },
  { to: "/liked", label: "Liked", icon: Heart },
];

const DEFAULT_TINT = "203 244 143";

export function AppShell() {
  const accent = usePlayerStore((s) => s.accent);
  const setLiked = usePlayerStore((s) => s.setLiked);
  const setLikeMutation = usePlayerStore((s) => s.setLikeMutation);

  const likedQuery = useQuery(api.likes.myLikedTrackIds);
  const toggleLikeMutation = useMutation(api.likes.toggleLike);

  // Keep the player store's liked map in sync with Convex.
  useEffect(() => {
    if (likedQuery) {
      setLiked(Object.fromEntries(likedQuery.map((d) => [d.trackId, d.createdAt])));
    }
  }, [likedQuery, setLiked]);

  // Wire the store's optimistic toggle to the Convex mutation.
  useEffect(() => {
    setLikeMutation((trackId: string) => toggleLikeMutation({ trackId }));
  }, [toggleLikeMutation, setLikeMutation]);

  // Global keyboard shortcuts (space = play/pause, arrows = seek).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (typing) return;

      const s = usePlayerStore.getState();
      if (e.code === "Space") {
        e.preventDefault();
        s.togglePlay();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        const t = s.duration > 0 ? Math.min(s.duration, s.currentTime + 5) : s.currentTime + 5;
        s.seek(t);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        s.seek(Math.max(0, s.currentTime - 5));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const tint = accent ? `${accent.r} ${accent.g} ${accent.b}` : DEFAULT_TINT;

  return (
    <div
      className="flex h-dvh overflow-hidden bg-background text-foreground"
      style={{ "--tint": tint } as React.CSSProperties}
    >
      <Sidebar />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* mobile top bar */}
        <div className="glass sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between border-b border-white/[0.06] px-4 lg:hidden">
          <Logo to="/home" />
          <nav className="flex items-center gap-1">
            {MOBILE_NAV.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                aria-label={label}
                className={({ isActive }) =>
                  cn(
                    "rounded-full p-2 transition-colors",
                    isActive
                      ? "bg-white/[0.08] text-[rgb(var(--tint))]"
                      : "text-muted-foreground hover:text-foreground",
                  )
                }
              >
                <Icon className="size-[18px]" />
              </NavLink>
            ))}
          </nav>
        </div>

        <main className="relative min-h-0 flex-1 overflow-y-auto">
          {/* ambient accent glow follows the current album art */}
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-[380px] opacity-60"
            style={{
              background: `radial-gradient(60% 100% at 50% 0%, rgb(${tint} / 0.14), transparent 70%)`,
            }}
          />
          <div className="relative mx-auto w-full max-w-6xl px-4 pt-6 pb-10 sm:px-6 lg:px-8 lg:pt-8">
            <Outlet />
          </div>
        </main>

        <PlayerBar />
      </div>

      <QueuePanel />
      <FullscreenPlayer />
    </div>
  );
}

export default AppShell;