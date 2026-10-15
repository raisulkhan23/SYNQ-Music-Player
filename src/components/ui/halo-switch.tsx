"use client";

import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";

import { cn } from "@/lib/utils";

/**
 * HaloSwitch — the SYNQ toggle.
 *
 * Why a dedicated component instead of the shadcn `Switch`: the settings rows
 * used to draw their own hand-rolled pill, the audio panel used a third look,
 * and every one of them drifted. Settings rows are dense and sit on a
 * translucent glass panel, so the control needs a soft "halo" (the tinted glow
 * that says *on*) and a spring on the thumb so a tap feels like it landed. That
 * is the whole reason this exists.
 *
 * State is driven entirely by Radix's `data-state` attribute and CSS, not by
 * React state, so the component works both controlled (`checked` +
 * `onCheckedChange`) and uncontrolled (`defaultChecked`) without a shim, and it
 * never re-renders to animate. The spring is a real cubic-bezier overshoot, so
 * there is no animation library in the critical path.
 *
 * Props are Radix's, plus:
 * - `size`: "default" for standalone use, "sm" for dense settings rows.
 * - `translucent`: for glass surfaces — the track lets the panel show through
 *   until it is switched on.
 */
const SIZES = {
  default: {
    track: "h-6 w-11",
    thumb: "size-5",
    /** Track width − 2×padding − thumb width. */
    on: "data-[state=checked]:translate-x-[20px]",
  },
  sm: {
    track: "h-5 w-9",
    thumb: "size-4",
    on: "data-[state=checked]:translate-x-[16px]",
  },
} as const;

export type HaloSwitchSize = keyof typeof SIZES;

export type HaloSwitchProps = React.ComponentProps<
  typeof SwitchPrimitive.Root
> & {
  size?: HaloSwitchSize;
  translucent?: boolean;
};

function HaloSwitch({
  className,
  size = "default",
  translucent = false,
  ...props
}: HaloSwitchProps) {
  const dims = SIZES[size];

  return (
    <SwitchPrimitive.Root
      data-slot="halo-switch"
      className={cn(
        // The `group` is what lets the halo react to the root's data-state.
        "group relative inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent p-0.5 outline-none transition-[background-color,box-shadow] duration-300",
        "focus-visible:ring-[3px] focus-visible:ring-[rgb(var(--tint)_/_0.45)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        dims.track,
        translucent
          ? [
              "border-white/10 bg-white/[0.08] backdrop-blur-sm",
              "supports-[backdrop-filter]:bg-white/[0.06]",
              "data-[state=checked]:border-transparent data-[state=checked]:bg-[rgb(var(--tint)_/_0.45)]",
            ]
          : [
              "bg-white/15",
              "data-[state=checked]:bg-[rgb(var(--tint))]",
            ],
        // The halo: a tight ring plus a wider bloom, only when switched on.
        "data-[state=checked]:shadow-[0_0_0_3px_rgb(var(--tint)_/_0.2),0_0_18px_rgb(var(--tint)_/_0.35)]",
        className,
      )}
      {...props}
    >
      {/* Inner sheen. Inert decoration: never a hit target. */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 rounded-full opacity-0 transition-opacity duration-300",
          "bg-[radial-gradient(130%_130%_at_22%_45%,rgb(var(--tint)_/_0.5),transparent_68%)]",
          "group-data-[state=checked]:opacity-100",
        )}
      />
      <SwitchPrimitive.Thumb
        data-slot="halo-switch-thumb"
        className={cn(
          "relative z-10 block rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.35)]",
          // Overshoot bezier = the "spring" without a runtime animation lib.
          "transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]",
          "group-data-[state=unchecked]:translate-x-0",
          dims.thumb,
          dims.on,
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { HaloSwitch };
