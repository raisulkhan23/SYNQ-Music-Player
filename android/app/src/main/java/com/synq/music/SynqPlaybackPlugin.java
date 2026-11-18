package com.synq.music;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.os.PowerManager;
import android.util.Log;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Keeps the WebView (and the CPU) alive while the web player says it is playing.
 *
 * The media-session plugin already provides the mediaPlayback foreground
 * service. That keeps the process from being killed, but it does not stop
 * Chromium from pausing an <audio> element when the WebView window becomes
 * GONE, and it does not hold the CPU awake with the screen off. Both are needed
 * for a track to continue when SYNQ is minimized.
 *
 * The web player is the source of truth for playback state, so this plugin is
 * deliberately a thin lease: `setPlaybackActive({ active: true })` acquires a
 * partial wake lock and makes the WebView believe it is still visible;
 * `active: false` releases both. It never starts, pauses or seeks audio itself.
 */
@CapacitorPlugin(name = "SynqPlayback")
public class SynqPlaybackPlugin extends Plugin {

    private static final String TAG = "SYNQPlayback";
    private static final String WAKE_LOCK_TAG = "SYNQ:Playback";

    /**
     * Read by SynqWebView from its visibility callback, which runs on the UI
     * thread independently of any plugin call.
     */
    private static volatile boolean playbackActive = false;

    private PowerManager.WakeLock wakeLock;

    public static boolean isPlaybackActive() {
        return playbackActive;
    }

    @PluginMethod
    public void setPlaybackActive(PluginCall call) {
        boolean active = Boolean.TRUE.equals(call.getBoolean("active", false));
        apply(active);
        call.resolve();
    }

    private void apply(boolean active) {
        playbackActive = active;
        setWakeLock(active);
        syncWebViewVisibility();
    }

    @SuppressLint("WakelockTimeout")
    private void setWakeLock(boolean active) {
        if (!active) {
            if (wakeLock != null && wakeLock.isHeld()) {
                try {
                    wakeLock.release();
                } catch (RuntimeException error) {
                    Log.w(TAG, "Could not release the playback wake lock", error);
                }
            }
            return;
        }

        try {
            if (wakeLock == null) {
                Context context = getContext();
                PowerManager manager =
                    context == null
                        ? null
                        : (PowerManager) context.getSystemService(Context.POWER_SERVICE);
                if (manager == null) return;
                wakeLock = manager.newWakeLock(
                    PowerManager.PARTIAL_WAKE_LOCK,
                    WAKE_LOCK_TAG
                );
                wakeLock.setReferenceCounted(false);
            }
            if (!wakeLock.isHeld()) {
                // No timeout: this is a user-started track, and pausing it is
                // what releases the lease. A timeout here would cut a long
                // album short in the background.
                wakeLock.acquire();
            }
        } catch (SecurityException error) {
            // A missing WAKE_LOCK permission must cost the wake lock, never
            // playback. The foreground service can still keep the process.
            Log.w(TAG, "Playback wake lock was refused", error);
        }
    }

    /**
     * Tell the custom WebView that the background-playback lease changed.
     *
     * SynqWebView overrides onWindowVisibilityChanged because Chromium pauses
     * HTML media when its window becomes GONE, even though Capacitor's
     * `keepRunning` setting means the bridge itself has not paused the WebView.
     */
    private void syncWebViewVisibility() {
        Activity activity = getActivity();
        if (activity == null) return;

        activity.runOnUiThread(() -> {
            Bridge bridge = getBridge();
            if (bridge == null) return;
            WebView webView = bridge.getWebView();
            if (webView instanceof SynqWebView) {
                ((SynqWebView) webView).syncPlaybackVisibility();
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        playbackActive = false;
        if (wakeLock != null && wakeLock.isHeld()) {
            try {
                wakeLock.release();
            } catch (RuntimeException error) {
                Log.w(TAG, "Could not release the playback wake lock", error);
            }
        }
        super.handleOnDestroy();
    }
}
