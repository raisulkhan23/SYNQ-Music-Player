/**
 * "Am I running inside a packaged native shell?" — asked in more than one place.
 *
 * Read from the injected `window.Capacitor` global rather than importing
 * `@capacitor/core`: the question is one property read, and the answer is the
 * same before and after the Capacitor runtime initialises. The Electron desktop
 * build injects nothing, so it answers false there — `isFileProtocol()` (see
 * `publicAsset`) is what tells the desktop app apart, because Electron loads
 * the bundle over `file://`.
 */
export function isNativeShell(): boolean {
  if (typeof window === "undefined") return false;
  const bridge = (
    window as unknown as {
      Capacitor?: {
        isNativePlatform?: () => boolean;
        getPlatform?: () => string;
      };
    }
  ).Capacitor;
  return bridge?.isNativePlatform?.() === true;
}

/** The packaged Android shell specifically. */
export function isAndroidShell(): boolean {
  if (!isNativeShell()) return false;
  const bridge = (
    window as unknown as {
      Capacitor?: { getPlatform?: () => string };
    }
  ).Capacitor;
  return bridge?.getPlatform?.() === "android";
}
