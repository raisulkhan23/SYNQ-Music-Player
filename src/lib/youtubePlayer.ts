// ---------------------------------------------------------------------------
// YouTube IFrame Player engine.
//
// YouTube bot-blocks datacenter IPs that try to resolve raw stream URLs, but
// the official IFrame Player API is designed to run in the user's browser and
// is not subject to that check. This module owns one YouTube player and
// exposes a small imperative API that mirrors the pieces of HTMLAudioElement
// the player store relies on (play / pause / seek / volume / state events).
//
// The player element lives inside `hostEl`. Normally the host is parked off-
// screen (audio-only mode); when the fullscreen player is open, the host is
// APPENDED into the fullscreen video frame so the real video is visible —
// no CSS positioning tricks, no re-parenting glitches. Playback continues
// through the same player instance the whole time.
// ---------------------------------------------------------------------------

import { publicAsset } from "@/lib/publicAsset";

interface YtPlayerLike {
  loadVideoById: (id: string, startSeconds?: number) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  setVolume: (v: number) => void;
  setPlaybackRate: (rate: number) => void;
  getPlaybackRate: () => number;
  mute: () => void;
  unMute: () => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  getPlayerState: () => number;
  /** Present on the real IFrame API player; used to detect autoplay drift. */
  getVideoData?: () => { video_id?: string };
}

interface YtNamespace {
  Player: new (
    el: HTMLElement | string,
    opts: {
      height?: string;
      width?: string;
      playerVars?: Record<string, string | number>;
      events?: {
        onReady?: (e: { target: YtPlayerLike }) => void;
        onStateChange?: (e: { data: number; target: YtPlayerLike }) => void;
        onError?: (e: { data: number }) => void;
      };
    },
  ) => YtPlayerLike;
}

declare global {
  interface Window {
    YT?: YtNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

export interface YtEngineHandlers {
  /** Mirrors YT player states: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued */
  onStateChange?: (state: number) => void;
  /** Fired ~4x/second while playing or buffering. */
  onTime?: (currentTime: number, duration: number) => void;
  /** 2 invalid param, 5 html5 error, 100 not found, 101/150 embed disabled */
  onError?: (code: number) => void;
}

let currentRate = 1;
let rateVerifyTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Apply the requested rate and VERIFY it actually took. YouTube silently
 * ignores setPlaybackRate while buffering/cued and resets it on state
 * changes, so a fire-and-forget call doesn't work. We poll getPlaybackRate()
 * and re-apply until it sticks (max ~5s), and re-apply whenever playback
 * (re)starts.
 */
function applyRate(): void {
  const target = currentRate;
  const attempt = () => {
    try {
      player?.setPlaybackRate(target);
    } catch {
      /* not ready */
    }
  };
  attempt();
  if (rateVerifyTimer !== null) clearInterval(rateVerifyTimer);
  let checks = 0;
  rateVerifyTimer = setInterval(() => {
    if (!player || rateVerifyTimer === null) {
      if (rateVerifyTimer !== null) clearInterval(rateVerifyTimer);
      rateVerifyTimer = null;
      return;
    }
    let actual = 0;
    try {
      actual = player.getPlaybackRate?.() ?? 0;
    } catch {
      actual = 0;
    }
    if (actual === 0 || Math.abs(actual - target) > 0.01) {
      attempt();
    }
    if (++checks > 20) {
      if (rateVerifyTimer !== null) clearInterval(rateVerifyTimer);
      rateVerifyTimer = null;
    }
  }, 250);
}

let handlers: YtEngineHandlers = {};
let player: YtPlayerLike | null = null;
let hostEl: HTMLDivElement | null = null;
let lastState = -1;
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** The video id currently loaded into the engine (null = nothing loaded). */
let loadedVideoId: string | null = null;
/**
 * The video the IFrame player is ACTUALLY on, read back from the player itself.
 * `loadedVideoId` only records what we asked for — with `autoplay: 1` YouTube
 * will roll on to a related video by itself, and nothing in our bookkeeping
 * notices. Callers compare this against the store's current track to catch that
 * drift instead of silently playing the wrong song.
 */
let actualVideoId: string | null = null;

/**
 * Slave mode: the engine plays a video MUTED purely as visuals while the
 * <audio> element (with Web Audio effects) supplies the sound. In this mode
 * the engine's events must NOT reach the store — the audio element drives
 * playback state — so all handler forwarding is suppressed.
 */
let slaveMode = false;

const OFFSCREEN_STYLE =
  "position:fixed;left:-9999px;top:0;width:640px;height:360px;opacity:0;pointer-events:none;border:0;overflow:hidden;z-index:-1;";

let apiPromise: Promise<void> | null = null;

/**
 * How long to wait for `youtube.com/iframe_api` before declaring it blocked.
 * The script is tiny and normally arrives in well under a second, so this is
 * deliberately short: the listener is waiting on music, not on a spinner.
 */
const API_LOAD_TIMEOUT_MS = 5_000;

function loadApi(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.YT?.Player) return Promise.resolve();
  if (apiPromise) return apiPromise;

  apiPromise = new Promise<void>((resolve, reject) => {
    let settled = false;
    function finish(err?: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!err) return resolve();
      // Don't cache the failure forever: the listener may allow youtube.com
      // (or switch the blocker off) and press play again.
      apiPromise = null;
      reject(err);
    }
    // Declared before `finish` can ever run so the closure is never in TDZ.
    const timer = setTimeout(
      () =>
        finish(
          new Error(
            "YouTube player API timed out — a blocker may be blocking youtube.com",
          ),
        ),
      API_LOAD_TIMEOUT_MS,
    );
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      finish();
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    tag.async = true;
    // A blocker REJECTS this request outright, so the script fires `error`
    // and `onYouTubeIframeAPIReady` never runs. Previously the promise simply
    // never settled: `ytEngine.play()` neither resolved nor rejected, and
    // the click produced absolute silence.
    tag.onerror = () =>
      finish(
        new Error(
          "YouTube player API blocked — a blocker may be blocking youtube.com",
        ),
      );
    document.head.appendChild(tag);
  });
  return apiPromise;
}

// Warm the API script as early as possible so the first play click is fast.
// Swallow the rejection: a blocked/blocked-forever API must not surface as an
// unhandled rejection at module scope — `play()` re-attempts and reports it.
void loadApi().catch(() => undefined);

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (!player) return;
    if (slaveMode) return; // audio element reports time in slave mode
    if (lastState !== 1 && lastState !== 3) return;
    let t = 0;
    let d = 0;
    try {
      t = player.getCurrentTime() ?? 0;
      d = player.getDuration() ?? 0;
    } catch {
      return;
    }
    handlers.onTime?.(t, d);
  }, 250);
}

async function ensurePlayer(): Promise<YtPlayerLike> {
  await loadApi();
  if (player) return player;
  const YT = window.YT;
  if (!YT?.Player) throw new Error("YouTube IFrame API unavailable");

  // YT.Player REPLACES the element you pass it with an iframe. So we pass an
  // inner div (mountEl) and keep a stable wrapper (hostEl) that we can move
  // between the off-screen parking spot and the fullscreen video frame.
  const host = document.createElement("div");
  host.style.cssText = OFFSCREEN_STYLE;
  const mount = document.createElement("div");
  mount.style.cssText = "width:100%;height:100%;";
  host.appendChild(mount);
  document.body.appendChild(host);
  hostEl = host;

  player = await new Promise<YtPlayerLike>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("YT player init timed out")),
      10_000,
    );
    try {
      new YT.Player(mount, {
        height: "100%",
        width: "100%",
        playerVars: {
          autoplay: 1,
          controls: 0,
          disablekb: 1,
          playsinline: 1,
          rel: 0,
          // Strip YouTube's own UI: no branding, no annotations, no captions,
          // no fullscreen button.
          modestbranding: 1,
          iv_load_policy: 3,
          cc_load_policy: 0,
          fs: 0,
        },
        events: {
          onReady: (e) => {
            clearTimeout(timeout);
            applyRate();
            resolve(e.target);
          },
          onStateChange: (e) => {
            lastState = e.data;
            if (e.data === 1 || e.data === 0) {
              // Read back the real video id whenever the player reports a
              // state, so autoplay drift is detectable.
              try {
                const data = e.target.getVideoData?.();
                if (data?.video_id) actualVideoId = data.video_id;
              } catch {
                /* player not ready */
              }
            }
            if (slaveMode) return; // muted visual slave — store never hears this
            handlers.onStateChange?.(e.data);
            // YouTube resets the playback rate on state changes — re-apply
            // whenever the video (re)starts playing or buffers.
            if (e.data === 1 || e.data === 3) applyRate();
            // Hide YouTube's pause overlay (related-videos grid etc.) by
            // showing our own cover while not actively playing.
            setPauseCoverVisible(e.data !== 1);
            // State 0 (ended) doesn't fire onTime again — push a final time
            // sample so the store can run A-B repeat / auto-advance logic.
            if (e.data === 0) {
              try {
                const d = e.target.getDuration() ?? 0;
                handlers.onTime?.(d > 0 ? d : 0, d);
              } catch {
                /* ignore */
              }
            }
          },
          onError: (e) => {
            if (slaveMode) return;
            handlers.onError?.(e.data);
          },
        },
      });
    } catch (err) {
      clearTimeout(timeout);
      reject(err instanceof Error ? err : new Error("YT player init failed"));
    }
  });

  startPolling();
  return player;
}

export function setHandlers(next: YtEngineHandlers): void {
  handlers = next;
}

/**
 * Create the hidden player during idle time so the first track click only
 * has to load the video, not initialize the entire IFrame API/player.
 */
export function warmup(): void {
  void ensurePlayer().catch(() => undefined);
}

/**
 * What the caller LAST asked for. `play()` is async and `pause()` is not, so a
 * pause issued while a play is still awaiting the player would otherwise be
 * undone the instant that play resolved.
 *
 * This is the defect behind permanently rough audio: the store starts the
 * IFrame first and hands playback to the `<audio>` decks as soon as a direct
 * stream resolves, so it calls `play()` and then `pause()` within the same tick.
 * If the IFrame API had not finished initialising, `pause()` found nothing to
 * pause and did nothing at all — and the pending `play()` then started the video
 * anyway. The deck played the same track through Web Audio while the IFrame
 * played it dry, microseconds out of phase. Two copies of one signal summed
 * that far apart is a comb filter: gritty, crackly, and quieter than either copy
 * on its own. The store recorded positions from both clocks at once.
 *
 * Recording the intent means a pause issued at ANY point wins, including before
 * the player exists.
 */
let wantPlaying = false;

/** Load a video and start playing. Safe to call repeatedly (reuses the player). */
export async function play(
  videoId: string,
  opts: { volume: number; muted: boolean; startSeconds?: number },
): Promise<void> {
  wantPlaying = true;
  const p = await ensurePlayer();
  p.setVolume(Math.round(Math.min(1, Math.max(0, opts.volume)) * 100));
  if (opts.muted) p.mute();
  else p.unMute();
  try {
    p.setPlaybackRate(currentRate);
  } catch {
    /* ignore */
  }
  lastState = -1;
  loadedVideoId = videoId;
  actualVideoId = videoId;
  p.loadVideoById(videoId, Math.max(0, opts.startSeconds ?? 0));
  // The pause that arrived while we were waiting for the player: apply it now,
  // or `loadVideoById` leaves a dry duplicate playing under the <audio> deck.
  if (!wantPlaying) {
    try {
      p.pauseVideo();
    } catch {
      /* ignore */
    }
  }
  // A fresh load resets the rate — the verified re-apply loop handles it.
  applyRate();
  suppressYtOverlays();
}

/**
 * YouTube overlays (title bar, end-screen links, watch-later/share buttons)
 * are rendered inside the iframe, but some sit in a same-origin shell we can
 * style. This injects one suppression stylesheet, once per session.
 */
/**
 * YouTube's own stylesheet classes are unreachable (cross-origin iframe), so
 * instead we hide its UI with OUR OWN elements layered above the player:
 * 1. an always-on "chrome shield" strip covering the title bar / top-right
 *    buttons and the bottom-right controls strip, and
 * 2. a full pause cover (dark + logo) shown whenever the video isn't playing,
 *    which hides the related-videos grid / pause overlay entirely.
 * These live in the same stacking context as the iframe, so they work.
 */
let shieldEl: HTMLDivElement | null = null;
let pauseCoverEl: HTMLDivElement | null = null;

function ensureShields(): void {
  if (!hostEl) return;
  if (!shieldEl) {
    shieldEl = document.createElement("div");
    shieldEl.style.cssText =
      // Dark gradient strips mask YouTube's own title bar (top) and control
      // strip (bottom) so they're never visible, while the middle of the
      // video stays fully clear.
      "position:absolute;inset:0;pointer-events:none;z-index:5;" +
      "background:linear-gradient(180deg, rgba(5,6,10,0.92) 0%, rgba(5,6,10,0) 16%, rgba(5,6,10,0) 74%, rgba(5,6,10,0.92) 100%);";
    hostEl.appendChild(shieldEl);
  }
  if (!pauseCoverEl) {
    pauseCoverEl = document.createElement("div");
    pauseCoverEl.style.cssText =
      "position:absolute;inset:0;display:none;align-items:center;justify-content:center;" +
      "background:#090a0f;z-index:6;pointer-events:none;transition:opacity .2s;";
    const logo = document.createElement("img");
    // Versioned for the same reason as the in-app Logo: a /public asset keeps
    // its URL, so an unversioned one can be served stale from cache.
    logo.src = publicAsset("logo.svg?v=4");
    logo.style.cssText = "width:56px;opacity:.5;";
    logo.onerror = () => {
      logo.style.display = "none";
    };
    pauseCoverEl.appendChild(logo);
    hostEl.appendChild(pauseCoverEl);
  }
}

/** Toggle our pause cover on top of YouTube's pause UI. */
function setPauseCoverVisible(visible: boolean): void {
  if (pauseCoverEl) pauseCoverEl.style.display = visible ? "flex" : "none";
}

function suppressYtOverlays(): void {
  ensureShields();
}

export function resume(): void {
  try {
    player?.playVideo();
  } catch {
    /* not ready yet */
  }
}

export function pause(): void {
  wantPlaying = false;
  try {
    player?.pauseVideo();
  } catch {
    /* not ready yet */
  }
}

export function seek(seconds: number): void {
  try {
    player?.seekTo(Math.max(0, seconds), true);
  } catch {
    /* not ready yet */
  }
}

/** volume in [0,1] */
export function setVolume(v: number): void {
  try {
    // In slave mode the <audio> element owns ALL the sound. Letting the
    // engine take volume would unbalance the mix, and unmuting it (below)
    // would play a second audio source over the filtered one.
    const value = slaveMode ? 0 : Math.min(1, Math.max(0, v));
    player?.setVolume(Math.round(value * 100));
  } catch {
    /* not ready yet */
  }
}

export function setMuted(muted: boolean): void {
  try {
    if (muted) {
      player?.mute();
    } else if (slaveMode) {
      // Never unmute the visual slave — the filtered <audio> element is the
      // only source of sound while effects are active.
      player?.setVolume(0);
      player?.mute();
    } else {
      player?.unMute();
    }
  } catch {
    /* not ready yet */
  }
}

/**
 * Playback speed 0.5–2. Applied immediately and re-applied shortly after —
 * YouTube resets the rate on fresh loads and sometimes on resume, so a single
 * call is not enough.
 */
export function setRate(rate: number): void {
  currentRate = Math.min(2, Math.max(0.5, rate));
  applyRate();
}

/**
 * IMPORTANT: re-parenting an iframe in the DOM RELOADS it, which would kill
 * playback. So "presenting" the video NEVER moves the player element —
 * instead the off-screen host is fixed-positioned exactly over the fullscreen
 * video frame's rectangle. Same DOM node, same iframe, playback continues.
 */
const OVERLAY_BASE =
  // Above the fullscreen player layer (z-[70]) so the video is visible;
  // sized exactly over the video frame, never covering the controls.
  // pointer-events:none is deliberate and load-bearing: the iframe is a live
  // YouTube page, so letting clicks through to it made the app feel frozen
  // and clicking the video area triggered YouTube's own title-bar link,
  // which started ANOTHER video of the same song over our playback. Clicks
  // must belong to our own UI, always.
  "position:fixed;z-index:71;pointer-events:none;border:0;overflow:hidden;opacity:1;border-radius:16px;";

/**
 * Overlay the live player over the given fullscreen frame element (measured
 * live from its bounding rect). Returns false while the frame isn't laid out
 * or the engine isn't ready — callers should retry.
 */
export function presentOverlay(frame: HTMLElement): boolean {
  if (!hostEl || !frame) return false;
  const r = frame.getBoundingClientRect();
  if (r.width < 10 || r.height < 10) return false;
  hostEl.style.cssText =
    OVERLAY_BASE +
    `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;`;
  hostEl.style.visibility = "visible";
  return true;
}

/**
 * Return the player to its off-screen parking spot (audio-only mode).
 * Also forces click-through: an overlay left over the UI would swallow every
 * click, which is what made the app feel "frozen" until an effect was
 * toggled again.
 */
export function dismissVideo(): void {
  if (!hostEl) return;
  // Never touch the parent — only reset the styling. Re-parenting would
  // reload the iframe and stop playback.
  hostEl.style.cssText = OFFSCREEN_STYLE;
  hostEl.style.pointerEvents = "none";
  hostEl.style.visibility = "hidden";
}

/** The engine's player host element, so consumers can check containment. */
export function getYtHost(): HTMLElement | null {
  return hostEl;
}

/**
 * Keep the overlay glued to the frame while it's visible (window resizes,
 * lyrics panel toggling, etc.). Returns a cleanup function.
 */
export function trackFrame(frame: HTMLElement): () => void {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    presentOverlay(frame);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return () => {
    stopped = true;
  };
}

/**
 * YT error codes that will never resolve by retrying the SAME video id, so
 * playback must be escalated to the fallback chain immediately.
 *
 * 2 invalid param · 5 HTML5 player error · 100 removed/private ·
 * 101/150 owner has disabled embedding · 153 embedding refused.
 *
 * 153 is the important one that used to be MISSING: a network blocker
 * (uBlock, AdGuard, 1Blocker) that stops `youtube.com/embed/*` makes the
 * IFrame report 153, and because it wasn't treated as fatal no error was
 * ever surfaced at all — the click produced total silence and only the
 * watchdog rescued it.
 */
export function isFatalError(code: number): boolean {
  return (
    code === 2 ||
    code === 5 ||
    code === 100 ||
    code === 101 ||
    code === 150 ||
    code === 153
  );
}

/**
 * TRUE only when the failure is evidence that the LISTENER's browser blocked
 * the embed — the one case where it is honest to name a blocker.
 *
 * Only 153 qualifies: it is what a network blocker (uBlock, AdGuard,
 * 1Blocker) produces when it stops `youtube.com/embed/*`. Deliberately
 * EXCLUDES 101/150 (the VIDEO OWNER disabled embedding — nothing the listener
 * can fix) and 2/5/100 (bad or removed video). Attributing any of those to a
 * blocker is exactly how the "your blocker is blocking YouTube" message used
 * to appear to listeners who had no blocker running.
 */
export function isEmbedBlocked(code: number): boolean {
  return code === 153;
}

/** The video id the engine currently has loaded — null when nothing loaded. */
export function getLoadedVideoId(): string | null {
  return loadedVideoId;
}

/**
 * The video the IFrame player is really playing, which can differ from
 * getLoadedVideoId() when YouTube autoplays into a related video.
 */
export function getActualVideoId(): string | null {
  if (actualVideoId) return actualVideoId;
  // Fall back to a live read for the case where no state change has fired yet.
  try {
    const data = player?.getVideoData?.();
    if (data?.video_id) {
      actualVideoId = data.video_id;
      return actualVideoId;
    }
  } catch {
    /* not ready */
  }
  return actualVideoId;
}

// --- slave (visual-only) mode -------------------------------------------------

/**
 * Start the engine as a MUTED visual slave: the video shows fullscreen while
 * the <audio> element (Web Audio effects chain) supplies the sound. All
 * engine events are suppressed while in this mode.
 */
export function startSlave(
  videoId: string,
  startSeconds: number,
): Promise<void> {
  slaveMode = true;
  return play(videoId, {
    volume: 0,
    muted: true,
    startSeconds: Math.max(0, startSeconds),
  }).finally(() => {
    // Re-assert silence: play() may have run before slaveMode was observed
    // by a concurrent volume/mute call, leaving the slave audible.
    try {
      player?.setVolume(0);
      player?.mute();
    } catch {
      /* not ready */
    }
  });
}

/** Exit slave mode: events resume, video pauses. */
export function stopSlave(): void {
  if (!slaveMode) return;
  slaveMode = false;
  try {
    player?.pauseVideo();
  } catch {
    /* not ready */
  }
}

/** Whether the engine is currently a muted visual slave. */
export function isSlaveMode(): boolean {
  return slaveMode;
}

/**
 * Make sure the engine is actually PLAYING `videoId` (muted when the audio
 * element owns the sound). The fullscreen player calls this while it waits
 * for the video to appear: the player is frequently left on a different
 * video, or loaded but paused/buffering, which is what made the fullscreen
 * player show a frozen thumbnail instead of motion. Returns true once the
 * engine reports it is playing this video.
 */
export async function ensureVideoPlaying(
  videoId: string,
  startSeconds: number,
  muted: boolean,
): Promise<boolean> {
  const p = await ensurePlayer();
  if (loadedVideoId !== videoId) {
    loadedVideoId = videoId;
    slaveMode = muted;
    p.setVolume(muted ? 0 : 100);
    if (muted) p.mute();
    else p.unMute();
    p.loadVideoById(videoId, Math.max(0, startSeconds));
  } else {
    // Same video already loaded — make sure it is actually running.
    let state = -1;
    try {
      state = p.getPlayerState?.() ?? -1;
    } catch {
      state = -1;
    }
    // 5 = cued, -1 = unstarted, 2 = paused, 3 = buffering.
    if (state === -1 || state === 2 || state === 5) {
      if (startSeconds > 0) {
        try {
          p.seekTo(startSeconds, true);
        } catch {
          /* not ready */
        }
      }
      p.playVideo();
    }
  }
  // Poll briefly: the state flips to PLAYING a moment after loadVideoById.
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 120));
    let state = -1;
    try {
      state = p.getPlayerState?.() ?? -1;
    } catch {
      state = -1;
    }
    if (state === 1) return true;
    // 100/101/150 — this video can never play in the iframe.
    if (state === 0) break;
  }
  return false;
}

/**
 * Raw IFrame player state: -1 unstarted, 0 ended, 1 playing, 2 paused,
 * 3 buffering, 5 cued. -1 also means "not ready yet", so callers should fall
 * back to their own bookkeeping rather than treating it as paused.
 */
export function getEngineState(): number {
  try {
    return player?.getPlayerState?.() ?? -1;
  } catch {
    return -1;
  }
}

/** Current playback position of the engine (for drift resync). */
export function getEngineTime(): number {
  try {
    return player?.getCurrentTime() ?? 0;
  } catch {
    return 0;
  }
}
