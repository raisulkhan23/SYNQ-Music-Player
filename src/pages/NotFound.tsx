import { motion } from "framer-motion";
import { Link } from "react-router";
import { AudioLines } from "lucide-react";

export default function NotFound() {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
      className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-background px-4 text-center text-foreground"
    >
      <div className="pointer-events-none absolute left-1/2 top-[-180px] h-[420px] w-[680px] -translate-x-1/2 rounded-full bg-brand/12 blur-3xl" />
      <div className="relative">
        <p className="font-display text-7xl font-bold tracking-tight sm:text-8xl">
          4<span className="text-brand">0</span>4
        </p>
        <p className="mt-3 font-display text-xl font-semibold">
          This track doesn&apos;t exist
        </p>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
          The page you&apos;re looking for was skipped, deleted, or never queued.
        </p>
        <Link
          to="/"
          className="mt-8 inline-flex items-center gap-2 rounded-full bg-brand px-6 py-3 text-sm font-semibold text-brand-foreground shadow-[0_10px_36px_rgb(203_244_143/0.35)] transition-transform hover:scale-105"
        >
          <AudioLines className="size-4" />
          Back to SoundScape
        </Link>
      </div>
    </motion.div>
  );
}