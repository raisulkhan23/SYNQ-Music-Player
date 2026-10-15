import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor configuration — the Android shell around SYNQ.
 *
 * Why this exists alongside the PWA: the installed PWA launches inside
 * Chrome's WebAPK wrapper, which is where "opens then instantly closes" was
 * happening. A Capacitor build is a real Android app in its own right: its own
 * launcher activity, its own WebView, no Chrome install step and no service
 * worker. `webDir` therefore points at the PRODUCTION build, not the dev
 * server — a WebView pointed at a dev server would break the moment the
 * preview session ended, which is the same failure in a different wrapper.
 *
 * `CAPACITOR_SERVER_URL` lets you point a debug build at a live dev server
 * while working. It is deliberately opt-in and unset by default, so a shipped
 * build can never accidentally load from localhost.
 */
const config: CapacitorConfig = {
  appId: "com.synq.music",
  appName: "SYNQ",
  webDir: "dist",
  android: {
    // Released builds must not ship a debuggable WebView, so this is OFF unless
    // it is asked for explicitly — the same opt-in shape as
    // `CAPACITOR_SERVER_URL` below, and for the same reason: an ambient setting
    // must never be able to leave a shipped build inspectable. A debug build
    // sets it to attach Chrome DevTools over `adb forward` when the background
    // playback behaviour has to be observed inside the real WebView, which is
    // not something the release APK should ever allow.
    webContentsDebuggingEnabled: process.env.CAPACITOR_DEBUG_WEBVIEW === "1",
  },
  server: {
    androidScheme: "https",
    // Live-reload against a dev server. Unset => use the bundled app.
    ...(process.env.CAPACITOR_SERVER_URL
      ? { url: process.env.CAPACITOR_SERVER_URL, cleartext: true }
      : {}),
  },
};

export default config;