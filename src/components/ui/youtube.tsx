import { cn } from "@/lib/utils";
import type { SVGAttributes } from "react";

/** Small YouTube mark used in the remote-play chip. */
export function YoutubeIcon({
  className,
  ...props
}: SVGAttributes<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      className={cn("size-3 shrink-0", className)}
      fill="currentColor"
      {...props}
    >
      <path d="M23.5 6.54c-5.56 0-10.4 1.68-14.06 4.16m-14.06-4.16C2.5 6.54 4.34 1.33 9.9 1.33c5.56 0 10.4 1.68 14.06 4.16m-14.06-4.16L12 20h12l-9.74-13.46z" />
    </svg>
  );
}
