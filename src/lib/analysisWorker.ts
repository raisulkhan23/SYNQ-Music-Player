/**
 * AutoMix analysis worker.
 *
 * The FFT pass is pure JavaScript over a few seconds of samples per track: fast
 * enough to finish, but it would still block the main thread for the length of
 * a scroll or a tap on a phone. Moving it here keeps `timeupdate`, the seek bar
 * and the UI on schedule while a track is being measured.
 *
 * The worker receives mono PCM that the main thread already decoded and
 * downsampled (decoding is native and fast; the DSP is not), and returns the
 * analysis object. It never touches the DOM, storage or the network.
 */

import { analyzePcm } from "./trackAnalysis";

interface AnalyzeRequest {
  id: number;
  trackId: string;
  samples: Float32Array;
  sampleRate: number;
}

interface AnalyzeResponse {
  id: number;
  ok: boolean;
  analysis?: unknown;
  error?: string;
}

self.onmessage = (event: MessageEvent<AnalyzeRequest>) => {
  const { id, trackId, samples, sampleRate } = event.data ?? {};
  const respond = (payload: AnalyzeResponse) => {
    (self as unknown as Worker).postMessage(payload);
  };
  try {
    if (!trackId || !(samples instanceof Float32Array)) {
      respond({ id, ok: false, error: "invalid analysis input" });
      return;
    }
    respond({
      id,
      ok: true,
      analysis: analyzePcm({ trackId, samples, sampleRate }),
    });
  } catch (error) {
    respond({
      id,
      ok: false,
      error: error instanceof Error ? error.message : "analysis failed",
    });
  }
};
