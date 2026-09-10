import { cn } from "@/lib/utils";
import { AudioLines } from "lucide-react";
import { Link } from "react-router";

export function Logo({ to = "/", className }: { to?: string; className?: string }) {
  return (
    <Link to={to} className={cn("group flex items-center gap-2.5", className)}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-[rgb(var(--tint))] text-black shadow-[0_4px_18px_rgb(var(--tint)/0.4)] transition-transform group-hover:scale-105">
        <AudioLines className="size-5" />
      </span>
      <span className="font-display text-[17px] font-bold tracking-tight">
        SoundScape
      </span>
    </Link>
  );
}