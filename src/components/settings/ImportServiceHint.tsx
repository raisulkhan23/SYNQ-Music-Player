import { Info, Music4 } from "lucide-react";
import type { ImporterCapabilities } from "@/lib/importers";
import type { DetectedSource } from "@/lib/sources";

/**
 * What the import panel says about the link that is currently in the box.
 *
 * Extracted from the panel for one reason: this is the only place in the app
 * that tells a listener their API keys are not a streaming licence, and it
 * needs to be renderable on its own to be tested at all. React 19 and happy-dom
 * deliver clicks but not controlled-input change events, so a keystroke cannot
 * be simulated to reach this state; mounting the component directly with real
 * `detectServiceUrl` output is the strongest check that actually runs.
 *
 * Two things are shown, and the second is the one that matters:
 *
 *   1. WHAT was recognised, before anything is clicked.
 *   2. Whether the recognised service can actually be PLAYED. Tidal, Spotify
 *      and Apple Music all import fine and all stream nothing — their APIs are
 *      catalog endpoints, and Tidal's in particular restricts audio to approved
 *      partner apps. Learning that only after wiring up credentials reads as a
 *      broken app rather than as a platform limit.
 */
export function ImportServiceHint({
  detected,
  capabilities,
  canImport,
}: {
  detected: DetectedSource;
  capabilities: ImporterCapabilities;
  canImport: boolean;
}) {
  return (
    <>
      <div
        data-testid="import-detection-badge"
        className="mt-2.5 flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-3 py-1.5 text-[11px]"
      >
        <Music4 className="size-3.5 shrink-0 text-[rgb(var(--tint))]" />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-semibold text-foreground">
            {capabilities.label}
          </span>{" "}
          <span className="text-muted-foreground">
            {detected.kind === "track" ? "track" : detected.kind}
            {detected.id ? "" : " link"} detected
          </span>
        </span>
        <span className="shrink-0 text-muted-foreground">
          {!canImport
            ? "File only"
            : capabilities.needsAuth
              ? "Connect to import"
              : "Ready"}
        </span>
      </div>

      {capabilities.playbackNote ? (
        <p
          data-testid="import-playback-note"
          className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground"
        >
          <Info className="mt-px size-3.5 shrink-0" />
          <span>{capabilities.playbackNote}</span>
        </p>
      ) : null}
    </>
  );
}
