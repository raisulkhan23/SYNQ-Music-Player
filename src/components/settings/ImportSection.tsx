import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ImportServiceHint } from "@/components/settings/ImportServiceHint";
import { useAction, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { parsePlaylistImport } from "@/lib/importPlaylist";
import { canDirectImport, detectServiceUrl, nameFromUrl } from "@/lib/sources";
import { importerFor } from "@/lib/importers";
import {
  describeOutcome,
  IMPORT_ERRORS,
  ImportError,
  summarizeOutcome,
  toStoredTracks,
  type ImportErrorCode,
  type ImportFailure,
  type ImportOutcome,
} from "@/lib/importModel";
import {
  buildAuthorizeUrl,
  createPkcePair,
  readAuthCallback,
} from "@/lib/spotifyAuth";
import {
  AlertCircle,
  Check,
  Link2,
  Loader2,
  Music4,
  RotateCcw,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

/**
 * Settings section for importing playlists.
 *
 * One flow, several services, all sharing the same states and the same
 * reporting. Nothing here duplicates an importer: detection comes from
 * `lib/sources`, capability from `lib/importers`, and every service maps into
 * the one `ImportOutcome` shape from `lib/importModel` before the UI sees it.
 *
 *  - A share link. YouTube and YouTube Music answer through the public
 *    InnerTube endpoint the player already uses: no account, no key.
 *  - Spotify connects over PKCE. PKCE has no client secret, so nothing
 *    sensitive is shipped to the browser and no token is stored beyond the
 *    redirect that issues it.
 *  - An exported file always works, for every service, with no account.
 *
 * Every async path ends in exactly one of idle / working / done / failed, so
 * the panel can never be left sitting on "Loading".
 */
type Phase =
  | { kind: "idle" }
  | { kind: "working"; label: string }
  | { kind: "done"; summary: string; detail?: string }
  | { kind: "failed"; failure: ImportFailure };

/** The PKCE verifier only has to outlive one redirect. */
const PKCE_KEY = "synq.spotify.pkce";
const PKCE_PLAYLIST_KEY = "synq.spotify.playlist";

export function ImportSection({
  open,
  className = "",
}: {
  open: boolean;
  className?: string;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [link, setLink] = useState("");
  const [lastImported, setLastImported] = useState<string | null>(null);
  const saveImported = useMutation(api.playlists.saveImported);
  const fetchYouTubePlaylist = useAction(api.youtube.importPlaylistById);
  const importSpotify = useAction(api.spotify.importPlaylist);
  const exchangeSpotifyCode = useAction(api.spotify.exchangeCode);
  const importAppleMusic = useAction(api.appleMusic.importPlaylist);
  const importTidal = useAction(api.tidal.importPlaylist);

  // Re-detect on every keystroke: cheap, and it means the badge never
  // describes a link the user has already edited.
  const detected = useMemo(
    () => (link.trim() ? detectServiceUrl(link) : null),
    [link],
  );
  const capabilities = detected ? importerFor(detected.service) : null;
  const canImport = !!detected && canDirectImport(detected);
  const busy = phase.kind === "working";

  /**
   * Turn anything thrown by an action into a failure the panel can render.
   *
   * Convex wraps handler errors, so the code is dug back out of the message
   * rather than being lost and replaced with a generic "something went wrong".
   */
  const toFailure = useCallback((error: unknown): ImportFailure => {
    if (error instanceof ImportError) {
      return {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.hint ? { hint: error.hint } : {}),
      };
    }
    const raw = error instanceof Error ? error.message : String(error ?? "");
    const codes = Object.keys(IMPORT_ERRORS) as ImportErrorCode[];
    const found = codes.find((code) => raw.includes(code));
    if (found) {
      return {
        code: found,
        message: IMPORT_ERRORS[found].message,
        retryable: IMPORT_ERRORS[found].retryable,
        ...(IMPORT_ERRORS[found].hint
          ? { hint: IMPORT_ERRORS[found].hint }
          : {}),
      };
    }
    return {
      code: "unknown",
      message: raw || IMPORT_ERRORS.unknown.message,
      retryable: IMPORT_ERRORS.unknown.retryable,
    };
  }, []);

  /** Save whatever an importer produced — one place, for every service. */
  const persist = useCallback(
    async (outcome: ImportOutcome, fallbackName: string) => {
      const verdict = describeOutcome(outcome);
      if (!verdict.ok) throw new ImportError(verdict.failure.code);
      const name = outcome.name || fallbackName;
      await saveImported({
        name,
        origin: outcome.origin,
        tracks: toStoredTracks(verdict.outcome.tracks),
      });
      const summary = summarizeOutcome(verdict.outcome);
      setLastImported(`${name} · ${summary}`);
      setPhase({
        kind: "done",
        summary,
        ...(verdict.outcome.warnings.length
          ? { detail: verdict.outcome.warnings.join(" ") }
          : {}),
      });
      // The toast has to say WHERE it went. A green confirmation with no
      // destination is exactly what made this feel broken: the import reported
      // success and the listener went looking for it in their library and found
      // nothing, with no way to tell whether the save or the search was at
      // fault. "Added to Your library" is both true and a direction.
      toast.success(`${name} — ${summary}`, {
        description: "Added to Your library.",
      });
    },
    [saveImported],
  );

  const handleFile = useCallback(
    async (file: File) => {
      if (busy) return;
      setPhase({ kind: "working", label: "Reading file…" });
      try {
        const text = await file.text();
        const fallbackName = file.name.replace(/\.(csv|txt|tsv)$/i, "");
        const parsed = parsePlaylistImport(text, fallbackName);
        if (!parsed) {
          setPhase({
            kind: "failed",
            failure: {
              code: "empty",
              message: "Couldn't find any songs in that file.",
              retryable: false,
              hint: "Export your playlist as CSV or a plain text list and try again.",
            },
          });
          return;
        }
        await persist(
          {
            name: parsed.name,
            origin: parsed.origin,
            tracks: parsed.tracks.map((track) => ({
              title: track.title,
              artist: track.artist,
              ...(track.duration !== undefined
                ? { duration: track.duration }
                : {}),
              source: "unknown" as const,
            })),
            skipped: 0,
            partial: false,
            warnings: [],
          },
          parsed.name,
        );
      } catch (error) {
        setPhase({ kind: "failed", failure: toFailure(error) });
      } finally {
        if (fileInput.current) fileInput.current.value = "";
      }
    },
    [busy, persist, toFailure],
  );

  /** Kick off the Spotify PKCE redirect. */
  const startSpotifyImport = useCallback(async (playlistId: string) => {
    const clientId = import.meta.env.VITE_SPOTIFY_CLIENT_ID as
      | string
      | undefined;
    if (!clientId) throw new ImportError("not-configured");

    const { verifier, challenge } = await createPkcePair();
    // The verifier and the target playlist have to survive the round trip.
    // Neither is a credential: the verifier is worthless without the client.
    sessionStorage.setItem(PKCE_KEY, verifier);
    sessionStorage.setItem(PKCE_PLAYLIST_KEY, playlistId);

    // Back to this same page, which completes the exchange in the effect
    // below. No extra route and no intermediate screen to get lost on.
    const redirectUri = `${window.location.origin}/settings`;
    window.location.assign(
      buildAuthorizeUrl({ clientId, redirectUri, challenge, verifier }),
    );
  }, []);

  const handleLink = useCallback(async () => {
    if (busy || !detected) return;
    const url = link.trim();
    const name = nameFromUrl(url);
    try {
      if (!canImport || !detected.id) {
        setPhase({
          kind: "failed",
          failure: {
            code: "unsupported",
            message:
              detected.kind === "track"
                ? `That's a single ${capabilities?.label} track, not a playlist.`
                : `${capabilities?.label ?? "That service"} can't be imported from a link yet.`,
            retryable: false,
            hint: "Export the playlist as CSV or a plain text list and drop it below — every service supports that.",
          },
        });
        return;
      }

      if (detected.service === "spotify") {
        setPhase({ kind: "working", label: "Connecting to Spotify…" });
        await startSpotifyImport(detected.id);
        return;
      }

      if (detected.service === "tidal") {
        setPhase({ kind: "working", label: "Reading Tidal…" });
        const outcome = await importTidal({ playlistId: detected.id });
        await persist(outcome, name ?? "Tidal playlist");
        return;
      }

      if (detected.service === "apple-music") {
        setPhase({ kind: "working", label: "Reading Apple Music…" });
        const outcome = await importAppleMusic({
          playlistId: detected.id,
          storefront: extractStorefront(url) ?? "us",
        });
        await persist(outcome, name ?? "Apple Music playlist");
        return;
      }

      // YouTube / YouTube Music — the existing InnerTube path, unchanged.
      setPhase({ kind: "working", label: "Reading playlist…" });
      const result = await fetchYouTubePlaylist({ playlistId: detected.id });
      const service =
        detected.service === "youtube-music"
          ? ("youtube-music" as const)
          : ("youtube" as const);
      // Every importer goes through the same `toStoredTracks` projection, so
      // artwork cannot be dropped here even if this branch is the one that
      // forgets it next time.
      await persist(
        {
          name: result.name,
          origin: result.origin,
          tracks: result.tracks.map((track) => ({
            title: track.title,
            artist: track.artist,
            ...(track.duration !== undefined
              ? { duration: track.duration }
              : {}),
            source: service,
          })),
          skipped: 0,
          partial: result.partial,
          warnings: [],
        },
        name ?? result.name,
      );
    } catch (error) {
      setPhase({ kind: "failed", failure: toFailure(error) });
    }
  }, [
    busy,
    canImport,
    capabilities,
    detected,
    fetchYouTubePlaylist,
    importAppleMusic,
    importTidal,
    link,
    persist,
    startSpotifyImport,
    toFailure,
  ]);

  // Completes the Spotify redirect on return. Runs only when a code is
  // actually present, so opening Settings normally costs nothing.
  useEffect(() => {
    if (!open) return;
    const callback = readAuthCallback(window.location.href);
    if (!callback.ok) return;
    const verifier = sessionStorage.getItem(PKCE_KEY);
    const playlistId = sessionStorage.getItem(PKCE_PLAYLIST_KEY);
    // Clear before doing anything: a refresh must not replay the exchange.
    sessionStorage.removeItem(PKCE_KEY);
    sessionStorage.removeItem(PKCE_PLAYLIST_KEY);

    let cancelled = false;
    const finish = async () => {
      if (!verifier || !playlistId) {
        setPhase({ kind: "failed", failure: IMPORT_ERRORS["auth-expired"] });
        return;
      }
      setPhase({ kind: "working", label: "Finishing Spotify sign-in…" });
      try {
        const { accessToken } = await exchangeSpotifyCode({
          code: callback.code,
          verifier,
          redirectUri: `${window.location.origin}/settings`,
        });
        setPhase({ kind: "working", label: "Importing from Spotify…" });
        const outcome = await importSpotify({ playlistId, accessToken });
        // Leave no authorisation code sitting in the address bar.
        window.history.replaceState(null, "", "/settings");
        if (!cancelled) await persist(outcome, "Spotify playlist");
      } catch (error) {
        if (!cancelled) {
          setPhase({ kind: "failed", failure: toFailure(error) });
        }
      }
    };
    void finish();
    return () => {
      cancelled = true;
    };
  }, [exchangeSpotifyCode, importSpotify, open, persist, toFailure]);

  const reset = () => setPhase({ kind: "idle" });

  return (
    // `id="import"` is what `/import` redirects to now that importing lives in
    // Settings. Without it that redirect is a dead link: the browser jumps to
    // `/settings#import`, finds no element with that id, and silently leaves
    // the listener at the TOP of a long settings page with import far below.
    <section
      id="import"
      className={`settings-import flex flex-col gap-2.5 ${className}`}
    >
      <p className="flex items-center gap-1.5 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
        <Music4 className="size-3.5" />
        Import playlists
      </p>

      {/* Direct import from a share link */}
      <div className="rounded-xl border border-white/10 bg-white/[0.03] px-3 py-3">
        <p className="text-sm font-medium">Paste a playlist link</p>
        <p className="mx-auto mt-1 max-w-xs text-xs text-muted-foreground">
          YouTube and YouTube Music import in one click. Spotify and Apple Music
          connect your account. Everything else works with an exported file.
        </p>

        {/* Detection badge + the "importable but not playable" note. Both live
            in their own component so the note can be rendered and tested on
            its own — it is the only place the app states that a service's API
            keys are not a streaming licence. */}
        {detected && capabilities ? (
          <ImportServiceHint
            detected={detected}
            capabilities={capabilities}
            canImport={canImport}
          />
        ) : null}

        <div className="mt-2.5 flex items-center gap-2">
          <div className="relative flex-1">
            <Link2 className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="url"
              inputMode="url"
              value={link}
              onChange={(e) => {
                setLink(e.target.value);
                if (phase.kind === "done" || phase.kind === "failed") reset();
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleLink();
              }}
              placeholder="https://open.spotify.com/playlist/…"
              aria-label="Playlist link"
              disabled={busy || !open}
              className="w-full rounded-full border border-white/10 bg-black/25 py-2 pr-3 pl-8 text-sm outline-none placeholder:text-muted-foreground focus:border-[rgb(var(--tint))] disabled:opacity-50"
            />
          </div>
          <button
            type="button"
            onClick={() => void handleLink()}
            disabled={busy || !open || !link.trim()}
            className="flex shrink-0 items-center gap-2 rounded-full bg-[rgb(var(--tint))] px-4 py-2 text-sm font-semibold text-black transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Link2 className="size-4" />
            )}
            {busy ? "Importing…" : "Import"}
          </button>
        </div>

        <StatusLine phase={phase} onRetry={() => void handleLink()} />
      </div>

      {/* File import */}
      <div className="rounded-xl border border-dashed border-white/15 bg-white/[0.03] px-3 py-4 text-center">
        <p className="text-sm font-medium">Or bring a file</p>
        <p className="mx-auto mt-1 max-w-xs text-xs text-muted-foreground">
          Export a playlist (or your liked songs) from another music service as
          a CSV or text file, then drop it here. It shows up in your Library.
        </p>
        <input
          ref={fileInput}
          type="file"
          accept=".csv,.txt,.tsv,text/csv,text/plain"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
        />
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          disabled={busy || !open}
          className="mx-auto mt-3 flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-4 py-2 text-sm font-semibold transition-colors hover:bg-white/[0.1] disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Upload className="size-4" />
          )}
          {busy ? "Importing…" : "Choose a file"}
        </button>
        <details className="mt-3 text-left">
          <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground hover:text-foreground">
            How do I export my playlists?
          </summary>
          <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[11px] text-muted-foreground">
            <li>
              <span className="font-medium text-foreground/80">
                YouTube / YouTube Music:
              </span>{" "}
              just paste the link above — no export needed.
            </li>
            <li>
              <span className="font-medium text-foreground/80">Spotify:</span>{" "}
              paste the link above and connect your account, or export to CSV.
            </li>
            <li>
              <span className="font-medium text-foreground/80">
                Apple Music:
              </span>{" "}
              paste the link above, or export to CSV.
            </li>
            <li>
              Any text list of songs also works — one "Artist - Title" per line.
            </li>
          </ul>
        </details>
        {lastImported && (
          <p className="mt-2 text-[11px] text-[rgb(var(--tint))]">
            Last import: {lastImported}
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * The one place the panel's state is shown.
 *
 * Every branch is terminal one way or the other — there is no state from which
 * the panel can fall back to an endless spinner, and a failure always offers
 * the way out of it.
 */
function StatusLine({ phase, onRetry }: { phase: Phase; onRetry: () => void }) {
  if (phase.kind === "idle") return null;
  if (phase.kind === "working") {
    return (
      <p className="mt-2.5 flex items-center gap-2 text-[11px] text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        {phase.label}
      </p>
    );
  }
  if (phase.kind === "done") {
    return (
      <p className="mt-2.5 flex items-center gap-2 text-[11px] text-[rgb(var(--tint))]">
        <Check className="size-3.5 shrink-0" />
        <span className="min-w-0">
          {phase.summary}
          {phase.detail ? (
            <span className="block text-muted-foreground">{phase.detail}</span>
          ) : null}
        </span>
      </p>
    );
  }
  return (
    <div className="mt-2.5 flex items-start gap-2 rounded-lg border border-red-400/25 bg-red-400/[0.06] px-2.5 py-2 text-[11px]">
      <AlertCircle className="mt-px size-3.5 shrink-0 text-red-300" />
      <span className="min-w-0 flex-1">
        <span className="block font-medium text-red-200">
          {phase.failure.message}
        </span>
        {phase.failure.hint ? (
          <span className="block text-muted-foreground">
            {phase.failure.hint}
          </span>
        ) : null}
      </span>
      {phase.failure.retryable ? (
        <button
          type="button"
          onClick={onRetry}
          className="flex shrink-0 items-center gap-1 rounded-full border border-white/15 px-2 py-1 font-semibold text-foreground transition-colors hover:bg-white/[0.08]"
        >
          <RotateCcw className="size-3" />
          Retry
        </button>
      ) : null}
    </div>
  );
}

/** Apple Music bakes the storefront into the path: /us/playlist/… */
function extractStorefront(url: string): string | null {
  try {
    const match = new URL(url).pathname.match(/^\/([a-z]{2})\//i);
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}
