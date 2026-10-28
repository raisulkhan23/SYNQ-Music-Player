package com.synq.music;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.media.AudioManager;
import android.util.Log;
import com.getcapacitor.Bridge;

/**
 * "The audio route you were using has just gone away" — in practice: the
 * headphones were unplugged, or a Bluetooth speaker went out of range.
 *
 * Android's contract for this is `AudioManager.ACTION_AUDIO_BECOMING_NOISY`,
 * and every expectation around it is that the app pauses. Playing out loud from
 * the phone's own speaker after someone yanks their headphones out is the
 * classic embarrassment, and the media frameworks only pause automatically in
 * apps that do their own audio routing.
 *
 * SYNQ's audio is a WebView `<audio>` element, so this has to be caught
 * natively and handed to the player as an event. The receiver does NOT touch
 * playback itself: it deliberately has no idea what is playing or whether the
 * user even wants it stopped. It emits, the store decides — which is the same
 * division of labour every other remote control in this app uses, and the
 * reason the notification and the lock screen cannot get out of step with the
 * transport bar.
 *
 * Nothing here resumes anything. Route loss is only ever a pause.
 */
public class AudioRouteLossReceiver extends BroadcastReceiver {

    private static final String TAG = "SYNQAudioRoute";

    /** The DOM event name the web player listens for. */
    public static final String EVENT_NAME = "synqAudioRouteLost";

    private final MainActivity activity;

    public AudioRouteLossReceiver(MainActivity activity) {
        this.activity = activity;
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        try {
            if (intent == null || !AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction())) {
                return;
            }
            Bridge bridge = activity.getBridge();
            if (bridge == null) return;
            // `triggerWindowJSEvent` dispatches a DOM event on `window`, which
            // is the only channel that works while the Activity is stopped and
            // no plugin call is in flight.
            bridge.triggerWindowJSEvent(EVENT_NAME);
        } catch (Exception error) {
            // A broadcast handler that throws takes the whole process down, and
            // losing an unplug-pause is not worth that.
            Log.w(TAG, "Could not deliver route-loss event", error);
        }
    }
}
