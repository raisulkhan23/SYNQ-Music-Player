import { useState } from "react";
import { motion } from "framer-motion";
import { Link } from "react-router";
import { Logo } from "@/components/brand/Logo";
import { InstallAppButton } from "@/components/pwa/InstallAppButton";
import { SiteFooter } from "@/components/landing/SiteFooter";
import {
  Activity,
  ArrowRight,
  AudioWaveform,
  Check,
  Download,
  Headphones,
  Heart,
  Keyboard,
  Layers3,
  ListMusic,
  Pause,
  Repeat,
  ShieldCheck,
  Shuffle,
  SkipBack,
  SkipForward,
  Sparkles,
  TimerReset,
  Volume2,
  Waves,
  Zap,
} from "lucide-react";

/**
 * The features added in this build. Kept as data so the section renders from
 * one list rather than repeating the same markup three times.
 */
const whatsNewCards = [
  {
    icon: Zap,
    title: "Search that actually finds the song",
    body: "Type what you mean — the right track comes back first.",
    points: [
      'Typing "we dont talk anymore" puts "We Don\'t Talk Anymore" first',
      "Fuzzy matching forgives typos, missing apostrophes and bad spelling",
      "Asking for a version — live, remix, slowed — brings that version up",
      "Versions are tagged on every row so you can see them at a glance",
    ],
  },
  {
    icon: ListMusic,
    title: "Lyrics that keep up",
    body: "The words follow the song, in the panel and on the player.",
    points: [
      "The current line sits between the artwork and the title, with the line before and after it",
      "Full lyrics panel with real type hierarchy, fades and a song header",
      "Verse structure is preserved instead of one flat wall of text",
      "Tapping any line seeks to it",
    ],
  },
  {
    icon: Layers3,
    title: "Mixes that mix",
    body: "Every mix plays its own thing. None of them play the same song.",
    points: [
      "Each mix runs its own query — no more six cards, one identical song",
      "Music search reads real studio tracks, not random uploads",
      'Requests for "live" or "slowed" return that version',
      "Suggestions appear as you type, with ↑ ↓ to pick",
    ],
  },
  {
    icon: Activity,
    title: "Roughly 10× faster lookups",
    body: "Repeat searches and share links come back from cache.",
    points: [
      "Search results are cached for ten minutes",
      "Concurrent identical requests collapse into one upstream call",
      "A request budget stops retry storms reaching the music service",
      "Your result stays steady instead of flipping between a cover and the original",
    ],
  },
  {
    icon: Download,
    title: "Downloads that are actually downloadable",
    body: "An honest look at what SYNQ is allowed to keep.",
    points: [
      "A Download hub at /downloads with progress, speed, ETA, cancel and retry",
      "Range-based, resumable downloads with integrity checking, stored on your device",
      "Download shows in the fullscreen player and in every track menu — only when the track can be saved",
      "Report what is genuinely offline, and say plainly when a provider only licenses streaming",
    ],
  },
] as const;

const fadeUp = {
  initial: { opacity: 0, y: 20 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: "-80px" },
  transition: { duration: 0.55, ease: "easeOut" as const },
};

const modeContent = {
  focus: {
    label: "Deep focus",
    title: "A calmer way in",
    body: "Warm frequencies, spacious arrangements, and fewer distractions for the first hour of the day.",
    track: "Weightless",
    artist: "Marconi Union",
    tone: "from-[#d7f27a]/90 via-[#8aa85b]/35 to-transparent",
    accent: "#d7f27a",
  },
  motion: {
    label: "Keep moving",
    title: "Find your pulse",
    body: "A brighter frequency for the miles between here and there. Press play, then let the queue take it from here.",
    track: "Midnight City",
    artist: "M83",
    tone: "from-[#8be8ff]/90 via-[#6275e8]/35 to-transparent",
    accent: "#8be8ff",
  },
  night: {
    label: "After hours",
    title: "Stay in the feeling",
    body: "Low-lit, slow-burning discoveries for the part of the night where the best songs show up.",
    track: "The Night We Met",
    artist: "Lord Huron",
    tone: "from-[#d5a7ff]/90 via-[#885bd4]/35 to-transparent",
    accent: "#d5a7ff",
  },
} as const;

type ListeningMode = keyof typeof modeContent;

function CoverArt({ className = "size-16" }: { className?: string }) {
  return (
    <div
      className={`relative shrink-0 overflow-hidden rounded-2xl ${className}`}
    >
      <img
        src="/show-me-love-cover.svg"
        alt="SYNQ cover art"
        className="size-full object-cover"
      />
      <span className="absolute inset-0 rounded-2xl ring-1 ring-inset ring-white/20" />
    </div>
  );
}

function ListeningExperience() {
  const [mode, setMode] = useState<ListeningMode>("focus");
  const current = modeContent[mode];

  return (
    <div className="relative overflow-hidden rounded-[2rem] border border-white/10 bg-[#0a0b10]/80 px-4 py-8 shadow-[0_30px_100px_rgba(0,0,0,0.42)] sm:px-8 sm:py-12">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(65%_75%_at_50%_38%,rgba(203,244,143,0.11),transparent_70%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-40 [background-image:linear-gradient(rgba(255,255,255,0.045)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.045)_1px,transparent_1px)] [background-size:42px_42px] [mask-image:linear-gradient(to_bottom,transparent,black_28%,black_72%,transparent)]" />
      <div className="relative mx-auto max-w-5xl">
        <div className="mx-auto max-w-2xl text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-brand/20 bg-brand/8 px-3 py-1 text-[10px] font-semibold tracking-[0.22em] text-brand uppercase">
            <Sparkles className="size-3.5" /> One continuous atmosphere
          </span>
          <h2 className="mt-4 font-display text-3xl font-bold tracking-tight sm:text-5xl">
            Your queue, in motion.
          </h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground sm:text-base">
            Choose a mood, then let SYNQ shape the space between songs.
          </p>
        </div>

        <div className="mx-auto mt-8 flex w-fit max-w-full gap-1 overflow-x-auto rounded-full border border-white/10 bg-white/[0.04] p-1">
          {(Object.keys(modeContent) as ListeningMode[]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setMode(key)}
              className={`whitespace-nowrap rounded-full px-4 py-2 text-xs font-semibold transition-all ${mode === key ? "bg-white text-black shadow-lg" : "text-muted-foreground hover:text-foreground"}`}
            >
              {modeContent[key].label}
            </button>
          ))}
        </div>

        <div className="relative mx-auto mt-10 h-[370px] max-w-4xl sm:h-[430px]">
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 28, repeat: Infinity, ease: "linear" }}
            className="absolute left-1/2 top-1/2 size-[250px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-brand/20 sm:size-[330px]"
          >
            <span className="absolute left-1/2 top-[-5px] size-2.5 -translate-x-1/2 rounded-full bg-brand shadow-[0_0_18px_5px_rgba(203,244,143,0.45)]" />
            <span className="absolute bottom-[12%] right-[-4px] size-2 rounded-full bg-cyan-300 shadow-[0_0_16px_4px_rgba(103,232,249,0.4)]" />
          </motion.div>
          <div className="absolute left-1/2 top-1/2 size-[205px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/10 bg-white/[0.025] shadow-[0_0_80px_rgba(203,244,143,0.08)] sm:size-[270px]" />
          <div className="absolute left-1/2 top-1/2 size-[150px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-brand/20 bg-brand/5 sm:size-[200px]" />

          <motion.div
            animate={{ y: [0, -8, 0], rotate: [0, 2, 0] }}
            transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
            className="absolute left-1/2 top-1/2 z-10 size-[132px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/20 bg-[#11151a] p-2 shadow-[0_20px_50px_rgba(0,0,0,0.55),0_0_45px_rgba(203,244,143,0.16)] sm:size-[174px]"
          >
            <div className="relative size-full overflow-hidden rounded-full border border-white/10">
              <img
                src="/show-me-love-cover.svg"
                alt=""
                className="size-full object-cover"
              />
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,transparent_30%,rgba(0,0,0,0.45))]" />
              <div className="absolute left-1/2 top-1/2 size-7 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/40 bg-[#11151a] shadow-[0_0_0_5px_rgba(255,255,255,0.06)] sm:size-9" />
            </div>
          </motion.div>

          <motion.div
            key={mode}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            className="liquid-glass absolute left-1/2 top-2 z-20 w-[250px] -translate-x-1/2 rounded-2xl border border-white/10 p-4 shadow-[0_18px_45px_rgba(0,0,0,0.4)] sm:w-[300px]"
          >
            <div
              className={`h-1.5 rounded-full bg-gradient-to-r ${current.tone}`}
            />
            <div className="mt-3 flex items-center gap-3">
              <CoverArt className="size-10 rounded-xl" />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">
                  {current.track}
                </p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {current.artist}
                </p>
              </div>
              <Headphones className="ml-auto size-4 shrink-0 text-muted-foreground" />
            </div>
            <p className="mt-3 text-[11px] text-muted-foreground">
              {current.body}
            </p>
          </motion.div>

          <motion.div
            animate={{ y: [0, 7, 0] }}
            transition={{
              duration: 5,
              repeat: Infinity,
              ease: "easeInOut",
              delay: 0.5,
            }}
            className="liquid-glass absolute bottom-[4%] left-[4%] z-20 w-[190px] rounded-2xl border border-white/10 p-3 shadow-[0_18px_45px_rgba(0,0,0,0.4)] sm:bottom-[5%] sm:left-[12%] sm:w-[220px]"
          >
            <div className="flex items-center gap-2 text-[10px] font-semibold tracking-[0.12em] text-muted-foreground uppercase">
              <Waves className="size-3.5 text-cyan-300" /> Queue synced
            </div>
            <div className="mt-3 flex h-6 items-end gap-1">
              {Array.from({ length: 18 }).map((_, index) => (
                <span
                  key={index}
                  className="eq-bar w-1 rounded-full bg-cyan-300/75"
                  style={{
                    height: `${25 + ((index * 29) % 70)}%`,
                    animationDelay: `${(index % 6) * 0.11}s`,
                  }}
                />
              ))}
            </div>
          </motion.div>

          <motion.div
            animate={{ y: [0, -7, 0] }}
            transition={{
              duration: 6,
              repeat: Infinity,
              ease: "easeInOut",
              delay: 1,
            }}
            className="liquid-glass absolute bottom-[8%] right-[4%] z-20 w-[180px] rounded-2xl border border-white/10 p-3 shadow-[0_18px_45px_rgba(0,0,0,0.4)] sm:bottom-[9%] sm:right-[10%] sm:w-[214px]"
          >
            <div className="flex items-center justify-between text-[10px] font-semibold text-muted-foreground">
              <span>Autoplay</span>
              <span className="text-brand">ON</span>
            </div>
            <div className="mt-3 flex -space-x-2">
              {[0, 1, 2].map((item) => (
                <span
                  key={item}
                  className="size-7 rounded-full border-2 border-[#11131a] bg-gradient-to-br from-brand/80 to-violet-400/80"
                />
              ))}
              <span className="flex size-7 items-center justify-center rounded-full border-2 border-[#11131a] bg-white/10 text-[9px] text-muted-foreground">
                +5
              </span>
            </div>
          </motion.div>
        </div>

        <div className="relative mx-auto grid max-w-3xl grid-cols-3 gap-2 border-t border-white/[0.07] pt-5 text-center sm:gap-4">
          {[
            ["∞", "endless discovery"],
            ["0", "interruptions"],
            ["1", "continuous mix"],
          ].map(([value, label]) => (
            <div key={label}>
              <p className="font-display text-xl font-bold text-brand sm:text-2xl">
                {value}
              </p>
              <p className="mt-0.5 text-[10px] text-muted-foreground sm:text-xs">
                {label}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PlayerPreview() {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.96, y: 24 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: 0.6, delay: 0.2 }}
      className="relative mx-auto w-full max-w-md"
    >
      <div className="liquid-glass relative rounded-3xl border border-white/10 p-6 shadow-[0_40px_90px_rgba(0,0,0,0.55)]">
        <div className="flex items-center gap-4">
          <CoverArt />
          <div className="min-w-0">
            <p className="mb-1 text-[9px] font-bold tracking-[0.22em] text-brand uppercase">
              Now playing
            </p>
            <p className="font-display text-[15px] font-bold tracking-tight">
              Show Me Love
            </p>
            <p className="text-xs text-muted-foreground">WizTheMc</p>
          </div>
          <Heart className="ml-auto size-4 shrink-0 fill-brand text-brand" />
        </div>
        <div className="mt-5 flex items-center gap-2">
          <span className="text-[10px] tabular-nums text-muted-foreground">
            1:24
          </span>
          <div className="relative h-1 flex-1 rounded-full bg-white/10">
            <div className="absolute inset-y-0 left-0 w-[38%] rounded-full bg-brand" />
            <div className="absolute top-1/2 left-[38%] size-2.5 -translate-y-1/2 rounded-full bg-white shadow" />
          </div>
          <span className="text-[10px] tabular-nums text-muted-foreground">
            3:32
          </span>
        </div>
        <div className="mt-4 flex items-center justify-center gap-4 text-muted-foreground">
          <Shuffle className="size-4 text-brand" />
          <SkipBack className="size-4 fill-current" />
          <span className="flex size-10 items-center justify-center rounded-full bg-white text-black shadow-lg">
            <Pause className="size-4 fill-current" />
          </span>
          <SkipForward className="size-4 fill-current" />
          <Repeat className="size-4" />
        </div>
        <div className="mt-5 flex items-center justify-between border-t border-white/[0.07] pt-4">
          <div className="flex h-5 items-end gap-[3px]">
            {Array.from({ length: 24 }).map((_, index) => (
              <span
                key={index}
                className="eq-bar w-[3px] rounded-full bg-brand"
                style={{
                  height: `${20 + ((index * 37) % 80)}%`,
                  animationDelay: `${(index % 7) * 0.12}s`,
                  animationDuration: `${0.8 + (index % 5) * 0.18}s`,
                }}
              />
            ))}
          </div>
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
            <Activity className="size-3.5 text-brand" /> Live spectrum
          </span>
        </div>
      </div>
      <motion.div
        animate={{ y: [0, -10, 0] }}
        transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
        className="absolute -top-5 -right-3 hidden rounded-2xl border border-white/10 bg-[#12141b]/90 px-4 py-3 shadow-xl backdrop-blur-xl sm:block"
      >
        <p className="text-[11px] font-semibold text-muted-foreground uppercase">
          Full-screen mode
        </p>
        <div className="mt-1.5 flex h-4 items-end gap-[3px]">
          {[0, 1, 2, 3, 4].map((item) => (
            <span
              key={item}
              className="eq-bar w-[3px] rounded-full bg-violet-400"
              style={{
                height: `${40 + item * 14}%`,
                animationDelay: `${item * 0.16}s`,
              }}
            />
          ))}
        </div>
      </motion.div>
      <motion.div
        animate={{ y: [0, 8, 0] }}
        transition={{
          duration: 5,
          repeat: Infinity,
          ease: "easeInOut",
          delay: 1,
        }}
        className="absolute -bottom-5 -left-3 hidden rounded-2xl border border-white/10 bg-[#12141b]/90 px-4 py-3 shadow-xl backdrop-blur-xl sm:block"
      >
        <p className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck className="size-4 text-brand" /> Zero ads. Ever.
        </p>
        <p className="mt-0.5 text-[11px] text-muted-foreground">
          No banners, no promos, no interruptions.
        </p>
      </motion.div>
    </motion.div>
  );
}

const flowSteps = [
  {
    number: "01",
    icon: AudioWaveform,
    title: "Find the frequency",
    body: "Search across music-only results and tune into a mood, artist, or title without leaving the flow.",
  },
  {
    number: "02",
    icon: Layers3,
    title: "Shape the session",
    body: "Build a queue, reorder the next few songs, and let autoplay carry the atmosphere forward.",
  },
  {
    number: "03",
    icon: Sparkles,
    title: "Stay in the moment",
    body: "Move from a small mobile player to a full-screen visual session without losing your place.",
  },
];

const featureCards = [
  {
    icon: ShieldCheck,
    title: "Zero ads, always",
    body: "No banners, no promotions, no interruptions. The interface is all music.",
  },
  {
    icon: Zap,
    title: "Instant playback",
    body: "Optimistic controls and a persistent player that never stops while you browse.",
  },
  {
    icon: Activity,
    title: "Live visualizer",
    body: "A canvas frequency spectrum that dances with the audio in full-screen mode.",
  },
  {
    icon: ListMusic,
    title: "Your library",
    body: "Like songs and build playlists with instant, optimistic updates.",
  },
];

export default function Landing() {
  return (
    <div className="relative min-h-dvh overflow-x-hidden bg-background pt-[env(safe-area-inset-top)] text-foreground">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[720px]">
        <div className="absolute left-1/2 top-[-240px] h-[600px] w-[900px] -translate-x-1/2 rounded-full bg-brand/15 blur-3xl" />
        <div className="absolute top-[300px] right-[-140px] h-[360px] w-[360px] rounded-full bg-violet-500/10 blur-3xl" />
        <div className="absolute top-[400px] left-[-160px] h-[320px] w-[320px] rounded-full bg-cyan-500/10 blur-3xl" />
      </div>

      <header className="relative z-20 mx-auto flex h-20 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
        <Logo to="/" />
        <nav className="hidden items-center gap-7 text-sm font-medium text-muted-foreground md:flex">
          <a
            href="#whats-new"
            className="transition-colors hover:text-foreground"
          >
            What&apos;s new
          </a>
          <a
            href="#features"
            className="transition-colors hover:text-foreground"
          >
            Features
          </a>
          <a
            href="#experience"
            className="transition-colors hover:text-foreground"
          >
            Experience
          </a>
        </nav>
        <div className="flex items-center gap-2">
          <Link
            to="/auth"
            className="hidden rounded-full px-4 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground sm:block"
          >
            Sign in
          </Link>
          <Link
            to="/home"
            className="rounded-full bg-brand px-4 py-2 text-sm font-semibold text-brand-foreground shadow-[0_6px_24px_rgb(203_244_143/0.35)] transition-transform hover:scale-105"
          >
            Start listening
          </Link>
        </div>
      </header>

      <section className="relative z-10 mx-auto grid w-full max-w-6xl items-center gap-14 px-4 pt-12 pb-24 sm:px-6 lg:grid-cols-2 lg:gap-8 lg:pt-20 lg:pb-32">
        <div>
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-1.5 text-xs font-medium text-muted-foreground"
          >
            <span className="size-1.5 rounded-full bg-brand" /> Music-only
            discovery · no ads · no noise
          </motion.div>
          <motion.h1
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.08 }}
            className="mt-6 max-w-xl font-display text-5xl leading-[0.98] font-bold tracking-tight sm:text-7xl"
          >
            Your music,
            <br />
            <span className="text-brand">uninterrupted.</span>
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.16 }}
            className="mt-6 max-w-lg text-base leading-7 text-muted-foreground sm:text-lg"
          >
            SYNQ is a home for the songs you actually want to hear — with a
            queue that moves like you do, a live visualizer, and a full-screen
            player that feels more like a listening room than an app.
          </motion.p>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.24 }}
            className="mt-8 flex flex-wrap items-center gap-3"
          >
            <Link
              to="/home"
              className="group flex items-center gap-2 rounded-full bg-brand px-6 py-3 text-sm font-semibold text-brand-foreground shadow-[0_10px_36px_rgb(203_244_143/0.4)] transition-transform hover:scale-105"
            >
              Start listening free{" "}
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
            </Link>
            <InstallAppButton />
            <a
              href="#experience"
              className="rounded-full border border-white/10 px-5 py-3 text-sm font-semibold text-muted-foreground transition-colors hover:border-white/20 hover:text-foreground"
            >
              See how it flows
            </a>
          </motion.div>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.6, delay: 0.4 }}
            className="mt-10 flex flex-wrap gap-x-8 gap-y-3 text-sm text-muted-foreground"
          >
            {[
              ["0", "ads"],
              ["∞", "moods"],
              ["1", "continuous mix"],
            ].map(([value, label]) => (
              <div key={label}>
                <p className="font-display text-xl font-bold text-foreground">
                  {value}
                </p>
                <p className="text-xs">{label}</p>
              </div>
            ))}
          </motion.div>
        </div>
        <PlayerPreview />
      </section>

      <section
        id="experience"
        className="relative z-10 mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 sm:py-16"
      >
        <ListeningExperience />
      </section>

      <section
        id="features"
        className="relative z-10 mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-28"
      >
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <span className="text-[10px] font-bold tracking-[0.24em] text-brand uppercase">
            Made for the long listen
          </span>
          <h2 className="mt-4 font-display text-3xl font-bold tracking-tight sm:text-5xl">
            A player that feels alive.
          </h2>
          <p className="mt-4 text-base leading-7 text-muted-foreground">
            Every detail is tuned for one thing: the music. No clutter, no ads,
            no tiny friction between you and the next song.
          </p>
        </motion.div>
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {featureCards.map(({ icon: Icon, title, body }, index) => (
            <motion.div
              key={title}
              {...fadeUp}
              transition={{ ...fadeUp.transition, delay: index * 0.07 }}
              className="group rounded-2xl border border-white/[0.07] bg-white/[0.03] p-5 transition-all hover:-translate-y-1 hover:border-brand/30 hover:bg-white/[0.05]"
            >
              <span className="flex size-10 items-center justify-center rounded-xl bg-brand/12 text-brand ring-1 ring-brand/20 transition-transform group-hover:scale-110">
                <Icon className="size-5" />
              </span>
              <h3 className="mt-4 font-display text-base font-semibold">
                {title}
              </h3>
              <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                {body}
              </p>
              <span className="mt-5 flex items-center gap-1 text-[10px] font-semibold tracking-wider text-brand uppercase">
                Built in <Check className="size-3" />
              </span>
            </motion.div>
          ))}
        </div>
      </section>

      <section className="relative z-10 mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-28">
        <motion.div
          {...fadeUp}
          className="grid gap-8 lg:grid-cols-[0.85fr_1.15fr] lg:items-end"
        >
          <div>
            <span className="text-[10px] font-bold tracking-[0.24em] text-brand uppercase">
              The SYNQ flow
            </span>
            <h2 className="mt-4 font-display text-3xl font-bold tracking-tight sm:text-5xl">
              From first note
              <br />
              to next obsession.
            </h2>
          </div>
          <p className="max-w-lg text-base leading-7 text-muted-foreground lg:justify-self-end">
            SYNQ keeps the decisions small: find a song, shape what comes next,
            and let the room take care of the rest. No rabbit holes. No ad
            breaks. No reset every time you change pages.
          </p>
        </motion.div>
        <div className="mt-12 grid gap-4 lg:grid-cols-3">
          {flowSteps.map(({ number, icon: Icon, title, body }, index) => (
            <motion.div
              key={number}
              {...fadeUp}
              transition={{ ...fadeUp.transition, delay: index * 0.1 }}
              className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.03] p-6"
            >
              <span className="font-display text-5xl font-bold text-white/[0.06]">
                {number}
              </span>
              <span className="relative mt-8 flex size-11 items-center justify-center rounded-xl border border-brand/20 bg-brand/10 text-brand">
                <Icon className="size-5" />
              </span>
              <h3 className="relative mt-5 font-display text-lg font-semibold">
                {title}
              </h3>
              <p className="relative mt-2 text-sm leading-6 text-muted-foreground">
                {body}
              </p>
              <div className="relative mt-6 h-px bg-gradient-to-r from-brand/50 to-transparent" />
            </motion.div>
          ))}
        </div>
      </section>

      {/* Keyboard shortcuts are a desktop affordance, so the showcase is
          desktop-only too — the same `lg` cutoff the settings tab and panel
          use. Nothing links to `#shortcuts` (the footer entry was removed), so
          hiding it leaves no dead anchor behind. */}
      <section
        id="shortcuts"
        className="relative z-10 mx-auto hidden w-full max-w-6xl px-4 py-12 sm:px-6 sm:py-20 lg:block"
      >
        <div className="grid overflow-hidden rounded-[2rem] border border-white/10 bg-[#0b0c11]/80 lg:grid-cols-[1.05fr_0.95fr]">
          <div className="relative p-7 sm:p-12">
            <div className="absolute inset-0 bg-[radial-gradient(80%_100%_at_0%_0%,rgba(203,244,143,0.14),transparent_70%)]" />
            <div className="relative">
              <span className="inline-flex items-center gap-2 rounded-full border border-brand/20 bg-brand/8 px-3 py-1 text-[10px] font-bold tracking-[0.2em] text-brand uppercase">
                <Keyboard className="size-3.5" /> Your shortcuts
              </span>
              <h2 className="mt-5 max-w-md font-display text-3xl font-bold tracking-tight sm:text-4xl">
                Keep your hands on the music.
              </h2>
              <p className="mt-3 max-w-md text-sm leading-6 text-muted-foreground">
                The controls you reach for most are one key away, wherever you
                are in the app.
              </p>
              <div className="mt-8 grid max-w-md grid-cols-2 gap-2 sm:grid-cols-3">
                {[
                  ["Space", "Play / pause"],
                  ["← →", "Seek"],
                  ["↑ ↓", "Volume"],
                  ["N", "Next"],
                  ["P", "Previous"],
                  ["M", "Mute"],
                ].map(([key, action]) => (
                  <div
                    key={key}
                    className="rounded-xl border border-white/[0.08] bg-white/[0.035] p-3"
                  >
                    <kbd className="rounded-md border border-white/15 bg-white/8 px-2 py-1 font-mono text-[10px] text-foreground">
                      {key}
                    </kbd>
                    <p className="mt-2 text-[10px] text-muted-foreground">
                      {action}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="relative flex min-h-[320px] items-center justify-center overflow-hidden border-t border-white/[0.08] bg-[radial-gradient(circle_at_50%_45%,rgba(139,232,255,0.12),transparent_42%)] p-8 lg:border-t-0 lg:border-l">
            <div className="absolute size-64 rounded-full border border-cyan-300/15" />
            <div className="absolute size-44 rounded-full border border-cyan-300/10" />
            <div className="relative w-full max-w-xs rounded-3xl border border-white/10 bg-[#11131a]/85 p-5 shadow-2xl backdrop-blur-xl">
              <div className="flex items-center gap-3">
                <CoverArt className="size-12" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">Show Me Love</p>
                  <p className="text-xs text-muted-foreground">WizTheMc</p>
                </div>
                <Volume2 className="ml-auto size-4 text-brand" />
              </div>
              <div className="mt-5 flex items-center justify-center gap-5 text-muted-foreground">
                <SkipBack className="size-4 fill-current" />
                <span className="flex size-11 items-center justify-center rounded-full bg-white text-black">
                  <Pause className="size-4 fill-current" />
                </span>
                <SkipForward className="size-4 fill-current" />
              </div>
              <div className="mt-5 flex items-center gap-2 text-[10px] text-muted-foreground">
                <span>1:24</span>
                <div className="h-1 flex-1 rounded-full bg-white/10">
                  <div className="h-full w-[38%] rounded-full bg-brand" />
                </div>
                <span>3:32</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/*
        What's New.

        Deliberately only FEATURES — the bug fixes from this cycle are real but
        they are not things to sell, and a changelog padded with "fixed the
        thing that was broken" reads as a confession. The full list, fixes
        included, lives in CHANGELOG.md.
      */}
      <section
        id="whats-new"
        className="relative z-10 mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 sm:py-28"
      >
        <motion.div {...fadeUp} className="mx-auto max-w-2xl text-center">
          <span className="inline-flex items-center gap-2 text-[10px] font-bold tracking-[0.24em] text-brand uppercase">
            <Sparkles className="size-3.5" /> Just landed
          </span>
          <h2 className="mt-4 font-display text-3xl font-bold tracking-tight sm:text-5xl">
            New in this build.
          </h2>
          <p className="mt-4 text-base leading-7 text-muted-foreground">
            Search that finds the song you actually meant, lyrics that keep up
            with it, mixes that mix, and lookups that come back fast.
          </p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground/80">
            Five things that changed how SYNQ feels day to day.
          </p>
        </motion.div>
        <div className="mt-12 flex flex-col gap-2.5">
          {whatsNewCards.map(({ icon: Icon, title, body }, index) => (
            <motion.div
              key={title}
              {...fadeUp}
              transition={{ ...fadeUp.transition, delay: index * 0.08 }}
              className="group flex items-center gap-4 rounded-2xl border border-white/[0.07] bg-white/[0.03] px-5 py-4 transition-colors hover:border-brand/30 hover:bg-white/[0.05]"
            >
              <span className="flex size-10 items-center justify-center rounded-xl bg-brand/12 text-brand ring-1 ring-brand/20 transition-transform group-hover:scale-110">
                <Icon className="size-5" />
              </span>
              <h3 className="max-w-full shrink-0 truncate font-display text-base font-semibold sm:text-lg">
                {title}
              </h3>
              <span
                aria-hidden
                className="hidden h-4 w-px shrink-0 bg-white/10 sm:block"
              />
              <p className="hidden min-w-0 flex-1 truncate text-sm text-muted-foreground sm:block">
                {body}
              </p>
            </motion.div>
          ))}
        </div>
      </section>

      <section className="relative z-10 mx-auto w-full max-w-6xl px-4 py-20 sm:px-6">
        <motion.div
          {...fadeUp}
          className="relative overflow-hidden rounded-3xl border border-white/10 px-6 py-16 text-center sm:px-12"
        >
          <div className="absolute inset-0 bg-gradient-to-br from-brand/18 via-transparent to-violet-500/12" />
          <div className="absolute inset-0 bg-[radial-gradient(60%_120%_at_50%_0%,rgb(203_244_143/0.12),transparent_70%)]" />
          <div className="relative">
            <span className="inline-flex items-center gap-2 text-[10px] font-bold tracking-[0.22em] text-brand uppercase">
              <TimerReset className="size-3.5" /> Your next favorite is waiting
            </span>
            <h2 className="mt-4 font-display text-3xl font-bold tracking-tight sm:text-5xl">
              Ready when you are.
            </h2>
            <p className="mx-auto mt-4 max-w-md text-base leading-7 text-muted-foreground">
              Browse first. Sign in when you press play, and let the next song
              find you.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Link
                to="/home"
                className="group flex items-center gap-2 rounded-full bg-brand px-7 py-3 text-sm font-semibold text-brand-foreground shadow-[0_10px_36px_rgb(203_244_143/0.4)] transition-transform hover:scale-105"
              >
                Start listening{" "}
                <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
              </Link>
              <InstallAppButton />
              <a
                href="#features"
                className="rounded-full border border-white/10 px-5 py-3 text-sm font-semibold text-muted-foreground transition-colors hover:border-white/20 hover:text-foreground"
              >
                Explore features
              </a>
            </div>
          </div>
        </motion.div>
      </section>

      <SiteFooter />
    </div>
  );
}
