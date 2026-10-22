declare global {
  interface Window {
    /**
     * Present only inside the Electron shell (`electron/preload.cjs`). The
     * renderer uses it to skip service workers and the install prompt, which
     * have no meaning in a packaged app.
     */
    synqDesktop?: {
      isDesktop: true;
      platform: string;
      shell: "electron";
    };
    /**
     * Navigate to the auth page with a custom redirect URL
     * @param redirectUrl - URL to redirect to after successful authentication
     */
    navigateToAuth: (redirectUrl: string) => void;
  }
}

export {};
