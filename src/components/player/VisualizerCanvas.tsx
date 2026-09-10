import { useEffect, useRef } from "react";
import { ensureAnalyser, readFrequencyData } from "@/lib/audio";
import { cn } from "@/lib/utils";
import { usePlayerStore } from "@/store/player";

const BAR_COUNT = 56;
const FALLBACK_LIME = { r: 196, g: 246, b: 152 };

function sampleBins(freq: Uint8Array, n: number): number[] {
  const out: number[] = [];
  const chunk = Math.max(1, Math.floor(freq.length / n));
  for (let i = 0; i < n; i++) {
    let m = 0;
    const start = i * chunk;
    const end = Math.min(freq.length, start + chunk);
    for (let j = start; j < end; j++) {
      if (freq[j] > m) m = freq[j];
    }
    out.push(m);
  }
  return out;
}

export function VisualizerCanvas({
  className,
  active,
}: {
  className?: string;
  active?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const accent = usePlayerStore((s) => s.accent);
  const analyserRef = useRef<AnalyserNode | null>(null);

  // Create the analyser on mount — the parent overlay is opened by a user
  // gesture, so the AudioContext can start.
  useEffect(() => {
    analyserRef.current = ensureAnalyser();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const freq = new Uint8Array(analyserRef.current?.frequencyBinCount ?? 128);
    const fake = new Float32Array(BAR_COUNT);
    let raf = 0;
    let last = performance.now();

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
      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      ctx.clearRect(0, 0, w, h);

      const analyserNode = analyserRef.current;
      let values: number[];
      if (analyserNode) {
        readFrequencyData(analyserNode, freq);
        values = sampleBins(freq, BAR_COUNT);
      } else {
        for (let i = 0; i < BAR_COUNT; i++) {
          const target =
            0.1 +
            0.55 *
              Math.abs(Math.sin(now / 950 + i * 0.71)) *
              (0.45 + 0.55 * Math.sin(now / 320 + i * 1.3));
          fake[i] += (target - fake[i]) * Math.min(1, dt * 7);
        }
        values = Array.from(fake, (v) => v * 255);
      }

      const { r, g, b } = accent ?? FALLBACK_LIME;
      const gap = Math.min(4, w / (BAR_COUNT * 2));
      const bw = Math.max(2, (w - (BAR_COUNT - 1) * gap) / BAR_COUNT - gap);
      const maxBarH = h * 0.5;
      const baseline = h * 0.985;

      for (let i = 0; i < BAR_COUNT; i++) {
        const norm = values[i] / 255;
        const eased = Math.pow(norm, 1.35);
        const bh = Math.max(3, eased * maxBarH);
        const totalW = BAR_COUNT * bw + (BAR_COUNT - 1) * gap;
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
    };
  }, [accent]);

  return <canvas ref={canvasRef} className={cn("block", className)} />;
}