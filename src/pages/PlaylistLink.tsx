import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { ListMusic, Loader2, Music2, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAuthGate } from "@/store/authGate";
import { formatTime } from "@/lib/format";

/**
 * The page a share link opens, for anyone — including a signed-out visitor.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not hand over playable ids, and
 * that is a design decision rather than an omission. A link can be forwarded to
 * anyone, so the URL is the whole of the authorisation; if this page returned
 * stream ids, "sign in to keep this" would be a formality and the playlist would
 * effectively be public the moment one link leaked. The server enforces the same
 * thing (`playlistByToken` returns no playback id), so this is a description of
 * the guarantee rather than the guarantee itself.
 *
 * A signed-out visitor therefore sees the honest preview — real titles, artists
 * and lengths — and is invited to sign in when they want to play it.
 */
export default function PlaylistLink() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const preview = useQuery(
    api.playlistSharing.playlistByToken,
    token ? { token } : "skip",
  );
  const addToLibrary = useMutation(api.playlistSharing.addLinkToLibrary);
  const [saving, setSaving] = useState(false);

  if (preview === undefined) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-12">
        <div className="h-40 w-40 animate-pulse rounded-2xl bg-white/[0.05]" />
        <div className="h-8 w-64 animate-pulse rounded bg-white/[0.05]" />
        <div className="h-4 w-40 animate-pulse rounded bg-white/[0.05]" />
      </div>
    );
  }

  /**
   * Covers the three ways a link can stop working — revoked, turned private, or
   * the playlist deleted — with one message. Telling them apart would confirm
   * whether a guessed token maps to a real playlist, so they are intentionally
   * indistinguishable to a visitor.
   */
  if (preview === null) {
    return (
      <div className="mx-auto flex w-full max-w-md flex-col items-center gap-4 px-4 py-24 text-center">
        <ListMusic className="size-10 text-muted-foreground/40" />
        <div>
          <h1 className="font-display text-xl font-bold">
            This link is no longer active
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The owner may have turned sharing off, or replaced the link.
          </p>
        </div>
        <Link
          to="/home"
          className="mt-1 rounded-full bg-[rgb(var(--tint))] px-5 py-2.5 text-sm font-semibold text-black"
        >
          Explore SYNQ
        </Link>
      </div>
    );
  }

  const handleAdd = async () => {
    if (!token || saving) return;
    // Adding a playlist to a library needs an owner, so a guest is asked for an
    // account here rather than being sent away and losing the link.
    if (!useAuthGate.getState().request("library", null)) return;
    setSaving(true);
    try {
      const id = await addToLibrary({ token });
      toast.success(`Added “${preview.name}” to your library`);
      navigate(`/playlist/${id as Id<"playlists">}`);
    } catch (error) {
      const message =
        error instanceof Error && error.message
          ? error.message.replace(/^\[.*?\]\s*/, "")
          : "Could not add this playlist";
      toast.error("That didn't work", { description: message });
    } finally {
      setSaving(false);
    }
  };

  const playableCount = preview.tracks.filter(
    (track) => track.status === "playable",
  ).length;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-10">
      <header className="flex flex-col gap-5 sm:flex-row sm:items-end">
        <PlaylistMosaic
          urls={preview.tracks.map((track) => track.coverUrl)}
        />
        <div className="min-w-0">
          <p className="text-[11px] font-semibold tracking-[0.2em] text-muted-foreground uppercase">
            Shared playlist
          </p>
          <h1 className="mt-1 truncate font-display text-3xl font-bold tracking-tight sm:text-4xl">
            {preview.name}
          </h1>
          {preview.description && (
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              {preview.description}
            </p>
          )}
          <p className="mt-2 text-sm text-muted-foreground">
            By {preview.ownerName} · {preview.trackCount}{" "}
            {preview.trackCount === 1 ? "song" : "songs"}
            {/* Only claimed when it is genuinely known. An import that has never
                been resolved shows the count, not a fabricated "0 playable". */}
            {playableCount > 0 && ` · ${playableCount} playable here`}
          </p>
          <div className="mt-4">
            <Button
              type="button"
              disabled={saving}
              onClick={() => void handleAdd()}
              className="rounded-full"
            >
              {saving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              Add to my library
            </Button>
          </div>
        </div>
      </header>

      <section className="flex flex-col gap-0.5">
        {preview.tracks.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            This playlist has no tracks in it yet.
          </p>
        ) : (
          preview.tracks.map((track, index) => (
            <div
              key={`${track.id}-${index}`}
              className="flex items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-white/[0.04]"
            >
              <span className="w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                {index + 1}
              </span>
              {track.coverUrl ? (
                <img
                  src={track.coverUrl}
                  alt=""
                  width={40}
                  height={40}
                  loading="lazy"
                  className="size-10 shrink-0 rounded-lg object-cover ring-1 ring-white/10"
                />
              ) : (
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-white/[0.06] ring-1 ring-white/10">
                  <Music2 className="size-4 text-muted-foreground/60" />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {track.title || "Untitled"}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {track.artist || "Unknown artist"}
                </span>
              </span>
              {/* A length that is unknown shows nothing. The old screen printed
                  `0:00`, which asserts a duration of zero for a song nobody
                  measured. */}
              {track.duration > 0 && (
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {formatTime(track.duration)}
                </span>
              )}
            </div>
          ))
        )}
      </section>

      {preview.truncated && (
        <p className="text-center text-xs text-muted-foreground">
          Showing the first {preview.tracks.length} of {preview.trackCount}{" "}
          songs. Add it to your library to see all of them.
        </p>
      )}

      <p className="text-center text-xs text-muted-foreground">
        The owner keeps editing this playlist — what you add is a copy of it as
        it is now.
      </p>
    </div>
  );
}

/** Same mosaic idea as a playlist detail hero: real covers, honest fallback. */
function PlaylistMosaic({ urls }: { urls: string[] }) {
  const tiles = Array.from(new Set(urls.filter((url) => url.trim()))).slice(0, 4);
  const frame =
    "flex size-40 shrink-0 overflow-hidden rounded-2xl bg-gradient-to-br from-white/[0.09] to-white/[0.03] shadow-2xl ring-1 ring-white/10 sm:size-48";
  if (tiles.length === 0) {
    return (
      <div className={`${frame} items-center justify-center`}>
        <ListMusic className="size-10 text-muted-foreground/50" />
      </div>
    );
  }
  if (tiles.length === 1) {
    return (
      <div className={frame}>
        <img
          src={tiles[0]}
          alt=""
          className="size-full object-cover"
          loading="lazy"
        />
      </div>
    );
  }
  return (
    <div className={`${frame} grid grid-cols-2 grid-rows-2 gap-px bg-white/10`}>
      {Array.from({ length: 4 }, (_, index) => tiles[index % tiles.length]).map(
        (url, index) => (
          <img
            key={`${url}-${index}`}
            src={url}
            alt=""
            className="size-full object-cover"
            loading="lazy"
          />
        ),
      )}
    </div>
  );
}
