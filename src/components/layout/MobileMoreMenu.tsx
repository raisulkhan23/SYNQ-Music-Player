import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useQuery } from "convex/react";
import {
  BarChart3,
  ChevronRight,
  Download,
  Heart,
  History,
  Loader2,
  LogOut,
  Menu,
  Radio,
  ShieldCheck,
  Upload,
  Users,
} from "lucide-react";

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { api } from "@/convex/_generated/api";
import { cn } from "@/lib/utils";
import { useAccountActions } from "@/hooks/use-account-actions";
import { useAuth } from "@/hooks/use-auth";

/**
 * Everything the desktop sidebar links to that the 4-item phone bottom bar
 * has no room for. Without this sheet, Liked Songs, Recently Played,
 * Listening Rooms, Listening stats and the admin area were unreachable on a
 * phone — the sidebar is `lg:`-only and the bottom nav is fixed at 4.
 *
 * Rendered into the mobile top bar (which is itself `lg:hidden`), so on
 * desktop the trigger never appears and the route list is irrelevant.
 */
const EXTRA_DESTINATIONS = [
  {
    to: "/liked",
    label: "Liked Songs",
    detail: "Everything you've hearted",
    icon: Heart,
  },
  {
    to: "/recent",
    label: "Recently Played",
    detail: "Your listening history, newest first",
    icon: History,
  },
  {
    to: "/social",
    label: "Listening Rooms",
    detail: "Listen in sync with friends",
    icon: Radio,
  },
  {
    to: "/stats",
    label: "Listening Stats",
    detail: "Top songs, artists and habits",
    icon: BarChart3,
  },
  {
    to: "/downloads",
    label: "Downloads",
    detail: "Offline copies and what's cached",
    icon: Download,
  },
  {
    to: "/import",
    label: "Import music",
    detail: "Bring a playlist in from another service",
    icon: Upload,
  },
] as const;

export function MobileMoreMenu() {
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  // null = not an admin. Same signal Profile uses, so the admin row appears
  // for exactly the same people on both layouts.
  const adminStatus = useQuery(api.admin.status);
  // The sidebar that carries the account menu is `lg:`-only, so a phone had
  // NO way to sign out or switch accounts at all. Same actions, same hook.
  const { user, isAuthenticated } = useAuth();
  const { pending, signOut, switchAccount } = useAccountActions();

  // A visitor browsing SYNQ has no session to end and no account to switch
  // away from. The sheet must say so rather than offering them a "Sign out"
  // that cannot mean anything.
  const isGuest = !isAuthenticated;

  const accountName =
    user?.name ?? (isGuest ? "Guest" : "Signed in as Listener");

  const go = (to: string) => {
    setOpen(false);
    void navigate(to);
  };

  // Highlight the trigger while the listener is on one of these pages, so the
  // sheet button is not the only part of the app that knows where they are.
  const isActive =
    EXTRA_DESTINATIONS.some((d) => d.to === location.pathname) ||
    location.pathname === "/admin";

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label="More"
          className={cn(
            "rounded-full p-2 transition-colors hover:text-foreground",
            isActive ? "text-[rgb(var(--tint))]" : "text-muted-foreground",
          )}
        >
          <Menu className="size-[18px]" />
        </button>
      </SheetTrigger>
      <SheetContent
        side="right"
        /* `fixed inset-y-0`, so on a notched phone the header would sit under
           the status bar and the last row under the home indicator. Same
           safe-area padding the queue sheet uses. */
        className="w-full max-w-sm border-l border-white/[0.08] bg-[#0e0f15]/95 p-0 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] backdrop-blur-2xl"
      >
        <SheetHeader className="border-b border-white/[0.06] px-5 py-4 pr-12">
          <SheetTitle className="flex items-center gap-2 font-display text-base">
            <Menu className="size-4 text-[rgb(var(--tint))]" />
            More
          </SheetTitle>
        </SheetHeader>
        <nav className="flex flex-col gap-1 overflow-y-auto px-3 py-3">
          {EXTRA_DESTINATIONS.map(({ to, label, detail, icon: Icon }) => (
            <button
              key={to}
              type="button"
              onClick={() => go(to)}
              className={cn(
                "flex items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors",
                location.pathname === to
                  ? "bg-[rgb(var(--tint)_/_0.12)]"
                  : "hover:bg-white/[0.06]",
              )}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-white/[0.06]">
                <Icon
                  className={cn(
                    "size-4",
                    location.pathname === to && "text-[rgb(var(--tint))]",
                  )}
                />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">
                  {label}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {detail}
                </span>
              </span>
              <ChevronRight className="ml-auto size-4 shrink-0 text-muted-foreground" />
            </button>
          ))}

          {adminStatus !== null && (
            <button
              type="button"
              onClick={() => go("/admin")}
              className={cn(
                "mt-1 flex items-center gap-3 rounded-2xl border border-[rgb(var(--tint)_/_0.25)] bg-[rgb(var(--tint)_/_0.08)] px-3 py-3 text-left transition-colors hover:bg-[rgb(var(--tint)_/_0.14)]",
                location.pathname === "/admin" &&
                  "bg-[rgb(var(--tint)_/_0.16)]",
              )}
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
            </button>
          )}
        </nav>

        {/* Account block. `nav` ends above it so these read as a footer, and
            the identity is shown above the actions so the sheet never leaves
            a listener unsure WHO they are about to sign out of. */}
        <div className="mt-auto border-t border-white/[0.06] px-3 py-3">
          <p className="px-3 pb-2 text-[10px] tracking-wide text-muted-foreground/60">
            {isGuest ? "Browsing as guest" : accountName}
            {user?.email ? ` · ${user.email}` : ""}
          </p>
          {isGuest ? (
            <button
              type="button"
              onClick={switchAccount}
              disabled={pending}
              className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors hover:bg-white/[0.06] disabled:opacity-50"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-white/[0.06]">
                {pending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Users className="size-4" />
                )}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold">Sign in</span>
                <span className="block truncate text-xs text-muted-foreground">
                  Play and save to sync your library
                </span>
              </span>
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={switchAccount}
                disabled={pending}
                className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors hover:bg-white/[0.06] disabled:opacity-50"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-white/[0.06]">
                  {pending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Users className="size-4" />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">
                    Switch account
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    Sign out and sign in as someone else
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={signOut}
                disabled={pending}
                className="flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors hover:bg-red-500/[0.08] disabled:opacity-50"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-white/[0.06]">
                  <LogOut className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-red-400">
                    Sign out
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    Clear this device&apos;s listening session
                  </span>
                </span>
              </button>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
