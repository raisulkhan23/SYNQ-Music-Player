import { useAction } from "convex/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { api } from "@/convex/_generated/api";
import type { BrowseRelease, BrowseTrack } from "@/lib/musicBrowse";

/**
 * The artist catalogue, loaded in the only order that is both honest and fast.
 *
 *   1. resolve   — display name → stable `UC…` artist id
 *   2. releases  — the artist's full release grid (albums, singles, EPs, live)
 *   3. tracks    — each release's tracklist, hydrated a few at a time
 *
 * Why progressive: an artist like Taylor Swift has ~100 releases. Reading all
 * of them before showing anything would make the page look broken for a minute.
 * The discography appears as soon as step 2 lands, and `All songs` grows as
 * tracklists arrive — with a visible count of what has actually been read, so a
 * partial list is never presented as the complete catalogue.
 *
 * Every stage is tagged with the artist it belongs to and cancelled on unmount
 * or navigation, so a slow response can never paint the previous artist's
 * records under a new name.
 */

/** How many release tracklists are read at once. */
export const TRACKLIST_CONCURRENCY = 3;

/**
 * Release tracklists hydrated per batch (first render and each load-more).
 *
 * 24 covers a normal artist in one go and takes a large one (Taylor Swift has
 * ~100 releases) to a handful of clicks rather than a dozen.
 */
export const TRACKLIST_BATCH = 24;

export interface CatalogIdentity {
  artistId: string;
  name: string;
  exact: boolean;
  thumbnail?: string;
  description?: string;
  audience?: string;
}

export interface CatalogRelease extends BrowseRelease {
  /** Undefined until this release's tracklist has been read. */
  tracks?: BrowseTrack[];
  /** True when the provider refused or the read failed. */
  failed?: boolean;
}

export interface ArtistCatalogState {
  /** `undefined` while the identity lookup is in flight, `null` if unresolved. */
  identity: CatalogIdentity | null | undefined;
  releases: CatalogRelease[];
  /** Provider says the release list ended. */
  complete: boolean;
  /** We stopped early with the provider still offering more. */
  truncated: boolean;
  loadingReleases: boolean;
  /** Releases whose tracklist has settled (read or failed). */
  hydrated: number;
  /** True while a tracklist batch is in flight. */
  loadingTracks: boolean;
  /** Flat, deduplicated list from every release already read. */
  tracks: Array<{ track: BrowseTrack; release: CatalogRelease }>;
  /** Read the next batch of release tracklists. */
  loadMore: () => void;
  /** True while some release still has no tracklist. */
  hasMoreTracks: boolean;
}

type FetchTracks = (args: {
  releaseId: string;
  cursor?: string;
}) => Promise<{ tracks: BrowseTrack[]; nextCursor: string | null }>;

/**
 * One release's tracklist, following continuation tokens until it ends.
 * Exported so the album page can read exactly one release without hydrating a
 * whole artist's catalogue first.
 */
export async function readTracklist(
  fetchPage: FetchTracks,
  releaseId: string,
  isCancelled: () => boolean,
): Promise<BrowseTrack[]> {
  const all: BrowseTrack[] = [];
  let cursor: string | undefined;
  // Bounded: a malformed cursor that never advances would otherwise loop
  // forever. Four pages is far beyond any real album.
  for (let page = 0; page < 4; page++) {
    if (isCancelled()) return all;
    const result = await fetchPage({
      releaseId,
      ...(cursor ? { cursor } : {}),
    });
    all.push(...result.tracks);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  const seen = new Set<string>();
  return all.filter((track) => {
    if (!track.videoId || seen.has(track.videoId)) return false;
    seen.add(track.videoId);
    return true;
  });
}

/** Albums first: they carry most of a catalogue and are what listeners open. */
const KIND_PRIORITY: Record<string, number> = {
  album: 0,
  ep: 1,
  single: 2,
  live: 3,
  soundtrack: 4,
  compilation: 5,
  other: 6,
};

export function useArtistCatalog(artistName: string): ArtistCatalogState {
  const resolveArtist = useAction(api.artistCatalog.resolveArtist);
  const fetchReleases = useAction(api.artistCatalog.artistReleases);
  const fetchTracks = useAction(api.artistCatalog.releaseTracks) as unknown as FetchTracks;

  const [identity, setIdentity] = useState<CatalogIdentity | null | undefined>(
    undefined,
  );
  const [releaseState, setReleaseState] = useState<{
    releases: CatalogRelease[];
    complete: boolean;
    truncated: boolean;
  } | null>(null);
  const [loadingTracks, setLoadingTracks] = useState(false);
  const [batch, setBatch] = useState(0);
  /** Releases whose tracklist has settled, for the "N of M read" label. */
  const [hydratedCount, setHydratedCount] = useState(0);
  // Read inside async callbacks so a stale answer is dropped, never painted.
  const nameRef = useRef(artistName);
  useEffect(() => {
    nameRef.current = artistName;
  }, [artistName]);

  // Memoised so its identity only moves when a new release state lands:
  // `?? []` in place would allocate a fresh array on every render and make
  // every consumer of it a dependency that churns.
  const releases = useMemo(
    () => releaseState?.releases ?? [],
    [releaseState],
  );
  // A stable identity for "which releases exist", so progress inside a batch
  // (tracklists arriving) does not retrigger the hydration effect and quietly
  // hydrate everything without a click.
  const releaseSetKey = useMemo(
    () => releases.map((release) => release.id).join("|"),
    [releases],
  );
  const releasesRef = useRef(releases);
  useEffect(() => {
    releasesRef.current = releases;
  }, [releases]);

  // ── 1. identity ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!artistName) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- an empty route has nothing to resolve, so this reports "unresolved" rather than leaving the previous artist's identity under a blank name
      setIdentity(null);
      return;
    }
    let cancelled = false;
    setIdentity(undefined);
    setReleaseState(null);
    setBatch(0);
    setHydratedCount(0);
    void (async () => {
      try {
        const result = await resolveArtist({ name: artistName });
        if (cancelled || nameRef.current !== artistName) return;
        setIdentity(result?.found ? (result as CatalogIdentity) : null);
      } catch {
        if (cancelled || nameRef.current !== artistName) return;
        setIdentity(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [artistName, resolveArtist]);

  // ── 2. releases ───────────────────────────────────────────────────────────
  const artistId = identity?.artistId;
  useEffect(() => {
    if (!artistId) return;
    let cancelled = false;
    void (async () => {
      // Yield once before announcing work: the flags below are a *reaction* to
      // the request, and setting them synchronously in an effect body cascades
      // a second render before any network work has happened.
      await Promise.resolve();
      if (cancelled) return;
      try {
        const result = await fetchReleases({ artistId });
        if (cancelled || nameRef.current !== artistName) return;
        setReleaseState({
          releases: (result?.releases ?? []) as CatalogRelease[],
          complete: Boolean(result?.complete),
          truncated: Boolean(result?.truncated),
        });
      } catch {
        if (cancelled || nameRef.current !== artistName) return;
        setReleaseState({ releases: [], complete: false, truncated: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [artistName, fetchReleases, artistId]);

  // ── 3. tracklists, one batch at a time, bounded concurrency ───────────────
  useEffect(() => {
    if (!releaseSetKey) return;
    let cancelled = false;

    void (async () => {
      const pending = [...releasesRef.current]
        .sort((a, b) => (KIND_PRIORITY[a.kind] ?? 9) - (KIND_PRIORITY[b.kind] ?? 9))
        // Failed reads are included so a load-more RETRIES them: a throttled
        // request must never leave a release permanently missing from the
        // catalogue.
        .filter((release) => release.tracks === undefined || release.failed)
        .slice(0, TRACKLIST_BATCH);
      if (pending.length === 0) return;

      await Promise.resolve();
      if (cancelled) return;
      setLoadingTracks(true);
      let cursor = 0;

      const mark = (id: string, patch: Partial<CatalogRelease>) => {
        setReleaseState((prev) => {
          if (!prev) return prev;
          let found = false;
          const next = prev.releases.map((release) => {
            if (release.id !== id) return release;
            found = true;
            return { ...release, ...patch };
          });
          return found ? { ...prev, releases: next } : prev;
        });
      };

      // A tiny worker pool: three at a time keeps the provider happy without
      // making a 100-release artist take a minute to become usable.
      const worker = async () => {
        for (;;) {
          if (cancelled) return;
          const release = pending[cursor++];
          if (!release) return;
          try {
            const tracks = await readTracklist(
              fetchTracks,
              release.id,
              () => cancelled,
            );
            if (cancelled) return;
            mark(release.id, { tracks });
          } catch {
            if (cancelled) return;
            mark(release.id, { failed: true });
          }
          if (cancelled) return;
          setHydratedCount((count) => count + 1);
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(TRACKLIST_CONCURRENCY, pending.length) },
          () => worker(),
        ),
      );
      if (!cancelled) setLoadingTracks(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [batch, fetchTracks, releaseSetKey]);

  const loadMore = useCallback(() => setBatch((value) => value + 1), []);

  const allTracks = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ track: BrowseTrack; release: CatalogRelease }> = [];
    for (const release of releases) {
      for (const track of release.tracks ?? []) {
        if (!track.videoId || seen.has(track.videoId)) continue;
        seen.add(track.videoId);
        out.push({ track, release });
      }
    }
    return out;
  }, [releases]);

  // A failed release is still unread, so the control stays available to retry
  // it rather than pretending the catalogue is complete.
  const hasMoreTracks = releases.some(
    (release) => release.tracks === undefined || release.failed,
  );

  return {
    identity,
    releases,
    complete: releaseState?.complete ?? false,
    truncated: releaseState?.truncated ?? false,
    // Derived, not stored: "waiting for releases" is a fact about the two
    // states we already have, and storing it would mean a third update per
    // navigation for something that cannot disagree with them.
    loadingReleases: Boolean(artistId) && releaseState === null,
    loadingTracks,
    hydrated: hydratedCount,
    tracks: allTracks,
    loadMore,
    hasMoreTracks,
  };
}
