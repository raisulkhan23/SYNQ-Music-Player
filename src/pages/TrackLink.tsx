import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useAction } from "convex/react";
import { Loader2, Music4, Play } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { copyText } from "@/lib/clipboard";
import { useAuth } from "@/hooks/use-auth";
import {
  isTrackId,
  trackMetaToPlayable,
  type TrackMeta,
} from "@/lib/shareLink";
import { usePlayerStore } from "@/store/player";
import { toast } from "sonner";

/**
 * Landing page for a shared track link (`/t/:id`).
 *
 * The URL carries nothing but the video id — that is all it takes to identify
 * the song — so the title, artist and artwork are resolved from the id on
 * open. Opening the link plays that song. It is deliberately a separate route
 * rather than a query string on the home page, so a link is a stable,
 * shareable address for one track, and so the player can take over from here
 * without the home page's discovery fetches running underneath it.
 */
export default function TrackLink() {
  const { trackId } = useParams();
  const navigate = useNavigate();
  const fetchMeta = useAction(api.youtube.trackMeta);
  const { isAuthenticated } = useAuth();
  const playTrack = usePlayerStore((s) => s.playTrack);
  const current = usePlayerStore((s) => s.current);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const togglePlay = usePlayerStore((s) => s.togglePlay);

  const valid = isTrackId(trackId);

  // The lookup result is tagged with the id it belongs to, so a stale answer
  // can never be rendered against a different link. Deriving every branch from
  // that (rather than storing a "not found" flag) means a bad id never needs a
  // state write to render — it just never looks anything up.
  const [resolved, setResolved] = useState<{
    id: string;
    meta: TrackMeta | null;
  } | null>(null);

  useEffect(() => {
    if (!valid || !trackId) return;
    let cancelled = false;
    void fetchMeta({ videoId: trackId })
      .then((meta) => {
        if (!cancelled) setResolved({ id: trackId, meta });
      })
      .catch(() => {
        if (!cancelled) setResolved({ id: trackId, meta: null });
      });
    return () => {
      cancelled = true;
    };
  }, [fetchMeta, trackId, valid]);

  // The answer only counts if it belongs to the id currently in the URL, so
  // navigating between two shared links can't render a stale one.
  const forThisLink = resolved && resolved.id === trackId ? resolved : null;
  const meta = forThisLink ? forThisLink.meta : null;

  // Play once the metadata is in. Keyed on the id so navigating between two
  // shared links restarts for the new one, while a re-render does not replay.
  //
  // Only for a listener who can actually hear it. A visitor has no session, so
  // firing this for them opened the deferred-auth dialog the instant the link
  // resolved — an auth prompt triggered by nothing they did, on page load,
  // which is precisely what deferred authentication is supposed to never do.
  // Guests get the track details and an explicit Play button instead, and the
  // dialog appears only when they press it.
  useEffect(() => {
    if (!meta) return;
    if (!isAuthenticated) return;
    playTrack(trackMetaToPlayable(meta));
  }, [meta, playTrack, isAuthenticated]);

  // A malformed id (truncated by a chat app, or not an id at all) never gets
  // as far as a lookup; a well-formed one that resolves to nothing is a
  // private or removed video. Both are the same dead end to the visitor.
  if (!valid || (forThisLink !== null && meta === null)) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background px-6 text-center text-foreground">
        <Music4 className="size-8 text-muted-foreground/40" />
        <p className="font-display text-lg font-semibold">
          We couldn&apos;t find that song
        </p>
        <p className="max-w-sm text-sm text-muted-foreground">
          This link doesn&apos;t point at a track we can play. It may have been
          copied incompletely, or the video may be private.
        </p>
        <Link
          to="/search"
          className="mt-2 rounded-full bg-[rgb(var(--tint))] px-5 py-2.5 text-sm font-semibold text-black"
        >
          Search SYNQ
        </Link>
      </div>
    );
  }

  // Still resolving. Rendering the "found" layout first would flash a blank
  // title and a broken image for as long as the lookup takes.
  if (!meta) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background px-6 text-center text-foreground">
        <Loader2 className="size-8 animate-spin text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">Loading track…</p>
      </div>
    );
  }

  // Browsers block autoplay until the page has been interacted with, and a
  // link opened in a fresh tab has no gesture yet. Claiming "Playing now" from
  // the track merely being LOADED would be a lie in exactly that case, so the
  // label follows the real playback state and a play button appears instead.
  const isCurrent = current?.id === meta.id || current?.youtubeId === meta.id;
  const playing = isCurrent && isPlaying;

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-background px-6 text-center text-foreground">
      <div className="w-40 overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04] shadow-2xl sm:w-56">
        {meta.coverUrl ? (
          <img
            src={meta.coverUrl}
            alt=""
            className="aspect-square w-full object-cover"
          />
        ) : (
          <div className="flex aspect-square w-full items-center justify-center">
            <Music4 className="size-10 text-muted-foreground/30" />
          </div>
        )}
      </div>

      <div className="max-w-md">
        <p className="text-[10px] font-semibold tracking-[0.24em] text-[rgb(var(--tint))] uppercase">
          Shared track
        </p>
        <h1 className="mt-2 truncate font-display text-2xl font-bold tracking-tight sm:text-3xl">
          {meta.title}
        </h1>
        <p className="mt-1 truncate text-sm text-muted-foreground">
          {meta.artist}
        </p>
      </div>

      {playing ? (
        <div className="flex items-center gap-2 rounded-full bg-[rgb(var(--tint)/0.12)] px-4 py-2 text-sm font-semibold text-[rgb(var(--tint))]">
          <Play className="size-4 fill-current" />
          Playing now
        </div>
      ) : isCurrent || !isAuthenticated ? (
        <button
          type="button"
          onClick={() =>
            isCurrent ? togglePlay() : playTrack(trackMetaToPlayable(meta))
          }
          className="flex items-center gap-2 rounded-full bg-[rgb(var(--tint))] px-5 py-2.5 text-sm font-semibold text-black shadow-[0_8px_30px_rgb(var(--tint)/0.35)] transition-transform hover:scale-[1.03]"
        >
          <Play className="size-4 fill-current" />
          Play
        </button>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Starting playback…
        </p>
      )}

      <div className="flex items-center gap-2">
        <Link
          to="/home"
          className="rounded-full bg-[rgb(var(--tint))] px-5 py-2.5 text-sm font-semibold text-black shadow-[0_8px_30px_rgb(var(--tint)/0.35)] transition-transform hover:scale-[1.03]"
        >
          Open SYNQ
        </Link>
        <button
          type="button"
          onClick={() => {
            void copyText(window.location.href).then((ok) => {
              if (ok) toast.success("Link copied");
              else toast.error("Couldn't copy the link");
            });
          }}
          className="rounded-full border border-white/15 bg-white/[0.05] px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-white/[0.1]"
        >
          Copy link
        </button>
      </div>

      <button
        type="button"
        onClick={() => navigate("/search")}
        className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        Search instead
      </button>
    </div>
  );
}
