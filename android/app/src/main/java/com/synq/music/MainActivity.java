package com.synq.music;

import android.content.BroadcastReceiver;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioManager;
import android.os.Bundle;
import android.util.Log;

import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    private static final String TAG = "SYNQMainActivity";

    private BroadcastReceiver routeLossReceiver;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        registerRouteLossReceiver();
    }

    /**
     * Listen for the audio route disappearing (headphones unplugged, Bluetooth
     * speaker gone) so the web player can pause instead of suddenly playing out
     * of the phone's own speaker.
     *
     * Registered by hand rather than in the manifest because the handler needs
     * the live bridge: an implicit-broadcast manifest entry would be delivered
     * to a fresh process instance and would have no page to talk to.
     *
     * `RECEIVER_NOT_EXPORTED` is correct and not merely conservative —
     * AUDIO_BECOMING_NOISY is a system broadcast, and the flag restricts
     * delivery to the system and this app, which is the only sender that should
     * ever be able to pause someone's music.
     *
     * Wrapped in try/catch on purpose: this is a nicety bolted onto a working
     * player, and a registration failure on some future Android version must
     * cost an unplug-pause, never the ability to launch the app.
     */
    private void registerRouteLossReceiver() {
        try {
            routeLossReceiver = new AudioRouteLossReceiver(this);
            ContextCompat.registerReceiver(
                this,
                routeLossReceiver,
                new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
                ContextCompat.RECEIVER_NOT_EXPORTED
            );
        } catch (Exception error) {
            Log.w(TAG, "Audio route-loss receiver not registered", error);
            routeLossReceiver = null;
        }
    }

    // `public`, not `protected`: BridgeActivity declares it public, and a
    // weaker override does not compile. (It is also the honest signature —
    // Capacitor calls into it.)
    @Override
    public void onDestroy() {
        if (routeLossReceiver != null) {
            try {
                unregisterReceiver(routeLossReceiver);
            } catch (IllegalArgumentException error) {
                Log.w(TAG, "Audio route-loss receiver already unregistered", error);
            }
            routeLossReceiver = null;
        }
        super.onDestroy();
    }
}
