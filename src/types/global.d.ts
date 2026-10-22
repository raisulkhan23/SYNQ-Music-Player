declare global {
  interface Window {
    /**
     * Present only inside the Electron shell (`electron/preload.cjs`). The
     * renderer uses it to skip service workers and the install prompt, which
     * have no meaning in a packaged app. Each additional surface is optional
     * and narrow: the web and Android shells never see this object.
     */
    synqDesktop?: {
      isDesktop: true;
      platform: string;
      shell: "electron";
      /** Register the callback id/nonce/timestamp this OAuth attempt expects
       * (desktop return path via `synq://callback`, see `src/lib/desktop-auth.ts`). */
      beginOAuth?: (clientId: string, params: DesktopOAuthBeginParams) => void;
      /** Subscribe to validated callback results. Returns an unsubscribe fn. */
      onAuthResult?: (
        listener: (result: DesktopOAuthResult) => void,
      ) => () => void;
      /** Renderer's close-to-tray preference (main process decides finally). */
      minimizeToTray?: (enable: boolean) => void;
      /** Tray menu quick actions. Returns an unsubscribe fn. */
      onTrayAction?: (listener: (action: string) => void) => () => void;
    };
    /**
     * Navigate to the auth page with a custom redirect URL
     * @param redirectUrl - URL to redirect to after successful authentication
     */
    navigateToAuth: (redirectUrl: string) => void;
  }
}

// The desktop OAuth contract types live next to their consumer module and are
// ambient here because the bridge surface must be described on `Window`.
interface DesktopOAuthBeginParams {
  /** The page the app should be on when sign-in completes. */
  redirectTo: string;
  /** Must match the `nonce` sent back in the deep link. */
  nonce: string;
  /** Epoch ms of the attempt; the main process rejects stale callbacks. */
  ts: number;
}

interface DesktopOAuthResult {
  client: string;
  ts: number;
  nonce: string | null;
  /** Set when the provider denied, or the callback failed validation. */
  error: string | null;
  /** The verification code the app exchanges for a session. */
  code: string | null;
  state: string | null;
}

export {};
