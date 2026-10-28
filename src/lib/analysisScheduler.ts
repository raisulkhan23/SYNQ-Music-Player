/**
 * AutoMix analysis scheduling, caching and PCM access.
 *
 * ## How audio is obtained (and when it cannot be)
 *
 * Analysis needs decoded PCM, and PCM needs the browser to be allowed to READ
 * the bytes. SYNQ plays through `<audio>` elements, which happily play
 * cross-origin audio that Web Audio may not touch. So this module FETCHES the
 * stream URL the player already resolved, which succeeds only when that URL is
 * CORS-readable:
 *
 *  * the Convex `audio-proxy` answers with `Access-Control-Allow-Origin: *`, so
 *    proxied YouTube/Piped streams are readable and ARE analysed;
 *  * a direct upstream host that sends no CORS headers makes `fetch` fail. That
 *    is reported as `unavailable` — never treated as "analysed, plain blend".
 *
 * Nothing here tries to defeat those rules: a refusal is a legitimate answer,
 * and the planner falls back to the ordinary crossfade.
 *
 * ## Scheduling
 *
 * One job at a time (analysis is CPU-heavy), newest request wins when it is for
 * the CURRENT track, and results are cached in memory plus `localStorage` so a
 * track is measured once per analyzer version. Failed or unavailable tracks are
 * retried at most every ten minutes: a transient CORS/most-recently-resolved
 * failure must not permanently disable AutoMix for that song.
 *
 * ## Lifecycle
 *
 * The worker is created lazily, reused, and terminated after 30 s idle. No
 * timers or listeners survive a page navigation.
 */

import {
  ANALYZER_VERSION,
  analyzePcm,
  downmixForAnalysis,
  sanitizeAnalysis,
  type TrackAnalysis,
} from "./trackAnalysis";

const CACHE_KEY = "ss.trackAnalysis.v1";
const CACHE_LIMIT = 40;
const RETRY_AFTER_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20_000;
const WORKER_TIMEOUT_MS = 20_000;
const MAX_TRACK_SECONDS = 15 * 60;

export interface AnalyzableTrack {
  id: string;
  title?: string;
  audioUrl?: string;
  youtubeId?: string;
  duration?: number;
}

interface CacheEntry {
  analysis: TrackAnalysis;
  /** When an unavailable result may be attempted again. 0 = no retry gate. */
  retryAfter: number;
}

const memory = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<TrackAnalysis>>();
/**
 * The player's own stream resolver, injected at startup.
 *
 * Analysis needs an http(s) URL with readable bytes, and a queued track's
 * `audioUrl` is usually just its video id until the engine resolves it. Asking
 * the engine for the URL (instead of resolving independently here) means
 * analysis and playback share one cache and one strategy — and it can never
 * fetch a stream the player itself would refuse to play.
 */
let resolveStream: ((videoId: string) => Promise<string | null>) | null = null;
let loadedCache = false;
let worker: Worker | null = null;
let workerIdleTimer: ReturnType<typeof setTimeout> | null = null;
let workerJobId = 0;
let chain: Promise<unknown> = Promise.resolve();

function readCache(): void {
  if (loadedCache || typeof window === "undefined") return;
  loadedCache = true;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as {
      version?: string;
      entries?: Record<string, TrackAnalysis>;
    };
    if (parsed.version !== ANALYZER_VERSION || !parsed.entries) return;
    for (const [id, value] of Object.entries(parsed.entries)) {
      const analysis = sanitizeAnalysis(value);
      if (analysis && analysis.trackId === id) {
        memory.set(id, { analysis, retryAfter: 0 });
      }
    }
  } catch {
    /* a corrupt cache is not an error, it is an empty cache */
  }
}

function persistCache(): void {
  if (typeof window === "undefined") return;
  try {
    const entries: Record<string, TrackAnalysis> = {};
    const usable = [...memory.entries()]
      .filter(([, entry]) => entry.analysis.status !== "unavailable")
      .sort((a, b) => b[1].analysis.analyzedAt - a[1].analysis.analyzedAt)
      .slice(0, CACHE_LIMIT);
    for (const [id, entry] of usable) entries[id] = entry.analysis;
    localStorage.setItem(CACHE_KEY, JSON.stringify({ version: ANALYZER_VERSION, entries }));
  } catch {
    // Quota or private mode: the in-memory cache still works for this session.
  }
}

/**
 * The cached analysis for a track, whatever its status.
 *
 * An `unavailable` result is returned deliberately: the planner has to be able
 * to explain WHY it fell back ("audio cannot be read"), and "never measured" is
 * a different sentence from "measured and refused". The retry gate below is
 * about WORK, not about what the decision may see.
 */
export function getCachedAnalysis(trackId: string): TrackAnalysis | null {
  readCache();
  return memory.get(trackId)?.analysis ?? null;
}

/** True when this track has a usable (ready/partial) measurement. */
export function hasUsableAnalysis(trackId: string): boolean {
  const analysis = getCachedAnalysis(trackId);
  return !!analysis && analysis.status !== "unavailable";
}

export function setAnalysisResolver(
  resolver: ((videoId: string) => Promise<string | null>) | null,
): void {
  resolveStream = resolver;
}

export function clearAnalysisCache(): void {
  memory.clear();
  if (typeof window !== "undefined") {
    try {
      localStorage.removeItem(CACHE_KEY);
    } catch {
      /* ignore */
    }
  }
}

/**
 * A YouTube *page*, not a media stream.
 *
 * Queued YouTube tracks carry `audioUrl: https://youtu.be/<id>`: that is the
 * address of a web page, and it is what the player later replaces with a
 * resolved stream. Fetching it here returned HTML, `decodeAudioData` rejected
 * it, and the track was cached as "audio cannot be read" — so analysis never
 * succeeded for a single normal YouTube track. A page URL means "resolve this
 * through the engine first", not "these are the bytes".
 */
const YOUTUBE_PAGE =
  /^https?:\/\/(?:www\.|m\.)?(?:youtu\.be\/|youtube\.com\/(?:watch|shorts|embed))/i;

function usableUrl(track: AnalyzableTrack): string | null {
  const url = track.audioUrl;
  // A bare video id ("dQw4w9WgXcQ") is not a URL — the stream has not been
  // resolved yet. The store resolves before playback starts, so analysis gets
  // another chance on the next call.
  if (!url || !/^(https?:|blob:)/.test(url)) return null;
  if (YOUTUBE_PAGE.test(url)) return null;
  return url;
}

function unavailable(trackId: string, reason: string): TrackAnalysis {
  return {
    trackId,
    status: "unavailable",
    source: "none",
    duration: 0,
    bpmConfidence: 0,
    beatConfidence: 0,
    analyzedAt: Date.now(),
    analyzerVersion: ANALYZER_VERSION,
    reason,
  };
}

function getWorker(): Worker | null {
  if (typeof window === "undefined" || typeof Worker === "undefined") return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("./analysisWorker.ts", import.meta.url), {
      type: "module",
    });
    worker.onerror = () => {
      // A worker that cannot start must not block analysis forever; drop it and
      // let the inline path handle the next job.
      worker?.terminate();
      worker = null;
    };
    return worker;
  } catch {
    return null;
  }
}

function scheduleWorkerShutdown(): void {
  if (workerIdleTimer !== null) clearTimeout(workerIdleTimer);
  workerIdleTimer = setTimeout(() => {
    worker?.terminate();
    worker = null;
    workerIdleTimer = null;
  }, 30_000);
}

function analyzeInWorker(
  trackId: string,
  samples: Float32Array,
  sampleRate: number,
): Promise<TrackAnalysis | null> {
  const w = getWorker();
  if (!w) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = ++workerJobId;
    let settled = false;
    const finish = (value: TrackAnalysis | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      w.removeEventListener("message", onMessage);
      w.removeEventListener("error", onError);
      resolve(value);
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        id?: number;
        ok?: boolean;
        analysis?: unknown;
      };
      if (!data || data.id !== id) return;
      if (!data.ok) return finish(null);
      finish(sanitizeAnalysis(data.analysis));
    };
    const onError = () => {
      w.terminate();
      worker = null;
      finish(null);
    };
    const timer = setTimeout(() => finish(null), WORKER_TIMEOUT_MS);
    w.addEventListener("message", onMessage);
    w.addEventListener("error", onError);
    // Transfer the buffer: this is a copy of the downmixed mono signal, so the
    // main thread does not need it after posting.
    w.postMessage({ id, trackId, samples, sampleRate }, [samples.buffer]);
  });
}

async function analyzeInline(
  trackId: string,
  samples: Float32Array,
  sampleRate: number,
): Promise<TrackAnalysis> {
  // `trackAnalysis` is already statically imported for versioning and the
  // downmix, so a dynamic import here would not split it into its own chunk —
  // it only produced a build warning.
  // Yield once so a long analysis cannot freeze the first paint after a skip.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  return analyzePcm({ trackId, samples, sampleRate });
}

async function decodeStream(
  track: AnalyzableTrack,
): Promise<{ samples: Float32Array; sampleRate: number } | null> {
  let url = usableUrl(track);
  if (!url && track.youtubeId && resolveStream) {
    // Resolving here is also a favour to playback: the engine caches the URL,
    // so the boundary later finds the stream already known.
    url = await resolveStream(track.youtubeId).catch(() => null);
    if (url && !/^(https?:|blob:)/.test(url)) url = null;
  }
  if (!url) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let buffer: ArrayBuffer;
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // Explicit: this request only makes sense if the bytes are readable.
      mode: "cors",
      credentials: "omit",
    });
    if (!response.ok) return null;
    buffer = await response.arrayBuffer();
  } catch {
    // CORS refusal, network failure or timeout. The planner will fall back.
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (!buffer || buffer.byteLength === 0) return null;

  const Ctx =
    typeof window !== "undefined" &&
    (window.OfflineAudioContext ??
      (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
        .webkitOfflineAudioContext);
  if (!Ctx) return null;
  try {
    const ctx = new Ctx(1, 1, 44100);
    const audio = await ctx.decodeAudioData(buffer);
    if (!Number.isFinite(audio.duration) || audio.duration > MAX_TRACK_SECONDS) {
      return null;
    }
    const channels: Float32Array[] = [];
    for (let c = 0; c < audio.numberOfChannels; c++) {
      channels.push(audio.getChannelData(c));
    }
    return {
      samples: downmixForAnalysis(channels, audio.sampleRate),
      sampleRate: 11025,
    };
  } catch {
    return null;
  }
}

async function runAnalysis(track: AnalyzableTrack): Promise<TrackAnalysis> {
  const decoded = await decodeStream(track);
  if (!decoded) {
    // Two different failures live here (no resolved URL vs unreadable bytes)
    // and both are reported the same way: no PCM, so no claims.
    return unavailable(track.id, "this track's audio cannot be read for analysis");
  }
  const fromWorker = await analyzeInWorker(
    track.id,
    decoded.samples,
    decoded.sampleRate,
  );
  if (fromWorker) return fromWorker;
  try {
    return sanitizeAnalysis(
      await analyzeInline(track.id, decoded.samples, decoded.sampleRate),
    ) as TrackAnalysis;
  } catch {
    return unavailable(track.id, "audio analysis failed on this device");
  }
}

/**
 * Measure a track. Cached results return immediately; a track that is already
 * being measured shares the same promise instead of queuing a second job.
 */
export function analyzeTrack(track: AnalyzableTrack): Promise<TrackAnalysis> {
  readCache();
  const cached = getCachedAnalysis(track.id);
  if (cached && (cached.status !== "unavailable" || cached.analyzedAt + RETRY_AFTER_MS > Date.now())) {
    return Promise.resolve(cached);
  }
  const existing = inFlight.get(track.id);
  if (existing) return existing;

  const job = chain
    .then(() => runAnalysis(track))
    .then((analysis) => {
      const retryAfter =
        analysis.status === "unavailable"
          ? analysis.analyzedAt + RETRY_AFTER_MS
          : 0;
      memory.set(track.id, { analysis, retryAfter });
      if (analysis.status !== "unavailable") persistCache();
      return analysis;
    })
    .catch(() => unavailable(track.id, "audio analysis failed"))
    .finally(() => {
      inFlight.delete(track.id);
      scheduleWorkerShutdown();
    });

  inFlight.set(track.id, job);
  chain = job.catch(() => undefined);
  return job;
}

/**
 * Fire-and-forget analysis used by the player: never awaited on the playback
 * path, never throws, and skips tracks that are already measured or running.
 */
export function warmAnalysis(track: AnalyzableTrack | null | undefined): void {
  if (!track?.id) return;
  readCache();
  if (inFlight.has(track.id)) return;
  const cached = memory.get(track.id);
  if (cached) {
    // A usable measurement is final for this session. A failure is not: the
    // stream URL, the network or a CORS proxy may change, so a refusal is
    // re-attempted after the retry window instead of disabling AutoMix for the
    // rest of the session.
    if (cached.analysis.status !== "unavailable") return;
    if (cached.retryAfter > Date.now()) return;
  }
  if (!usableUrl(track) && !(track.youtubeId && resolveStream)) return;
  void analyzeTrack(track).catch(() => undefined);
}

/** A one-line, listener-readable summary of a cached analysis. */
export function describeAnalysis(trackId: string | undefined): string {
  if (!trackId) return "Nothing playing";
  const analysis = getCachedAnalysis(trackId);
  if (!analysis) return "Not analysed yet";
  if (analysis.status === "unavailable") {
    return analysis.reason ?? "Audio unavailable for analysis";
  }
  const parts: string[] = [];
  if (analysis.bpm) parts.push(`${analysis.bpm} BPM`);
  parts.push(`${Math.round(analysis.beatConfidence * 100)}% beat confidence`);
  if (analysis.tempoStability !== undefined) {
    parts.push(`${Math.round(analysis.tempoStability * 100)}% steady`);
  }
  if (analysis.status === "partial") {
    parts.push(analysis.reason ?? "partial");
  }
  return parts.join(" · ");
}
