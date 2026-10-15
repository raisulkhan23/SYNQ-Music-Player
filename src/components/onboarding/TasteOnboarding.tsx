import { useState } from "react";
import { useNavigate } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Check, Sparkles } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import {
  EMPTY_TASTE,
  MAX_TASTE_ARTISTS,
  MAX_TASTE_MOODS,
  TASTE_ARTISTS,
  TASTE_MOODS,
  isOnboardingDone,
  markOnboardingDone,
  shouldOfferOnboarding,
  tasteIsUsable,
  tasteSeedQueries,
  writeTasteProfile,
  type TasteProfile,
} from "@/lib/onboarding";

/**
 * The cold-start "What are you into?" prompt.
 *
 * Shown ONCE, to a signed-in listener who has no listening history and no saved
 * taste. The picks are turned into REAL upstream searches (see
 * `tasteSeedQueries`), and finishing the flow sends the listener straight to the
 * first seed's results — so the reward for answering is immediately hearing
 * something, not an empty dashboard. Renders nothing when it should not offer
 * itself, so mounting it unconditionally is safe.
 */
export function TasteOnboarding() {
  const { isAuthenticated } = useAuth();
  const taste = useQuery(api.users.myTaste);
  const history = useQuery(api.history.continueListening);
  const setTaste = useMutation(api.users.setTaste);
  const completeOnboarding = useMutation(api.users.completeOnboarding);
  const navigate = useNavigate();

  const [profile, setProfile] = useState<TasteProfile>(EMPTY_TASTE);
  const [dismissed, setDismissed] = useState(false);
  const [saving, setSaving] = useState(false);

  const serverTasteSet =
    taste !== null && taste !== undefined && (taste.artists.length > 0 || taste.moods.length > 0);
  const offer =
    !dismissed &&
    taste !== undefined &&
    history !== undefined &&
    shouldOfferOnboarding({
      signedIn: isAuthenticated,
      done: isOnboardingDone(),
      serverTasteSet,
      hasHistory: history !== null,
    });

  if (!offer) return null;

  const toggleArtist = (artist: string) =>
    setProfile((prev) => {
      const has = prev.artists.includes(artist);
      if (has) return { ...prev, artists: prev.artists.filter((a) => a !== artist) };
      if (prev.artists.length >= MAX_TASTE_ARTISTS) return prev;
      return { ...prev, artists: [...prev.artists, artist] };
    });

  const toggleMood = (id: string) =>
    setProfile((prev) => {
      const has = prev.moods.includes(id);
      if (has) return { ...prev, moods: prev.moods.filter((m) => m !== id) };
      if (prev.moods.length >= MAX_TASTE_MOODS) return prev;
      return { ...prev, moods: [...prev.moods, id] };
    });

  const finish = async () => {
    if (!tasteIsUsable(profile) || saving) return;
    setSaving(true);
    try {
      await setTaste({ artists: profile.artists, moods: profile.moods });
      writeTasteProfile(profile);
      markOnboardingDone();
      const seeds = tasteSeedQueries(profile);
      toast.success("Nice — finding music you'll like");
      navigate(seeds[0] ? `/search?q=${encodeURIComponent(seeds[0])}` : "/");
    } catch {
      toast.error("Couldn't save your picks — try again");
      setSaving(false);
    }
  };

  const skip = async () => {
    setDismissed(true);
    markOnboardingDone();
    try {
      await completeOnboarding({});
    } catch {
      // Best-effort; the local flag already stops the prompt reappearing.
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/70 p-0 sm:items-center sm:p-4">
      <div className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-t-3xl border border-white/10 bg-[rgb(18_18_22)] p-6 sm:rounded-3xl">
        <div className="flex items-center gap-2">
          <Sparkles className="size-5 text-[rgb(var(--tint))]" />
          <h2 className="font-display text-xl font-bold">What are you into?</h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick a few artists and moods. We'll turn them into real searches — no account
          history needed to get started.
        </p>

        <p className="mt-5 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Artists
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {TASTE_ARTISTS.map((artist) => {
            const selected = profile.artists.includes(artist);
            return (
              <button
                key={artist}
                type="button"
                aria-pressed={selected}
                onClick={() => toggleArtist(artist)}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
                  selected
                    ? "border-[rgb(var(--tint))] bg-[rgb(var(--tint)_/_0.15)] text-[rgb(var(--tint))]"
                    : "border-white/10 text-muted-foreground hover:border-white/25 hover:text-foreground",
                )}
              >
                {artist}
              </button>
            );
          })}
        </div>

        <p className="mt-5 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
          Moods
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {TASTE_MOODS.map((mood) => {
            const selected = profile.moods.includes(mood.id);
            return (
              <button
                key={mood.id}
                type="button"
                aria-pressed={selected}
                onClick={() => toggleMood(mood.id)}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
                  selected
                    ? "border-[rgb(var(--tint))] bg-[rgb(var(--tint)_/_0.15)] text-[rgb(var(--tint))]"
                    : "border-white/10 text-muted-foreground hover:border-white/25 hover:text-foreground",
                )}
              >
                {mood.label}
              </button>
            );
          })}
        </div>

        <div className="mt-6 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => void skip()}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Skip for now
          </button>
          <button
            type="button"
            onClick={() => void finish()}
            disabled={!tasteIsUsable(profile) || saving}
            className={cn(
              "flex items-center gap-2 rounded-full px-5 py-2.5 text-sm font-semibold transition-transform",
              tasteIsUsable(profile) && !saving
                ? "bg-[rgb(var(--tint))] text-black hover:scale-[1.02]"
                : "cursor-not-allowed bg-white/[0.06] text-muted-foreground",
            )}
          >
            <Check className="size-4" />
            {saving ? "Saving…" : "Start listening"}
          </button>
        </div>
      </div>
    </div>
  );
}
