import { create } from "zustand";
import { getAudio } from "@/lib/audio";
import { albumById, artistById, type Track } from "@/lib/catalog";
import type { RGB } from "@/lib/covers";

export type RepeatMode = "off" | "all" | "one";

let likeMutation: LikeMutation | null = null;

export interface LikeMutation {
  (trackId: string): Promise<boolean>;
}

interface PlayerStore {
  // playback
  queue: Track[];
  queueIndex: number;
  current: Track | null;
  isPlaying: boolean;
  isBuffering: boolean;
  currentTime: number;
  duration: number;
  bufferedEnd: number;

  // preferences
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;

  // interface
  queueOpen: boolean;
  fullscreen: boolean;
  accent: RGB | null;

  // liked songs (synced with Convex, optimistic)
  liked: Record<string, number>;
  likedLoaded: boolean;

  // actions
  playTrack: (track: Track, list?: Track[]) => void;
  playIndex: (index: number) => void;
  togglePlay: () => void;
  next: () => void;
  prev: () => void;
  seek: (time: number) => void;
  setVolume: (volume: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  setQueueOpen: (open: boolean) => void;
  setFullscreen: (open: boolean) => void;
  setAccent: (accent: RGB | null) => void;
  removeFromQueue: (index: number) => void;
  replaceUpcoming: (upcoming: Track[]) => void;
  clearQueue: () => void;

  setLiked: (liked: Record<string, number>) => void;
  setLikeMutation: (fn: LikeMutation | null) => void;
  toggleLike: (trackId: string) => void;
}

// --- persistence helpers ----------------------------------------------------

const readNum = (key: string, fallback: number): number => {
  const raw = localStorage.getItem(key);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};
const readBool = (key: string, fallback: boolean): boolean => {
  const raw = localStorage.getItem(key);
  return raw === null ? fallback : raw === "1";
};

const initialVolume = Math.min(1, Math.max(0, readNum("ss.volume", 0.8)));
const initialMuted = readBool("ss.muted", false);
const initialShuffle = readBool("ss.shuffle", false);
const initialRepeat = (localStorage.getItem("ss.repeat") as RepeatMode | null) ?? "off";

// --- audio element wiring ----------------------------------------------------

let wired = false;
function wireAudio() {
  if (wired) return;
  wired = true;
  const audio = getAudio();
  audio.volume = initialVolume;
  audio.muted = initialMuted;

  audio.addEventListener("timeupdate", () => {
    const duration = audio.duration && Number.isFinite(audio.duration) ? audio.duration : 0;
    usePlayerStore.setState({ currentTime: audio.currentTime, duration });
  });

  audio.addEventListener("durationchange", () => {
    if (audio.duration && Number.isFinite(audio.duration)) {
      usePlayerStore.setState({ duration: audio.duration });
    }
  });

  audio.addEventListener("progress", () => {
    try {
      if (audio.buffered.length > 0) {
        const end = audio.buffered.end(audio.buffered.length - 1);
        usePlayerStore.setState({ bufferedEnd: end });
      }
    } catch {
      /* ignore */
    }
  });

  audio.addEventListener("waiting", () => usePlayerStore.setState({ isBuffering: true }));
  audio.addEventListener("playing", () => usePlayerStore.setState({ isBuffering: false, isPlaying: true }));
  audio.addEventListener("pause", () => usePlayerStore.setState({ isPlaying: false, isBuffering: false }));
  audio.addEventListener("play", () => usePlayerStore.setState({ isPlaying: true }));

  audio.addEventListener("ended", () => {
    const s = usePlayerStore.getState();
    if (s.repeat === "one") {
      s.seek(0);
      void audio.play().catch(() => undefined);
      return;
    }
    if (s.shuffle && s.queue.length > 1) {
      s.playIndex(randomIndex(s.queue.length, s.queueIndex));
      return;
    }
    if (s.queueIndex < s.queue.length - 1) {
      s.playIndex(s.queueIndex + 1);
      return;
    }
    if (s.repeat === "all" && s.queue.length > 0) {
      s.playIndex(0);
      return;
    }
    // end of queue, repeat off
    audio.currentTime = 0;
    usePlayerStore.setState({ isPlaying: false, currentTime: 0 });
  });

  audio.addEventListener("error", () => {
    usePlayerStore.setState({ isBuffering: false, isPlaying: false });
  });
}

const randomIndex = (length: number, exclude: number): number => {
  if (length <= 1) return 0;
  let i = Math.floor(Math.random() * length);
  if (i === exclude) i = (i + 1) % length;
  return i;
};

// --- media session (lock screen / hardware keys) ------------------------------

function syncMediaSession(track: Track | null, playing: boolean) {
  if (!("mediaSession" in navigator)) return;
  if (!track) {
    navigator.mediaSession.metadata = null;
    return;
  }
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: artistById(track.artistId).name,
    album: albumById(track.albumId).title,
  });
  navigator.mediaSession.playbackState = playing ? "playing" : "paused";
}

// --- store --------------------------------------------------------------------

export const usePlayerStore = create<PlayerStore>()((set, get) => {
  wireAudio();

  const loadTrack = (track: Track) => {
    const audio = getAudio();
    audio.src = track.audioUrl;
    audio.load();
    audio.currentTime = 0;
    set({ current: track, currentTime: 0, duration: track.duration, bufferedEnd: 0, isBuffering: true });
    syncMediaSession(track, true);
    void audio.play().catch(() => {
      set({ isPlaying: false, isBuffering: false });
    });
  };

  const playTrack = (track: Track, list?: Track[]) => {
    const list2 = list && list.length > 0 ? list : [track];
    const idx = list2.findIndex((t) => t.id === track.id);
    const index = idx >= 0 ? idx : 0;
    set({ queue: list2, queueIndex: index });
    loadTrack(list2[index]);
  };

  const playIndex = (index: number) => {
    const s = get();
    if (index < 0 || index >= s.queue.length) return;
    set({ queueIndex: index });
    loadTrack(s.queue[index]);
  };

  const togglePlay = () => {
    const s = get();
    if (s.current) {
      const audio = getAudio();
      if (audio.paused) {
        void audio.play().catch(() => undefined);
        syncMediaSession(s.current, true);
      } else {
        audio.pause();
        syncMediaSession(s.current, false);
      }
      return;
    }
    if (s.queue.length > 0) {
      playIndex(s.queueIndex >= 0 ? s.queueIndex : 0);
    }
  };

  const next = () => {
    const s = get();
    if (s.queue.length === 0) return;
    if (s.shuffle && s.queue.length > 1) {
      playIndex(randomIndex(s.queue.length, s.queueIndex));
      return;
    }
    if (s.queueIndex < s.queue.length - 1) {
      playIndex(s.queueIndex + 1);
    } else if (s.repeat === "all") {
      playIndex(0);
    }
  };

  const prev = () => {
    const s = get();
    if (s.queue.length === 0) return;
    if (s.currentTime > 3) {
      s.seek(0);
      return;
    }
    if (s.shuffle && s.queue.length > 1) {
      playIndex(randomIndex(s.queue.length, s.queueIndex));
      return;
    }
    if (s.queueIndex > 0) {
      playIndex(s.queueIndex - 1);
    } else {
      s.seek(0);
    }
  };

  const seek = (time: number) => {
    const audio = getAudio();
    const duration = get().duration;
    const t = Math.max(0, Math.min(time, duration || time));
    audio.currentTime = t;
    set({ currentTime: t });
  };

  const setVolume = (volume: number) => {
    const v = Math.min(1, Math.max(0, volume));
    getAudio().volume = v;
    localStorage.setItem("ss.volume", String(v));
    set({ volume: v });
  };

  const toggleMute = () => {
    const s = get();
    const nextMuted = !s.muted;
    getAudio().muted = nextMuted;
    localStorage.setItem("ss.muted", nextMuted ? "1" : "0");
    if (!nextMuted && s.volume === 0) {
      get().setVolume(0.8);
    }
    set({ muted: nextMuted });
  };

  const toggleShuffle = () => {
    const next = !get().shuffle;
    localStorage.setItem("ss.shuffle", next ? "1" : "0");
    set({ shuffle: next });
  };

  const cycleRepeat = () => {
    const order: RepeatMode[] = ["off", "all", "one"];
    const idx = order.indexOf(get().repeat);
    const next = order[(idx + 1) % order.length];
    localStorage.setItem("ss.repeat", next);
    set({ repeat: next });
  };

  const setLikeMutation = (fn: LikeMutation | null) => {
    likeMutation = fn;
  };

  const toggleLike = (trackId: string) => {
    const s = get();
    const wasLiked = s.liked[trackId] !== undefined;
    const createdAt = Date.now();

    // optimistic flip
    set((state) => {
      const liked = { ...state.liked };
      if (wasLiked) delete liked[trackId];
      else liked[trackId] = createdAt;
      return { liked };
    });

    if (!likeMutation) return;
    likeMutation(trackId)
      .then((nowLiked) => {
        // reconcile with the server's answer
        set((state) => {
          const liked = { ...state.liked };
          if (nowLiked) liked[trackId] = state.liked[trackId] ?? Date.now();
          else delete liked[trackId];
          return { liked };
        });
      })
      .catch(() => {
        // roll back
        set((state) => {
          const liked = { ...state.liked };
          if (wasLiked) liked[trackId] = state.liked[trackId] ?? createdAt;
          else delete liked[trackId];
          return { liked };
        });
      });
  };

  return {
    queue: [],
    queueIndex: -1,
    current: null,
    isPlaying: false,
    isBuffering: false,
    currentTime: 0,
    duration: 0,
    bufferedEnd: 0,

    volume: initialVolume,
    muted: initialMuted,
    shuffle: initialShuffle,
    repeat: initialRepeat,

    queueOpen: false,
    fullscreen: false,
    accent: null,

    liked: {},
    likedLoaded: false,

    playTrack,
    playIndex,
    togglePlay,
    next,
    prev,
    seek,
    setVolume,
    toggleMute,
    toggleShuffle,
    cycleRepeat,
    setQueueOpen: (queueOpen) => set({ queueOpen }),
    setFullscreen: (fullscreen) => set({ fullscreen }),
    setAccent: (accent) => set({ accent }),
    removeFromQueue: (index) =>
      set((state) => {
        if (index < 0 || index >= state.queue.length) return state;
        const queue = state.queue.filter((_, i) => i !== index);
        const queueIndex = index < state.queueIndex ? state.queueIndex - 1 : state.queueIndex;
        const current = queueIndex >= 0 ? queue[queueIndex] : null;
        return { queue, queueIndex, current };
      }),
    replaceUpcoming: (upcoming) =>
      set((state) => {
        const current = state.queue[state.queueIndex] ?? null;
        const queue = current ? [current, ...upcoming] : [...upcoming];
        return { queue, queueIndex: 0, current };
      }),
    clearQueue: () =>
      set((state) => ({
        queue: state.current ? [state.current] : [],
        queueIndex: state.current ? 0 : -1,
        current: state.current,
      })),

    setLiked: (liked) => set({ liked, likedLoaded: true }),
    setLikeMutation,
    toggleLike,
  };
});