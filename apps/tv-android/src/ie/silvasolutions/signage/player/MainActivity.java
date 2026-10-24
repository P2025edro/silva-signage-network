package ie.silvasolutions.signage.player;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

/**
 * Kiosk shell for the Silva Signage web player: full screen, screen always on,
 * starts with the TV, and recovers by itself from network or renderer failures.
 * The pairing token lives in the WebView's storage, so pairing survives restarts.
 */
public class MainActivity extends Activity {
    static final String PLAYER_URL = "https://silva-signage.vercel.app/player/";
    private static final long RETRY_MS = 15_000;
    /** Safety net: reload the player every 12 hours (it also refreshes itself). */
    private static final long DAILY_RELOAD_MS = 12L * 60 * 60 * 1000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private WebView web;
    private boolean retryScheduled = false;
    private int backPresses = 0;

    private final Runnable retry = new Runnable() {
        @Override public void run() {
            retryScheduled = false;
            if (web != null) web.loadUrl(PLAYER_URL);
        }
    };
    private final Runnable periodicReload = new Runnable() {
        @Override public void run() {
            if (web != null) web.loadUrl(PLAYER_URL);
            handler.postDelayed(this, DAILY_RELOAD_MS);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_FULLSCREEN
                | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        setContentView(root);
        createWebView();
        web.loadUrl(PLAYER_URL);
        handler.postDelayed(periodicReload, DAILY_RELOAD_MS);
        maybeAskToStartOnBoot();
    }

    private void createWebView() {
        if (web != null) {
            root.removeView(web);
            web.destroy();
        }
        web = new WebView(this);
        web.setBackgroundColor(Color.BLACK);
        web.setFocusable(true);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        if (Build.VERSION.SDK_INT >= 21) s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptCookie(true);
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return false; // stay inside the kiosk
            }
            @SuppressWarnings("deprecation")
            @Override public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                if (failingUrl != null && failingUrl.startsWith(PLAYER_URL)) scheduleRetry();
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (Build.VERSION.SDK_INT >= 21 && request.isForMainFrame()) scheduleRetry();
            }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // The web engine crashed or was killed for memory: rebuild it and carry on.
                handler.post(new Runnable() {
                    @Override public void run() {
                        createWebView();
                        web.loadUrl(PLAYER_URL);
                    }
                });
                return true;
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        web.requestFocus();
    }

    private void scheduleRetry() {
        if (retryScheduled) return;
        retryScheduled = true;
        handler.postDelayed(retry, RETRY_MS);
    }

    /** Android 10+ only lets an app open itself at boot if "display over other apps" is allowed. */
    private void maybeAskToStartOnBoot() {
        if (Build.VERSION.SDK_INT < 29 || Settings.canDrawOverlays(this)) return;
        SharedPreferences prefs = getSharedPreferences("silva", MODE_PRIVATE);
        if (prefs.getBoolean("askedOverlay", false)) return;
        prefs.edit().putBoolean("askedOverlay", true).apply();
        Toast.makeText(this, "Allow \"Display over other apps\" so Silva Signage opens when the TV turns on.", Toast.LENGTH_LONG).show();
        try {
            startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getPackageName())));
        } catch (ActivityNotFoundException ignored) {
            // Some TVs have no such screen; the app can still be opened from the launcher.
        }
    }

    private void hideSystemUi() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }

    @Override public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    @Override protected void onResume() {
        super.onResume();
        hideSystemUi();
        if (web != null) web.onResume();
    }

    /** Back is ignored so a stray remote press doesn't stop the adverts. Press it 5 times quickly to leave. */
    @Override public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            backPresses++;
            handler.removeCallbacks(resetBack);
            handler.postDelayed(resetBack, 2000);
            if (backPresses >= 5) {
                backPresses = 0;
                moveTaskToBack(true);
            }
            return true;
        }
        if (keyCode == KeyEvent.KEYCODE_MENU) { // menu key reloads the player
            if (web != null) web.loadUrl(PLAYER_URL);
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    private final Runnable resetBack = new Runnable() {
        @Override public void run() { backPresses = 0; }
    };

    @Override protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
