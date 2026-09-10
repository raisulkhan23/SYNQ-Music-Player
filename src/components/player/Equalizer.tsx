import { cn } from "@/lib/utils";

export function Equalizer({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("flex h-4 items-end gap-[2.5px]", className)}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="eq-bar w-[3px] rounded-full bg-[rgb(var(--tint))]"
          style={{
            height: `${[70, 100, 55][i]}%`,
            animationDelay: `${i * 0.18}s`,
            animationDuration: `${0.9 + i * 0.14}s`,
          }}
        />
      ))}
    </span>
  );
}