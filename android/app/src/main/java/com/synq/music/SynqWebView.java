package com.synq.music;

import android.content.Context;
import android.util.AttributeSet;
import android.view.View;

import com.getcapacitor.CapacitorWebView;

/**
 * A Capacitor WebView that can stay "visible" to Chromium while audio plays.
 *
 * When an Activity is backgrounded, Android reports the WebView's window as
 * GONE. Chromium responds by pausing HTML media, independently of Capacitor's
 * `keepRunning` setting. The only supported-for-now workaround is to withhold
 * that GONE notification while the native playback lease is active. The
 * player's own pause/stop is what ends the lease and lets the WebView sleep.
 *
 * The class extends CapacitorWebView rather than WebView so the bridge still
 * recognises it and attaches its input/config behavior.
 */
public class SynqWebView extends CapacitorWebView {

    /** Set by MainActivity: whether the activity itself is currently visible. */
    private static volatile boolean activityVisible = true;

    public SynqWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    public static void setActivityVisible(boolean visible) {
        activityVisible = visible;
    }

    @Override
    protected void onWindowVisibilityChanged(int visibility) {
        // Chromium pauses HTML media as soon as it believes its window is not
        // visible, which is exactly what happens when the app is minimised or
        // the screen is turned off. While the playback lease is held the WebView
        // must therefore keep reporting itself as visible, so an <audio>
        // element keeps decoding and the foreground service is not the only
        // thing keeping the track alive.
        if ((visibility == View.GONE || visibility == View.INVISIBLE)
                && SynqPlaybackPlugin.isPlaybackActive()) {
            super.onWindowVisibilityChanged(View.VISIBLE);
            return;
        }
        super.onWindowVisibilityChanged(visibility);
    }

    @Override
    public void onVisibilityChanged(View changedView, int visibility) {
        if ((visibility == View.GONE || visibility == View.INVISIBLE)
                && SynqPlaybackPlugin.isPlaybackActive()
                && changedView == this) {
            super.onVisibilityChanged(changedView, View.VISIBLE);
            return;
        }
        super.onVisibilityChanged(changedView, visibility);
    }

    /** Re-apply the visibility Chromium should see after a lease change. */
    public void syncPlaybackVisibility() {
        if (SynqPlaybackPlugin.isPlaybackActive()) {
            if (!activityVisible) super.onWindowVisibilityChanged(View.VISIBLE);
            return;
        }
        if (!activityVisible) super.onWindowVisibilityChanged(View.GONE);
    }
}
