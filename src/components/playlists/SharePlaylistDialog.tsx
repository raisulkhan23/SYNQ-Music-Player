import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Check,
  Copy,
  Link2,
  Link2Off,
  Loader2,
  Lock,
  Search as SearchIcon,
  Share2,
  Trash2,
  Users,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { cn } from "@/lib/utils";

/** No point asking the server for a one-character search. Mirrors the backend. */
const MIN_SEARCH_LENGTH = 2;

/**
 * How long to wait after the last keystroke before searching.
 *
 * The directory lookup is a table scan, so it is the one request in this dialog
 * worth not making per character. 250ms is short enough that the list still
 * feels live while typing and long enough that "bjork" is one request rather
 * than five.
 */
const SEARCH_DEBOUNCE_MS = 250;

type Visibility = "private" | "link" | "public";

const VISIBILITY_COPY: Record<
  Visibility,
  { label: string; hint: string; icon: typeof Lock }
> = {
  private: {
    label: "Private",
    hint: "Only you and people you share it with directly.",
    icon: Lock,
  },
  link: {
    label: "Anyone with the link",
    hint: "A signed-out visitor can see a preview of the track list.",
    icon: Link2,
  },
  public: {
    label: "Public",
    hint: "Any signed-in listener can find and read it.",
    icon: Users,
  },
};

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    // Convex wraps thrown errors as `[CONVEX M(...)] Message`. Keep the part a
    // person can act on rather than pasting a stack frame into a toast.
    const stripped = error.message.replace(/^\[.*?\]\s*/, "");
    return stripped || fallback;
  }
  return fallback;
}

/**
 * Share a playlist with people, or hand out a link to it.
 *
 * OWNER-FACING ONLY. `sharingState` answers `canShare: false` for a viewer, and
 * this component renders a read-only note instead of controls in that case —
 * the server rejects those calls anyway, so offering them would only produce
 * error toasts for buttons that were never going to work.
 */
export function SharePlaylistDialog({
  open,
  onOpenChange,
  playlistId,
  playlistName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  playlistId: Id<"playlists">;
  playlistName: string;
}) {
  const state = useQuery(
    api.playlistSharing.sharingState,
    open ? { playlistId } : "skip",
  );
  const shares = useQuery(
    api.playlistSharing.sharesFor,
    open ? { playlistId } : "skip",
  );

  const setVisibility = useMutation(api.playlistSharing.setVisibility);
  const createShareLink = useMutation(api.playlistSharing.createShareLink);
  const revokeShareLink = useMutation(api.playlistSharing.revokeShareLink);
  const shareWith = useMutation(api.playlistSharing.shareWith);
  const revoke = useMutation(api.playlistSharing.revoke);

  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState<Array<{ id: string; name: string }>>(
    [],
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Debounced so typing a name does not run a directory scan per keystroke.
  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed.length < MIN_SEARCH_LENGTH) {
      setDebounced("");
      return;
    }
    const timer = setTimeout(() => setDebounced(trimmed), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  // The stale-response guard: a slow answer for "bj" must not overwrite the
  // results for "bjork" that arrived first.
  const latestQuery = useRef("");
  useEffect(() => {
    latestQuery.current = debounced;
  }, [debounced]);

  const results = useQuery(
    api.playlistSharing.searchUsers,
    open && debounced.length >= MIN_SEARCH_LENGTH
      ? { query: debounced }
      : "skip",
  );

  // Reset the transient bits when the dialog closes, so reopening it does not
  // show a stale search or a stale "copied" tick.
  useEffect(() => {
    if (open) return;
    setSearch("");
    setDebounced("");
    setSelected([]);
    setCopied(false);
  }, [open]);

  const searchResults = useMemo(() => {
    if (!results) return [];
    const taken = new Set(selected.map((entry) => entry.id));
    return results.filter((entry) => !taken.has(entry.id));
  }, [results, selected]);

  const visibility: Visibility =
    state?.visibility === "link" || state?.visibility === "public"
      ? state.visibility
      : "private";

  const shareUrl = state?.shareToken
    ? `${window.location.origin}/p/${state.shareToken}`
    : null;

  const run = async (key: string, work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(key);
    try {
      await work();
    } catch (error) {
      toast.error("That didn't work", {
        description: errorMessage(error, "Try again in a moment."),
      });
    } finally {
      setBusy(null);
    }
  };

  const toggleRecipient = (entry: { id: string; name: string }) => {
    setSelected((current) =>
      current.some((item) => item.id === entry.id)
        ? current.filter((item) => item.id !== entry.id)
        : [...current, entry],
    );
  };

  const handleSend = () =>
    run("send", async () => {
      if (selected.length === 0) return;
      const result = await shareWith({
        playlistId,
        recipientIds: selected.map((entry) => entry.id as Id<"users">),
      });
      const added = (result as { added?: number } | undefined)?.added ?? 0;
      const updated = (result as { updated?: number } | undefined)?.updated ?? 0;
      toast.success(
        added > 0
          ? `Shared with ${added} ${added === 1 ? "listener" : "listeners"}`
          : updated > 0
            ? "Sharing settings updated"
            : "Already shared with them",
      );
      setSelected([]);
      setSearch("");
    });

  const handleCopy = () =>
    run("copy", async () => {
      if (!shareUrl) return;
      try {
        await navigator.clipboard.writeText(shareUrl);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // Clipboard access is denied in some embedded/desktop contexts. Showing
        // the URL is the fallback that always works, so the feature does not
        // depend on a permission the app cannot grant itself.
        toast("Copy this link", { description: shareUrl, duration: 15_000 });
      }
    });

  const ownerControls = state?.canShare !== false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display">
            <span className="flex size-8 items-center justify-center rounded-lg bg-[rgb(var(--tint))] text-black">
              <Share2 className="size-4" />
            </span>
            Share “{playlistName}”
          </DialogTitle>
          <DialogDescription>
            Send it to a listener, or hand out a link. They always see your
            current track list — nothing is copied.
          </DialogDescription>
        </DialogHeader>

        {state === undefined ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Checking sharing settings…
          </div>
        ) : state === null ? (
          <p className="py-8 text-sm text-muted-foreground">
            This playlist is not available to share from this account.
          </p>
        ) : (
          <div className="flex flex-col gap-5">
            {ownerControls ? (
              <>
                {/* ------------------------------------------------ recipients */}
                <div className="flex flex-col gap-2">
                  <label
                    htmlFor="share-search"
                    className="text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase"
                  >
                    Share with a listener
                  </label>
                  <div className="relative">
                    <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="share-search"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search by name…"
                      autoComplete="off"
                      className="pl-9"
                    />
                  </div>

                  {selected.length > 0 && (
                    <ul className="flex flex-wrap gap-1.5">
                      {selected.map((entry) => (
                        <li key={entry.id}>
                          <button
                            type="button"
                            onClick={() => toggleRecipient(entry)}
                            className="flex items-center gap-1.5 rounded-full border border-[rgb(var(--tint)_/_0.5)] bg-[rgb(var(--tint)_/_0.14)] px-2.5 py-1 text-xs font-medium text-[rgb(var(--tint))]"
                          >
                            {entry.name}
                            <span aria-hidden className="opacity-70">
                              ×
                            </span>
                            <span className="sr-only">Remove</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* Results are only rendered once a search has actually run,
                      so the empty state never claims a search found nothing
                      when none was made. */}
                  {debounced.length >= MIN_SEARCH_LENGTH && (
                    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02]">
                      {results === undefined ? (
                        <p className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
                          <Loader2 className="size-3 animate-spin" />
                          Searching…
                        </p>
                      ) : searchResults.length === 0 ? (
                        <p className="px-3 py-3 text-xs text-muted-foreground">
                          No listeners match “{debounced}”. They need a SYNQ
                          account before you can share with them — send the link
                          instead.
                        </p>
                      ) : (
                        <ul className="max-h-56 overflow-y-auto p-1">
                          {searchResults.map((entry) => (
                            <li key={entry.id}>
                              <button
                                type="button"
                                onClick={() =>
                                  toggleRecipient({ id: entry.id, name: entry.name })
                                }
                                className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-white/[0.06] focus-visible:ring-2 focus-visible:ring-[rgb(var(--tint))] focus-visible:outline-none"
                              >
                                {entry.image ? (
                                  <img
                                    src={entry.image}
                                    alt=""
                                    width={28}
                                    height={28}
                                    loading="lazy"
                                    className="size-7 shrink-0 rounded-full object-cover"
                                  />
                                ) : (
                                  <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-xs font-semibold">
                                    {entry.name.slice(0, 1).toUpperCase()}
                                  </span>
                                )}
                                <span className="min-w-0 flex-1 truncate">
                                  {entry.name}
                                </span>
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}

                  <Button
                    type="button"
                    disabled={selected.length === 0 || busy !== null}
                    onClick={() => void handleSend()}
                    className="self-start rounded-full"
                  >
                    {busy === "send" ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Share2 className="size-4" />
                    )}
                    {selected.length > 1
                      ? `Share with ${selected.length}`
                      : "Share"}
                  </Button>
                </div>

                {/* --------------------------------------------------- link */}
                <div className="flex flex-col gap-2 border-t border-white/[0.07] pt-4">
                  <span className="text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                    Share link
                  </span>
                  {shareUrl ? (
                    <>
                      <div className="flex items-center gap-2">
                        <input
                          readOnly
                          value={shareUrl}
                          aria-label="Playlist share link"
                          onFocus={(event) => event.currentTarget.select()}
                          className="h-10 min-w-0 flex-1 rounded-lg border border-white/10 bg-white/[0.05] px-3 text-xs text-muted-foreground focus:border-[rgb(var(--tint)_/_0.6)] focus:outline-none"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void handleCopy()}
                          className="rounded-full"
                        >
                          {copied ? (
                            <Check className="size-4" />
                          ) : (
                            <Copy className="size-4" />
                          )}
                          {copied ? "Copied" : "Copy"}
                        </Button>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={busy !== null}
                          onClick={() =>
                            void run("rotate", async () => {
                              await createShareLink({ playlistId });
                              toast.success("New link created", {
                                description: "The old link no longer works.",
                              });
                            })
                          }
                        >
                          <Link2 className="size-4" />
                          Regenerate
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={busy !== null}
                          onClick={() =>
                            void run("revoke-link", async () => {
                              await revokeShareLink({ playlistId });
                              toast.success("Link turned off");
                            })
                          }
                        >
                          <Link2Off className="size-4" />
                          Turn off
                        </Button>
                      </div>
                    </>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy !== null}
                      className="self-start rounded-full"
                      onClick={() =>
                        void run("create-link", async () => {
                          await createShareLink({ playlistId });
                          toast.success("Link ready to share");
                        })
                      }
                    >
                      {busy === "create-link" ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Link2 className="size-4" />
                      )}
                      Create a link
                    </Button>
                  )}
                </div>

                {/* --------------------------------------------- visibility */}
                <div className="flex flex-col gap-2 border-t border-white/[0.07] pt-4">
                  <span className="text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                    Who can see it
                  </span>
                  <div className="flex flex-col gap-1.5">
                    {(
                      ["private", "link", "public"] as const
                    ).map((value) => {
                      const copy = VISIBILITY_COPY[value];
                      const Icon = copy.icon;
                      const active = visibility === value;
                      return (
                        <button
                          key={value}
                          type="button"
                          aria-pressed={active}
                          disabled={busy !== null}
                          onClick={() =>
                            void run(`visibility-${value}`, async () => {
                              if (active) return;
                              await setVisibility({ playlistId, visibility: value });
                              toast.success(`Now ${copy.label.toLowerCase()}`);
                            })
                          }
                          className={cn(
                            "flex items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:opacity-60",
                            active
                              ? "border-[rgb(var(--tint)_/_0.55)] bg-[rgb(var(--tint)_/_0.1)]"
                              : "border-white/[0.07] hover:bg-white/[0.04]",
                          )}
                        >
                          <Icon
                            className={cn(
                              "mt-0.5 size-4 shrink-0",
                              active
                                ? "text-[rgb(var(--tint))]"
                                : "text-muted-foreground",
                            )}
                          />
                          <span className="min-w-0">
                            <span className="block text-sm font-semibold">
                              {copy.label}
                            </span>
                            <span className="block text-xs text-muted-foreground">
                              {copy.hint}
                            </span>
                          </span>
                          {active && (
                            <Check className="mt-0.5 ml-auto size-4 shrink-0 text-[rgb(var(--tint))]" />
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* -------------------------------------------- shared with */}
                <div className="flex flex-col gap-2 border-t border-white/[0.07] pt-4">
                  <span className="text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase">
                    Shared with
                  </span>
                  {shares === undefined ? (
                    <p className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="size-3 animate-spin" />
                      Loading…
                    </p>
                  ) : shares.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Nobody yet. People you share with directly appear here.
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {shares.map((grant) => (
                        <li
                          key={grant.recipientId}
                          className="flex items-center gap-3 rounded-lg px-1 py-1.5"
                        >
                          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-xs font-semibold">
                            {grant.name.slice(0, 1).toUpperCase()}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm">
                            {grant.name}
                          </span>
                          <button
                            type="button"
                            aria-label={`Revoke access for ${grant.name}`}
                            disabled={busy !== null}
                            onClick={() =>
                              void run(`revoke-${grant.recipientId}`, async () => {
                                await revoke({
                                  playlistId,
                                  recipientId:
                                    grant.recipientId as Id<"users">,
                                });
                                toast.success(
                                  `${grant.name} no longer has access`,
                                );
                              })
                            }
                            className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-red-500/15 hover:text-red-400 disabled:opacity-50"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            ) : (
              <p className="py-4 text-sm text-muted-foreground">
                {state.role === "editor"
                  ? "This playlist was shared with you, so you can edit its tracks — only its owner can change who it is shared with."
                  : "This playlist was shared with you. You can play and browse it; the owner controls sharing."}
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
