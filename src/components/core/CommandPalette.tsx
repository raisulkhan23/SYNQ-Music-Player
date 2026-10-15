import { useEffect } from "react";
import { useNavigate } from "react-router";
import { create } from "zustand";
import {
  Compass,
  Disc3,
  Heart,
  House,
  ListMusic,
  Pause,
  Play,
  Repeat,
  Search,
  Settings,
  Shuffle,
  SkipBack,
  SkipForward,
  UserRound,
} from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { usePlayerStore } from "@/store/player";
import { cn } from "@/lib/utils";

/**
 * The ⌘K palette.
 *
 * What makes this worth having is that it is ONE component that only ever does
 * things the app already does: it navigates to routes that already exist and
 * calls store actions that PlayerBar already calls. It adds no router state,
 * fetches nothing, and cannot put the app into a state it could not otherwise
 * reach.
 *
 * The open/closed state lives in a tiny store rather than in a `useState` inside
 * this component, for one specific reason. The palette is reachable two ways —
 * the ⌘K hotkey and a visible button in the shell — and if each owned its own
 * state there would be two `keydown` listeners that each toggled a *different*
 * `open`. Pressing ⌘K would flip both, leaving it shut. A single store means
 * one listener, one dialog, and the button and the shortcut are provably the
 * same thing.
 */
const usePalette = create<{ open: boolean; setOpen: (open: boolean) => void }>(
  (set) => ({
    open: false,
    setOpen: (open) => set({ open }),
  }),
);

const PAGES = [
  { label: "Home", to: "/home", icon: House },
  { label: "Search", to: "/search", icon: Search },
  { label: "Discover", to: "/discover", icon: Compass },
  { label: "Liked songs", to: "/liked", icon: Heart },
  { label: "Your library", to: "/playlists", icon: ListMusic },
  { label: "Listening history", to: "/recent", icon: Disc3 },
  { label: "Stats", to: "/stats", icon: ListMusic },
  { label: "Profile", to: "/profile", icon: UserRound },
  { label: "Settings", to: "/settings", icon: Settings },
] as const;

/**
 * Mount ONCE, in the app shell. Owns the hotkey and renders the dialog.
 */
export function CommandPalette() {
  const open = usePalette((s) => s.open);
  const setOpen = usePalette((s) => s.setOpen);
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key?.toLowerCase() !== "k") return;
      if (!event.metaKey && !event.ctrlKey) return;
      // Otherwise the browser also acts on it (focus its search bar on some
      // platforms, or opens the dev tools find-in-page on others).
      event.preventDefault();
      setOpen(!usePalette.getState().open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  // A page change from anywhere else — the back button, a link, the browser —
  // must not leave the palette open on top of a page it no longer describes.
  useEffect(() => {
    setOpen(false);
  }, [navigate, setOpen]);

  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const next = usePlayerStore((s) => s.next);
  const prev = usePlayerStore((s) => s.prev);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const cycleRepeat = usePlayerStore((s) => s.cycleRepeat);
  const setQueueOpen = usePlayerStore((s) => s.setQueueOpen);
  const toggleLike = usePlayerStore((s) => s.toggleLike);
  const hasTrack = usePlayerStore((s) => Boolean(s.current));

  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };
  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Jump to a page or control playback"
      className="sm:max-w-[560px]"
    >
      <CommandInput placeholder="Jump to a page, or control playback…" />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>

        <CommandGroup heading="Go to">
          {PAGES.map((page) => (
            <CommandItem
              key={page.to}
              value={`go ${page.label}`}
              onSelect={() => go(page.to)}
            >
              <page.icon className="size-4 text-muted-foreground" />
              <span>{page.label}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandSeparator />

        <CommandGroup heading="Playback">
          <CommandItem
            value="playback play pause resume"
            onSelect={run(togglePlay)}
          >
            {isPlaying ? (
              <Pause className="size-4 text-muted-foreground" />
            ) : (
              <Play className="size-4 text-muted-foreground" />
            )}
            <span>{isPlaying ? "Pause" : "Play"}</span>
            <CommandShortcut>Space</CommandShortcut>
          </CommandItem>
          <CommandItem
            value="playback next track"
            disabled={!hasTrack}
            onSelect={run(next)}
          >
            <SkipForward className="size-4 text-muted-foreground" />
            <span>Next track</span>
            <CommandShortcut>N</CommandShortcut>
          </CommandItem>
          <CommandItem
            value="playback previous track"
            disabled={!hasTrack}
            onSelect={run(prev)}
          >
            <SkipBack className="size-4 text-muted-foreground" />
            <span>Previous track</span>
            <CommandShortcut>P</CommandShortcut>
          </CommandItem>
          <CommandItem
            value="playback shuffle random"
            onSelect={run(toggleShuffle)}
          >
            <Shuffle className="size-4 text-muted-foreground" />
            <span>Toggle shuffle</span>
            <CommandShortcut>S</CommandShortcut>
          </CommandItem>
          <CommandItem value="playback repeat loop" onSelect={run(cycleRepeat)}>
            <Repeat className="size-4 text-muted-foreground" />
            <span>Toggle repeat</span>
            <CommandShortcut>R</CommandShortcut>
          </CommandItem>
          <CommandItem
            value="playback like favourite favorite heart save"
            disabled={!hasTrack}
            onSelect={run(() => {
              // Read the CURRENT track at invoke time rather than closing over
              // render state, so the palette can never like the previous song.
              const id = usePlayerStore.getState().current?.id;
              if (id) toggleLike(id);
            })}
          >
            <Heart className="size-4 text-muted-foreground" />
            <span>Like current track</span>
            <CommandShortcut>L</CommandShortcut>
          </CommandItem>
          <CommandItem
            value="playback queue up next"
            onSelect={run(() => setQueueOpen(true))}
          >
            <ListMusic className="size-4 text-muted-foreground" />
            <span>Open queue</span>
            <CommandShortcut>Q</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

/**
 * The visible affordance, so the palette is discoverable rather than a
 * secret. Drives the same store as the hotkey, so the two cannot disagree.
 */
/**
 * The button that makes the ⌘K palette discoverable. A shortcut nobody can
 * find is not a shortcut, and this drives the same store the hotkey does, so
 * the two can never disagree.
 *
 * `compact` is the 72px collapsed-rail form: a `⌕ Search ⌘K` pill is roughly
 * 110px wide and CANNOT fit there — it overflowed and was clipped, which is
 * what the screenshot showed. The rail gets a bare icon sized like its
 * neighbours; the full pill, which does fit, goes in the expanded sidebar.
 */
export function CommandPaletteHint({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  const setOpen = usePalette((s) => s.setOpen);
  if (compact) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open command palette"
        title="Search (⌘K)"
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground",
          className,
        )}
      >
        <Search className="size-4" />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      aria-label="Open command palette"
      title="Search (⌘K)"
      className={cn(
        "flex w-full items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] text-muted-foreground transition-colors hover:border-white/20 hover:text-foreground",
        className,
      )}
    >
      <Search className="size-4 shrink-0" />
      <span className="flex-1 text-left">Search</span>
      <kbd className="shrink-0 rounded border border-white/10 bg-white/[0.06] px-1.5 py-0.5 text-[10px]">
        ⌘K
      </kbd>
    </button>
  );
}
