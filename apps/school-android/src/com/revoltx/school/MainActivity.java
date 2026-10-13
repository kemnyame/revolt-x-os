package com.revoltx.school;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Message;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.JsResult;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebMessage;
import android.webkit.WebMessagePort;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/** A signed Android client for the dedicated School mobile experience; no credentials are bundled. */
public class MainActivity extends Activity {
    private static final int SELECT_FILE = 100, SAVE_FILE = 101;
    private WebView web;
    private ProgressBar progress;
    private LinearLayout offline;
    private FrameLayout loadingOverlay;
    private TextView loadingText;
    private ValueCallback<Uri[]> filePicker;
    private WebMessagePort nativePort;
    private ByteArrayOutputStream download;
    private byte[] pendingDocument;
    private int expectedSize;
    private String downloadName, downloadMime;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().setStatusBarColor(Color.rgb(244,247,245));
        getWindow().setNavigationBarColor(Color.rgb(244,247,245));
        if (Build.VERSION.SDK_INT >= 26) getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        else if (Build.VERSION.SDK_INT >= 23) getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(244,247,245));
        // Android 15 draws under system bars: reserve their actual insets without adding browser-like chrome.
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets;
        });
        setContentView(root);

        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(244,247,245));
        root.addView(web, new FrameLayout.LayoutParams(-1,-1));

        offline = new LinearLayout(this);
        offline.setOrientation(LinearLayout.VERTICAL);
        offline.setGravity(Gravity.CENTER);
        offline.setPadding(dp(32),dp(32),dp(32),dp(32));
        offline.setBackgroundColor(Color.rgb(244,247,245));
        ImageView offlineIcon = new ImageView(this);
        offlineIcon.setImageResource(R.drawable.app_icon);
        LinearLayout.LayoutParams offlineIconParams = new LinearLayout.LayoutParams(dp(68),dp(68));
        offlineIconParams.bottomMargin=dp(22); offline.addView(offlineIcon,offlineIconParams);
        TextView offlineTitle = new TextView(this);
        offlineTitle.setText("Let us get you reconnected"); offlineTitle.setTextSize(22); offlineTitle.setTextColor(Color.rgb(34,60,50)); offlineTitle.setTypeface(Typeface.DEFAULT,Typeface.BOLD); offlineTitle.setGravity(Gravity.CENTER); offline.addView(offlineTitle);
        TextView explanation = new TextView(this);
        explanation.setText("Check your internet connection and try again. If your school service is starting, it may take a moment to become available.");
        explanation.setTextSize(15); explanation.setTextColor(Color.rgb(99,119,107)); explanation.setGravity(Gravity.CENTER); explanation.setPadding(0,dp(12),0,dp(20)); offline.addView(explanation);
        Button retry = new Button(this);
        retry.setText("Try again"); retry.setAllCaps(false); retry.setTextSize(15); retry.setOnClickListener(view -> { offline.setVisibility(View.GONE); showLoading("Reconnecting to your school…"); web.reload(); }); offline.addView(retry,new LinearLayout.LayoutParams(-1,dp(52)));
        root.addView(offline,new FrameLayout.LayoutParams(-1,-1)); offline.setVisibility(View.GONE);

        loadingOverlay = new FrameLayout(this);
        loadingOverlay.setBackgroundColor(Color.rgb(244,247,245));
        LinearLayout loadingCard = new LinearLayout(this);
        loadingCard.setOrientation(LinearLayout.VERTICAL); loadingCard.setGravity(Gravity.CENTER); loadingCard.setPadding(dp(36),dp(36),dp(36),dp(36));
        ImageView logo = new ImageView(this); logo.setImageResource(R.drawable.app_icon);
        LinearLayout.LayoutParams logoParams = new LinearLayout.LayoutParams(dp(88),dp(88)); logoParams.bottomMargin=dp(22); loadingCard.addView(logo,logoParams);
        TextView brand = new TextView(this); brand.setText("Revolt School"); brand.setTextSize(24); brand.setTextColor(Color.rgb(24,54,42)); brand.setTypeface(Typeface.DEFAULT,Typeface.BOLD); brand.setGravity(Gravity.CENTER); loadingCard.addView(brand);
        loadingText = new TextView(this); loadingText.setText("Preparing your school workspace"); loadingText.setTextSize(13); loadingText.setTextColor(Color.rgb(116,131,121)); loadingText.setGravity(Gravity.CENTER); loadingText.setPadding(0,dp(8),0,dp(24)); loadingCard.addView(loadingText);
        progress = new ProgressBar(this); progress.setIndeterminate(true); loadingCard.addView(progress,new LinearLayout.LayoutParams(dp(36),dp(36)));
        FrameLayout.LayoutParams cardParams = new FrameLayout.LayoutParams(-2,-2,Gravity.CENTER); loadingOverlay.addView(loadingCard,cardParams);
        root.addView(loadingOverlay,new FrameLayout.LayoutParams(-1,-1));

        WebSettings settings = web.getSettings();
        settings.setUserAgentString(settings.getUserAgentString() + " RevoltSchoolAndroid/3.0");
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setUseWideViewPort(true); settings.setLoadWithOverviewMode(true);
        settings.setAllowFileAccess(false); settings.setAllowFileAccessFromFileURLs(false); settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setAllowContentAccess(true); // Only the system picker grants access to selected attachments.
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW); settings.setSafeBrowsingEnabled(true);
        settings.setSupportMultipleWindows(true); settings.setJavaScriptCanOpenWindowsAutomatically(true);
        CookieManager.getInstance().setAcceptCookie(true); CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        WebView.setWebContentsDebuggingEnabled(false);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return route(request.getUrl().toString()); }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) { return route(url); }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) { closeChannel(); offline.setVisibility(View.GONE); showLoading("Opening your school…"); }
            @Override public void onPageFinished(WebView view, String url) { if (SecurityRules.isSchoolUrl(url)) attachChannel(); CookieManager.getInstance().flush(); hideLoading(); }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) { if (request.isForMainFrame()) { closeChannel(); hideLoading(); offline.setVisibility(View.VISIBLE); } }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, android.net.http.SslError error) { handler.cancel(); closeChannel(); hideLoading(); offline.setVisibility(View.VISIBLE); }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onProgressChanged(WebView view, int value) { if(value>65&&value<100&&loadingOverlay.getVisibility()==View.VISIBLE)loadingText.setText("Almost ready…"); }
            @Override public boolean onJsAlert(WebView view, String url, String message, JsResult result) { if (!SecurityRules.isSchoolUrl(url)) { result.cancel(); return true; } new AlertDialog.Builder(MainActivity.this).setTitle("Revolt School").setMessage(message).setPositiveButton("OK", (d,w) -> result.confirm()).setOnCancelListener(d -> result.cancel()).show(); return true; }
            @Override public boolean onJsConfirm(WebView view, String url, String message, JsResult result) { if (!SecurityRules.isSchoolUrl(url)) { result.cancel(); return true; } new AlertDialog.Builder(MainActivity.this).setTitle("Please confirm").setMessage(message).setPositiveButton("Continue", (d,w) -> result.confirm()).setNegativeButton("Cancel", (d,w) -> result.cancel()).setOnCancelListener(d -> result.cancel()).show(); return true; }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (!SecurityRules.isSchoolUrl(view.getUrl())) { callback.onReceiveValue(null); return true; }
                if (filePicker != null) filePicker.onReceiveValue(null); filePicker = callback;
                try { startActivityForResult(params.createIntent(), SELECT_FILE); } catch (ActivityNotFoundException e) { callback.onReceiveValue(null); filePicker = null; toast("No file picker is available on this device."); }
                return true;
            }
            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean gesture, Message result) {
                if (!SecurityRules.isSchoolUrl(view.getUrl())) return false;
                final WebView popup = new WebView(MainActivity.this);
                popup.getSettings().setJavaScriptEnabled(true); popup.getSettings().setAllowFileAccess(false); popup.getSettings().setAllowContentAccess(false);
                final AlertDialog preview = new AlertDialog.Builder(MainActivity.this).setTitle("School document").setView(popup).setPositiveButton("Print / Save PDF",null).setNegativeButton("Close",(d,w) -> {}).create();
                preview.setOnDismissListener(d -> popup.destroy());
                popup.setWebViewClient(new WebViewClient() {
                    private boolean open(String url) { if ("about:blank".equals(url)) return false; if (SecurityRules.isMobilePage(url)) web.loadUrl(url); else external(url); preview.dismiss(); return true; }
                    @Override public boolean shouldOverrideUrlLoading(WebView v, String url) { return open(url); }
                    @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) { return open(req.getUrl().toString()); }
                });
                ((WebView.WebViewTransport) result.obj).setWebView(popup); result.sendToTarget(); preview.show();
                preview.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(button -> { PrintManager manager=(PrintManager)getSystemService(PRINT_SERVICE); if(manager!=null)manager.print("School document",popup.createPrintDocumentAdapter("School document"),new PrintAttributes.Builder().build()); });
                popup.setLayoutParams(new android.widget.FrameLayout.LayoutParams(-1,dp(420))); return true;
            }
        });
        web.setDownloadListener((url, agent, disposition, mime, length) -> {
            if (SecurityRules.isSchoolUrl(url)) external(url);
            else if (url.startsWith("blob:")) toast("Use the document's Download button to save a PDF.");
            else external(url);
        });
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::goBack);
        if (saved == null || web.restoreState(saved) == null || !SecurityRules.isMobilePage(web.getUrl())) web.loadUrl(SecurityRules.HOME); else hideLoading();
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private void toast(String text) { Toast.makeText(this, text, Toast.LENGTH_LONG).show(); }
    private void showLoading(String message) { if(loadingOverlay==null)return; loadingText.setText(message); loadingOverlay.setAlpha(1f); loadingOverlay.setVisibility(View.VISIBLE); }
    private void hideLoading() { if(loadingOverlay==null||loadingOverlay.getVisibility()!=View.VISIBLE)return; loadingOverlay.animate().alpha(0f).setDuration(220).withEndAction(()->{loadingOverlay.setVisibility(View.GONE);loadingOverlay.setAlpha(1f);}).start(); }
    private boolean route(String url) { if (SecurityRules.isMobilePage(url)) return false; external(url); return true; }
    private void external(String url) { if (!SecurityRules.isExternalUrl(url)) return; try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (ActivityNotFoundException e) { toast("No application can open this link."); } }
    private void goBack() {
        if (offline.getVisibility() == View.VISIBLE) { offline.setVisibility(View.GONE); showLoading("Opening your school…"); web.loadUrl(SecurityRules.HOME); return; }
        if (SecurityRules.isMobilePage(web.getUrl())) {
            web.evaluateJavascript("(function(){return typeof window.rxMobileBack==='function'?window.rxMobileBack():false})()", handled -> { if (!"true".equals(handled)) browserBack(); });
        } else browserBack();
    }
    private void browserBack() { if (web.canGoBack()) web.goBack(); else finish(); }
    @Override public void onBackPressed() { goBack(); }

    private void showMenu(View anchor) {
        PopupMenu menu = new PopupMenu(this, anchor);
        menu.getMenu().add(0,1,0,"Refresh"); menu.getMenu().add(0,2,1,"School home"); menu.getMenu().add(0,3,2,"Print / Save PDF"); menu.getMenu().add(0,4,3,"Open in browser");
        menu.setOnMenuItemClickListener(item -> { switch (item.getItemId()) { case 1: mobileAction("rxMobileRefresh", () -> web.reload()); break; case 2: mobileAction("rxMobileHome", () -> web.loadUrl(SecurityRules.HOME)); break; case 3: printPage(); break; case 4: external(SecurityRules.isSchoolUrl(web.getUrl()) ? web.getUrl() : SecurityRules.HOME); break; } return true; }); menu.show();
    }
    private void mobileAction(String action, Runnable fallback) { web.evaluateJavascript("(function(){return typeof window." + action + "==='function'?window." + action + "():false})()", handled -> { if (!"true".equals(handled)) fallback.run(); }); }
    private void printPage() { if (!SecurityRules.isSchoolUrl(web.getUrl())) return; PrintManager manager = (PrintManager)getSystemService(PRINT_SERVICE); if (manager != null) manager.print("Revolt School document",web.createPrintDocumentAdapter("Revolt School document"),new PrintAttributes.Builder().build()); }

    private void closeChannel() { if (nativePort != null) { nativePort.close(); nativePort = null; } download = null; }
    private void attachChannel() {
        closeChannel();
        try {
            InputStream input = getAssets().open("android-bridge.js"); ByteArrayOutputStream buffer = new ByteArrayOutputStream(); byte[] part = new byte[4096]; int count; while ((count = input.read(part)) != -1) buffer.write(part,0,count); input.close();
            String token = UUID.randomUUID().toString();
            String script = new String(buffer.toByteArray(),StandardCharsets.UTF_8).replace("__RX_CHANNEL_TOKEN__",token);
            WebMessagePort[] ports = web.createWebMessageChannel(); nativePort = ports[0];
            nativePort.setWebMessageCallback(new WebMessagePort.WebMessageCallback() { @Override public void onMessage(WebMessagePort port, WebMessage message) { if (SecurityRules.isSchoolUrl(web.getUrl())) nativeMessage(message.getData()); } });
            web.evaluateJavascript(script, value -> { if (SecurityRules.isSchoolUrl(web.getUrl())) web.postWebMessage(new WebMessage(token,new WebMessagePort[]{ports[1]}),Uri.parse(SecurityRules.ORIGIN)); });
        } catch (Exception e) { closeChannel(); }
    }
    private void nativeMessage(String text) {
        if (text == null || text.length() > 50000) return;
        try {
            JSONObject data = new JSONObject(text); String type = data.optString("type");
            if ("print".equals(type)) { printPage(); return; }
            if ("download_start".equals(type)) {
                int size = data.getInt("size"); if (pendingDocument != null || size < 0 || size > SecurityRules.MAX_DOWNLOAD) { toast("Finish saving the current file, or open large files in your browser."); return; }
                expectedSize = size; downloadName = SecurityRules.safeFilename(data.optString("name")); downloadMime = data.optString("mime","application/octet-stream");
                if (!downloadMime.matches("[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+")) downloadMime = "application/octet-stream";
                download = new ByteArrayOutputStream();
            } else if ("download_chunk".equals(type) && download != null) {
                byte[] bytes = Base64.decode(data.getString("data"),Base64.NO_WRAP);
                if (download.size() + bytes.length > expectedSize) { download = null; return; } download.write(bytes,0,bytes.length);
            } else if ("download_end".equals(type) && download != null) {
                if (download.size() != expectedSize) { download = null; return; }
                pendingDocument = download.toByteArray(); download = null;
                Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(downloadMime).putExtra(Intent.EXTRA_TITLE,downloadName);
                startActivityForResult(save,SAVE_FILE);
            }
        } catch (Exception e) { download = null; pendingDocument = null; toast("Unable to save this document. Try again or open it in your browser."); }
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request,result,data);
        if (request == SELECT_FILE && filePicker != null) { filePicker.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result,data)); filePicker = null; }
        if (request == SAVE_FILE && pendingDocument != null) {
            byte[] document = pendingDocument; pendingDocument = null;
            if (result == RESULT_OK && data != null && data.getData() != null) {
                Uri destination = data.getData();
                new Thread(() -> { try (OutputStream output = getContentResolver().openOutputStream(destination)) { if (output == null) throw new Exception(); output.write(document); runOnUiThread(() -> toast("Document saved.")); } catch (Exception e) { runOnUiThread(() -> toast("Unable to save this document.")); } }).start();
            }
        }
    }
    @Override public void onSaveInstanceState(Bundle state) { super.onSaveInstanceState(state); web.saveState(state); }
    @Override protected void onResume() { super.onResume(); if (web != null) web.onResume(); }
    @Override protected void onPause() { if (web != null) { web.onPause(); CookieManager.getInstance().flush(); } super.onPause(); }
    @Override protected void onDestroy() { closeChannel(); pendingDocument = null; if (filePicker != null) filePicker.onReceiveValue(null); if (web != null) web.destroy(); super.onDestroy(); }
}
