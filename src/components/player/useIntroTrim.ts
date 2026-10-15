import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { getSignalLevel } from "@/lib/audio";
import {
  DEFAULT_INTRO_TRIM_OPTIONS,
  detectIntroEnd,
  formatSkipped,
  INTRO_SAMPLE_INTERVAL_MS,
  type IntroSample,
} from "@/lib/introTrim";
import { soundIsOnAudioElement, usePlayerStore } from "@/store/player";

/** How long to keep sampling before admitting the analyser is unavailable. */
const GRAPH_GRACE_MS = 8000;

/**
 * Runs the smart intro trim for as long as the app is mounted.
 *
 * While a track plays its opening seconds this samples the analyser's RMS
 * level and hands the series to `detectIntroEnd`, which decides whether there
 * is a long enough quiet lead-in to be worth skipping. The decision itself is
 * pure and lives in `lib/introTrim`; this hook only does the sampling and the
 * seek.
 *
 * Mounted once in the app shell rather than per-player so a trim can still
 * happen when the user is on the queue panel or browsing the library.
 *
 * Two failure modes are handled explicitly rather than silently:
 * - The Web Audio graph may not exist yet (it is created on a user gesture).
 *   We ask for it and, if it never appears, say so once instead of probing
 *   forever.
 * - The YouTube IFrame engine cannot be tapped by Web Audio, so tracks playing
 *   through it report no level. The manual "skip" control in the player bar
 *   covers those, and the settings copy says so.
 */
export function useIntroTrim(): void {
  const enabled = usePlayerStore((s) => s.introTrim);
  const playing = usePlayerStore((s) => s.isPlaying);
  const trackId = usePlayerStore((s) => s.current?.id ?? null);
  const trimmed = usePlayerStore((s) => s.introTrimSkipped);

  const samples = useRef<IntroSample[]>([]);
  const lastTrackId = useRef<string | null>(null);

  // Samples belong to a track. A new track starts a fresh series — reusing
  // the previous one's levels would make the new track look like it had
  // already passed its intro.
  useEffect(() => {
    if (lastTrackId.current === trackId) return;
    lastTrackId.current = trackId;
    samples.current = [];
  }, [trackId]);

  useEffect(() => {
    if (!enabled || !playing || !trackId || trimmed !== null) return;

    let warned = false;
    const startedAt = performance.now();

    const timer = window.setInterval(() => {
      const s = usePlayerStore.getState();
      // The track changed under us (skip, or the queue advanced) — the
      // per-track reset effect will restart the probe for the new one.
      if (s.current?.id !== trackId) {
        window.clearInterval(timer);
        return;
      }
      // Past the probe window, or the listener deliberately seeked forward:
      // either way there is nothing left to decide.
      if (s.currentTime > DEFAULT_INTRO_TRIM_OPTIONS.maxSkipSeconds) {
        window.clearInterval(timer);
        return;
      }

      // The analyser lives INSIDE the Web Audio graph, so it can only hear a
      // track that is playing through the <audio> deck. While the YouTube
      // IFrame owns the sound — which is the whole time the direct stream is
      // still resolving, and forever if it never resolves — the graph reads
      // digital silence.
      //
      // That silence is indistinguishable from a genuinely quiet intro, so the
      // probe used to conclude the track opened quietly and, the moment the
      // stream was swapped onto the deck, treat the first real audio as the
      // start of the track and seek the listener 8-60s into a song that had
      // been playing the entire time. Nothing is sampled on those ticks; once
      // the sound does move to the deck, sampling resumes for the same track.
      if (!soundIsOnAudioElement()) return;

      const level = getSignalLevel();
      if (level < 0) {
        // No graph, so nothing to listen to. The graph is built where a user
        // gesture actually exists — the Settings toggle and the fullscreen
        // control — not here: `createMediaElementSource` permanently reroutes
        // the shared audio element, and this effect has no gesture to justify
        // that. Worse, `ensureGraph` resets its context to null on failure, so
        // retrying it from a 250ms timer churns through AudioContexts for the
        // whole track. Say so once, then stop the probe entirely; the manual
        // skip button still works.
        if (performance.now() - startedAt <= GRAPH_GRACE_MS) return;
        window.clearInterval(timer);
        if (!warned) {
          warned = true;
          toast("Smart trim is waiting for audio", {
            id: "intro-trim-graph",
            description:
              "Press play once, or use the skip button \u2014 this browser needs a click before it can listen for a silent intro.",
          });
        }
        return;
      }

      samples.current.push({ t: s.currentTime, level });
      const skip = detectIntroEnd(samples.current);
      if (skip <= 0) return;

      window.clearInterval(timer);
      const applied = usePlayerStore.getState().skipIntro(skip);
      if (applied > 0) {
        toast(`Skipped ${formatSkipped(applied)} of quiet intro`, {
          id: "intro-trim-applied",
          description: "Undo it any time from the player bar.",
        });
      }
    }, INTRO_SAMPLE_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [enabled, playing, trackId, trimmed]);
}
