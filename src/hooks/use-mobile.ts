import * as React from "react";

const MOBILE_BREAKPOINT = 768;

export function useIsMobile() {
  // Read the breakpoint during the initial render instead of in an effect:
  // the first paint was previously a desktop layout that flipped to mobile a
  // frame later, which made the shell visibly jump.
  const [isMobile, setIsMobile] = React.useState<boolean>(() =>
    typeof window === "undefined"
      ? false
      : window.innerWidth < MOBILE_BREAKPOINT,
  );

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return !!isMobile;
}
