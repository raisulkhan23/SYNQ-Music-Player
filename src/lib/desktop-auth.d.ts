// ---------------------------------------------------------------------------
// SYNQ desktop preload bridge type declarations + Electron-CJS ambient module
// declarations for the web build.
//
// The web build never runs Electron, but it imports modules that TYPE-CHECK
// against `require("electron")` and `require("./oauth-deep-link.cjs")`. The
// web build excludes those files at runtime, so the ambient declarations below
// are enough to make the type checker happy without changing runtime behavior.
// ---------------------------------------------------------------------------

export interface SynqDesktopAuth {
  beginOAuth: (
    clientId: string,
    params?: { nonce?: string; ts?: number; redirectTo?: string },
  ) => void;
  onAuthResult: (listener: (result: unknown) => void) => () => void;
}

export interface SynqDesktopTray {
  minimizeToTray: (enable: boolean) => void;
  onTrayAction: (listener: (action: string) => void) => () => void;
}

export interface SynqDesktopDownload {
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
}

export interface SynqDesktop {
  isDesktop: boolean;
  platform: string;
  shell: string;
  beginOAuth: SynqDesktopAuth["beginOAuth"];
  onAuthResult: SynqDesktopAuth["onAuthResult"];
  minimizeToTray: SynqDesktopTray["minimizeToTray"];
  onTrayAction: SynqDesktopTray["onTrayAction"];
  download?: SynqDesktopDownload;
}

// `window.synqDesktop` is declared ONCE, in `src/types/global.d.ts`. A second
// augmentation here used to narrow the merged type and broke every module that
// read a surface missing from this copy; the `SynqDesktop*` interfaces above
// remain as the documented shape of each surface.

// Ambient module declarations for Electron-only CJS modules that the web build
// does not execute but that downstream code might reference through a narrow
// typed surface. These do NOT provide runtime implementations; they only let
// the type checker accept the desktop-only branches.
declare module "electron" {
  const electron: {
    app: {
      getPath: (name: string) => string;
      getVersion: () => string;
      isPackaged: boolean;
      setAsDefaultProtocolClient: (
        protocol: string,
        executablePath?: string,
        args?: string[],
      ) => boolean;
      isDefaultProtocolClient: (protocol: string) => boolean;
      requestSingleInstanceLock: () => boolean;
      on: (event: string, handler: (...args: any[]) => void) => void;
      whenReady: () => Promise<void>;
      quit: () => void;
      setAppUserModelId: (id: string) => void;
      BrowserWindow: any;
      Menu: any;
    };
    BrowserWindow: any;
    Menu: any;
    Tray: any;
    dialog: any;
    ipcMain: any;
    net: any;
    protocol: any;
    shell: any;
    nativeImage: any;
  };
  export = electron;
}

declare module "../electron/oauth-deep-link.cjs" {
  export function findDeepLinkArg(args: string[]): string | null;
  export function decideNavigationPolicy(
    url: string,
    options?: { appSchemes?: string[]; appOrigins?: string[]; appFileRoot?: string | null },
  ): "deny" | "open-external" | "allow";
  export function onAuthNavigation(
    webContents: any,
    opts?: { appSchemes?: string[]; appOrigins?: string[]; appFileRoot?: string | null; openExternal?: (url: string) => void },
  ): () => void;
  export function recordPendingCallback(id: string, params: { nonce?: string | null; ts?: number | null }): void;
  export function forgetPendingCallback(id: string): void;
  export function forgetAllPendingCallbacks(): void;
  export function parseDeepLinkParams(url: string, now?: number): {
    client: string;
    ts: number;
    nonce: string | null;
    error: string | null;
    code: string | null;
    state: string | null;
  } | null;
  export function dispatchAuthResult(mainWindow: any, result: { client: string; ts: number; nonce: string | null; error: string | null; code: string | null; state: string | null }): void;
  export function registerDeepLink(): void;
  export function handleDeepLink(mainWindow: any, url: string): void;
  export function focusMainWindow(mainWindow: any): void;
  export function onSecondInstance(getWindow: () => any, callback?: () => void): () => void;
  export function onBeginOAuth(): void;
}

export {};
