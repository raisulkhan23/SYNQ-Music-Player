declare global {
  interface Window {
    /**
     * Present only inside the Electron shell (`electron/preload.cjs`, plus the
     * optional `electron/preload-download.cjs` surface).
     *
     * THIS IS THE ONLY DECLARATION of `window.synqDesktop` in the project.
     * It used to also be declared in `desktop-auth.d.ts`,
     * `desktopDownloadStatus.ts` and `desktop-download-bridge.ts`, each with a
     * narrower shape. TypeScript merges those augmentations, so the narrowest
     * one won and every module that touched a surface outside it failed to
     * compile (`Property 'beginOAuth' does not exist on type …`). One
     * declaration, describing the surfaces the shell really installs, keeps
     * the renderer honest without duplicating the contract.
     *
     * Every feature surface is optional because the web build and the Android
     * shell never see this object at all, and older desktop builds do not have
     * every surface.
     */
    synqDesktop?: {
      isDesktop: boolean;
      platform?: string;
      /** The only renderer this object exists in. */
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
      /**
       * Desktop download bridge (`electron/preload-download.cjs`). Missing in
       * builds that do not install it — the renderer must treat that as
       * "desktop download machinery is absent", never as "yt-dlp works".
       */
      download?: {
        isDesktopDownloadBridge: boolean;
        onEvent: (
          eventType: "progress" | "done" | "error",
          handler: (detail: unknown) => void,
        ) => () => void;
        startDownload: (
          trackId: string,
          relayUrl: string,
          filename: string,
        ) => boolean;
        abortDownload: (trackId: string) => boolean;
      };
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
