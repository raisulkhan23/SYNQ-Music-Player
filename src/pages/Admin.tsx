import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { downloadCsv, toCsv } from "@/lib/csvExport";
import { VisitAnalytics } from "@/components/admin/VisitAnalytics";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  BarChart3,
  Clock3,
  Eye,
  Heart,
  ListMusic,
  Loader2,
  Pencil,
  Radio,
  Shield,
  ShieldCheck,
  Sparkles,
  TrendingUp,
  Users,
} from "lucide-react";
import { toast } from "sonner";

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Sign-in methods Convex Auth records for an account. These are the normalized
 * `authAccounts.provider` ids (see `normalizeAuthProvider` in
 * `src/convex/admin.ts`) surfaced as `providers` on each accounts-table row.
 */
const SIGN_IN_METHODS = [
  { id: "github", label: "GitHub" },
  { id: "google", label: "Google" },
  { id: "email-otp", label: "Email" },
  { id: "anonymous", label: "Guest" },
] as const;

type SignInMethod = (typeof SIGN_IN_METHODS)[number]["id"];

const KNOWN_SIGN_IN_METHODS = new Set<string>(SIGN_IN_METHODS.map((m) => m.id));

/** Bucket for providers the filter doesn't name (password, phone, custom…). */
const OTHER_SIGN_IN_METHOD = "other";
type UserMethodFilter = "all" | SignInMethod | typeof OTHER_SIGN_IN_METHOD;

/** Does this account match the chosen sign-in filter? */
function userMatchesMethod(
  providers: string[] | undefined,
  method: UserMethodFilter,
): boolean {
  if (method === "all") return true;
  const list = providers ?? [];
  if (method === OTHER_SIGN_IN_METHOD) {
    return list.some((p) => !KNOWN_SIGN_IN_METHODS.has(p));
  }
  return list.includes(method);
}

function ResultGroup({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-4">
      <p className="flex items-center justify-between text-xs font-semibold tracking-widest text-muted-foreground uppercase">
        {title}
        <span className="tabular-nums">{count}</span>
      </p>
      <div className="mt-2 flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

function ResultRow({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-white/[0.05]">
      <span className="min-w-0 truncate font-medium">{title}</span>
      <span className="shrink-0 truncate text-xs text-muted-foreground">
        {detail}
      </span>
    </div>
  );
}

/** Two-step destructive action: first click arms, second click confirms. */
/**
 * Shape of `api.admin.playlistDetail`, declared structurally so the component
 * stays a plain function rather than a generic one.
 */
type PlaylistDetail = {
  name: string;
  description: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  knownTracks: number;
  tracks: {
    trackId: string;
    title: string | null;
    artist: string | null;
    album: string | null;
    duration: number | null;
    known: boolean;
  }[];
};

function formatTrackDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
    return "--:--";
  }
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Read-only view of one playlist's contents, for an admin.
 *
 * Deliberately NOT a player: it does not resolve streams and does not call
 * `playIndex`. An admin inspecting a playlist is reading it to judge it — for
 * a report, a copyright claim, a moderation decision — and pressing play would
 * write to the listener's own history and queue, which is both a side effect
 * they did not ask for and a way to disturb whatever they were listening to.
 */
function PlaylistInspector({
  detail,
  onClose,
}: {
  detail: undefined | PlaylistDetail;
  onClose: () => void;
}) {
  if (detail === undefined) return null;
  const unknown = detail.tracks.length - detail.knownTracks;

  return (
    <div className="rounded-2xl border border-[rgb(var(--tint)_/_0.35)] bg-white/[0.03] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <ListMusic className="size-4 text-[rgb(var(--tint))]" />
            {detail.name}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {detail.ownerName ?? detail.ownerEmail ?? "Unknown owner"} ·{" "}
            {detail.tracks.length}{" "}
            {detail.tracks.length === 1 ? "track" : "tracks"}
            {unknown > 0 ? (
              // Say so rather than quietly rendering a shorter list: "this
              // playlist has 40 tracks and we can only identify 32" is the
              // honest answer, and it is often the interesting part.
              <span className="text-amber-400/90">
                {" "}
                · {unknown} without saved details
              </span>
            ) : null}
          </p>
          {detail.description ? (
            <p className="mt-2 max-w-prose text-xs text-muted-foreground">
              {detail.description}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="shrink-0 rounded-full border border-white/10 px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
        >
          Close
        </button>
      </div>

      <div className="mt-4 max-h-[26rem] overflow-y-auto rounded-xl border border-white/[0.07]">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-[#0b0b12] text-[11px] tracking-widest text-muted-foreground uppercase">
            <tr className="border-b border-white/[0.07]">
              <th className="w-10 px-3 py-2 text-right font-semibold">#</th>
              <th className="px-3 py-2 font-semibold">Title</th>
              <th className="px-3 py-2 font-semibold">Artist</th>
              <th className="hidden px-3 py-2 font-semibold sm:table-cell">
                Album
              </th>
              <th className="px-3 py-2 text-right font-semibold">Length</th>
            </tr>
          </thead>
          <tbody>
            {detail.tracks.map((track, i) => (
              <tr
                key={`${track.trackId}-${i}`}
                className="border-b border-white/[0.04] last:border-0"
              >
                <td className="px-3 py-2 text-right text-xs tabular-nums text-muted-foreground">
                  {i + 1}
                </td>
                <td className="px-3 py-2">
                  {track.title ?? (
                    <span
                      className="font-mono text-xs text-muted-foreground/70"
                      title="This playlist entry has no saved title"
                    >
                      {track.trackId} · details not saved
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-muted-foreground">
                  {track.artist ?? "--"}
                </td>
                <td className="hidden px-3 py-2 text-muted-foreground sm:table-cell">
                  {track.album ?? "--"}
                </td>
                <td className="px-3 py-2 text-right text-xs tabular-nums text-muted-foreground">
                  {formatTrackDuration(track.duration)}
                </td>
              </tr>
            ))}
            {detail.tracks.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-8 text-center text-sm text-muted-foreground"
                >
                  This playlist is empty.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ConfirmButton({
  label,
  confirmLabel = "Confirm?",
  onConfirm,
  className,
}: {
  label: string;
  confirmLabel?: string;
  onConfirm: () => void;
  className?: string;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);

  return (
    <button
      type="button"
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
        }
      }}
      className={
        armed
          ? "rounded-full bg-red-500/90 px-3 py-1.5 text-xs font-semibold text-white transition-colors"
          : `rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-red-500/40 hover:text-red-400 ${className ?? ""}`
      }
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

export default function Admin() {
  const status = useQuery(api.admin.status);
  const users = useQuery(api.admin.listUsers);
  const playlists = useQuery(api.admin.listAllPlaylists);
  const allLikes = useQuery(api.admin.listAllLikes);
  const topTracks = useQuery(api.admin.globalTopTracks);
  const activity = useQuery(api.admin.userActivity);
  const me = useQuery(api.users.currentUser);

  // Visit analytics. The window is state HERE rather than inside the panel so
  // the range buttons actually change what is fetched — the panel asks, this
  // refetches.
  const [visitDays, setVisitDays] = useState<7 | 14 | 30>(14);
  const visitSummary = useQuery(api.admin.visitAnalytics, { days: visitDays });

  const setRole = useMutation(api.admin.setRole);
  const deleteUser = useMutation(api.admin.deleteUser);
  const deletePlaylist = useMutation(api.admin.deletePlaylist);
  const renamePlaylist = useMutation(api.admin.renamePlaylist);
  const clearUserHistory = useMutation(api.admin.clearUserHistory);
  const deleteRoom = useMutation(api.admin.deleteRoom);
  const deleteImport = useMutation(api.admin.deleteImport);
  const fetchGithub = useAction(api.admin.githubProfile);

  const listeningStats = useQuery(api.admin.platformListeningStats, {});
  const recentSignups = useQuery(api.admin.recentSignups, {});
  const rooms = useQuery(api.admin.listRooms, {});
  const imports = useQuery(api.admin.listImports, {});

  const [renaming, setRenaming] = useState<{
    id: Id<"playlists">;
    name: string;
  } | null>(null);

  const handleRenamePlaylist = async (
    playlistId: Id<"playlists">,
    name: string,
  ) => {
    try {
      await renamePlaylist({ playlistId, name });
      toast.success("Playlist renamed");
      setRenaming(null);
    } catch {
      toast.error("Could not rename the playlist");
    }
  };

  const handleClearHistory = async (userId: Id<"users">, name: string) => {
    try {
      const n = await clearUserHistory({ userId });
      toast.success(`Cleared ${n} history rows for ${name}`);
    } catch {
      toast.error("Could not clear the history");
    }
  };

  const handleDeleteRoom = async (roomId: Id<"listeningRooms">) => {
    try {
      await deleteRoom({ roomId });
      toast.success("Listening room removed");
    } catch {
      toast.error("Could not remove the room");
    }
  };

  const handleDeleteImport = async (importId: Id<"importedPlaylists">) => {
    try {
      await deleteImport({ importId });
      toast.success("Import deleted");
    } catch {
      toast.error("Could not delete the import");
    }
  };

  const [tab, setTab] = useState("overview");
  // Table controls: instant client-side narrowing so admins don't have to page
  // through long lists, and so they work without extra round trips on mobile.
  const [userQuery, setUserQuery] = useState("");
  const [userRole, setUserRole] = useState<"all" | "admin" | "user">("all");
  const [userMethod, setUserMethod] = useState<UserMethodFilter>("all");
  const [userSort, setUserSort] = useState<"newest" | "oldest" | "name">(
    "newest",
  );
  const [playlistQuery, setPlaylistQuery] = useState("");
  const [playlistSort, setPlaylistSort] = useState<
    "newest" | "largest" | "name"
  >("newest");
  const [globalQuery, setGlobalQuery] = useState("");

  /**
   * Which playlist an admin has open for inspection, if any.
   *
   * The playlists table showed a row per playlist with a track COUNT, but
   * there was no way to see the contents. Handling a report or a copyright
   * complaint needs the actual tracks, and the only way to get them was to ask
   * the user to screenshot their playlist.
   */
  const [inspecting, setInspecting] = useState<Id<"playlists"> | null>(null);
  const inspected = useQuery(
    api.admin.playlistDetail,
    inspecting ? { playlistId: inspecting } : "skip",
  );

  const filteredUsers = useMemo(() => {
    const q = userQuery.trim().toLowerCase();
    const rows = (users ?? []).filter((u) => {
      if (userRole === "admin" && u.role !== "admin") return false;
      if (userRole === "user" && u.role === "admin") return false;
      // Narrow by sign-in method: "who signed up with GitHub" is the question
      // admins ask most, and the per-row badges can't answer it once the
      // accounts table is long. "Any sign-in" clears the filter entirely;
      // "Other" catches providers the named methods don't cover, so no
      // account can become invisible.
      if (!userMatchesMethod(u.providers, userMethod)) return false;
      if (!q) return true;
      const name = (u.name ?? "").toLowerCase();
      const email = (u.email ?? "").toLowerCase();
      // The external GitHub account id is searchable for the same reason the
      // badge shows it: looking it up should land on that row.
      const github = (u.githubId ?? "").toLowerCase();
      return (
        name.includes(q) ||
        email.includes(q) ||
        github.includes(q) ||
        u._id.includes(q)
      );
    });
    return rows.sort((a, b) => {
      if (userSort === "name")
        return (a.name ?? "").localeCompare(b.name ?? "");
      if (userSort === "oldest") return a._creationTime - b._creationTime;
      return b._creationTime - a._creationTime;
    });
  }, [users, userQuery, userRole, userMethod, userSort]);

  /** How many accounts use each sign-in method, shown on the filter labels. */
  const methodCounts = useMemo(() => {
    // `all` is the "Any sign-in" total; `other` counts accounts carrying at
    // least one provider the named methods don't cover, so the numbers add up
    // instead of leaving rows unexplained.
    const counts: Record<string, number> = {
      all: 0,
      [OTHER_SIGN_IN_METHOD]: 0,
    };
    for (const u of users ?? []) {
      counts.all += 1;
      // `providers` carries one entry per linked auth account, so a user with
      // two GitHub credentials would otherwise be counted twice and the label
      // would promise more rows than the filter can show.
      const unique = new Set(u.providers ?? []);
      for (const p of unique) {
        if (KNOWN_SIGN_IN_METHODS.has(p)) counts[p] = (counts[p] ?? 0) + 1;
        else counts[OTHER_SIGN_IN_METHOD] += 1;
      }
    }
    return counts;
  }, [users]);

  const filteredPlaylists = useMemo(() => {
    const q = playlistQuery.trim().toLowerCase();
    const rows = (playlists ?? []).filter(
      (p) =>
        !q ||
        p.name.toLowerCase().includes(q) ||
        p._id.includes(q) ||
        (p.ownerName ?? "").toLowerCase().includes(q),
    );
    return rows.sort((a, b) => {
      if (playlistSort === "largest") return b.trackCount - a.trackCount;
      if (playlistSort === "name") return a.name.localeCompare(b.name);
      return b._creationTime - a._creationTime;
    });
  }, [playlists, playlistQuery, playlistSort]);

  /** Cross-entity search over the data already loaded for the admin. */
  const globalResults = useMemo(() => {
    const q = globalQuery.trim().toLowerCase();
    if (!q) return null;
    return {
      users: (users ?? [])
        .filter(
          (u) =>
            (u.name ?? "").toLowerCase().includes(q) ||
            (u.email ?? "").toLowerCase().includes(q),
        )
        .slice(0, 25),
      playlists: (playlists ?? [])
        .filter((p) => p.name.toLowerCase().includes(q) || p._id.includes(q))
        .slice(0, 25),
      likes: (allLikes ?? [])
        .filter(
          (l) =>
            l.title.toLowerCase().includes(q) ||
            l.artistName.toLowerCase().includes(q),
        )
        .slice(0, 25),
      rooms: (rooms ?? [])
        .filter((r) => (r.name ?? "").toLowerCase().includes(q))
        .slice(0, 25),
      imports: (imports ?? [])
        .filter((i) => (i.name ?? "").toLowerCase().includes(q))
        .slice(0, 25),
    };
  }, [globalQuery, users, playlists, allLikes, rooms, imports]);
  const [gh, setGh] = useState<{
    userId: string;
    name: string;
    loading: boolean;
    data: Awaited<ReturnType<typeof fetchGithub>>;
  } | null>(null);

  const openGithub = async (
    userId: string,
    githubId: string | null,
    name: string,
  ) => {
    setGh({ userId, name, loading: true, data: null });
    try {
      const data = githubId ? await fetchGithub({ githubId }) : null;
      setGh({ userId, name, loading: false, data });
    } catch {
      setGh({ userId, name, loading: false, data: null });
    }
  };

  if (status === undefined) {
    return (
      <div className="flex flex-col gap-3 py-10">
        <div className="h-9 w-64 animate-pulse rounded bg-white/[0.05]" />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-28 animate-pulse rounded-2xl bg-white/[0.04]"
            />
          ))}
        </div>
      </div>
    );
  }

  if (status === null) {
    return (
      <div className="flex flex-col items-center gap-4 py-24 text-center">
        <span className="flex size-14 items-center justify-center rounded-2xl bg-white/[0.05] ring-1 ring-white/10">
          <ShieldCheck className="size-7 text-muted-foreground/60" />
        </span>
        <div>
          <h1 className="font-display text-xl font-bold tracking-tight">
            Admin access required
          </h1>
          <p className="mx-auto mt-1 max-w-sm text-sm leading-6 text-muted-foreground">
            This area is reserved for administrators. If you manage this
            deployment, contact an existing admin to be granted access.
          </p>
        </div>
        <Link
          to="/home"
          className="mt-2 rounded-full border border-white/10 bg-white/[0.04] px-5 py-2.5 text-sm font-semibold transition-colors hover:bg-white/[0.08]"
        >
          Back to your dashboard
        </Link>
      </div>
    );
  }

  const counts = status.counts;

  const handleSetRole = async (
    userId: Id<"users">,
    name: string,
    role: "admin" | "user",
  ) => {
    try {
      await setRole({ userId, role });
      toast.success(
        role === "admin"
          ? `${name} is now an admin`
          : `${name} is now a standard user`,
      );
    } catch {
      toast.error("Could not update the role");
    }
  };

  const handleDeleteUser = async (userId: Id<"users">, name: string) => {
    try {
      await deleteUser({ userId });
      toast.success(`Deleted ${name}'s account`);
    } catch {
      toast.error("Could not delete the account");
    }
  };

  const handleDeletePlaylist = async (playlistId: Id<"playlists">) => {
    try {
      await deletePlaylist({ playlistId });
      toast.success("Playlist deleted");
    } catch {
      toast.error("Could not delete the playlist");
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-[rgb(var(--tint)_/_0.14)] text-[rgb(var(--tint))]">
            <Shield className="size-5" />
          </span>
          <div>
            <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">
              Admin
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Manage accounts, content, and listening activity across the
              deployment.
            </p>
          </div>
        </div>
      </header>

      <Tabs value={tab} onValueChange={setTab}>
        {/* 7 tabs wrapped into a tall stack on a phone. Scroll the rail
            sideways instead so the admin area stays one-handed. */}
        <TabsList className="slider-rail h-auto w-full justify-start gap-1 overflow-x-auto bg-white/[0.05] p-1">
          <TabsTrigger value="overview" className="shrink-0">
            Overview
          </TabsTrigger>
          <TabsTrigger value="users" className="shrink-0">
            Users
          </TabsTrigger>
          <TabsTrigger value="insights" className="shrink-0">
            Insights
          </TabsTrigger>
          <TabsTrigger value="visits" className="shrink-0">
            Visits
          </TabsTrigger>
          <TabsTrigger value="likes" className="shrink-0">
            Liked songs
          </TabsTrigger>
          <TabsTrigger value="playlists" className="shrink-0">
            Playlists
          </TabsTrigger>
          <TabsTrigger value="rooms" className="shrink-0">
            Listening rooms
          </TabsTrigger>
          <TabsTrigger value="imports" className="shrink-0">
            Imports
          </TabsTrigger>
          <TabsTrigger value="search" className="shrink-0">
            Search
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6 flex flex-col gap-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard icon={Users} label="Accounts" value={counts.users} />
            <StatCard icon={ShieldCheck} label="Admins" value={counts.admins} />
            <StatCard
              icon={ListMusic}
              label="Playlists"
              value={counts.playlists}
            />
            <StatCard icon={Heart} label="Liked songs" value={counts.likes} />
          </div>

          {recentSignups !== undefined && recentSignups.length > 0 && (
            <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-5">
              <p className="flex items-center gap-2 text-sm font-semibold">
                <Sparkles className="size-4 text-[rgb(var(--tint))]" />
                Recent signups
              </p>
              <div className="mt-3 flex flex-col gap-2">
                {recentSignups.map((u) => (
                  <div
                    key={u._id}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <span className="min-w-0 truncate">
                      {u.name ??
                        (u.isAnonymous ? "Guest listener" : "Unnamed listener")}
                      {u.role === "admin" && (
                        <span className="ml-2 text-xs text-[rgb(var(--tint))]">
                          admin
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatDate(u._creationTime)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-5">
            <p className="text-sm font-semibold">About this admin area</p>
            <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">
              From here you can review every account on the deployment, grant or
              revoke admin access, and moderate any playlist. The first account
              ever created on this deployment was automatically promoted to
              admin, which is how you&apos;re here.
            </p>
          </div>
        </TabsContent>

        <TabsContent value="search" className="mt-6 flex flex-col gap-3">
          <input
            value={globalQuery}
            onChange={(e) => setGlobalQuery(e.target.value)}
            placeholder="Search accounts, playlists, liked songs, rooms and imports…"
            aria-label="Search everything"
            className="h-11 w-full rounded-full border border-white/10 bg-white/[0.04] px-4 text-sm outline-none placeholder:text-muted-foreground/70 focus:border-[rgb(var(--tint)_/_0.5)]"
          />
          {!globalResults ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              Type to search across every list in this admin area.
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {globalResults.users.length > 0 && (
                <ResultGroup
                  title="Accounts"
                  count={globalResults.users.length}
                >
                  {globalResults.users.map((u) => (
                    <ResultRow
                      key={u._id}
                      title={
                        u.name ??
                        (u.isAnonymous ? "Guest listener" : "Unnamed listener")
                      }
                      detail={u.email ?? "Anonymous sign-in"}
                    />
                  ))}
                </ResultGroup>
              )}
              {globalResults.playlists.length > 0 && (
                <ResultGroup
                  title="Playlists"
                  count={globalResults.playlists.length}
                >
                  {globalResults.playlists.map((p) => (
                    <ResultRow
                      key={p._id}
                      title={p.name}
                      detail={`${p.trackCount} tracks · ${p.ownerName ?? "unknown owner"}`}
                    />
                  ))}
                </ResultGroup>
              )}
              {globalResults.likes.length > 0 && (
                <ResultGroup
                  title="Liked songs"
                  count={globalResults.likes.length}
                >
                  {globalResults.likes.map((l) => (
                    <ResultRow
                      key={`${l._id}`}
                      title={l.title}
                      detail={l.artistName}
                    />
                  ))}
                </ResultGroup>
              )}
              {globalResults.rooms.length > 0 && (
                <ResultGroup
                  title="Listening rooms"
                  count={globalResults.rooms.length}
                >
                  {globalResults.rooms.map((r) => (
                    <ResultRow
                      key={r._id}
                      title={r.name}
                      detail={`${r.memberCount} listeners · ${r.hostName}`}
                    />
                  ))}
                </ResultGroup>
              )}
              {globalResults.imports.length > 0 && (
                <ResultGroup
                  title="Imports"
                  count={globalResults.imports.length}
                >
                  {globalResults.imports.map((i) => (
                    <ResultRow
                      key={i._id}
                      title={i.name ?? "Untitled import"}
                      detail={`${i.trackCount ?? 0} tracks`}
                    />
                  ))}
                </ResultGroup>
              )}
              {globalResults.users.length === 0 &&
                globalResults.playlists.length === 0 &&
                globalResults.likes.length === 0 &&
                globalResults.rooms.length === 0 &&
                globalResults.imports.length === 0 && (
                  <p className="py-10 text-center text-sm text-muted-foreground">
                    Nothing matched “{globalQuery}”.
                  </p>
                )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="users" className="mt-6 flex flex-col gap-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              value={userQuery}
              onChange={(e) => setUserQuery(e.target.value)}
              placeholder="Search name, email or GitHub id…"
              aria-label="Search accounts"
              className="h-10 w-full rounded-full border border-white/10 bg-white/[0.04] px-4 text-sm outline-none placeholder:text-muted-foreground/70 focus:border-[rgb(var(--tint)_/_0.5)] sm:max-w-xs"
            />
            <div className="flex flex-wrap items-center gap-1.5">
              {(["all", "admin", "user"] as const).map((role) => (
                <button
                  key={role}
                  type="button"
                  onClick={() => setUserRole(role)}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-xs font-semibold capitalize transition-colors",
                    userRole === role
                      ? "border-[rgb(var(--tint))] bg-[rgb(var(--tint)_/_0.14)] text-[rgb(var(--tint))]"
                      : "border-white/10 text-muted-foreground hover:border-white/25 hover:text-foreground",
                  )}
                >
                  {role}
                </button>
              ))}
              <select
                value={userMethod}
                onChange={(e) =>
                  setUserMethod(e.target.value as typeof userMethod)
                }
                aria-label="Filter by sign-in method"
                className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-muted-foreground outline-none"
              >
                <option value="all">
                  Any sign-in ({methodCounts.all ?? 0})
                </option>
                {SIGN_IN_METHODS.map((method) => (
                  <option key={method.id} value={method.id}>
                    {method.label} ({methodCounts[method.id] ?? 0})
                  </option>
                ))}
                {(methodCounts[OTHER_SIGN_IN_METHOD] ?? 0) > 0 && (
                  <option value={OTHER_SIGN_IN_METHOD}>
                    Other ({methodCounts[OTHER_SIGN_IN_METHOD] ?? 0})
                  </option>
                )}
              </select>
              <select
                value={userSort}
                onChange={(e) => setUserSort(e.target.value as typeof userSort)}
                aria-label="Sort accounts"
                className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-muted-foreground outline-none"
              >
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
                <option value="name">Name</option>
              </select>
              <span className="text-[11px] text-muted-foreground">
                {filteredUsers.length} of {users?.length ?? 0}
              </span>
              <button
                type="button"
                onClick={() => {
                  // Exports exactly what the table is showing, so the active
                  // search / role / sign-in filters carry into the file.
                  const stamp = new Date().toISOString().slice(0, 10);
                  const ok = downloadCsv(
                    `synq-accounts-${stamp}.csv`,
                    toCsv(filteredUsers, [
                      { header: "Name", value: (u) => u.name ?? "" },
                      { header: "Email", value: (u) => u.email ?? "" },
                      { header: "Role", value: (u) => u.role ?? "user" },
                      {
                        header: "Sign-in",
                        value: (u) => (u.providers ?? []).join(" + "),
                      },
                      { header: "GitHub id", value: (u) => u.githubId ?? "" },
                      {
                        header: "Guest",
                        value: (u) => (u.isAnonymous ? "yes" : "no"),
                      },
                      {
                        header: "Joined",
                        value: (u) => new Date(u._creationTime).toISOString(),
                      },
                      { header: "Account id", value: (u) => u._id },
                    ]),
                  );
                  if (!ok) {
                    toast.error("Couldn't export the accounts");
                    return;
                  }
                  toast.success(
                    `Exported ${filteredUsers.length} account${filteredUsers.length === 1 ? "" : "s"}`,
                  );
                }}
                className="flex items-center gap-1 rounded-full border border-white/10 px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:border-white/25 hover:text-foreground"
              >
                <ArrowDownToLine className="size-3.5" />
                CSV
              </button>
            </div>
          </div>
          <div className="overflow-x-auto rounded-2xl border border-white/[0.07]">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-white/[0.07] bg-white/[0.03] text-[11px] tracking-widest text-muted-foreground uppercase">
                  <th className="px-4 py-3 font-semibold">Account</th>
                  <th className="hidden px-4 py-3 font-semibold md:table-cell">
                    Member since
                  </th>
                  <th className="px-4 py-3 font-semibold">Role</th>
                  <th className="px-4 py-3 text-right font-semibold">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {users === undefined &&
                  [0, 1, 2].map((i) => (
                    <tr key={i}>
                      <td colSpan={4} className="px-4 py-3">
                        <div className="h-6 animate-pulse rounded bg-white/[0.05]" />
                      </td>
                    </tr>
                  ))}
                {filteredUsers.map((user) => {
                  const isSelf = user._id === me?._id;
                  const name =
                    user.name ??
                    (user.isAnonymous ? "Guest listener" : "Unnamed listener");
                  const email = user.email ?? "Anonymous sign-in";
                  return (
                    <tr
                      key={user._id}
                      className="border-b border-white/[0.04] last:border-0"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          {user.image ? (
                            <img
                              src={user.image}
                              alt=""
                              className="size-9 shrink-0 rounded-full object-cover ring-1 ring-white/10"
                              loading="lazy"
                            />
                          ) : (
                            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[rgb(var(--tint)_/_0.14)] text-xs font-bold text-[rgb(var(--tint))]">
                              {name
                                .split(/\s+/)
                                .map((w) => w[0])
                                .join("")
                                .slice(0, 2)
                                .toUpperCase()}
                            </span>
                          )}
                          <div className="min-w-0">
                            <p className="truncate font-medium">
                              {name}
                              {isSelf && (
                                <span className="ml-2 text-xs text-muted-foreground">
                                  (you)
                                </span>
                              )}
                            </p>
                            <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                              {email}
                              {user.providers?.includes("github") && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    openGithub(user._id, user.githubId, name)
                                  }
                                  title={`GitHub account${user.githubId ? ` #${user.githubId}` : ""} — click for profile`}
                                  className="inline-flex items-center rounded bg-white/[0.07] px-1.5 py-0.5 text-[10px] font-semibold transition-colors hover:bg-white/[0.15] hover:text-foreground"
                                >
                                  <svg
                                    viewBox="0 0 24 24"
                                    className="mr-1 size-3 fill-current"
                                    aria-hidden="true"
                                  >
                                    <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-2.17c-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.72-1.54-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.79 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.12 3.05.74.81 1.18 1.83 1.18 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.06.78 2.14v3.17c0 .3.21.67.8.55A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z" />
                                  </svg>
                                  GitHub
                                </button>
                              )}
                              {user.providers?.includes("google") && (
                                <span className="inline-flex items-center rounded bg-white/[0.07] px-1.5 py-0.5 text-[10px] font-semibold">
                                  Google
                                </span>
                              )}
                              {user.providers?.includes("email-otp") && (
                                <span className="inline-flex items-center rounded bg-white/[0.07] px-1.5 py-0.5 text-[10px] font-semibold">
                                  Email
                                </span>
                              )}
                              {user.providers?.includes("anonymous") && (
                                <span className="inline-flex items-center rounded bg-white/[0.07] px-1.5 py-0.5 text-[10px] font-semibold">
                                  Guest
                                </span>
                              )}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="hidden px-4 py-3 text-muted-foreground md:table-cell">
                        {formatDate(user._creationTime)}
                      </td>
                      <td className="px-4 py-3">
                        {user.role === "admin" ? (
                          <Badge className="bg-[rgb(var(--tint)_/_0.16)] text-[rgb(var(--tint))] ring-1 ring-[rgb(var(--tint)_/_0.3)]">
                            Admin
                          </Badge>
                        ) : (
                          <Badge
                            variant="secondary"
                            className="bg-white/[0.05] text-muted-foreground"
                          >
                            Standard
                          </Badge>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-2">
                          {!isSelf && (
                            <>
                              {user.role === "admin" ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleSetRole(user._id, name, "user")
                                  }
                                  className="flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
                                >
                                  <ArrowDownToLine className="size-3.5" />
                                  Demote
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleSetRole(user._id, name, "admin")
                                  }
                                  className="flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
                                >
                                  <ArrowUpFromLine className="size-3.5" />
                                  Make admin
                                </button>
                              )}
                              <ConfirmButton
                                label="Clear history"
                                confirmLabel="Clear all plays?"
                                onConfirm={() =>
                                  handleClearHistory(user._id, name)
                                }
                              />
                              <ConfirmButton
                                label="Delete"
                                onConfirm={() =>
                                  handleDeleteUser(user._id, name)
                                }
                              />
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="likes" className="mt-6 flex flex-col gap-6">
          {/* per-user activity rollup */}
          <div className="overflow-x-auto rounded-2xl border border-white/[0.07]">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-white/[0.07] bg-white/[0.03] text-[11px] tracking-widest text-muted-foreground uppercase">
                  <th className="px-4 py-3 font-semibold">Listener</th>
                  <th className="px-4 py-3 font-semibold">Likes</th>
                  <th className="hidden px-4 py-3 font-semibold sm:table-cell">
                    Playlists
                  </th>
                  <th className="px-4 py-3 font-semibold">Plays</th>
                  <th className="hidden px-4 py-3 font-semibold md:table-cell">
                    Last played
                  </th>
                </tr>
              </thead>
              <tbody>
                {activity === undefined &&
                  [0, 1, 2].map((i) => (
                    <tr key={i}>
                      <td colSpan={5} className="px-4 py-3">
                        <div className="h-6 animate-pulse rounded bg-white/[0.05]" />
                      </td>
                    </tr>
                  ))}
                {activity?.map((row) => (
                  <tr
                    key={row._id}
                    className="border-b border-white/[0.04] last:border-0"
                  >
                    <td className="px-4 py-3 font-medium">
                      {row.name ?? row.email ?? "Anonymous"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground tabular-nums">
                      {row.likes}
                    </td>
                    <td className="hidden px-4 py-3 text-muted-foreground tabular-nums sm:table-cell">
                      {row.playlists}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground tabular-nums">
                      {row.plays}
                    </td>
                    <td className="hidden px-4 py-3 text-muted-foreground md:table-cell">
                      {row.lastPlayedAt ? formatDate(row.lastPlayedAt) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* every liked song across the deployment */}
          <div className="overflow-x-auto rounded-2xl border border-white/[0.07]">
            <div className="flex items-center gap-2 border-b border-white/[0.07] bg-white/[0.03] px-4 py-3">
              <Heart className="size-4 text-[rgb(var(--tint))]" />
              <p className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
                All liked songs · {allLikes?.length ?? "…"}
              </p>
            </div>
            <div className="max-h-[420px] overflow-y-auto">
              <table className="w-full min-w-[560px] text-left text-sm">
                <tbody>
                  {allLikes === undefined &&
                    [0, 1, 2, 3].map((i) => (
                      <tr key={i}>
                        <td colSpan={4} className="px-4 py-3">
                          <div className="h-10 animate-pulse rounded bg-white/[0.05]" />
                        </td>
                      </tr>
                    ))}
                  {allLikes?.map((like) => (
                    <tr
                      key={like._id}
                      className="border-b border-white/[0.04] last:border-0"
                    >
                      <td className="w-12 px-4 py-2">
                        {like.coverUrl ? (
                          <img
                            src={like.coverUrl}
                            alt=""
                            loading="lazy"
                            className="size-10 rounded-md object-cover"
                          />
                        ) : (
                          <span className="flex size-10 items-center justify-center rounded-md bg-white/[0.06]">
                            <Heart className="size-4 text-muted-foreground/50" />
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        <p className="truncate font-medium">{like.title}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {like.artistName}
                        </p>
                      </td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {like.ownerName ?? like.ownerEmail ?? "Unknown"}
                      </td>
                      <td className="hidden px-4 py-2 text-xs text-muted-foreground md:table-cell">
                        {formatDate(like.createdAt)}
                      </td>
                    </tr>
                  ))}
                  {allLikes !== undefined && allLikes.length === 0 && (
                    <tr>
                      <td
                        colSpan={4}
                        className="px-4 py-10 text-center text-sm text-muted-foreground"
                      >
                        No liked songs yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* deployment-wide most played */}
          <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-5">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <TrendingUp className="size-4 text-[rgb(var(--tint))]" />
              Most played across the deployment
            </p>
            <div className="mt-3 flex flex-col gap-1.5">
              {topTracks === undefined && (
                <div className="h-16 animate-pulse rounded bg-white/[0.05]" />
              )}
              {topTracks?.map((t, i) => (
                <div
                  key={t.trackId}
                  className="flex items-center gap-3 text-sm"
                >
                  <span className="w-6 text-right text-xs tabular-nums text-muted-foreground">
                    {i + 1}
                  </span>
                  {/* The song's TITLE, not its id. This list used to render the
                      raw trackId, which told an admin nothing they could act
                      on. */}
                  <span className="min-w-0 flex-1 truncate">
                    {t.title ?? (
                      // No snapshot on any of this track's rows — an older
                      // play, recorded before titles were stored. Showing the
                      // id in muted type is honest; inventing a name is not.
                      <span
                        className="font-mono text-xs text-muted-foreground/70"
                        title="No title was recorded for this track"
                      >
                        {t.trackId} · title not recorded
                      </span>
                    )}
                    {t.title && t.artistName ? (
                      <span className="text-muted-foreground">
                        {" — "}
                        {t.artistName}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {t.plays} plays · {t.listeners} listener
                    {t.listeners === 1 ? "" : "s"}
                  </span>
                </div>
              ))}
              {topTracks !== undefined && topTracks.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  No listening history yet.
                </p>
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="playlists" className="mt-6 flex flex-col gap-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              value={playlistQuery}
              onChange={(e) => setPlaylistQuery(e.target.value)}
              placeholder="Search playlist, owner or id…"
              aria-label="Search playlists"
              className="h-10 w-full rounded-full border border-white/10 bg-white/[0.04] px-4 text-sm outline-none placeholder:text-muted-foreground/70 focus:border-[rgb(var(--tint)_/_0.5)] sm:max-w-xs"
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <select
                value={playlistSort}
                onChange={(e) =>
                  setPlaylistSort(e.target.value as typeof playlistSort)
                }
                aria-label="Sort playlists"
                className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-xs font-semibold text-muted-foreground outline-none"
              >
                <option value="newest">Newest</option>
                <option value="largest">Most tracks</option>
                <option value="name">Name</option>
              </select>
              <span className="text-[11px] text-muted-foreground">
                {filteredPlaylists.length} of {playlists?.length ?? 0}
              </span>
            </div>
          </div>
          <div className="overflow-x-auto rounded-2xl border border-white/[0.07]">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-white/[0.07] bg-white/[0.03] text-[11px] tracking-widest text-muted-foreground uppercase">
                  <th className="px-4 py-3 font-semibold">Playlist</th>
                  <th className="hidden px-4 py-3 font-semibold sm:table-cell">
                    Owner
                  </th>
                  <th className="px-4 py-3 font-semibold">Tracks</th>
                  <th className="hidden px-4 py-3 font-semibold md:table-cell">
                    Created
                  </th>
                  <th className="px-4 py-3 text-right font-semibold">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {playlists === undefined &&
                  [0, 1].map((i) => (
                    <tr key={i}>
                      <td colSpan={5} className="px-4 py-3">
                        <div className="h-6 animate-pulse rounded bg-white/[0.05]" />
                      </td>
                    </tr>
                  ))}
                {filteredPlaylists.map((playlist) => (
                  <tr
                    key={playlist._id}
                    className="border-b border-white/[0.04] last:border-0"
                  >
                    <td className="px-4 py-3 font-medium">{playlist.name}</td>
                    <td className="hidden px-4 py-3 text-muted-foreground sm:table-cell">
                      {playlist.ownerName ?? playlist.ownerEmail ?? "Unknown"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {playlist.trackCount}
                    </td>
                    <td className="hidden px-4 py-3 text-muted-foreground md:table-cell">
                      {formatDate(playlist._creationTime)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        {renaming?.id === playlist._id ? (
                          <form
                            onSubmit={(e) => {
                              e.preventDefault();
                              if (renaming.name.trim())
                                handleRenamePlaylist(
                                  playlist._id,
                                  renaming.name,
                                );
                            }}
                            className="flex items-center gap-1.5"
                          >
                            <input
                              autoFocus
                              value={renaming.name}
                              onChange={(e) =>
                                setRenaming({
                                  id: playlist._id,
                                  name: e.target.value,
                                })
                              }
                              className="w-40 rounded-full border border-white/15 bg-white/[0.05] px-3 py-1.5 text-xs outline-none focus:border-[rgb(var(--tint))]"
                            />
                            <button
                              type="submit"
                              className="rounded-full bg-[rgb(var(--tint))] px-3 py-1.5 text-xs font-semibold text-black"
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              onClick={() => setRenaming(null)}
                              className="rounded-full border border-white/10 px-3 py-1.5 text-xs text-muted-foreground"
                            >
                              Cancel
                            </button>
                          </form>
                        ) : (
                          <>
                            <button
                              type="button"
                              aria-label={`Inspect the tracks in ${playlist.name}`}
                              title="See what's in this playlist"
                              onClick={() => setInspecting(playlist._id)}
                              className="flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
                            >
                              <Eye className="size-3.5" />
                              Inspect
                            </button>

                            <button
                              type="button"
                              aria-label={`Rename ${playlist.name}`}
                              title="Rename"
                              onClick={() =>
                                setRenaming({
                                  id: playlist._id,
                                  name: playlist.name,
                                })
                              }
                              className="flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
                            >
                              <Pencil className="size-3.5" />
                              Rename
                            </button>
                            <ConfirmButton
                              label="Delete"
                              confirmLabel="Delete playlist?"
                              onConfirm={() =>
                                handleDeletePlaylist(playlist._id)
                              }
                            />
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {playlists !== undefined && playlists.length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-4 py-10 text-center text-sm text-muted-foreground"
                    >
                      No playlists exist yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <PlaylistInspector
            detail={inspected}
            onClose={() => setInspecting(null)}
          />
        </TabsContent>

        <TabsContent value="insights" className="mt-6 flex flex-col gap-6">
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard
              icon={Activity}
              label="Plays · last 14 days"
              value={listeningStats?.totalPlays ?? 0}
            />
            <StatCard
              icon={BarChart3}
              label="Unique tracks · 14 days"
              value={listeningStats?.uniqueTracks ?? 0}
            />
            <StatCard
              icon={Clock3}
              label="Peak listening hour"
              value={
                listeningStats?.peakHour == null
                  ? "—"
                  : `${String(listeningStats.peakHour).padStart(2, "0")}:00`
              }
            />
          </div>

          <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-5">
            <p className="text-sm font-semibold">
              Plays per day — last 14 days
            </p>
            {listeningStats === undefined ? (
              <div className="mt-3 h-32 animate-pulse rounded bg-white/[0.05]" />
            ) : listeningStats.totalPlays === 0 ? (
              <div className="mt-3 flex h-32 flex-col items-center justify-center rounded-xl border border-dashed border-white/[0.08] bg-black/10 px-4 text-center">
                <BarChart3 className="size-6 text-muted-foreground/45" />
                <p className="mt-2 text-sm font-semibold">
                  No listening activity yet
                </p>
                <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                  Plays from the last 14 days will appear here as people listen.
                </p>
              </div>
            ) : (
              <div className="mt-4 flex h-32 items-end gap-1.5">
                {listeningStats.daily.map((d) => {
                  const max = Math.max(
                    1,
                    ...listeningStats.daily.map((x) => x.plays),
                  );
                  return (
                    <div
                      key={d.day}
                      className="group relative z-10 flex h-full min-w-0 flex-1 flex-col items-center gap-1 hover:z-20"
                    >
                      <div
                        className="relative w-full rounded-t bg-[rgb(var(--tint)_/_0.55)] transition-colors group-hover:bg-[rgb(var(--tint))]"
                        style={{
                          height: `${Math.max(3, (d.plays / max) * 100)}%`,
                        }}
                        aria-label={`${d.label}: ${d.plays} plays`}
                      >
                        <span className="pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 z-20 hidden w-max -translate-x-1/2 rounded-lg border border-white/10 bg-[#12151d]/95 px-2.5 py-1.5 text-left text-[10px] text-foreground shadow-xl backdrop-blur-xl group-hover:block">
                          <span className="block font-semibold">{d.label}</span>
                          <span className="block text-muted-foreground">
                            {d.plays} {d.plays === 1 ? "play" : "plays"}
                          </span>
                        </span>
                      </div>
                      <span className="w-full truncate text-center text-[9px] text-muted-foreground">
                        {d.label.split(" ")[1]}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="visits" className="mt-6">
          <VisitAnalytics
            summary={visitSummary}
            days={visitDays}
            onDaysChange={setVisitDays}
          />
        </TabsContent>

        <TabsContent value="rooms" className="mt-6">
          <div className="overflow-x-auto rounded-2xl border border-white/[0.07]">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-white/[0.07] bg-white/[0.03] text-[11px] tracking-widest text-muted-foreground uppercase">
                  <th className="px-4 py-3 font-semibold">Room</th>
                  <th className="hidden px-4 py-3 font-semibold sm:table-cell">
                    Host
                  </th>
                  <th className="px-4 py-3 font-semibold">Members</th>
                  <th className="hidden px-4 py-3 font-semibold md:table-cell">
                    Now playing
                  </th>
                  <th className="px-4 py-3 text-right font-semibold">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {rooms === undefined &&
                  [0, 1].map((i) => (
                    <tr key={i}>
                      <td colSpan={5} className="px-4 py-3">
                        <div className="h-6 animate-pulse rounded bg-white/[0.05]" />
                      </td>
                    </tr>
                  ))}
                {rooms?.map((room) => (
                  <tr
                    key={room._id}
                    className="border-b border-white/[0.04] last:border-0"
                  >
                    <td className="flex items-center gap-2 px-4 py-3 font-medium">
                      <Radio className="size-4 text-[rgb(var(--tint))]" />
                      {room.name}
                    </td>
                    <td className="hidden px-4 py-3 text-muted-foreground sm:table-cell">
                      {room.hostName}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground tabular-nums">
                      {room.memberCount}
                    </td>
                    <td className="hidden max-w-[220px] truncate px-4 py-3 text-muted-foreground md:table-cell">
                      {room.nowPlaying ?? "—"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end">
                        <ConfirmButton
                          label="Remove"
                          confirmLabel="Remove room?"
                          onConfirm={() => handleDeleteRoom(room._id)}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
                {rooms !== undefined && rooms.length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-4 py-10 text-center text-sm text-muted-foreground"
                    >
                      No listening rooms exist yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="imports" className="mt-6">
          <div className="overflow-x-auto rounded-2xl border border-white/[0.07]">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead>
                <tr className="border-b border-white/[0.07] bg-white/[0.03] text-[11px] tracking-widest text-muted-foreground uppercase">
                  <th className="px-4 py-3 font-semibold">Playlist</th>
                  <th className="hidden px-4 py-3 font-semibold sm:table-cell">
                    Origin
                  </th>
                  <th className="hidden px-4 py-3 font-semibold sm:table-cell">
                    Owner
                  </th>
                  <th className="px-4 py-3 font-semibold">Tracks</th>
                  <th className="hidden px-4 py-3 font-semibold md:table-cell">
                    Imported
                  </th>
                  <th className="px-4 py-3 text-right font-semibold">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {imports === undefined &&
                  [0, 1].map((i) => (
                    <tr key={i}>
                      <td colSpan={6} className="px-4 py-3">
                        <div className="h-6 animate-pulse rounded bg-white/[0.05]" />
                      </td>
                    </tr>
                  ))}
                {imports?.map((imp) => (
                  <tr
                    key={imp._id}
                    className="border-b border-white/[0.04] last:border-0"
                  >
                    <td className="px-4 py-3 font-medium">{imp.name}</td>
                    <td className="hidden px-4 py-3 text-muted-foreground sm:table-cell">
                      {imp.origin}
                    </td>
                    <td className="hidden px-4 py-3 text-muted-foreground sm:table-cell">
                      {imp.ownerName}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground tabular-nums">
                      {imp.trackCount}
                    </td>
                    <td className="hidden px-4 py-3 text-muted-foreground md:table-cell">
                      {formatDate(imp.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end">
                        <ConfirmButton
                          label="Delete"
                          confirmLabel="Delete import?"
                          onConfirm={() => handleDeleteImport(imp._id)}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
                {imports !== undefined && imports.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-10 text-center text-sm text-muted-foreground"
                    >
                      No imported playlists yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </TabsContent>
      </Tabs>

      {/* GitHub profile popover */}
      {gh && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setGh(null)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#141419] p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-sm font-semibold">GitHub account — {gh.name}</p>
            {gh.loading && (
              <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Fetching profile…
              </div>
            )}
            {!gh.loading && gh.data && (
              <div className="mt-4 flex items-start gap-4">
                {gh.data.avatarUrl && (
                  <img
                    src={gh.data.avatarUrl}
                    alt=""
                    className="size-14 rounded-full ring-1 ring-white/10"
                    loading="lazy"
                  />
                )}
                <div className="min-w-0 text-sm">
                  <p className="truncate font-medium">
                    {gh.data.name ?? gh.data.login}
                  </p>
                  <a
                    href={gh.data.htmlUrl ?? undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-[rgb(var(--tint))] hover:underline"
                  >
                    @{gh.data.login} — open on GitHub
                  </a>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {gh.data.publicRepos} public repos
                  </p>
                  {gh.data.createdAt && (
                    <p className="text-xs text-muted-foreground">
                      Joined GitHub {new Date(gh.data.createdAt).getFullYear()}
                    </p>
                  )}
                </div>
              </div>
            )}
            {!gh.loading && !gh.data && (
              <p className="mt-4 text-sm text-muted-foreground">
                Couldn&apos;t load this GitHub profile (account may be private
                or deleted).
              </p>
            )}
            <button
              type="button"
              onClick={() => setGh(null)}
              className="mt-5 w-full rounded-full border border-white/10 py-2 text-sm font-medium transition-colors hover:bg-white/[0.06]"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: number | string;
}) {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.03] p-5">
      <span className="flex size-9 items-center justify-center rounded-xl bg-[rgb(var(--tint)_/_0.14)] text-[rgb(var(--tint))]">
        <Icon className="size-[18px]" />
      </span>
      <p className="mt-3 font-display text-3xl font-bold tracking-tight tabular-nums">
        {value}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
