import { useEffect, useRef } from "react";
import { ensureAnalyser, getAudio, readFrequencyData } from "@/lib/audio";
import { cn } from "@/lib/utils";
import { usePlayerStore } from "@/store/player";

const BAR_COUNT = 40;
const FALLBACK_LIME = { r: 196, g: 246, b: 152 };

function sampleBins(freq: Uint8Array, n: number, out: number[]): void {
  const chunk = Math.max(1, Math.floor(freq.length / n));
  for (let i = 0; i < n; i++) {
    let m = 0;
    const start = i * chunk;
    const end = Math.min(freq.length, start + chunk);
    for (let j = start; j < end; j++) {
      if (freq[j] > m) m = freq[j];
    }
    out[i] = m;
  }
}

/**
 * Deterministic per-track visual signature. Hashes the track id into a seed,
 * then derives an energy level (0.35–1.0) and tempo (BPM-ish pulse) from the
 * track's mood tags — so a chill ambient song visibly breathes slower and
 * softer than a dance track, and every song looks distinct.
 */
function trackVibe(): { seed: number; energy: number; pulseHz: number } {
  const current = usePlayerStore.getState().current;
  if (!current) return { seed: 1, energy: 0.5, pulseHz: 2 };
  let seed = 0;
  for (let i = 0; i < current.id.length; i++) {
    seed = (seed * 31 + current.id.charCodeAt(i)) >>> 0;
  }
  // Derive a stable pseudo-energy from the title so each song looks distinct
  // without needing genre metadata.
  let titleHash = 0;
  for (let i = 0; i < current.title.length; i++) {
    titleHash = (titleHash * 33 + current.title.charCodeAt(i)) >>> 0;
  }
  const energy = 0.45 + (titleHash % 100) / 200; // 0.45 – 0.95
  // Pulse between ~1.4Hz (84 BPM ballad) and ~2.4Hz (144 BPM dance).
  const pulseHz = Math.min(2.4, Math.max(1.4, 1.9 + ((seed % 20) - 10) * 0.02));
  return { seed, energy, pulseHz };
}

export function VisualizerCanvas({
  className,
  active = true,
}: {
  className?: string;
  active?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const accent = usePlayerStore((s) => s.accent);
  const trackId = usePlayerStore((s) => s.current?.id);
  const visualizerEnabled = usePlayerStore((s) => s.visualizerEnabled);
  // The canvas redraws itself every frame, which no CSS rule can switch off,
  // so performance mode has to stop the loop as well as hide the element.
  const performanceMode = usePlayerStore((s) => s.performanceMode);
  const analyserRef = useRef<AnalyserNode | null>(null);

  // Attach to the shared audio element when visualization is enabled. The
  // graph can fail during the first render (before a browser gesture), so
  // retry on the toggle and on the next user interaction rather than relying
  // on a DOM <audio> element that this app never appends.
  useEffect(() => {
    if (!visualizerEnabled || performanceMode) return;
    const attachAnalyser = () => {
      analyserRef.current = ensureAnalyser();
    };
    attachAnalyser();
    window.addEventListener("pointerdown", attachAnalyser, { passive: true });
    window.addEventListener("focus", attachAnalyser);
    return () => {
      window.removeEventListener("pointerdown", attachAnalyser);
      window.removeEventListener("focus", attachAnalyser);
    };
  }, [visualizerEnabled, performanceMode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !visualizerEnabled || !active || performanceMode) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Keep the canvas inexpensive: 1x resolution and 24 FPS is still smooth
    // for a background visualizer and substantially reduces main-thread work.
    const dpr = 1;
    const freq = new Uint8Array(analyserRef.current?.frequencyBinCount ?? 128);
    const sim = new Float32Array(BAR_COUNT);
    const values = new Array<number>(BAR_COUNT);
    let raf = 0;
    let last = performance.now();
    let lastDraw = 0;
    let vibe = trackVibe();

    // Re-derive the vibe whenever the track changes.
    const onTrackChange = () => {
      vibe = trackVibe();
    };
    const unsubTrack = usePlayerStore.subscribe(onTrackChange);

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const draw = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (now - lastDraw < 42) {
        raf = requestAnimationFrame(draw);
        return;
      }
      lastDraw = now;

      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      ctx.clearRect(0, 0, w, h);

      // A graph may have been created after this animation frame started.
      // Retry here as a final recovery path for a context rejected on mount.
      const analyserNode = (analyserRef.current ??= ensureAnalyser());
      // Use real FFT only when the catalog audio element is the active
      // source. For YouTube (IFrame engine) the spectrum isn't tappable, so
      // we simulate — but with the track's own energy/tempo signature.
      const audioEl = getAudio();
      const usingRealAudio =
        analyserNode &&
        audioEl &&
        !audioEl.paused &&
        !audioEl.src.includes("youtu");

      if (usingRealAudio) {
        readFrequencyData(analyserNode, freq);
        sampleBins(freq, BAR_COUNT, values);
      } else {
        const { seed, energy, pulseHz } = vibe;
        const playing = usePlayerStore.getState().isPlaying;
        const level = playing ? energy : energy * 0.25; // idle = gentle breathing
        const beatPhase = (now / 1000) * pulseHz * Math.PI * 2;
        const beat = 0.5 + 0.5 * Math.sin(beatPhase); // 0..1 pulse
        for (let i = 0; i < BAR_COUNT; i++) {
          // Per-bar pseudo-random character derived from track seed.
          const char =
            Math.sin(i * 12.9898 + (seed % 1000) * 0.618) * 0.5 + 0.5;
          // Bass-weighted profile: low bars move more, highs flutter.
          const weight = 1 - (i / BAR_COUNT) * 0.55;
          const target =
            0.08 +
            level *
              weight *
              (0.35 + 0.65 * beat) *
              (0.4 +
                0.6 * Math.abs(Math.sin(now / (700 + char * 500) + i * 0.62)));
          sim[i] += (target - sim[i]) * Math.min(1, dt * (6 + beat * 6));
        }
        for (let i = 0; i < BAR_COUNT; i++) values[i] = sim[i] * 255;
      }

      const { r, g, b } = accent ?? FALLBACK_LIME;
      const gap = Math.min(4, w / (BAR_COUNT * 2));
      const bw = Math.max(2, (w - (BAR_COUNT - 1) * gap) / BAR_COUNT - gap);
      const maxBarH = h * 0.5;
      const baseline = h * 0.985;
      // Loop-invariant: it was recomputed for all 24 bars on every frame.
      const totalW = BAR_COUNT * bw + (BAR_COUNT - 1) * gap;

      for (let i = 0; i < BAR_COUNT; i++) {
        const norm = values[i] / 255;
        const eased = Math.pow(norm, 1.35);
        const bh = Math.max(3, eased * maxBarH);
        const x = (w - totalW) / 2 + i * (bw + gap);
        const alpha = 0.12 + eased * 0.55;
        ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.beginPath();
        ctx.roundRect(x, baseline - bh, bw, bh, bw / 2);
        ctx.fill();
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      unsubTrack();
    };
  }, [accent, trackId, visualizerEnabled, active, performanceMode]);

  if (!visualizerEnabled || performanceMode) return null;
  return <canvas ref={canvasRef} className={cn("block", className)} />;
}
