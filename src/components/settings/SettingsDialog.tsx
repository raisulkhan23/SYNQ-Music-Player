import { Button } from "@/components/ui/button";
import { CardTransparencySection } from "@/components/settings/CardTransparencySection";
import { ExplorationSection } from "@/components/settings/ExplorationSection";
import { ImportSection } from "@/components/settings/ImportSection";
import { ResolverSection } from "@/components/settings/ResolverSection";
import { useSettingsNavigation } from "@/components/settings/useSettingsNavigation";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { DEFAULT_CARD_TRANSPARENCY } from "@/lib/cardTransparency";
import { publicAsset } from "@/lib/publicAsset";
import { PresetSelector } from "@/components/settings/PresetSelector";
import { ANIMATION_LEVEL_META, ANIMATION_LEVELS } from "@/lib/motion";
import {
  ARTIST_REPETITION_LEVELS,
  ARTIST_REPETITION_META,
} from "@/lib/artistRepetition";
import {
  notificationPermission,
  notificationsSupported,
  requestNotificationPermission,
} from "@/lib/notifications";
import { downloadJson } from "@/lib/download";
import { useSleepCountdown } from "@/lib/sleepTimer";
import { CROSSFADE_CHOICES } from "@/lib/transition";
import {
  installBlockedReason,
  manualInstallHint,
  usePwaInstall,
} from "@/lib/pwa";
import {
  applyEqPreset,
  setAudioFilter,
  setEqBalance,
  setEqBass,
  setEqBand,
  resetEqBands,
  setEqMono,
  setEqTreble,
  setDeckPitch,
  setRatePreservesPitch,
  setReverbMix,
  setDistortion,
  setVolumeNormalization,
  EQ_BAND_FREQUENCIES,
  EQ_BAND_MIN_DB,
  EQ_BAND_MAX_DB,
  type AudioFilterId,
  AUDIO_FILTERS,
  AUDIO_EFFECT_DELAY_MESSAGE,
  ensureGraph,
} from "@/lib/audio";
import { useAuth } from "@/hooks/use-auth";
import {
  clearPlayHistory,
  crossfadeSelfTest,
  playbackSelfTest,
  prewarmYoutubeStream,
  usePlayerStore,
} from "@/store/player";
import { cn } from "@/lib/utils";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  Check,
  Clock3,
  Database,
  Download,
  Film,
  Gauge,
  ImageOff,
  ImagePlus,
  Keyboard,
  Loader2,
  LogOut,
  Moon,
  Palette,
  Pause,
  Pencil,
  Play,
  SlidersHorizontal,
  SkipForward,
  Sparkles,
  RotateCcw,
  Trash2,
  UserRound,
  Users,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import {
  deleteAllWallpaperFiles,
  deleteWallpaperFile,
  getImageWallpaperUrl,
  getLiveWallpaperUrl,
  getWallpaperKey,
  getWallpaperUrl,
  listWallpaperFiles,
  saveWallpaperLibraryFile,
  wallpaperKind,
  wallpaperMarker,
  type StoredWallpaper,
  type WallpaperKind,
  IMAGE_WALLPAPER_KEY,
  LIVE_WALLPAPER_KEY,
  IMAGE_WALLPAPER_MARKER,
  LIVE_WALLPAPER_MARKER,
} from "@/lib/wallpaperStorage";

const MAX_WALLPAPER_BYTES = 100_000_000;
const MAX_LIVE_WALLPAPER_BYTES = 100_000_000;
const DEFAULT_WALLPAPER_BLUR_AMOUNT = 24;
const MAX_WALLPAPER_BLUR_AMOUNT = 48;

type WallpaperLibraryEntry = StoredWallpaper & {
  url: string;
  kind: WallpaperKind;
};

const SHORTCUTS: [string, string][] = [
  ["Space", "Play / pause"],
  ["← / →", "Seek ±5s"],
  ["↑ / ↓", "Volume"],
  ["N / P", "Next / previous"],
  ["S", "Shuffle"],
  ["R", "Repeat"],
  ["M", "Mute"],
  ["Q", "Queue"],
  ["F", "Full-screen player"],
  ["L", "Like current song"],
  ["/", "Search"],
];

const FOCUS_LAYOUTS = [
  { id: "off", name: "No session", detail: "Standard navigation" },
  { id: "study", name: "Study", detail: "Wide and calm" },
  { id: "work", name: "Work", detail: "Compact and focused" },
  { id: "sleep", name: "Sleep", detail: "Dim with end-of-song stop" },
] as const;

/**
 * Ordered by how often a listener has a reason to open each category, and in
 * the SAME order the sections render. The two used to disagree — the rail
 * opened on Playback while the document started on Profile — so the
 * highlighted chip disagreed with the content on first paint.
 */
const SETTINGS_SECTIONS = [
  ["Playback", "settings-playback", Gauge],
  ["Audio", "settings-audio", SlidersHorizontal],
  ["Appearance", "settings-appearance", Palette],
  ["Personalize", "settings-personalization", Sparkles],
  ["Profile", "settings-profile", UserRound],
  ["Shortcuts", "settings-shortcuts", Keyboard],
  ["App", "settings-app", Download],
  ["Data", "settings-data", Database],
] as const;

type FocusLayout = (typeof FOCUS_LAYOUTS)[number]["id"];

function isFocusLayout(value: string | null): value is FocusLayout {
  return FOCUS_LAYOUTS.some((layout) => layout.id === value);
}

export function SettingsDialog({
  open,
  onOpenChange,
  onSignOut,
  pageMode = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the user signs out (navigates away from the app). */
  onSignOut?: () => void | Promise<void>;
  /** Render the same controls as a full authenticated page at /settings. */
  pageMode?: boolean;
}) {
  const { user } = useAuth();
  const updateName = useMutation(api.users.updateName);
  const updateImage = useMutation(api.users.updateImage);
  const clearHistory = useMutation(api.history.clearHistory);

  const rate = usePlayerStore((s) => s.rate);
  const crossfade = usePlayerStore((s) => s.crossfade);
  const setCrossfade = usePlayerStore((s) => s.setCrossfade);
  const transitionNote = usePlayerStore((s) => s.transitionNote);
  /** Live verdict for the boundary that is coming, not a replay of a log. */
  const [blendCheck, setBlendCheck] = useState<string | null>(null);
  /** Raw media-element state — the only honest answer to "why is it buffering". */
  const [playbackCheck, setPlaybackCheck] = useState<string | null>(null);
  const gapless = usePlayerStore((s) => s.gapless);
  const toggleGapless = usePlayerStore((s) => s.toggleGapless);
  const videoEnabled = usePlayerStore((s) => s.videoEnabled);
  const toggleVideo = usePlayerStore((s) => s.toggleVideo);
  const setRate = usePlayerStore((s) => s.setRate);
  const autoplay = usePlayerStore((s) => s.autoplay);
  const toggleAutoplay = usePlayerStore((s) => s.toggleAutoplay);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const smartShuffle = usePlayerStore((s) => s.smartShuffle);
  const toggleSmartShuffle = usePlayerStore((s) => s.toggleSmartShuffle);
  const introTrim = usePlayerStore((s) => s.introTrim);
  const toggleIntroTrim = usePlayerStore((s) => s.toggleIntroTrim);
  const sleepEndsAt = usePlayerStore((s) => s.sleepEndsAt);
  const sleepAtSongEnd = usePlayerStore((s) => s.sleepAtSongEnd);
  const sleepAtQueueEnd = usePlayerStore((s) => s.sleepAtQueueEnd);
  // Ticking clock for the preset highlight below. Reading `Date.now()` during
  // render made the check an impure render, and it went stale: the preset only
  // repainted when something else in the dialog changed, so a timer that had
  // counted down into the next bucket kept the old button lit.
  const sleepNow = useSleepCountdown(sleepEndsAt);
  const setSleepTimer = usePlayerStore((s) => s.setSleepTimer);
  const accentTheme = usePlayerStore((s) => s.accentTheme);
  const setAccentTheme = usePlayerStore((s) => s.setAccentTheme);
  const compactMode = usePlayerStore((s) => s.compactMode);
  const toggleCompactMode = usePlayerStore((s) => s.toggleCompactMode);
  const ambientGlow = usePlayerStore((s) => s.ambientGlow);
  const toggleAmbientGlow = usePlayerStore((s) => s.toggleAmbientGlow);
  const visualizerEnabled = usePlayerStore((s) => s.visualizerEnabled);
  const toggleVisualizer = usePlayerStore((s) => s.toggleVisualizer);
  const pointerEffects = usePlayerStore((s) => s.pointerEffects);
  const togglePointerEffects = usePlayerStore((s) => s.togglePointerEffects);
  const performanceMode = usePlayerStore((s) => s.performanceMode);
  const togglePerformanceMode = usePlayerStore((s) => s.togglePerformanceMode);
  const animationLevel = usePlayerStore((s) => s.animationLevel);
  const setAnimationLevel = usePlayerStore((s) => s.setAnimationLevel);
  const artistRepetition = usePlayerStore((s) => s.artistRepetition);
  const setArtistRepetition = usePlayerStore((s) => s.setArtistRepetition);
  const notificationsEnabled = usePlayerStore((s) => s.notificationsEnabled);
  const setNotificationsEnabled = usePlayerStore((s) => s.setNotificationsEnabled);
  const themeMode = usePlayerStore((s) => s.themeMode);
  const setThemeMode = usePlayerStore((s) => s.setThemeMode);
  const hideExplicit = usePlayerStore((s) => s.hideExplicit);
  const toggleHideExplicit = usePlayerStore((s) => s.toggleHideExplicit);
  const liquidGlass = usePlayerStore((s) => s.liquidGlass);
  const toggleLiquidGlass = usePlayerStore((s) => s.toggleLiquidGlass);
  const wallpaper = usePlayerStore((s) => s.wallpaper);
  const wallpaperType = usePlayerStore((s) => s.wallpaperType);
  const setWallpaper = usePlayerStore((s) => s.setWallpaper);
  const setWallpaperType = usePlayerStore((s) => s.setWallpaperType);
  const hideSidebarEmail = usePlayerStore((s) => s.hideSidebarEmail);
  const toggleHideSidebarEmail = usePlayerStore(
    (s) => s.toggleHideSidebarEmail,
  );
  const currentTrack = usePlayerStore((s) => s.current);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const next = usePlayerStore((s) => s.next);

  const [trackPalettes, setTrackPalettes] = useState(
    () => localStorage.getItem("ss.trackPalettes") !== "0",
  );
  const [settingsShimmer, setSettingsShimmer] = useState(
    () => localStorage.getItem("ss.settingsShimmer") !== "0",
  );
  const [settingsDepth, setSettingsDepth] = useState(
    () => localStorage.getItem("ss.settingsDepth") !== "0",
  );
  const [focusLayout, setFocusLayout] = useState<FocusLayout>(() => {
    const saved = localStorage.getItem("ss.focusLayout");
    if (isFocusLayout(saved)) return saved;
    return localStorage.getItem("ss.focusMode") === "1" ? "study" : "off";
  });
  const [name, setName] = useState("");
  const wallpaperInputRef = useRef<HTMLInputElement>(null);
  /** Cached bounds of the settings surface for the pointer handlers. Null means
   *  "not measured yet"; a window resize invalidates it. */
  const surfaceBoundsRef = useRef<DOMRect | null>(null);
  const pointerPositionRef = useRef({ x: 0, y: 0 });
  const glowTargetRef = useRef<HTMLDivElement | null>(null);
  const glowFrameRef = useRef<number | null>(null);
  const liveWallpaperInputRef = useRef<HTMLInputElement>(null);
  const [liveWallpaperFileName, setLiveWallpaperFileName] = useState("");
  const [wallpaperLibrary, setWallpaperLibrary] = useState<
    WallpaperLibraryEntry[]
  >([]);
  const [activeWallpaperKey, setActiveWallpaperKey] = useState<string | null>(
    () => getWallpaperKey(localStorage.getItem("ss.wallpaper")),
  );
  const wallpaperLibraryUrlsRef = useRef<string[]>([]);
  const [liveWallpaperUrl, setLiveWallpaperUrl] = useState(() => {
    const saved = localStorage.getItem("ss.wallpaper");
    return localStorage.getItem("ss.wallpaperType") === "video" &&
      saved?.startsWith("http")
      ? saved
      : "";
  });
  const [wallpaperEnabled, setWallpaperEnabled] = useState(
    () => localStorage.getItem("ss.wallpaperEnabled") !== "0",
  );
  const [wallpaperBlurAmount, setWallpaperBlurAmount] = useState(() => {
    const storedAmount = Number(localStorage.getItem("ss.wallpaperBlurAmount"));
    if (Number.isFinite(storedAmount) && storedAmount > 0) {
      return Math.min(MAX_WALLPAPER_BLUR_AMOUNT, Math.round(storedAmount));
    }
    return localStorage.getItem("ss.wallpaperBlur") === "0"
      ? 0
      : DEFAULT_WALLPAPER_BLUR_AMOUNT;
  });
  const [lowMemoryWallpaperPreviews, setLowMemoryWallpaperPreviews] = useState(
    () => localStorage.getItem("ss.lowMemoryWallpaperPreviews") !== "0",
  );

  const loadWallpaperLibrary = useCallback(async () => {
    const records = await listWallpaperFiles();
    const current = usePlayerStore.getState().wallpaper;
    const activeKey = getWallpaperKey(localStorage.getItem("ss.wallpaper"));
    const next = records.map((record) => ({
      ...record,
      kind: wallpaperKind(record),
      url:
        activeKey === record.key && current?.startsWith("blob:")
          ? current
          : URL.createObjectURL(record.blob),
    }));
    wallpaperLibraryUrlsRef.current.forEach((url) => {
      if (url !== current) URL.revokeObjectURL(url);
    });
    wallpaperLibraryUrlsRef.current = next.map((entry) => entry.url);
    setWallpaperLibrary(next);
    setActiveWallpaperKey(
      getWallpaperKey(localStorage.getItem("ss.wallpaper")),
    );
  }, []);

  useEffect(() => {
    if (!open) return;
    // Wallpaper library loading intentionally refreshes state when Settings
    // opens. The directive has to sit directly above the call that sets state:
    // an earlier version put it above the `if`, and when that block was
    // reformatted onto several lines the directive stopped applying — which is
    // why this showed up as a real error next to an "unused directive" warning.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadWallpaperLibrary().catch(() =>
      toast.error("Couldn't load saved wallpapers"),
    );
  }, [open, loadWallpaperLibrary]);

  useEffect(() => {
    const onTrackPaletteChange = (event: Event) => {
      const next = (event as CustomEvent<boolean>).detail;
      if (typeof next === "boolean") setTrackPalettes(next);
    };
    const onFocusLayoutChange = (event: Event) => {
      const next = (event as CustomEvent<string>).detail;
      if (isFocusLayout(next)) setFocusLayout(next);
    };
    window.addEventListener("synq:track-palettes-change", onTrackPaletteChange);
    window.addEventListener("synq:focus-layout-change", onFocusLayoutChange);
    return () => {
      window.removeEventListener(
        "synq:track-palettes-change",
        onTrackPaletteChange,
      );
      window.removeEventListener(
        "synq:focus-layout-change",
        onFocusLayoutChange,
      );
    };
  }, []);

  useEffect(() => {
    const onFocusLayoutChange = (event: Event) => {
      const next = (event as CustomEvent<string>).detail;
      if (!pageMode && isFocusLayout(next) && next !== "off")
        onOpenChange(false);
    };
    window.addEventListener("synq:focus-layout-change", onFocusLayoutChange);
    return () =>
      window.removeEventListener(
        "synq:focus-layout-change",
        onFocusLayoutChange,
      );
  }, [onOpenChange, pageMode]);

  // A resize under a stationary cursor fires no pointerenter, so the cached
  // bounds (and the glow that follows them) would stay offset by the size
  // delta until the pointer left and came back.
  useEffect(() => {
    const invalidateBounds = () => {
      surfaceBoundsRef.current = null;
    };
    window.addEventListener("resize", invalidateBounds);
    return () => {
      window.removeEventListener("resize", invalidateBounds);
      if (glowFrameRef.current !== null)
        cancelAnimationFrame(glowFrameRef.current);
    };
  }, []);

  useEffect(() => {
    return () => {
      const current = usePlayerStore.getState().wallpaper;
      wallpaperLibraryUrlsRef.current.forEach((url) => {
        if (url !== current) URL.revokeObjectURL(url);
      });
    };
  }, []);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [savingAvatar, setSavingAvatar] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  // Audio settings — persisted locally, applied live to the Web Audio graph.
  const [eq, setEq] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("ss.eq") ?? "{}") as {
        bass?: number;
        treble?: number;
        balance?: number;
        mono?: boolean;
        bands?: number[];
        filter?: AudioFilterId;
      };
      // Effects are session-scoped. Do not resurrect a previous Bass Boost
      // from localStorage while a new track is already playing.
      return { ...saved, filter: usePlayerStore.getState().audioFilter };
    } catch {
      return { filter: usePlayerStore.getState().audioFilter };
    }
  });
  const persistEq = (next: typeof eq) => {
    setEq(next);
    try {
      localStorage.setItem("ss.eq", JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  // Vibe settings (pitch / reverb / distortion) and loudness normalization —
  // same pattern as the EQ: persisted locally, applied live to the graph.
  const [pitch, setPitch] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("ss.pitch") ?? "{}") as {
        semitones?: number;
        preserve?: boolean;
      };
      return { semitones: saved.semitones ?? 0, preserve: saved.preserve ?? true };
    } catch {
      return { semitones: 0, preserve: true };
    }
  });
  const persistPitch = (next: typeof pitch) => {
    setPitch(next);
    try {
      localStorage.setItem("ss.pitch", JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };
  const [reverb, setReverb] = useState(() => {
    const saved = Number(localStorage.getItem("ss.reverb"));
    return Number.isFinite(saved) && saved > 0 ? Math.min(100, saved) : 0;
  });
  const persistReverb = (value: number) => {
    setReverb(value);
    try {
      localStorage.setItem("ss.reverb", String(value));
    } catch {
      /* ignore */
    }
  };
  const [distortion, setDistortionLevel] = useState(() => {
    const saved = Number(localStorage.getItem("ss.distortion"));
    return Number.isFinite(saved) && saved > 0 ? Math.min(100, saved) : 0;
  });
  const persistDistortion = (value: number) => {
    setDistortionLevel(value);
    try {
      localStorage.setItem("ss.distortion", String(value));
    } catch {
      /* ignore */
    }
  };
  const [normalize, setNormalize] = useState(
    () => localStorage.getItem("ss.normalize") === "1",
  );
  const persistNormalize = (value: boolean) => {
    setNormalize(value);
    try {
      localStorage.setItem("ss.normalize", value ? "1" : "0");
    } catch {
      /* ignore */
    }
  };

  // Keep the editable name in sync with the user. The reset is keyed by the
  // dialog OPENING (not by an in-render setState) and happens in the same
  // effect that reacts to the user changing, so no cascading render is
  // triggered from the effect body itself.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => setName(user?.name ?? ""));
    return () => cancelAnimationFrame(id);
  }, [open, user?.name]);

  // Resolve the current YouTube stream as soon as Settings opens. EQ playback
  // can then switch to the filtered audio path without waiting on a second
  // network round-trip when the user moves a slider.
  useEffect(() => {
    if (open && currentTrack?.youtubeId)
      prewarmYoutubeStream(currentTrack.youtubeId);
  }, [open, currentTrack?.youtubeId]);

  const displayName = user?.name ?? (user?.isAnonymous ? "Guest" : "Listener");
  const avatarInitials = displayName
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const saveName = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Name can't be empty");
      return;
    }
    if (trimmed === displayName) return;
    setSaving(true);
    try {
      await updateName({ name: trimmed });
      toast.success(`You're now known as ${trimmed}`);
    } catch {
      toast.error("Couldn't save your name — try again");
    } finally {
      setSaving(false);
    }
  };

  const handleSignOut = async () => {
    if (!onSignOut) return;
    setSigningOut(true);
    try {
      await onSignOut();
    } finally {
      setSigningOut(false);
    }
  };

  const handleClearHistory = async () => {
    setClearing(true);
    try {
      const n = await clearHistory({});
      clearPlayHistory();
      toast.success(
        `Cleared ${n} ${n === 1 ? "entry" : "entries"} from your history`,
      );
    } catch {
      toast.error("Couldn't clear history — try again");
    } finally {
      setClearing(false);
    }
  };

  const [exporting, setExporting] = useState(false);

  const handleAvatarChange = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Choose an image file for your profile picture");
      return;
    }
    if (file.size > 700_000) {
      toast.error("Profile picture must be smaller than 700 KB");
      return;
    }

    const reader = new FileReader();
    reader.onload = async () => {
      if (typeof reader.result !== "string") {
        toast.error("Couldn't read that image");
        return;
      }
      setSavingAvatar(true);
      try {
        await updateImage({ image: reader.result });
        toast.success("Profile picture updated");
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Couldn't update your profile picture",
        );
      } finally {
        setSavingAvatar(false);
      }
    };
    reader.onerror = () => toast.error("Couldn't read that image");
    reader.readAsDataURL(file);
  };

  const clearAvatar = async () => {
    setSavingAvatar(true);
    try {
      await updateImage({});
      toast("Profile picture removed");
    } catch {
      toast.error("Couldn't remove your profile picture");
    } finally {
      setSavingAvatar(false);
    }
  };

  const applyLiveWallpaper = () => {
    const value = liveWallpaperUrl.trim();
    if (!value) {
      toast.error("Paste a video URL first");
      return;
    }
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("unsupported protocol");
      }
    } catch {
      toast.error("Use a valid http(s) video URL");
      return;
    }
    setWallpaper(value, "video");
    localStorage.setItem("ss.savedVideoUrl", value);
    toast.success("Live wallpaper applied");
  };

  const handleLiveWallpaperFileChange = async (
    event: ChangeEvent<HTMLInputElement>,
  ) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (!file.type.startsWith("video/")) {
      toast.error("Choose a video file for your live wallpaper");
      return;
    }
    if (file.size > MAX_LIVE_WALLPAPER_BYTES) {
      toast.error("Live wallpaper videos must be smaller than 100 MB");
      return;
    }

    try {
      const record = await saveWallpaperLibraryFile(file);
      const url = await getWallpaperUrl(record.key);
      if (!url) throw new Error("Wallpaper file was not found after saving");
      if (
        wallpaper?.startsWith("blob:") &&
        !wallpaperLibraryUrlsRef.current.includes(wallpaper)
      ) {
        URL.revokeObjectURL(wallpaper);
      }
      setWallpaper(url, "video");
      localStorage.setItem("ss.wallpaper", wallpaperMarker(record.key));
      setActiveWallpaperKey(record.key);
      setLiveWallpaperFileName(file.name);
      setLiveWallpaperUrl("");
      await loadWallpaperLibrary();
      toast.success("Live wallpaper saved to your library");
    } catch {
      toast.error("Couldn't save that video — try a smaller file");
    }
  };

  const handleWallpaperChange = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Choose an image file for your wallpaper");
      return;
    }
    if (file.size > MAX_WALLPAPER_BYTES) {
      toast.error("Wallpapers must be smaller than 100 MB");
      return;
    }

    void saveWallpaperLibraryFile(file)
      .then(async (record) => {
        const url = await getWallpaperUrl(record.key);
        if (!url) throw new Error("Wallpaper file was not found after saving");
        if (
          wallpaper?.startsWith("blob:") &&
          !wallpaperLibraryUrlsRef.current.includes(wallpaper)
        ) {
          URL.revokeObjectURL(wallpaper);
        }
        setWallpaper(url, "image");
        localStorage.setItem("ss.wallpaper", wallpaperMarker(record.key));
        setActiveWallpaperKey(record.key);
        await loadWallpaperLibrary();
        toast.success("Wallpaper saved to your library");
      })
      .catch(() => {
        toast.error("Couldn't save that image — try a smaller file");
      });
  };

  const activateWallpaperEntry = (entry: WallpaperLibraryEntry) => {
    if (
      wallpaper?.startsWith("blob:") &&
      !wallpaperLibraryUrlsRef.current.includes(wallpaper)
    ) {
      URL.revokeObjectURL(wallpaper);
    }
    setWallpaper(entry.url, entry.kind);
    localStorage.setItem("ss.wallpaper", wallpaperMarker(entry.key));
    setActiveWallpaperKey(entry.key);
    toast.success(`${entry.name} applied`);
  };

  const removeWallpaperEntry = async (entry: WallpaperLibraryEntry) => {
    await deleteWallpaperFile(entry.key);
    if (wallpaperLibraryUrlsRef.current.includes(entry.url)) {
      URL.revokeObjectURL(entry.url);
      wallpaperLibraryUrlsRef.current = wallpaperLibraryUrlsRef.current.filter(
        (url) => url !== entry.url,
      );
    }
    if (activeWallpaperKey === entry.key) {
      setWallpaper(null, entry.kind);
      setActiveWallpaperKey(null);
      localStorage.removeItem("ss.wallpaper");
    }
    await loadWallpaperLibrary();
    toast.success(`${entry.name} removed`);
  };

  const resetVisualPreferences = () => {
    setAccentTheme("auto");
    setThemeMode("dark");
    setTrackPalettes(true);
    setSettingsShimmer(true);
    setSettingsDepth(true);
    // Motion budget lives in the store now, and its applier writes the legacy
    // `ss.reduceMotion` key too, so this is the only line the reset needs.
    setAnimationLevel("full");
    if (!liquidGlass) toggleLiquidGlass();
    if (
      usePlayerStore.getState().cardTransparency !== DEFAULT_CARD_TRANSPARENCY
    ) {
      usePlayerStore.getState().setCardTransparency(DEFAULT_CARD_TRANSPARENCY);
    }
    if (!ambientGlow) toggleAmbientGlow();
    if (!pointerEffects) togglePointerEffects();
    if (!visualizerEnabled) toggleVisualizer();
    if (performanceMode) togglePerformanceMode();
    localStorage.setItem("ss.accentTheme", "auto");
    localStorage.setItem("ss.themeMode", "dark");
    localStorage.setItem("ss.trackPalettes", "1");
    localStorage.setItem("ss.settingsShimmer", "1");
    localStorage.setItem("ss.settingsDepth", "1");
    localStorage.setItem("ss.liquidGlass", "1");
    localStorage.setItem("ss.ambientGlow", "1");
    localStorage.setItem("ss.pointerEffects", "1");
    localStorage.setItem("ss.visualizer", "1");
    localStorage.setItem("ss.performanceMode", "0");
    document.documentElement.classList.remove("no-glass", "reduce-motion");
    window.dispatchEvent(
      new CustomEvent("synq:track-palettes-change", { detail: true }),
    );
    toast.success("Visual preferences reset");
  };

  const clearWallpaper = () => {
    if (
      wallpaper?.startsWith("blob:") &&
      !wallpaperLibraryUrlsRef.current.includes(wallpaper)
    ) {
      URL.revokeObjectURL(wallpaper);
    }
    wallpaperLibraryUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    wallpaperLibraryUrlsRef.current = [];
    setWallpaperLibrary([]);
    setActiveWallpaperKey(null);
    void deleteAllWallpaperFiles();
    localStorage.removeItem("ss.savedImageWallpaper");
    localStorage.removeItem("ss.savedVideoUrl");
    setWallpaper(null, wallpaperType);
    setLiveWallpaperFileName("");
    toast("Wallpaper library removed");
  };

  /**
   * Go back to the stock SYNQ background without touching saved files.
   *
   * Deliberately non-destructive, unlike clearWallpaper: every pointer to the
   * active wallpaper is dropped and the blur returns to its default, but the
   * library stays in IndexedDB so the user can re-apply a wallpaper in one
   * click. It also has to clear the two "remembered for when you switch back"
   * keys — leaving them behind meant that switching to Photo after reverting
   * silently resurrected the wallpaper the user just reverted away from.
   */
  const revertWallpaper = () => {
    if (
      wallpaper?.startsWith("blob:") &&
      !wallpaperLibraryUrlsRef.current.includes(wallpaper)
    ) {
      URL.revokeObjectURL(wallpaper);
    }
    setActiveWallpaperKey(null);
    setLiveWallpaperFileName("");
    setLiveWallpaperUrl("");
    localStorage.removeItem("ss.savedImageWallpaper");
    localStorage.removeItem("ss.savedVideoUrl");
    // Clearing the value removes `ss.wallpaper` and writes `ss.wallpaperType`.
    setWallpaper(null, "image");
    setWallpaperType("image");
    setWallpaperBlurAmount(DEFAULT_WALLPAPER_BLUR_AMOUNT);
    localStorage.setItem("ss.wallpaperBlur", "1");
    localStorage.setItem(
      "ss.wallpaperBlurAmount",
      String(DEFAULT_WALLPAPER_BLUR_AMOUNT),
    );
    window.dispatchEvent(
      new CustomEvent("ss:wallpaper-blur-change", {
        detail: DEFAULT_WALLPAPER_BLUR_AMOUNT,
      }),
    );
    toast("Back to the default background");
  };

  // Section navigation. The hook owns which category is active, scrolls to
  // the one that was asked for, and cancels any animation still in flight when
  // a new chip is clicked. See the hook for what that fixes.
  const navStickyRef = useRef<HTMLElement | null>(null);
  const sectionIds = useMemo(() => SETTINGS_SECTIONS.map(([, id]) => id), []);
  const {
    activeId: activeSection,
    register: registerSection,
    goTo: goToSection,
  } = useSettingsNavigation({
    ids: sectionIds,
    // No `containerRef`: in page mode the panel is rendered inside the
    // shell's `<main>`, which is a DOM ancestor this component cannot hold a
    // ref to. It used to declare one, never attach it, and pass it along —
    // which read as "the container is handled" while every click silently fell
    // back to the nearest-scrollable-ancestor search. The hook does that
    // search properly now, and it walks past a non-scrolling wrapper to the
    // box whose `scrollTop` actually moves.
    stickyRef: navStickyRef,
    // Only the full settings page scrolls; the compact dialog is short
    // enough that the rail never needs to follow the reader.
    enabled: pageMode && open,
  });

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      modal={pageMode ? false : undefined}
    >
      <DialogContent
        hideOverlay={pageMode}
        showCloseButton={!pageMode}
        className={
          pageMode
            ? cn(
                /* `!max-h-none !overflow-y-visible` opt out of the base
                   DialogContent's viewport cap + scroll. In page mode this
                   panel is `!static` inside the shell's `<main>`, and
                   `jumpToSetting` scrolls `<main>` by hand — a second scroll
                   container here clipped the sections and broke that math. */
                "settings-page-grid liquid-glass settings-liquid-glass relative !static !top-auto !left-auto !z-10 !mx-auto !grid !w-full !max-w-5xl !max-h-none !translate-x-0 !translate-y-0 !gap-0 !overflow-y-visible !rounded-3xl !border !border-white/10 !p-3.5 !shadow-xl sm:!p-8",
                settingsShimmer
                  ? "settings-glass-shimmer"
                  : "settings-glass-still",
                settingsDepth && "settings-glass-depth",
              )
            : /* 85dvh, not 85vh: `vh` ignores the collapsing browser chrome, so
               on a phone the dialog ran off under the URL bar. */
              "glass-card !fixed max-h-[85dvh] max-w-md overflow-y-auto"
        }
        onPointerEnter={(event) => {
          if (pointerEffects && event.pointerType !== "touch") {
            // Re-measure on enter: the window can have been resized while this
            // surface was open, and a stale rect would offset the glow.
            surfaceBoundsRef.current =
              event.currentTarget.getBoundingClientRect();
            event.currentTarget.style.setProperty("--pointer-opacity", "1");
          }
        }}
        onPointerMove={(event) => {
          if (!pointerEffects || event.pointerType === "touch") return;
          // Cached, not measured per event: this surface has five blurred
          // sheets on it, so a forced layout read on every pointer move is
          // exactly the kind of cost the pointer effects are meant to avoid.
          if (surfaceBoundsRef.current === null) {
            surfaceBoundsRef.current =
              event.currentTarget.getBoundingClientRect();
          }
          const rect = surfaceBoundsRef.current;
          pointerPositionRef.current = {
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
          };
          glowTargetRef.current = event.currentTarget;
          // Batched to one write per frame: pointermove can fire far more
          // often than the display refreshes, and every custom-property write
          // invalidates style for the glow.
          if (glowFrameRef.current !== null) return;
          glowFrameRef.current = requestAnimationFrame(() => {
            glowFrameRef.current = null;
            const target = glowTargetRef.current;
            const { x, y } = pointerPositionRef.current;
            if (!target) return;
            target.style.setProperty("--pointer-x", `${x}px`);
            target.style.setProperty("--pointer-y", `${y}px`);
          });
        }}
        onPointerLeave={(event) => {
          event.currentTarget.style.setProperty("--pointer-opacity", "0");
        }}
      >
        {pointerEffects && (
          <div
            className="settings-pointer-glow pointer-glow pointer-events-none absolute inset-0"
            aria-hidden="true"
          />
        )}
        <DialogHeader className="settings-header">
          {pageMode && (
            <Link
              to="/home"
              className="mb-1 inline-flex w-fit items-center text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground"
            >
              ← Back to listening
            </Link>
          )}
          <DialogTitle className="font-display">Settings</DialogTitle>
          <DialogDescription>
            Profile, playback and data preferences.
          </DialogDescription>
        </DialogHeader>

        <nav
          ref={navStickyRef}
          className={cn(
            "settings-jump-bar settings-jump-glass relative z-30 -mx-1 rounded-2xl border border-white/[0.14] px-1 py-2",
            pageMode ? "!sticky top-3 z-50" : "sticky top-0 bg-white/[0.03]",
          )}
          aria-label="Settings sections"
        >
          {/* `pb-2.5` reserves a band for the 8px `.slider-rail` scrollbar so it
                stops riding over the jump chips. */}
          <div className="settings-jump-rail slider-rail flex items-center gap-2 overflow-x-auto pt-0.5 pb-2.5">
            <span className="settings-jump-label hidden shrink-0 px-1 text-[10px] font-semibold tracking-widest text-foreground/70 uppercase sm:block">
              Jump to
            </span>
            {/* The section chips are the jump control on every screen size. On a
                phone the rail scrolls sideways inside the bar (`slider-rail`)
                so the page itself never gains a horizontal scrollbar. */}
            <div className="settings-jump-list flex shrink-0 gap-1">
              {SETTINGS_SECTIONS.map(([label, id, Icon]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => goToSection(id)}
                  aria-current={activeSection === id ? "true" : undefined}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-transparent px-2.5 py-1.5 text-[11px] font-semibold text-foreground/70 transition-colors hover:border-white/15 hover:bg-white/[0.07] hover:text-foreground",
                    activeSection === id &&
                      "settings-tab-active border-white/15 bg-white/[0.09] text-foreground",
                    // Keyboard shortcuts are a pointer-and-keyboard feature:
                    // no tab, no panel, nothing to tap on a phone. The cutoff is
                    // `lg`, not `md`, because a phone in landscape is wider than
                    // 768px and would otherwise get the whole keyboard UI back.
                    label === "Shortcuts" && "hidden lg:inline-flex",
                  )}
                >
                  <Icon className="size-3" />
                  {label}
                </button>
              ))}
            </div>
          </div>
        </nav>

        {/* playback */}
        <section
          id="settings-playback"
          ref={registerSection("settings-playback")}
          className="scroll-mt-20 flex flex-col gap-2.5"
        >
          <p className="flex items-center gap-1.5 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
            <Gauge className="size-3.5" />
            Playback
          </p>

          {currentTrack && (
            <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] p-3">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Now playing</p>
                  <p className="text-xs text-muted-foreground">
                    Quick controls without leaving Settings
                  </p>
                </div>
                <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-[rgb(var(--tint))]">
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      isPlaying
                        ? "animate-pulse bg-[rgb(var(--tint))]"
                        : "bg-white/30",
                    )}
                  />
                  {isPlaying ? "Live" : "Paused"}
                </span>
              </div>
              <div className="flex items-center gap-3">
                {currentTrack.coverUrl ? (
                  <img
                    src={currentTrack.coverUrl}
                    alt=""
                    className="size-12 shrink-0 rounded-lg object-cover shadow-md"
                  />
                ) : (
                  <div className="size-12 shrink-0 rounded-lg bg-white/[0.08]" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">
                    {currentTrack.title}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {currentTrack.artistName}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={togglePlay}
                  aria-label={
                    isPlaying ? "Pause current track" : "Play current track"
                  }
                  className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[rgb(var(--tint))] text-black transition-transform hover:scale-105 active:scale-95"
                >
                  {isPlaying ? (
                    <Pause className="size-4 fill-current" />
                  ) : (
                    <Play className="size-4 fill-current" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={next}
                  aria-label="Skip to next track"
                  className="flex size-9 shrink-0 items-center justify-center rounded-full border border-white/10 text-muted-foreground transition-colors hover:border-white/25 hover:text-foreground"
                >
                  <SkipForward className="size-4" />
                </button>
              </div>
            </div>
          )}

          <ToggleRow
            label="Shuffle by default"
            description="Start queues shuffled"
            on={shuffle}
            onToggle={toggleShuffle}
          />
          <ToggleRow
            label="Smart shuffle"
            description="Avoid recently played tracks when filling shuffle queues"
            on={smartShuffle}
            onToggle={() => {
              toggleSmartShuffle();
              toast(smartShuffle ? "Smart shuffle off" : "Smart shuffle on");
            }}
          />
          {/* Artist-repetition control: Off / Balanced / Strict. Complements
              smart shuffle — that avoids the same TRACK, this spreads ARTISTS
              out so a shuffle cannot play one artist three songs in a row. */}
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5">
            <div className="flex items-center gap-2">
              <Users className="size-4 text-[rgb(var(--tint))]" />
              <div className="min-w-0">
                <p className="text-sm font-medium">Artist repetition</p>
                <p className="text-xs text-muted-foreground">
                  {ARTIST_REPETITION_META[artistRepetition].description}
                </p>
              </div>
            </div>
            <div
              role="radiogroup"
              aria-label="Artist repetition"
              className="mt-2 flex gap-1 rounded-lg border border-white/10 bg-white/[0.02] p-1"
            >
              {ARTIST_REPETITION_LEVELS.map((level) => (
                <button
                  key={level}
                  type="button"
                  role="radio"
                  aria-checked={artistRepetition === level}
                  onClick={() => {
                    setArtistRepetition(level);
                    toast(`Artist repetition: ${ARTIST_REPETITION_META[level].label}`);
                  }}
                  className={cn(
                    "flex-1 rounded-md px-2 py-1.5 text-xs font-semibold transition-colors",
                    artistRepetition === level
                      ? "bg-[rgb(var(--tint))] text-black"
                      : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground",
                  )}
                >
                  {ARTIST_REPETITION_META[level].label}
                </button>
              ))}
            </div>
          </div>

          {/* Web notifications. The toggle is the ONLY place permission is
              requested, and only after an explicit click — never on load. */}
          <ToggleRow
            label="Track-change notifications"
            description={
              !notificationsSupported()
                ? "Not supported in this browser"
                : notificationPermission() === "denied"
                  ? "Blocked in your browser settings"
                  : "Show what's playing when you're in another tab"
            }
            on={notificationsEnabled}
            onToggle={() => {
              void (async () => {
                if (notificationsEnabled) {
                  setNotificationsEnabled(false);
                  toast("Track notifications off");
                  return;
                }
                const permission = await requestNotificationPermission();
                if (permission !== "granted") {
                  toast.error("Allow notifications in your browser to use this");
                  return;
                }
                setNotificationsEnabled(true);
                toast("Track notifications on");
              })();
            }}
          />
          <ToggleRow
            label="Smart intro trim"
            description="Skip the silent lead-in on cinematic and visualiser uploads. Works on streams that play through the audio pipeline; the player bar keeps a manual skip button for everything else."
            on={introTrim}
            onToggle={() => {
              toggleIntroTrim();
              // The trim listens to the Web Audio analyser, and an
              // AudioContext can only be created inside a user gesture. This
              // click is that gesture, so build the graph now instead of
              // waiting for the probe to fail on its own.
              if (!introTrim) ensureGraph();
              toast(introTrim ? "Smart intro trim off" : "Smart intro trim on");
            }}
          />

          <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5">
            <div className="flex items-center gap-2">
              <Clock3 className="size-4 text-[rgb(var(--tint))]" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">Sleep timer</p>
                <p className="text-xs text-muted-foreground">
                  Stop playback automatically
                </p>
              </div>
              {sleepAtSongEnd || sleepAtQueueEnd || sleepEndsAt !== null ? (
                <span className="text-[10px] font-semibold uppercase tracking-widest text-[rgb(var(--tint))]">
                  Active
                </span>
              ) : null}
            </div>
            <div className="mt-2.5 grid grid-cols-3 gap-1.5">
              {[
                { label: "Off", value: null },
                { label: "Song end", value: "end" as const },
                { label: "Queue end", value: "queue" as const },
                { label: "5 min", value: 5 },
                { label: "10 min", value: 10 },
                { label: "15 min", value: 15 },
                { label: "30 min", value: 30 },
                { label: "45 min", value: 45 },
                { label: "60 min", value: 60 },
              ].map((option) => {
                const active =
                  option.value === null
                    ? sleepEndsAt === null &&
                      !sleepAtSongEnd &&
                      !sleepAtQueueEnd
                    : option.value === "end"
                      ? sleepAtSongEnd
                      : option.value === "queue"
                        ? sleepAtQueueEnd
                        : // Compared against the ticking clock, not a value
                          // captured once: a timer that counted down into the
                          // next bucket has to move the highlight with it.
                          sleepEndsAt !== null &&
                          sleepEndsAt - sleepNow > (option.value - 1) * 60_000 &&
                          sleepEndsAt - sleepNow < (option.value + 1) * 60_000;
                return (
                  <button
                    key={option.label}
                    type="button"
                    onClick={() => {
                      setSleepTimer(option.value);
                      toast(
                        option.value === null
                          ? "Sleep timer off"
                          : option.value === "end"
                            ? "Stopping after this song"
                            : option.value === "queue"
                              ? "Stopping at the end of the queue"
                              : `Sleep timer set for ${option.value} minutes`,
                      );
                    }}
                    className={cn(
                      "rounded-lg border px-2 py-1.5 text-[11px] font-semibold transition-colors",
                      active
                        ? "border-[rgb(var(--tint))] bg-[rgb(var(--tint)_/_0.14)] text-[rgb(var(--tint))]"
                        : "border-white/10 text-muted-foreground hover:border-white/25 hover:text-foreground",
                    )}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* default playback speed */}
          <div className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium">Default speed</p>
              <p className="text-xs text-muted-foreground">
                Applies to new tracks
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {[0.75, 1, 1.25, 1.5].map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setRate(r)}
                  className={cn(
                    "rounded-full px-2 py-1 text-[11px] font-semibold tabular-nums transition-colors",
                    rate === r
                      ? "bg-[rgb(var(--tint)_/_0.2)] text-[rgb(var(--tint))]"
                      : "text-muted-foreground hover:bg-white/[0.06] hover:text-foreground",
                  )}
                >
                  {r}×
                </button>
              ))}
            </div>
          </div>
        </section>

        <Separator className="bg-white/[0.07]" />

        {/* audio */}
        <section
          id="settings-audio"
          ref={registerSection("settings-audio")}
          className="scroll-mt-20 flex flex-col gap-2.5"
        >
          <p className="flex items-center gap-1.5 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
            <SlidersHorizontal className="size-3.5" />
            Audio
          </p>

          {/* crossfade — blends one song into the next */}
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">Crossfade</p>
                <p className="text-xs text-muted-foreground">
                  Blend the end of one song into the next
                </p>
              </div>
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-widest text-[rgb(var(--tint))] tabular-nums">
                {crossfade === 0 ? "Off" : `${crossfade}s`}
              </span>
            </div>
            <div
              role="radiogroup"
              aria-label="Crossfade duration"
              className="mt-2.5 grid grid-cols-6 gap-1"
            >
              {CROSSFADE_CHOICES.map((seconds) => (
                <button
                  key={seconds}
                  type="button"
                  role="radio"
                  aria-checked={crossfade === seconds}
                  onClick={() => {
                    setCrossfade(seconds);
                    toast(
                      seconds === 0
                        ? "Crossfade off"
                        : `Crossfade set to ${seconds} seconds`,
                    );
                  }}
                  className={cn(
                    "rounded-lg border px-1 py-1.5 text-[11px] font-semibold tabular-nums transition-colors",
                    crossfade === seconds
                      ? "border-[rgb(var(--tint))] bg-[rgb(var(--tint)_/_0.14)] text-[rgb(var(--tint))]"
                      : "border-white/10 text-muted-foreground hover:border-white/25 hover:text-foreground",
                  )}
                >
                  {seconds === 0 ? "Off" : `${seconds}s`}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground/80">
              Crossfading needs both songs playing through the audio pipeline.
              Songs served by the YouTube player keep their gapless boundary
              instead.
            </p>

            {/*
              Why this control exists: a crossfade that does not run is
              invisible. There is no overlap, no error and no message, so the
              only observable is the absence of a fade — which looks identical
              whether the planner said no, the browser could not build the audio
              graph, or nothing was queued. These two lines name both: what the
              last boundary actually did, and whether the NEXT one can blend.
            */}
            <div className="mt-2.5 flex flex-col gap-2 rounded-lg border border-white/[0.06] bg-black/20 px-2.5 py-2">
              <p className="text-[11px] leading-relaxed text-muted-foreground/90">
                <span className="font-semibold text-foreground/80">
                  Last change:
                </span>{" "}
                {transitionNote ?? "Nothing yet — let a track finish first."}
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setBlendCheck(crossfadeSelfTest())}
                  className="shrink-0 rounded-md border border-white/10 px-2 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-white/25 hover:text-foreground"
                >
                  Check blending here
                </button>
                <button
                  type="button"
                  onClick={() => setPlaybackCheck(playbackSelfTest())}
                  className="shrink-0 rounded-md border border-white/10 px-2 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-white/25 hover:text-foreground"
                >
                  Report playback state
                </button>
                {blendCheck && (
                  <p className="min-w-0 text-[11px] leading-relaxed text-foreground/75">
                    {blendCheck}
                  </p>
                )}
              </div>
              {playbackCheck && (
                <p className="text-[11px] leading-relaxed break-words text-foreground/75">
                  {playbackCheck}
                </p>
              )}
            </div>
          </div>

          <ToggleRow
            label="Gapless playback"
            description="Start the next track the moment this one stops, with no added silence. Albums and live sets are unaffected by the crossfade setting."
            on={gapless}
            onToggle={() => {
              toggleGapless();
              toast(gapless ? "Gapless playback off" : "Gapless playback on");
            }}
          />

          <ToggleRow
            label="Video preview"
            description="Allow the live video in the maximized player when a song plays from YouTube. The player has its own Video button for hiding the picture without changing this. Leave it off for an audio-only player — useful if a browser extension blocks embedded videos."
            on={videoEnabled}
            onToggle={() => {
              toggleVideo();
              toast(videoEnabled ? "Video preview hidden" : "Video preview on");
            }}
          />

          {/* presets */}
          <div className="flex flex-wrap gap-1.5">
            {[
              { label: "Flat", bass: 0, treble: 0 },
              { label: "Bass Boost", bass: 10, treble: 0 },
              { label: "Treble Boost", bass: 0, treble: 8 },
              { label: "Vocal", bass: -3, treble: 5 },
              { label: "Rock", bass: 5, treble: 4 },
              { label: "Pop", bass: 3, treble: 3 },
              { label: "Classical", bass: 1, treble: 2 },
              { label: "Electronic", bass: 8, treble: 3 },
            ].map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => {
                  applyEqPreset({ bass: p.bass, treble: p.treble });
                  persistEq({ ...eq, bass: p.bass, treble: p.treble });
                  toast(`EQ preset: ${p.label}`);
                }}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-semibold transition-colors",
                  eq.bass === p.bass && eq.treble === p.treble
                    ? "border-transparent bg-[rgb(var(--tint)_/_0.2)] text-[rgb(var(--tint))]"
                    : "border-white/10 text-muted-foreground hover:border-white/30 hover:text-foreground",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* bass */}
          <EqSlider
            label="Bass"
            value={eq.bass ?? 0}
            onChange={(v) => {
              setEqBass(v);
              persistEq({ ...eq, bass: v });
              if (v !== 0) toast(AUDIO_EFFECT_DELAY_MESSAGE);
            }}
          />
          <EqSlider
            label="Treble"
            value={eq.treble ?? 0}
            onChange={(v) => {
              setEqTreble(v);
              persistEq({ ...eq, treble: v });
            }}
          />
          <EqSlider
            label="Balance"
            min={-1}
            max={1}
            step={0.1}
            value={eq.balance ?? 0}
            format={(v) =>
              v === 0
                ? "Center"
                : v < 0
                  ? `L ${Math.round(-v * 100)}%`
                  : `R ${Math.round(v * 100)}%`
            }
            onChange={(v) => {
              setEqBalance(v);
              persistEq({ ...eq, balance: v });
            }}
          />

          <ToggleRow
            label="Mono audio"
            description="Same signal in both ears — good for single-ear listening"
            on={eq.mono ?? false}
            onToggle={() => {
              const next = !(eq.mono ?? false);
              setEqMono(next);
              persistEq({ ...eq, mono: next });
              if (next) toast(AUDIO_EFFECT_DELAY_MESSAGE);
            }}
          />

          {/* 10-band graphic EQ */}
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-sm font-medium">10-band equalizer</p>
              <button
                type="button"
                onClick={() => {
                  resetEqBands();
                  persistEq({
                    ...eq,
                    bands: EQ_BAND_FREQUENCIES.map(() => 0),
                  });
                  toast("EQ bands reset");
                }}
                className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
              >
                Reset
              </button>
            </div>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Fine control across the spectrum. Composes with the Bass/Treble
              sliders and sound effects.
            </p>
            <div className="mt-3 grid grid-cols-10 items-end gap-1.5">
              {EQ_BAND_FREQUENCIES.map((freq, index) => {
                const value = eq.bands?.[index] ?? 0;
                return (
                  <div
                    key={freq}
                    className="flex flex-col items-center gap-1"
                  >
                    <span className="text-[9px] tabular-nums text-muted-foreground/70">
                      {value > 0 ? `+${Math.round(value)}` : Math.round(value)}
                    </span>
                    <Slider
                      orientation="vertical"
                      min={EQ_BAND_MIN_DB}
                      max={EQ_BAND_MAX_DB}
                      step={1}
                      value={[value]}
                      onValueChange={(values) => {
                        const next = values[0] ?? 0;
                        setEqBand(index, next);
                        const bands = [...(eq.bands ?? EQ_BAND_FREQUENCIES.map(() => 0))];
                        bands[index] = next;
                        persistEq({ ...eq, bands });
                      }}
                      aria-label={`${freq} hertz band`}
                      className="h-24 w-4 data-[orientation=vertical]:min-h-24"
                    />
                    <span className="text-[9px] text-muted-foreground/70">
                      {freq >= 1000 ? `${freq / 1000}k` : freq}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* pitch / vibe */}
          <EqSlider
            label="Pitch"
            min={-12}
            max={12}
            step={1}
            value={pitch.semitones}
            format={(v) => (v === 0 ? "Original key" : `${v > 0 ? "+" : ""}${v} semitones`)}
            onChange={(v) => {
              setDeckPitch(v);
              persistPitch({ ...pitch, semitones: v });
              if (v !== 0) toast(AUDIO_EFFECT_DELAY_MESSAGE);
            }}
          />
          <ToggleRow
            label="Speed keeps the key"
            description="When on, changing playback speed preserves pitch. When off, speeding up raises it (the classic Nightcore / slowed mechanism)."
            on={pitch.preserve}
            onToggle={() => {
              const next = !pitch.preserve;
              setRatePreservesPitch(next);
              persistPitch({ ...pitch, preserve: next });
              if (!next) toast(AUDIO_EFFECT_DELAY_MESSAGE);
            }}
          />
          <EqSlider
            label="Reverb"
            min={0}
            max={100}
            value={reverb}
            format={(v) => (v === 0 ? "Dry" : `${Math.round(v)}% room`)}
            onChange={(v) => {
              setReverbMix(v / 100);
              persistReverb(v);
            }}
          />
          <EqSlider
            label="Distortion"
            min={0}
            max={100}
            value={distortion}
            format={(v) => (v === 0 ? "Clean" : `${Math.round(v)}% drive`)}
            onChange={(v) => {
              setDistortion(v);
              persistDistortion(v);
            }}
          />
          <ToggleRow
            label="Volume normalization"
            description="Keeps loud and quiet songs near the same level by steering the gain toward a target loudness, with a limiter catching peaks."
            on={normalize}
            onToggle={() => {
              const next = !normalize;
              setVolumeNormalization(next);
              persistNormalize(next);
              if (next) toast(AUDIO_EFFECT_DELAY_MESSAGE);
            }}
          />

          {/* vibe presets — one press composes speed/pitch/reverb/distortion */}
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5">
            <p className="text-sm font-medium">Vibe presets</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/80">
              One press sets speed, pitch, reverb and drive together. The
              playback speed menu still shows the result.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {[
                {
                  label: "Clean",
                  apply: () => {
                    setRate(1);
                    setDeckPitch(0);
                    setRatePreservesPitch(true);
                    setReverbMix(0);
                    setDistortion(0);
                    persistPitch({ semitones: 0, preserve: true });
                    persistReverb(0);
                    persistDistortion(0);
                  },
                },
                {
                  label: "Nightcore",
                  apply: () => {
                    setRate(1.25);
                    setRatePreservesPitch(false);
                    setDeckPitch(0);
                    setReverbMix(0);
                    setDistortion(0);
                    persistPitch({ semitones: 0, preserve: false });
                    persistReverb(0);
                    persistDistortion(0);
                  },
                },
                {
                  label: "Slowed + Reverb",
                  apply: () => {
                    setRate(0.85);
                    setRatePreservesPitch(true);
                    setDeckPitch(0);
                    setReverbMix(0.35);
                    setDistortion(0);
                    persistPitch({ semitones: 0, preserve: true });
                    persistReverb(35);
                    persistDistortion(0);
                  },
                },
                {
                  label: "Speed up",
                  apply: () => {
                    setRate(1.15);
                    setRatePreservesPitch(true);
                    setDeckPitch(0);
                    setReverbMix(0);
                    setDistortion(0);
                    persistPitch({ semitones: 0, preserve: true });
                    persistReverb(0);
                    persistDistortion(0);
                  },
                },
                {
                  label: "Daycore",
                  apply: () => {
                    setRate(0.75);
                    setRatePreservesPitch(false);
                    setDeckPitch(-2);
                    setReverbMix(0.25);
                    setDistortion(0);
                    persistPitch({ semitones: -2, preserve: false });
                    persistReverb(25);
                    persistDistortion(0);
                  },
                },
              ].map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => {
                    preset.apply();
                    toast(`Vibe: ${preset.label}`);
                  }}
                  className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-white/30 hover:text-foreground"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          {/* live sound filters (8D etc.) */}
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5">
            <p className="text-sm font-medium">Sound effects</p>
            <p className="text-xs text-muted-foreground">
              Applies to what's playing right now
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/80">
              Turning on sound effects may add a small delay before music
              starts.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {AUDIO_FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => {
                    if (setAudioFilter(f.id)) {
                      persistEq({ ...eq, filter: f.id });
                      if (f.id !== "off") toast(AUDIO_EFFECT_DELAY_MESSAGE);
                    } else toast.error("Effects need a browser with Web Audio");
                  }}
                  className={cn(
                    "flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors",
                    (eq.filter ?? "off") === f.id
                      ? "border-transparent bg-[rgb(var(--tint)_/_0.2)] text-[rgb(var(--tint))]"
                      : "border-white/10 text-muted-foreground hover:border-white/30 hover:text-foreground",
                  )}
                >
                  <span>{f.icon}</span>
                  {f.label}
                </button>
              ))}
            </div>
          </div>
        </section>

        <Separator className="bg-white/[0.07]" />

        {/* appearance */}
        <section
          id="settings-appearance"
          ref={registerSection("settings-appearance")}
          className="scroll-mt-20 flex flex-col gap-2.5"
        >
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-3">
            <div className="mb-2 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold">Interface finish</p>
                <p className="text-xs text-muted-foreground">
                  Tune the light and depth of this settings surface.
                </p>
              </div>
              <Sparkles className="size-4 text-[rgb(var(--tint))]" />
            </div>
            <div className="flex flex-col gap-2">
              <ToggleRow
                label="Animated glass sheen"
                description="Let light drift across the settings surface"
                on={settingsShimmer}
                onToggle={() => {
                  const next = !settingsShimmer;
                  setSettingsShimmer(next);
                  localStorage.setItem("ss.settingsShimmer", next ? "1" : "0");
                  toast(next ? "Settings sheen on" : "Settings sheen paused");
                }}
              />
              <p className="px-1 text-[11px] leading-relaxed text-muted-foreground/80">
                The animated sheen may pause or appear static when Reduce motion
                is turned on.
              </p>
              <ToggleRow
                label="Deep surface depth"
                description="Add a softer floating shadow beneath the glass"
                on={settingsDepth}
                onToggle={() => {
                  const next = !settingsDepth;
                  setSettingsDepth(next);
                  localStorage.setItem("ss.settingsDepth", next ? "1" : "0");
                  toast(next ? "Surface depth on" : "Surface depth off");
                }}
              />
              {/* Animations: Full / Reduced / Off. Replaces the older
                  Reduce-motion boolean with the three levels the rest of the
                  app now understands — and it is a store setting, so it
                  applies from boot, not only while this dialog is open. */}
              <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5">
                <p className="text-sm font-medium">Animations</p>
                <p className="text-xs text-muted-foreground">
                  {ANIMATION_LEVEL_META[animationLevel].description}
                </p>
                <div
                  role="radiogroup"
                  aria-label="Animation level"
                  className="mt-2 flex gap-1 rounded-lg border border-white/10 bg-white/[0.02] p-1"
                >
                  {ANIMATION_LEVELS.map((level) => (
                    <button
                      key={level}
                      type="button"
                      role="radio"
                      aria-checked={animationLevel === level}
                      onClick={() => {
                        setAnimationLevel(level);
                        toast(
                          `Animations ${ANIMATION_LEVEL_META[level].label.toLowerCase()}`,
                        );
                      }}
                      className={cn(
                        "flex-1 rounded-md px-2 py-1.5 text-xs font-semibold transition-colors",
                        animationLevel === level
                          ? "bg-[rgb(var(--tint))] text-black"
                          : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground",
                      )}
                    >
                      {ANIMATION_LEVEL_META[level].label}
                    </button>
                  ))}
                </div>
              </div>
              <button
                type="button"
                onClick={resetVisualPreferences}
                className="mt-1 inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-muted-foreground transition-colors hover:border-white/25 hover:bg-white/[0.05] hover:text-foreground"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Reset visual preferences
              </button>
            </div>
          </div>
          <p className="flex items-center gap-1.5 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
            <Palette className="size-3.5" />
            Appearance
          </p>

          <PresetSelector />

          <Separator className="my-3 bg-white/[0.07]" />

          <ToggleRow
            label="Adaptive track palettes"
            description="Build a smooth new color theme from every song's artwork"
            on={trackPalettes}
            onToggle={() => {
              const next = !trackPalettes;
              setTrackPalettes(next);
              if (next) setAccentTheme("auto");
              localStorage.setItem("ss.trackPalettes", next ? "1" : "0");
              window.dispatchEvent(
                new CustomEvent("synq:track-palettes-change", { detail: next }),
              );
              toast(next ? "Track palettes on" : "Track palettes off");
            }}
          />

          {/* accent color */}
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">Accent color</p>
                <p className="text-xs text-muted-foreground">
                  Tints buttons, highlights and the ambient glow
                </p>
              </div>
            </div>
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              {(
                [
                  {
                    id: "auto",
                    label: "Auto",
                    swatch: "linear-gradient(135deg,#f472b6,#60a5fa,#a3e635)",
                  },
                  { id: "lime", label: "Lime", swatch: "rgb(203 244 143)" },
                  { id: "violet", label: "Violet", swatch: "rgb(167 139 250)" },
                  { id: "blue", label: "Blue", swatch: "rgb(96 165 250)" },
                  { id: "rose", label: "Rose", swatch: "rgb(251 113 133)" },
                  { id: "amber", label: "Amber", swatch: "rgb(251 191 36)" },
                  { id: "teal", label: "Teal", swatch: "rgb(45 212 191)" },
                  { id: "orange", label: "Orange", swatch: "rgb(251 146 60)" },
                ] as const
              ).map(({ id, label, swatch }) => (
                <button
                  key={id}
                  type="button"
                  title={label}
                  onClick={() => {
                    setAccentTheme(id);
                    const adaptive = id === "auto";
                    setTrackPalettes(adaptive);
                    localStorage.setItem(
                      "ss.trackPalettes",
                      adaptive ? "1" : "0",
                    );
                    window.dispatchEvent(
                      new CustomEvent("synq:track-palettes-change", {
                        detail: adaptive,
                      }),
                    );
                  }}
                  className={cn(
                    "flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-semibold transition-all",
                    accentTheme === id
                      ? "border-white/60 bg-white/[0.1] text-foreground"
                      : "border-white/10 text-muted-foreground hover:border-white/30",
                  )}
                >
                  <span
                    className="size-4 rounded-full ring-1 ring-white/20"
                    style={{ background: swatch }}
                  />
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* theme mode */}
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5">
            <p className="text-sm font-medium">Theme</p>
            <div className="mt-2 grid grid-cols-3 gap-1.5">
              {(
                [
                  { id: "dark", label: "Dark" },
                  { id: "light", label: "Light" },
                  { id: "amoled", label: "AMOLED" },
                ] as const
              ).map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setThemeMode(id)}
                  className={cn(
                    "rounded-lg border px-2 py-1.5 text-xs font-semibold transition-colors",
                    themeMode === id
                      ? "border-[rgb(var(--tint))] bg-[rgb(var(--tint)_/_0.14)] text-[rgb(var(--tint))]"
                      : "border-white/10 text-muted-foreground hover:border-white/30 hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <ToggleRow
            label="Personal wallpaper"
            description="Show your saved image or video behind the app"
            on={wallpaperEnabled}
            onToggle={() => {
              const next = !wallpaperEnabled;
              setWallpaperEnabled(next);
              localStorage.setItem("ss.wallpaperEnabled", next ? "1" : "0");
              window.dispatchEvent(
                new CustomEvent("ss:wallpaper-enabled-change", {
                  detail: next,
                }),
              );
              toast(next ? "Personal wallpaper on" : "Personal wallpaper off");
            }}
          />

          {/* personal wallpaper */}
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5">
            <div className="flex items-center gap-3">
              <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-black/20">
                {wallpaper &&
                wallpaperType === "video" &&
                wallpaper !== LIVE_WALLPAPER_MARKER ? (
                  <video
                    src={wallpaper}
                    muted
                    loop
                    autoPlay
                    playsInline
                    className="size-full object-cover"
                  />
                ) : wallpaper &&
                  wallpaper !== LIVE_WALLPAPER_MARKER &&
                  wallpaper !== IMAGE_WALLPAPER_MARKER ? (
                  <img
                    src={wallpaper}
                    alt="Wallpaper preview"
                    className="size-full object-cover"
                  />
                ) : (
                  <ImagePlus className="size-5 text-muted-foreground" />
                )}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium">Personal wallpaper</p>
                <p className="text-xs leading-5 text-muted-foreground">
                  {wallpaperType === "video"
                    ? "A looping video sits behind the app with a soft blur and dark glass overlay."
                    : "Your image sits behind the app with a soft blur and dark glass overlay."}
                </p>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-1.5 rounded-lg border border-white/[0.07] bg-black/10 p-1">
              {(["image", "video"] as const).map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => {
                    if (type === wallpaperType) return;
                    const hasVideoWallpaper = Boolean(
                      wallpaper &&
                      (wallpaper.startsWith("http") ||
                        wallpaper.startsWith("blob:") ||
                        wallpaper.startsWith("data:video/") ||
                        wallpaper === LIVE_WALLPAPER_MARKER),
                    );
                    if (type === "video") {
                      const savedEntry = wallpaperLibrary.find(
                        (entry) => entry.kind === "video",
                      );
                      if (savedEntry) {
                        activateWallpaperEntry(savedEntry);
                        return;
                      }
                      // Restore the legacy single uploaded file when switching
                      // back from Photo; switching modes never deletes it.
                      void getLiveWallpaperUrl()
                        .then((url) => {
                          if (url) {
                            if (
                              wallpaper?.startsWith("blob:") &&
                              !wallpaperLibraryUrlsRef.current.includes(
                                wallpaper,
                              )
                            ) {
                              URL.revokeObjectURL(wallpaper);
                            }
                            setWallpaper(url, "video");
                            localStorage.setItem(
                              "ss.wallpaper",
                              LIVE_WALLPAPER_MARKER,
                            );
                            setActiveWallpaperKey(LIVE_WALLPAPER_KEY);
                            return;
                          }
                          if (
                            wallpaper &&
                            !hasVideoWallpaper &&
                            !wallpaper.startsWith("blob:")
                          ) {
                            localStorage.setItem(
                              "ss.savedImageWallpaper",
                              wallpaper,
                            );
                          }
                          if (wallpaper && !hasVideoWallpaper) {
                            setWallpaper(null, "video");
                          } else {
                            const savedVideoUrl =
                              localStorage.getItem("ss.savedVideoUrl");
                            if (savedVideoUrl)
                              setWallpaper(savedVideoUrl, "video");
                            else setWallpaperType("video");
                          }
                        })
                        .catch(() => {
                          if (wallpaper && !hasVideoWallpaper)
                            setWallpaper(null, "video");
                          else setWallpaperType("video");
                        });
                    } else {
                      const savedEntry = wallpaperLibrary.find(
                        (entry) => entry.kind === "image",
                      );
                      if (savedEntry) {
                        activateWallpaperEntry(savedEntry);
                        return;
                      }
                      // Restore the legacy single image file when switching back
                      // from Live video.
                      void getImageWallpaperUrl()
                        .then((url) => {
                          if (url) {
                            if (
                              wallpaper?.startsWith("blob:") &&
                              !wallpaperLibraryUrlsRef.current.includes(
                                wallpaper,
                              )
                            ) {
                              URL.revokeObjectURL(wallpaper);
                            }
                            setWallpaper(url, "image");
                            localStorage.setItem(
                              "ss.wallpaper",
                              IMAGE_WALLPAPER_MARKER,
                            );
                            setActiveWallpaperKey(IMAGE_WALLPAPER_KEY);
                            return;
                          }
                          const savedImage = localStorage.getItem(
                            "ss.savedImageWallpaper",
                          );
                          if (savedImage) setWallpaper(savedImage, "image");
                          else if (wallpaper && hasVideoWallpaper)
                            setWallpaper(null, "image");
                          else setWallpaperType("image");
                        })
                        .catch(() => {
                          if (wallpaper && hasVideoWallpaper)
                            setWallpaper(null, "image");
                          else setWallpaperType("image");
                        });
                    }
                  }}
                  className={cn(
                    "rounded-md px-2 py-1.5 text-[11px] font-semibold transition-colors",
                    wallpaperType === type
                      ? "bg-white/[0.1] text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {type === "image" ? "Photo" : "Live video"}
                </button>
              ))}
            </div>

            {wallpaperType === "image" ? (
              <>
                <input
                  ref={wallpaperInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/avif"
                  className="hidden"
                  onChange={handleWallpaperChange}
                />
                <div className="mt-2.5 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => wallpaperInputRef.current?.click()}
                    className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.05] px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:border-white/25 hover:bg-white/[0.1]"
                  >
                    <ImagePlus className="size-3.5" />
                    {wallpaper ? "Add another image" : "Choose image"}
                  </button>
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  PNG, JPG, WebP or AVIF · up to 100 MB
                </p>
              </>
            ) : (
              <>
                <div className="mt-2.5 flex gap-2">
                  <Input
                    value={liveWallpaperUrl}
                    onChange={(event) =>
                      setLiveWallpaperUrl(event.target.value)
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") applyLiveWallpaper();
                    }}
                    placeholder="https://.../wallpaper.mp4"
                    aria-label="Live wallpaper video URL"
                    className="min-w-0 text-xs"
                  />
                  <Button
                    size="sm"
                    onClick={applyLiveWallpaper}
                    className="shrink-0"
                  >
                    <Film className="size-3.5" />
                    Apply
                  </Button>
                </div>
                <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
                  Use a direct MP4/WebM URL, or choose a video file from your
                  device.
                </p>
                <input
                  ref={liveWallpaperInputRef}
                  type="file"
                  accept="video/mp4,video/webm,video/ogg"
                  className="hidden"
                  onChange={handleLiveWallpaperFileChange}
                />
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => liveWallpaperInputRef.current?.click()}
                    className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.05] px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:border-white/25 hover:bg-white/[0.1]"
                  >
                    <Film className="size-3.5" />
                    Add video file
                  </button>
                  {liveWallpaperFileName && (
                    <span className="max-w-full truncate py-1.5 text-xs text-[rgb(var(--tint))]">
                      {liveWallpaperFileName}
                    </span>
                  )}
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  MP4, WebM or OGG · up to 100 MB
                </p>
              </>
            )}

            {wallpaperLibrary.length > 0 && (
              <div className="mt-3 border-t border-white/[0.07] pt-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
                    Saved wallpapers
                  </p>
                  <span className="text-[10px] text-muted-foreground">
                    {wallpaperLibrary.length}{" "}
                    {wallpaperLibrary.length === 1 ? "file" : "files"}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {wallpaperLibrary.map((entry) => {
                    const selected = activeWallpaperKey === entry.key;
                    return (
                      <div key={entry.key} className="group relative">
                        <button
                          type="button"
                          onClick={() => activateWallpaperEntry(entry)}
                          className={cn(
                            "relative aspect-square w-full overflow-hidden rounded-lg border bg-black/20 transition-all hover:scale-[1.03]",
                            selected
                              ? "border-[rgb(var(--tint))] ring-2 ring-[rgb(var(--tint)_/_0.35]"
                              : "border-white/10 hover:border-white/30",
                          )}
                          aria-label={`Use ${entry.name}`}
                        >
                          {entry.kind === "video" &&
                            (lowMemoryWallpaperPreviews && !selected ? (
                              <span className="flex size-full flex-col items-center justify-center gap-1 bg-gradient-to-br from-white/[0.1] to-black/30 text-white/55">
                                <Film className="size-5" />
                                <span className="text-[9px] font-medium">
                                  Video
                                </span>
                              </span>
                            ) : (
                              <video
                                src={entry.url}
                                muted
                                loop={!lowMemoryWallpaperPreviews}
                                autoPlay={!lowMemoryWallpaperPreviews}
                                playsInline
                                preload={
                                  lowMemoryWallpaperPreviews
                                    ? "metadata"
                                    : "auto"
                                }
                                className="size-full object-cover"
                              />
                            ))}
                          {entry.kind === "image" && (
                            <img
                              src={entry.url}
                              alt=""
                              loading="lazy"
                              decoding="async"
                              className="size-full object-cover"
                            />
                          )}
                          {selected && (
                            <span className="absolute right-1.5 top-1.5 flex size-5 items-center justify-center rounded-full bg-[rgb(var(--tint))] text-black shadow-lg">
                              <Check className="size-3" />
                            </span>
                          )}
                        </button>
                        <p
                          className="mt-1 truncate text-[10px] text-muted-foreground"
                          title={entry.name}
                        >
                          {entry.name}
                        </p>
                        <button
                          type="button"
                          onClick={() => void removeWallpaperEntry(entry)}
                          className="absolute right-1 top-1 hidden size-6 items-center justify-center rounded-full bg-black/70 text-red-300 backdrop-blur transition hover:bg-red-500/80 hover:text-white group-hover:flex"
                          aria-label={`Remove ${entry.name}`}
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Click any saved wallpaper to switch instantly. Files stay in
                  this browser.
                </p>
              </div>
            )}

            {(wallpaper || wallpaperLibrary.length > 0) && (
              /* Two distinct actions, deliberately side by side: "Revert" is
                 safe and keeps every saved file, while "Remove library" is
                 destructive and deletes them from IndexedDB. */
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={revertWallpaper}
                  className="inline-flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:border-[rgb(var(--tint))]/40 hover:bg-[rgb(var(--tint))]/10 hover:text-[rgb(var(--tint))]"
                >
                  <RotateCcw className="size-3.5" />
                  Revert to default
                </button>
                <button
                  type="button"
                  onClick={clearWallpaper}
                  className="inline-flex items-center gap-1.5 rounded-full border border-white/10 px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:border-red-400/30 hover:bg-red-400/[0.08] hover:text-red-300"
                >
                  <ImageOff className="size-3.5" />
                  Remove wallpaper library
                </button>
              </div>
            )}
          </div>

          <ToggleRow
            label="Wallpaper blur"
            description="Keep the personal wallpaper softly blurred behind the UI"
            on={wallpaperBlurAmount > 0}
            onToggle={() => {
              const nextAmount =
                wallpaperBlurAmount > 0 ? 0 : DEFAULT_WALLPAPER_BLUR_AMOUNT;
              setWallpaperBlurAmount(nextAmount);
              localStorage.setItem(
                "ss.wallpaperBlur",
                nextAmount > 0 ? "1" : "0",
              );
              localStorage.setItem(
                "ss.wallpaperBlurAmount",
                String(nextAmount),
              );
              window.dispatchEvent(
                new CustomEvent("ss:wallpaper-blur-change", {
                  detail: nextAmount,
                }),
              );
              toast(
                nextAmount > 0 ? "Wallpaper blur on" : "Wallpaper blur off",
              );
            }}
          />

          <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">Blur intensity</p>
                <p className="text-xs text-muted-foreground">
                  Adjust the softness of your live or image wallpaper
                </p>
              </div>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {wallpaperBlurAmount === 0 ? "Off" : `${wallpaperBlurAmount}px`}
              </span>
            </div>
            <Slider
              value={[wallpaperBlurAmount]}
              min={0}
              max={MAX_WALLPAPER_BLUR_AMOUNT}
              step={2}
              onValueChange={([value]) => {
                const nextAmount = Math.max(
                  0,
                  Math.min(MAX_WALLPAPER_BLUR_AMOUNT, value),
                );
                setWallpaperBlurAmount(nextAmount);
                localStorage.setItem(
                  "ss.wallpaperBlur",
                  nextAmount > 0 ? "1" : "0",
                );
                localStorage.setItem(
                  "ss.wallpaperBlurAmount",
                  String(nextAmount),
                );
                window.dispatchEvent(
                  new CustomEvent("ss:wallpaper-blur-change", {
                    detail: nextAmount,
                  }),
                );
              }}
              className="mt-2"
              aria-label="Wallpaper blur intensity"
            />
            <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
              <span>None</span>
              <span>Strong</span>
            </div>
          </div>

          <CardTransparencySection />

          {/* Recommendations. Sits with the other listening controls rather
              than buried under playback, because it changes what the app
              PROPOSES, not how it sounds. */}
          <ExplorationSection />

          <ToggleRow
            label="Low-memory wallpaper previews"
            description="Avoid playing saved video previews until you select one; switching stays instant"
            on={lowMemoryWallpaperPreviews}
            onToggle={() => {
              const next = !lowMemoryWallpaperPreviews;
              setLowMemoryWallpaperPreviews(next);
              localStorage.setItem(
                "ss.lowMemoryWallpaperPreviews",
                next ? "1" : "0",
              );
              toast(next ? "Low-memory previews on" : "Live previews on");
            }}
          />

          <ToggleRow
            label="Performance mode"
            description="Turn off glass blur, the light sheen, aurora orbs, pointer glow and cursor trail for a smoother page"
            on={performanceMode}
            onToggle={() => {
              togglePerformanceMode();
              toast(
                performanceMode
                  ? "Performance mode off"
                  : "Performance mode on",
              );
            }}
          />

          <ToggleRow
            label="Hide explicit content"
            description="Filter out tracks flagged explicit"
            on={hideExplicit}
            onToggle={() => {
              toggleHideExplicit();
              toast(
                hideExplicit
                  ? "Explicit content shown"
                  : "Explicit content hidden",
              );
            }}
          />
          <ToggleRow
            label="Compact mode"
            description="Tighter player bar, wider content layout"
            on={compactMode}
            onToggle={() => {
              toggleCompactMode();
              toast(compactMode ? "Compact mode off" : "Compact mode on");
            }}
          />
          <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5">
            <p className="text-sm font-medium">Focus layout</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Adapt the canvas and player to your session
            </p>
            <div className="mt-2.5 grid grid-cols-2 gap-2">
              {FOCUS_LAYOUTS.map((layout) => {
                const selected = focusLayout === layout.id;
                return (
                  <button
                    key={layout.id}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      setFocusLayout(layout.id);
                      localStorage.setItem("ss.focusLayout", layout.id);
                      localStorage.setItem(
                        "ss.focusMode",
                        layout.id === "off" ? "0" : "1",
                      );
                      window.dispatchEvent(
                        new CustomEvent("synq:focus-layout-change", {
                          detail: layout.id,
                        }),
                      );
                      toast(
                        layout.id === "off"
                          ? "Focus layout off"
                          : `${layout.name} focus on`,
                      );
                    }}
                    className={cn(
                      "rounded-lg border px-2.5 py-2 text-left transition-all hover:-translate-y-0.5",
                      selected
                        ? "border-[rgb(var(--tint))] bg-[rgb(var(--tint)_/_0.1)] ring-2 ring-[rgb(var(--tint)_/_0.18)]"
                        : "border-white/10 hover:border-white/25",
                    )}
                  >
                    <span className="block text-xs font-semibold">
                      {layout.name}
                    </span>
                    <span className="mt-0.5 block text-[10px] text-muted-foreground">
                      {layout.detail}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <ToggleRow
            label="Ambient glow"
            description="Soft colored glow at the top of the page"
            on={ambientGlow}
            onToggle={() => {
              toggleAmbientGlow();
              toast(ambientGlow ? "Ambient glow off" : "Ambient glow on");
            }}
          />
          <ToggleRow
            label="Liquid glass"
            description="Frosted, refractive panels with a moving light sheen"
            on={liquidGlass}
            onToggle={() => {
              toggleLiquidGlass();
              toast(liquidGlass ? "Liquid glass off" : "Liquid glass on");
            }}
          />
          <ToggleRow
            label="Visualizer"
            description="Animated bars that vibe with the song"
            on={visualizerEnabled}
            onToggle={() => {
              toggleVisualizer();
              toast(visualizerEnabled ? "Visualizer off" : "Visualizer on");
            }}
          />
          <ToggleRow
            label="Pointer glow"
            description="A soft liquid-glass light that follows your cursor"
            on={pointerEffects}
            onToggle={() => {
              togglePointerEffects();
              toast(pointerEffects ? "Pointer glow off" : "Pointer glow on");
            }}
          />
          <p className="px-1 text-xs leading-5 text-muted-foreground">
            Performance mode only changes how the page is drawn — playback, the
            queue and every setting stay exactly as they are. It is the one
            switch to reach for if scrolling, the visualizer or fullscreen ever
            feel stuttery on your device.
          </p>
        </section>

        <Separator className="bg-white/[0.07]" />

        {/* personalization */}
        <section
          id="settings-personalization"
          ref={registerSection("settings-personalization")}
          className="scroll-mt-20 flex flex-col gap-2"
        >
          <p className="flex items-center gap-1.5 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
            <Sparkles className="size-3.5" />
            Personalization
          </p>
          <ToggleRow
            label="Autoplay"
            description="Keep playing similar music when the queue ends"
            on={autoplay}
            onToggle={() => {
              toggleAutoplay();
              toast(autoplay ? "Autoplay off" : "Autoplay on");
            }}
          />
          <p className="px-1 text-xs leading-5 text-muted-foreground">
            Home adapts to what you play: your most-heard artists shape
            recommendations, recently played fills Continue Listening, and
            Discover Weekly refreshes with a new mix for you every week.
          </p>
        </section>

        <Separator className="bg-white/[0.07]" />

        {/* profile */}
        <section
          id="settings-profile"
          ref={registerSection("settings-profile")}
          className="settings-profile scroll-mt-20 flex flex-col gap-2.5"
        >
          <p className="flex items-center gap-1.5 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
            <UserRound className="size-3.5" />
            Profile
          </p>
          <div className="flex items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.03] p-3">
            <button
              type="button"
              onClick={() => avatarInputRef.current?.click()}
              className="group relative flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[rgb(var(--tint))] text-lg font-bold text-black ring-2 ring-white/10 transition-transform hover:scale-105"
              aria-label="Change profile picture"
            >
              {user?.image ? (
                <img
                  src={user.image}
                  alt="Your profile picture"
                  className="size-full object-cover"
                />
              ) : (
                <span>{avatarInitials}</span>
              )}
              {savingAvatar && (
                <span className="absolute inset-0 flex items-center justify-center bg-black/45">
                  <Loader2 className="size-5 animate-spin text-white" />
                </span>
              )}
            </button>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Profile picture</p>
              <p className="text-xs leading-5 text-muted-foreground">
                Choose a square image for your avatar across the app.
              </p>
              <div className="mt-1.5 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => avatarInputRef.current?.click()}
                  disabled={savingAvatar}
                  className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[11px] font-semibold transition-colors hover:border-white/25 hover:bg-white/[0.1] disabled:opacity-50"
                >
                  Change photo
                </button>
                {user?.image && (
                  <button
                    type="button"
                    onClick={() => void clearAvatar()}
                    disabled={savingAvatar}
                    className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:border-red-400/30 hover:text-red-300 disabled:opacity-50"
                  >
                    Remove
                  </button>
                )}
              </div>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={handleAvatarChange}
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Pencil className="absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={displayName}
                maxLength={40}
                className="pl-9"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !saving) void saveName();
                }}
              />
            </div>
            <Button
              size="icon"
              onClick={() => void saveName()}
              disabled={saving || !name.trim() || name.trim() === displayName}
              aria-label="Save name"
            >
              {saving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Check className="size-4" />
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Signed in as{" "}
            <span className="font-medium text-foreground">{displayName}</span>
            {user?.email ? ` · ${user.email}` : ""}
          </p>
          {onSignOut && (
            <button
              type="button"
              onClick={() => void handleSignOut()}
              disabled={signingOut}
              className="flex items-center gap-2 self-start rounded-full border border-white/10 px-3.5 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:border-red-500/40 hover:bg-red-500/[0.08] hover:text-red-400 disabled:opacity-50"
            >
              {signingOut ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <LogOut className="size-3.5" />
              )}
              Sign out
            </button>
          )}
          {user?.email && (
            <ToggleRow
              label="Hide email in sidebar"
              description="Show only your name in the corner account panel"
              on={hideSidebarEmail}
              onToggle={() => {
                toggleHideSidebarEmail();
                toast(
                  hideSidebarEmail
                    ? "Email shown in sidebar"
                    : "Email hidden in sidebar",
                );
              }}
            />
          )}
        </section>

        {/* This divider belongs to the shortcuts block below. Hiding the block
            without hiding the divider with it left two hairlines stacked on
            top of each other on a phone. */}
        <Separator className="hidden bg-white/[0.07] lg:block" />

        {/* Keyboard shortcuts are a desktop-only affordance: the tab, the
            panel and this divider are all gated at `lg`, so a phone — including
            one in landscape, which is wider than the `md` breakpoint — never
            sees any of it. The global key handler still works wherever there is
            a physical keyboard. */}
        <section
          id="settings-shortcuts"
          ref={registerSection("settings-shortcuts")}
          className="hidden flex-col gap-2 lg:flex"
        >
          <p className="flex items-center gap-1.5 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
            <Keyboard className="size-3.5" />
            Keyboard shortcuts
          </p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5">
            {SHORTCUTS.map(([key, label]) => (
              <div
                key={key}
                className="flex items-center justify-between gap-2 text-xs"
              >
                <kbd className="rounded border border-white/10 bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-foreground">
                  {key}
                </kbd>
                <span className="truncate text-muted-foreground">{label}</span>
              </div>
            ))}
          </div>
        </section>

        <Separator className="bg-white/[0.07]" />

        {/* import */}
        <ImportSection open={open} />

        <Separator className="bg-white/[0.07]" />

        {/* offline downloads — the resolver downloads need */}
        <ResolverSection />

        <Separator className="bg-white/[0.07]" />

        {/* data */}
        <section
          id="settings-app"
          ref={registerSection("settings-app")}
          className="flex flex-col gap-2"
        >
          <p className="flex items-center gap-1.5 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
            <Download className="size-3.5" />
            App
          </p>
          <InstallAppRow />
        </section>

        <Separator className="bg-white/[0.07]" />

        <section
          id="settings-data"
          ref={registerSection("settings-data")}
          className="flex flex-col gap-2"
        >
          <p className="flex items-center gap-1.5 text-[11px] font-semibold tracking-widest text-muted-foreground uppercase">
            <Moon className="size-3.5" />
            Your data
          </p>
          {exporting ? (
            <DataExportRow onDone={() => setExporting(false)} />
          ) : (
            <button
              type="button"
              onClick={() => setExporting(true)}
              className="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5 text-left text-sm transition-colors hover:border-[rgb(var(--tint)_/_0.35)] hover:bg-white/[0.05]"
            >
              <Download className="size-4 text-[rgb(var(--tint))]" />
              <span className="min-w-0">
                <span className="block font-medium">Download my data</span>
                <span className="block text-xs text-muted-foreground">
                  A JSON copy of your profile, likes, playlists and listening
                  history.
                </span>
              </span>
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleClearHistory()}
            disabled={clearing}
            className="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5 text-left text-sm transition-colors hover:border-red-500/30 hover:bg-red-500/[0.06] disabled:opacity-50"
          >
            {clearing ? (
              <Loader2 className="size-4 animate-spin text-red-400" />
            ) : (
              <Trash2 className="size-4 text-red-400" />
            )}
            <span className="min-w-0">
              <span className="block font-medium">Clear listening history</span>
              <span className="block text-xs text-muted-foreground">
                Removes recently played and most-played data. Likes and
                playlists are kept.
              </span>
            </span>
          </button>
        </section>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Fetches the account export and hands it to the browser as JSON.
 *
 * Mounted only on demand: the query pulls every like, playlist and history
 * row for the account, which is not something to run for someone who merely
 * opened Settings.
 */
/**
 * Install SYNQ as an app, reachable from Settings even after the in-app
 * prompt was dismissed.
 *
 * Three genuinely different states, not one button relabelled three ways:
 * an installed app says so and offers nothing to click, browsers with a
 * captured prompt get the real install call, and iOS — which has no install
 * API at all — gets the manual Share > Add to Home Screen steps rather than a
 * button that would silently do nothing.
 */
function InstallAppRow() {
  const { state, install, reset } = usePwaInstall();

  if (state === "installed") {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5">
        <img
          src={publicAsset("icons/icon-192.png")}
          alt=""
          width={36}
          height={36}
          className="size-9 shrink-0 rounded-lg"
        />
        <div className="min-w-0">
          <p className="text-sm font-medium">SYNQ is installed</p>
          <p className="text-xs text-muted-foreground">
            Running in its own window
          </p>
        </div>
      </div>
    );
  }

  const hint =
    state === "manual"
      ? manualInstallHint(true)
      : state === "ready"
        ? "Launch it in its own window, with the player intact."
        : state === "dismissed"
          ? "You dismissed this earlier."
          : // Say WHY it cannot be installed instead of a vague "not yet".
            // The most common cause by far is that this build is a preview
            // rather than a published build, and Chrome will not offer the
            // install at all in that case — so "this browser hasn't offered
            // installation yet" reads as a broken PWA when nothing is broken.
            (installBlockedReason() ??
            "This browser hasn't offered installation yet.");

  return (
    <div className="flex items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5">
      <img
        src="/icons/icon-192.png"
        alt=""
        width={36}
        height={36}
        className="size-9 shrink-0 rounded-lg"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">Install SYNQ</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      {state === "ready" && (
        <button
          type="button"
          onClick={() => {
            void install();
          }}
          className="shrink-0 rounded-full bg-[rgb(var(--tint))] px-3 py-1.5 text-xs font-semibold text-black transition-transform hover:scale-105"
        >
          Install
        </button>
      )}
      {state === "dismissed" && (
        <button
          type="button"
          onClick={reset}
          className="shrink-0 rounded-full border border-white/10 px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:border-white/25 hover:text-foreground"
        >
          Show again
        </button>
      )}
    </div>
  );
}

function DataExportRow({ onDone }: { onDone: () => void }) {
  const data = useQuery(api.me.exportData);

  useEffect(() => {
    if (data === undefined) return;
    if (data === null) {
      toast.error("Sign in to export your data");
      onDone();
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const ok = downloadJson(`synq-my-data-${stamp}.json`, data);
    if (!ok) {
      toast.error("Couldn't build the export");
    } else {
      toast.success("Your data is downloading");
    }
    onDone();
  }, [data, onDone]);

  return (
    <div className="flex items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5 text-sm">
      <Loader2 className="size-4 animate-spin text-[rgb(var(--tint))]" />
      <span className="min-w-0">
        <span className="block font-medium">Preparing your export…</span>
        <span className="block text-xs text-muted-foreground">
          Collecting your profile, likes, playlists and history.
        </span>
      </span>
    </div>
  );
}

/** Labeled dB/balance slider for the audio panel. */
function EqSlider({
  label,
  value,
  onChange,
  min = -12,
  max = 12,
  step = 1,
  format,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  format?: (v: number) => string;
}) {
  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{label}</p>
        <span className="text-xs tabular-nums text-muted-foreground">
          {format ? format(value) : `${value > 0 ? "+" : ""}${value} dB`}
        </span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([v]) => onChange(v)}
        className="mt-2"
        aria-label={label}
      />
    </div>
  );
}

function ToggleRow({
  label,
  description,
  on,
  onToggle,
}: {
  label: string;
  description: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.07] bg-white/[0.03] px-3 py-2.5 text-left transition-colors hover:bg-white/[0.05]"
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">
          {description}
        </span>
      </span>
      <span
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full transition-colors",
          on ? "bg-[rgb(var(--tint))]" : "bg-white/15",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-4 rounded-full bg-white shadow transition-all",
            on ? "left-[18px]" : "left-0.5",
          )}
        />
      </span>
    </button>
  );
}
