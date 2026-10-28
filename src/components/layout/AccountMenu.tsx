import { useCallback } from "react";
import { useNavigate } from "react-router";
import {
  ChevronUp,
  Loader2,
  LogIn,
  LogOut,
  Settings as SettingsIcon,
  UserRound,
  Users,
} from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/hooks/use-auth";
import { useAccountActions } from "@/hooks/use-account-actions";
import { cn } from "@/lib/utils";

/**
 * The account control: who is signed in, and the two ways out.
 *
 * It renders the trigger for two sidebar shapes and delegates every action to
 * `useAccountActions`, which is the single implementation shared with the
 * phone sheet. See that hook for why the sign-out was previously unreachable
 * and why the local session is cleared before the auth token is.
 */
export function AccountMenu({
  /** `collapsed` is the icon-only 72px rail; `expanded` shows name + email. */
  variant = "collapsed",
  className,
  hideEmail = false,
}: {
  variant?: "collapsed" | "expanded";
  className?: string;
  /** Honours the existing "Hide email in sidebar" setting. */
  hideEmail?: boolean;
}) {
  const { user, isAuthenticated } = useAuth();
  const { pending, signOut, switchAccount } = useAccountActions();
  const navigate = useNavigate();

  /**
   * No session at all. This is the normal state for a visitor browsing SYNQ
   * before creating an account, not an error — so the menu says "guest" and
   * offers a sign-in instead of pretending there is a profile to open and a
   * session to end.
   */
  const isGuest = !isAuthenticated;

  const name = user?.name ?? (isGuest ? "Guest" : "Signed in as Listener");
  const initials =
    user?.name
      ?.split(/\s+/)
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() ?? "U";

  const go = useCallback(
    (to: string) => {
      void navigate(to);
    },
    [navigate],
  );

  const avatar = user?.image ? (
    <img src={user.image} alt="" className="size-full object-cover" />
  ) : (
    <span>{initials}</span>
  );

  if (variant === "expanded") {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Account menu"
            className={cn(
              "flex w-full items-center gap-2.5 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-white/[0.06]",
              className,
            )}
          >
            <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[rgb(var(--tint))] text-sm font-bold text-black ring-2 ring-white/10">
              {avatar}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">
                {name}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {hideEmail
                  ? "Tap for account"
                  : (user?.email ?? "Anonymous session")}
              </span>
            </span>
            <ChevronUp className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="w-64">
          <AccountRows
            name={name}
            email={user?.email ?? null}
            pending={pending}
            isGuest={isGuest}
            onSignOut={signOut}
            onSwitchAccount={switchAccount}
            onGo={go}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          title={name}
          className={cn(
            "flex size-10 items-center justify-center overflow-hidden rounded-full bg-[rgb(var(--tint))] text-sm font-bold text-black ring-2 ring-white/10 transition-opacity hover:opacity-90",
            className,
          )}
        >
          {avatar}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="right" className="w-64">
        <AccountRows
          name={name}
          email={user?.email ?? null}
          pending={pending}
          isGuest={isGuest}
          onSignOut={signOut}
          onSwitchAccount={switchAccount}
          onGo={go}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The menu body, shared by both trigger shapes.
 *
 * Split out so the two variants can differ in geometry without the list ever
 * drifting — a sign-out that exists in the sidebar rail but not in the
 * expanded panel is precisely the bug this replaced.
 *
 * "Switch account" is listed above "Sign out" on purpose: on a shared device
 * it is the action people reach for, and it differs only in where it lands.
 *
 * ## Guests get a different menu
 *
 * A visitor who has not signed in has no profile, no library and no session to
 * end. Offering them "Your profile", "Sign out" and "Anonymous session" is
 * three dead controls and a lie about their state — which is exactly the
 * impression deferred authentication works to avoid. They get one honest
 * action: sign in.
 */
function AccountRows({
  name,
  email,
  pending,
  isGuest,
  onSignOut,
  onSwitchAccount,
  onGo,
}: {
  name: string;
  email: string | null;
  pending: boolean;
  isGuest: boolean;
  onSignOut: () => void;
  onSwitchAccount: () => void;
  onGo: (to: string) => void;
}) {
  if (isGuest) {
    return (
      <>
        <DropdownMenuLabel className="flex flex-col gap-0.5 px-2 py-1.5 font-normal">
          <span className="truncate text-sm font-semibold">
            Browsing as guest
          </span>
          <span className="truncate text-xs text-muted-foreground">
            Play and save to sync your library
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={onSwitchAccount}
          disabled={pending}
          className="cursor-pointer font-semibold"
        >
          {pending ? (
            <Loader2 className="mr-2 size-4 animate-spin" />
          ) : (
            <LogIn className="mr-2 size-4" />
          )}
          Sign in
        </DropdownMenuItem>
      </>
    );
  }

  return (
    <>
      <DropdownMenuLabel className="flex flex-col gap-0.5 px-2 py-1.5 font-normal">
        <span className="truncate text-sm font-semibold">{name}</span>
        <span className="truncate text-xs text-muted-foreground">
          {email ?? "Signed in"}
        </span>
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onClick={() => onGo("/profile")}
        className="cursor-pointer"
      >
        <UserRound className="mr-2 size-4" />
        Your profile
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={() => onGo("/settings")}
        className="cursor-pointer"
      >
        <SettingsIcon className="mr-2 size-4" />
        Settings
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      {/*
        Convex Auth holds one session per browser, so "switch account" is
        necessarily sign-out-then-sign-in. It is offered as its own action
        because the destination is different — /auth instead of the landing
        page — and because "log out" and "use a different account" are
        genuinely different intents on a shared device.
      */}
      <DropdownMenuItem
        onClick={onSwitchAccount}
        disabled={pending}
        className="cursor-pointer"
      >
        {pending ? (
          <Loader2 className="mr-2 size-4 animate-spin" />
        ) : (
          <Users className="mr-2 size-4" />
        )}
        Switch account
      </DropdownMenuItem>
      <DropdownMenuItem
        onClick={onSignOut}
        disabled={pending}
        className="cursor-pointer text-destructive focus:text-destructive"
      >
        {pending ? (
          <Loader2 className="mr-2 size-4 animate-spin" />
        ) : (
          <LogOut className="mr-2 size-4" />
        )}
        Sign out
      </DropdownMenuItem>
    </>
  );
}
