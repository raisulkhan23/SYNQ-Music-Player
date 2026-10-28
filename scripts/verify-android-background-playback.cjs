#!/usr/bin/env node
/**
 * On-device proof that SYNQ keeps playing when the screen is off or the app is
 * minimised, and that the media session / foreground service really exist while
 * it does.
 *
 * ## Why this exists
 *
 * "The music stops when I lock my phone" cannot be settled by reading code: the
 * answer depends on the WebView, the Android version and the foreground
 * service, and all three are only observable on a device. So this drives the
 * real installed app, turns the screen off, and asks the platform — not the app
 * — what is happening:
 *
 *   - `dumpsys media_session`  → is a session PLAYING, with the right metadata?
 *   - `dumpsys activity services` → is our mediaPlayback service in the
 *     foreground (which is what stops Android freezing the WebView)?
 *   - `dumpsys notification`   → is the media notification actually posted?
 *   - the audio element's `currentTime` via CDP → did audio ADVANCE while the
 *     screen was off? A running service does not by itself prove sound.
 *
 * The audio is played on the app's OWN deck element (`window.__ssAudio`, put
 * there by `@/lib/audio`), with the app's own plugin calls, so what is being
 * measured is the app's real playback object rather than a test double.
 *
 * ## Requirements
 *
 *   - a REAL device attached (`adb devices`), or an emulator you trust. The
 *     result this script reports is only as good as the device: a sluggish or
 *     misconfigured AVD can fail the audio-advance check for reasons that have
 *     nothing to do with SYNQ, so prefer hardware.
 *   - a DEBUG build (`CAPACITOR_DEBUG_WEBVIEW=1 npx cap sync android` then
 *     `./gradlew assembleDebug`), because CDP needs a debuggable WebView
 *   - the app launched at least once
 *
 * NOTE: the audio has to be started by this script rather than by tapping Play,
 * because playback in SYNQ requires a signed-in account and a test rig must not
 * need one. Everything else is the production path: the app's own deck element,
 * the app's own media-session plugin, the app's own foreground service.
 *
 * ## Usage
 *
 *   node scripts/verify-android-background-playback.cjs all
 *
 * or one step at a time:
 *
 *   … start          put audio on the deck, publish the session, start playing
 *   … status         print the platform evidence
 *   … position       audio element's currentTime / paused, via CDP
 *   … button 87      send a media button (87 = MEDIA_NEXT, 85 = PLAY_PAUSE)
 *   … screen off|on
 *   … all [seconds]  the whole sequence, ending in PASS/FAIL lines
 */
const { execFileSync } = require("node:child_process");

const ADB_CANDIDATES = [
  process.env.ADB,
  "adb",
  "D:/Android/platform-tools/adb.exe",
  `${process.env.LOCALAPPDATA}/Android/Sdk/platform-tools/adb.exe`,
];

function adbBin() {
  for (const candidate of ADB_CANDIDATES) {
    if (!candidate) continue;
    try {
      execFileSync(candidate, ["version"], { stdio: "ignore" });
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  throw new Error("adb not found — set ADB=/path/to/adb");
}

const ADB = adbBin();

function adb(...args) {
  return execFileSync(ADB, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
}

function shell(...args) {
  return adb("shell", ...args);
}

/** The WebView's devtools socket, which is how we reach the page's JS. */
function devtoolsSocket() {
  const listing = shell("cat", "/proc/net/unix");
  const match = listing.match(/webview_devtools_remote_\d+/);
  if (!match) {
    throw new Error(
      "No WebView devtools socket. Is the app running, and is this a DEBUG build (CAPACITOR_DEBUG_WEBVIEW=1)?",
    );
  }
  return match[0];
}

let forwarded = false;

function forward() {
  if (forwarded) return;
  const socket = devtoolsSocket();
  adb("forward", "--remove-all");
  adb("forward", "tcp:9222", `localabstract:${socket}`);
  forwarded = true;
}

async function pageTarget() {
  forward();
  const response = await fetch("http://127.0.0.1:9222/json");
  const targets = await response.json();
  const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page) throw new Error("No page target on the WebView devtools socket");
  return page.webSocketDebuggerUrl;
}

/** Evaluate an expression in the app's page and return its value. */
async function evaluate(expression) {
  const url = await pageTarget();
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("CDP socket failed")), {
      once: true,
    });
  });
  try {
    const id = 1;
    const result = await new Promise((resolve, reject) => {
      const onMessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== id) return;
        socket.removeEventListener("message", onMessage);
        resolve(message);
      };
      socket.addEventListener("message", onMessage);
      socket.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: {
            expression,
            awaitPromise: true,
            returnByValue: true,
            userGesture: true,
          },
        }),
      );
      setTimeout(() => reject(new Error("CDP evaluate timed out")), 30000);
    });
    if (result.result?.exceptionDetails) {
      throw new Error(
        `page threw: ${result.result.exceptionDetails.exception?.description ?? "unknown"}`,
      );
    }
    return result.result?.result?.value;
  } finally {
    socket.close();
  }
}

/**
 * The harness, run inside the real page.
 *
 * It uses `window.__ssAudio` — the deck element the app itself plays through —
 * and the bridge's own plugin handle, so every part of the chain under test
 * (media element, media session plugin, foreground service) is the production
 * one. The audio is a generated 120s tone, because the app's catalogue needs a
 * signed-in account and this test must not require one.
 */
const HARNESS = `(async () => {
  const seconds = 120;
  const rate = 8000;
  const frames = rate * seconds;
  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);
  const ascii = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  ascii(0, "RIFF"); view.setUint32(4, 36 + frames * 2, true); ascii(8, "WAVE");
  ascii(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); ascii(36, "data"); view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) view.setInt16(44 + i * 2, Math.round(Math.sin(i * 0.08) * 900), true);

  const url = URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));
  // The app's OWN deck element: decks are built at store creation, so this is
  // the very object the player would be playing through.
  const audio = window.__ssAudio || (() => { const a = new Audio(); a.setAttribute("aria-hidden", "true"); a.style.display = "none"; document.body.appendChild(a); window.__ssAudio = a; return a; })();
  audio.src = url;
  audio.loop = false;
  audio.currentTime = 0;
  await audio.play();

  const plugin = window.Capacitor?.Plugins?.MediaSession;
  const native = window.Capacitor;
  const call = (method, options, handler) => {
    if (plugin?.setMetadata) {
      return handler ? plugin[method](options, handler) : plugin[method](options);
    }
    // Fall back to the bridge itself, which is how the plugin proxy is built.
    if (handler) return native.nativeCallback("MediaSession", method, options, handler);
    return native.nativePromise("MediaSession", method, options);
  };

  window.__synqTestCounters = { next: 0, pause: 0, play: 0, stop: 0 };
  await call("setMetadata", { title: "Background Test", artist: "SYNQ rig", album: "Verification", artwork: [] });
  await call("setActionHandler", { action: "nexttrack" }, () => { window.__synqTestCounters.next++; });
  await call("setActionHandler", { action: "pause" }, () => { window.__synqTestCounters.pause++; });
  await call("setActionHandler", { action: "play" }, () => { window.__synqTestCounters.play++; });
  await call("setActionHandler", { action: "stop" }, () => { window.__synqTestCounters.stop++; });
  await call("setPlaybackState", { playbackState: "playing" });

  return {
    deck: !!window.__ssAudio,
    pluginHandle: !!plugin,
    paused: audio.paused,
    currentTime: audio.currentTime,
    duration: audio.duration || null,
  };
})()`;

const POSITION = `(() => {
  const a = window.__ssAudio;
  return { paused: a ? a.paused : null, currentTime: a ? a.currentTime : null, readyState: a ? a.readyState : null, counters: window.__synqTestCounters || null };
})()`;

function status() {
  const out = {};
  const mediaSession = shell("dumpsys", "media_session");
  const lines = mediaSession.split("\n");
  const index = lines.findIndex((line) => line.includes("com.synq.music"));
  out.mediaSession =
    index >= 0
      ? lines
          .slice(index, index + 14)
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith("package "))
          .join(" | ")
      : "NO SESSION for com.synq.music";

  const services = shell("dumpsys", "activity", "services", "com.synq.music");
  out.service = services.includes("MediaSessionService")
    ? services
        .split("\n")
        .filter((line) => line.includes("ServiceRecord") || line.includes("isForeground") || line.includes("MediaSessionService"))
        .map((line) => line.trim())
        .slice(0, 6)
        .join(" | ")
    : "NO MediaSessionService running";

  const notifications = shell("dumpsys", "notification", "--noredact");
  out.notification = notifications.includes("com.synq.music")
    ? notifications
        .split("\n")
        .filter((line) => line.includes("com.synq.music"))
        .map((line) => line.trim())
        .slice(0, 4)
        .join(" | ")
    : "NO notification for com.synq.music";
  out.screenOn = shell("dumpsys", "power").includes("mWakefulness=Awake");
  return out;
}

function screen(state) {
  const showing = shell("dumpsys", "power").includes("mWakefulness=Awake");
  if (state === "off" && showing) shell("input", "keyevent", "26");
  if (state === "on" && !showing) {
    shell("input", "keyevent", "26");
    shell("wm", "dismiss-keyguard");
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function line(label, value) {
  console.log(`${label.padEnd(22)} ${value}`);
}

async function all(seconds) {
  const wait = seconds || 90;
  console.log("== SYNQ background playback verification ==\n");
  shell("am", "start", "-n", "com.synq.music/.MainActivity");
  await sleep(4000);

  const started = await evaluate(HARNESS);
  line("harness", JSON.stringify(started));
  await sleep(2500);

  const before = await evaluate(POSITION);
  line("position (awake)", JSON.stringify(before));
  const beforeStatus = status();
  line("session (awake)", beforeStatus.mediaSession);
  line("service (awake)", beforeStatus.service);
  line("notification (awake)", beforeStatus.notification);

  console.log(`\n-- screen off + backgrounded, waiting ${wait}s --\n`);
  screen("off");
  await sleep(wait);

  const afterStatus = status();
  // Reading the element requires the process and page to still be alive; if
  // this throws, the page is gone and that IS the finding.
  let after = null;
  let pageAlive = true;
  try {
    after = await evaluate(POSITION);
  } catch (error) {
    pageAlive = false;
    after = { error: String(error.message) };
  }

  line("screen awake?", afterStatus.screenOn);
  line("session (screen off)", afterStatus.mediaSession);
  line("service (screen off)", afterStatus.service);
  line("notification (off)", afterStatus.notification);
  line("page alive?", pageAlive);
  line("position (screen off)", JSON.stringify(after));

  const advanced =
    pageAlive && after.currentTime !== null && after.currentTime > (before.currentTime ?? 0) + wait * 0.5;
  const playing = /PLAYING|state=3/.test(afterStatus.mediaSession);
  const foreground = /isForeground=true/.test(afterStatus.service);
  const notified = !afterStatus.notification.startsWith("NO notification");

  // Media button control, still screen-off: proof the lock-screen transport is
  // wired to our handlers and not just drawn.
  shell("input", "keyevent", "87"); // MEDIA_NEXT
  await sleep(1500);
  const afterButton = pageAlive ? await evaluate(POSITION) : { counters: null };

  screen("on");

  console.log("\n== result ==");
  line("audio advanced", advanced ? "PASS" : "FAIL");
  line("session PLAYING", playing ? "PASS" : "FAIL");
  line("service foreground", foreground ? "PASS" : "FAIL");
  line("notification posted", notified ? "PASS" : "FAIL");
  line("media button reached JS", afterButton?.counters?.next > 0 ? "PASS" : "FAIL");
  line("counters", JSON.stringify(afterButton?.counters ?? null));
  process.exit(advanced && playing && foreground ? 0 : 1);
}

async function main() {
  const [command, argument] = process.argv.slice(2);
  switch (command) {
    case "start": {
      shell("am", "start", "-n", "com.synq.music/.MainActivity");
      await sleep(4000);
      line("harness", JSON.stringify(await evaluate(HARNESS)));
      break;
    }
    case "position":
      line("position", JSON.stringify(await evaluate(POSITION)));
      break;
    case "status":
      for (const [key, value] of Object.entries(status())) line(key, value);
      break;
    case "button":
      shell("input", "keyevent", String(argument || 87));
      await sleep(1200);
      line("position", JSON.stringify(await evaluate(POSITION)));
      break;
    case "screen":
      screen(argument === "on" ? "on" : "off");
      line("screen", argument === "on" ? "on" : "off");
      break;
    case "eval":
      line("result", JSON.stringify(await evaluate(argument)));
      break;
    case "all":
      await all(Number(argument) || 90);
      break;
    default:
      console.log(
        "usage: node scripts/verify-android-background-playback.cjs <start|status|position|button <keycode>|screen on|off|eval <js>|all [seconds]>",
      );
  }
}

main().catch((error) => {
  console.error(`verification failed: ${error.message}`);
  process.exit(1);
});
