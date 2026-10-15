import { useNavigate } from "react-router";
import { useQuery } from "convex/react";
import { Heart } from "lucide-react";

import { api } from "@/convex/_generated/api";
import { formatTime } from "@/lib/format";

/**
 * Pinned "Liked Songs" entry shown at the top of the Playlists tab. It is not a
 * stored playlist — it mirrors the server-side likes and links to /liked — so it
 * deliberately has no rename or delete affordance.
 */
export function LikedSongsCard() {
  const navigate = useNavigate();
  const liked = useQuery(api.likes.myLikedRemote);

  const count = liked?.length ?? 0;
  const totalSeconds = (liked ?? []).reduce(
    (sum, row) => sum + row.duration,
    0,
  );
  const subtitle =
    liked === undefined
      ? "Loading…"
      : count > 0
        ? `${count} ${count === 1 ? "song" : "songs"} · ${formatTime(totalSeconds)}`
        : "Nothing here yet";

  const open = () => navigate("/liked");

  return (
    <div className="group relative w-36 shrink-0 cursor-pointer sm:w-44">
      <div
        role="button"
        tabIndex={0}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
          }
        }}
        className="w-full"
      >
        <div className="relative aspect-square overflow-hidden rounded-xl ring-1 ring-white/10">
          <div className="absolute inset-0 bg-gradient-to-br from-rose-500/45 via-fuchsia-500/20 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-transparent" />
          <div className="relative flex size-full items-center justify-center">
            <Heart className="size-9 text-[rgb(var(--tint))] drop-shadow-[0_4px_16px_rgb(var(--tint)/0.45)] transition-transform duration-300 group-hover:scale-110" />
          </div>
          <div className="absolute inset-0 bg-gradient-to-t from-black/40 via-transparent to-transparent opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
        </div>
        <div className="mt-2.5 px-0.5">
          <p className="truncate text-sm font-semibold">Liked Songs</p>
          <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
        </div>
      </div>
    </div>
  );
}
