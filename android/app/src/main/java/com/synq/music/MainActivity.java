package com.synq.music;

import android.content.BroadcastReceiver;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;

import androidx.core.content.ContextCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import com.getcapacitor.WebViewListener;

import org.json.JSONObject;

public class MainActivity extends BridgeActivity {

    private static final String TAG = "SYNQMainActivity";

    /**
     * The deep-link scheme this activity answers for OAuth returns.
     * Kept in step with `android/app/src/main/AndroidManifest.xml` and with
     * `NATIVE_CALLBACK_SCHEME` in `src/lib/native-auth.ts`.
     */
    private static final String AUTH_CALLBACK_SCHEME = "com.synq.music";

    private BroadcastReceiver routeLossReceiver;

    /** A deep link that arrived before the page could receive it. */
    private String pendingAuthUrl;

    /** Whether the WebView has finished loading the app at least once. */
    private boolean pageLoaded;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        registerRouteLossReceiver();
        installOAuthNavigation(getBridge());
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

    /**
     * Keep OAuth out of the WebView.
     *
     * The Convex Auth sign-in route and the provider consent pages it redirects
     * to are main-frame navigations. Left alone they load INSIDE the app's
     * WebView, which breaks sign-in in two ways: Google refuses to complete
     * OAuth in an embedded browser (`disallowed_useragent`), and the flow would
     * have to return to `https://localhost`, replacing the whole document — so
     * even a successful sign-in would land on a fresh, signed-out page.
     *
     * Handing those navigations to the system browser keeps this document
     * mounted. The browser goes to the provider, comes back to the Convex
     * callback, and that callback redirects to `com.synq.music://callback`,
     * which the manifest routes back into `onNewIntent` below.
     *
     * Only main-frame navigations reach here — the email/OTP flow and every
     * other Convex call are `fetch` requests and are unaffected.
     */
    private void installOAuthNavigation(Bridge bridge) {
        if (bridge == null) {
            Log.w(TAG, "No bridge at startup — sign-in will use the WebView");
            return;
        }

        WebView webView = bridge.getWebView();
        if (webView == null) {
            Log.w(TAG, "No WebView at startup — sign-in will use the WebView");
            return;
        }

        webView.setWebViewClient(
            new BridgeWebViewClient(bridge) {
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    Uri url = request.getUrl();
                    if (url != null && shouldOpenExternally(url)) {
                        openInBrowser(url);
                        return true;
                    }
                    return super.shouldOverrideUrlLoading(view, request);
                }
            }
        );

        // The bridge only reports a page as loaded once it reaches 100%, which
        // is also the point where the app's bundle has run and has registered
        // `window.synqNativeAuthDeliver`. A deep link that arrived earlier (the
        // OS can restart this activity while the user is in the browser) is
        // held until then instead of being delivered to a page that cannot
        // receive it.
        bridge.addWebViewListener(
            new WebViewListener() {
                @Override
                public void onPageStarted(WebView view) {
                    pageLoaded = false;
                }

                @Override
                public void onPageLoaded(WebView view) {
                    pageLoaded = true;
                    deliverPendingAuthUrl();
                }
            }
        );
    }

    /**
     * Main-frame navigations that must leave the WebView.
     *
     * The `/api/auth/` path is precise: the app is served from `https://localhost`
     * and nothing else in it navigates to that route as a document.
     */
    private static boolean shouldOpenExternally(Uri url) {
        String raw = url.toString();
        if (raw.contains("/api/auth/")) return true;

        String host = url.getHost();
        if (host == null) return false;
        if (host.equals("github.com")) return true;
        return host.equals("accounts.google.com") || host.endsWith(".accounts.google.com");
    }

    private void openInBrowser(Uri url) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, url);
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            startActivity(intent);
        } catch (Exception error) {
            // No browser at all is unusual but not fatal: the WebView still
            // loads the page, and the user can sign in with an email code.
            Log.w(TAG, "Could not open sign-in in a browser", error);
        }
    }

    // `public`, not `protected`: BridgeActivity declares it public, and a
    // weaker override does not compile. (It is also the honest signature —
    // Capacitor calls into it.)
    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        captureAuthCallback(intent);
    }

    /**
     * The tail of an OAuth attempt: Android launched us with the callback URL.
     *
     * `launchMode="singleTask"` means this arrives on the EXISTING activity, so
     * the WebView still holds the Convex client and the OAuth verifier the SDK
     * stored when the flow began.
     */
    private void captureAuthCallback(Intent intent) {
        if (intent == null) return;
        Uri data = intent.getData();
        if (data == null) return;
        if (!AUTH_CALLBACK_SCHEME.equals(data.getScheme())) return;

        pendingAuthUrl = data.toString();
        deliverPendingAuthUrl();
    }

    /**
     * Hand the callback to `src/lib/native-auth.ts`, which validates it against
     * the attempt it is waiting for and then exchanges the code.
     */
    private void deliverPendingAuthUrl() {
        if (pendingAuthUrl == null || !pageLoaded) return;

        Bridge bridge = getBridge();
        if (bridge == null) return;
        WebView webView = bridge.getWebView();
        if (webView == null) return;

        final String url = pendingAuthUrl;
        pendingAuthUrl = null;

        // JSONObject.quote is the correct escaping for embedding a URL in a JS
        // string literal — the callback carries a query string, so quoting it by
        // hand would be a way to inject script into our own page.
        final String script =
            "window.synqNativeAuthDeliver && window.synqNativeAuthDeliver("
                + JSONObject.quote(url)
                + ");";

        webView.post(() -> {
            try {
                webView.evaluateJavascript(script, null);
            } catch (Exception error) {
                Log.w(TAG, "Could not deliver the sign-in callback to the page", error);
            }
        });
    }

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
