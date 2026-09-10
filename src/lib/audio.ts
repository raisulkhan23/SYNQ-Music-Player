// ---------------------------------------------------------------------------
// A single shared HTMLAudioElement drives playback app-wide so music never
// stops while navigating. The Web Audio analyser (for the visualizer) is
// created lazily on the first user gesture and routes audio through a graph.
// ---------------------------------------------------------------------------

let audio: HTMLAudioElement | null = null;
let audioContext: AudioContext | null = null;
let mediaSource: MediaElementAudioSourceNode | null = null;
let analyser: AnalyserNode | null = null;

export function getAudio(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio();
    audio.preload = "metadata";
    audio.volume = 1;
  }
  return audio;
}

/**
 * Ensure the Web Audio analyser exists and the context is running.
 * Must be called from a user gesture (autoplay policy).
 */
export function ensureAnalyser(): AnalyserNode | null {
  try {
    if (!audioContext) {
      const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      audioContext = new AC();
      mediaSource = audioContext.createMediaElementSource(getAudio());
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.8;
      mediaSource.connect(analyser);
      analyser.connect(audioContext.destination);
    }
    if (audioContext.state === "suspended") {
      void audioContext.resume().catch(() => undefined);
    }
    return analyser;
  } catch {
    return null;
  }
}

export function getAnalyser(): AnalyserNode | null {
  return analyser;
}

/** Convenience: copy frequency data into a reusable Uint8Array. */
export function readFrequencyData(analyser: AnalyserNode | null, data: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  if (analyser) {
    analyser.getByteFrequencyData(data);
  } else {
    data.fill(0);
  }
  return data;
}