// Ambient declarations for the desktop shell bridge.
//
// The surface must stay in lockstep with `electron/preload.cjs`, which exposes
// a single frozen `window.synqDesktop` object via `contextBridge`. Everything
// here is optional because the web/PWA/Android builds never see the bridge.

export {};

declare global {
  interface SynqDesktopBridge {
    isDesktop: true;
    platform: string;
    shell: "electron";

    // --- Desktop OAuth (src/lib/desktop-auth.ts) ---------------------------
    beginOAuth: (
      clientId: string,
      params?: { nonce?: string | null; ts?: number | null; redirectTo?: string | null },
    ) => void;
    onAuthResult: (
      listener: (result: {
        client: string;
        ts: number;
        nonce: string | null;
        error: string | null;
        code: string | null;
        state: string | null;
      }) => void,
    ) => () => void;

    // --- Tray (src/lib/trayBridge.ts) --------------------------------------
    minimizeToTray: (enable: boolean) => void;
    onTrayAction: (listener: (action: string) => void) => () => void;
  }

  interface Window {
    synqDesktop?: SynqDesktopBridge;
  }
}
