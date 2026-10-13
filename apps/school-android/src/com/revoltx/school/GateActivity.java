package com.revoltx.school;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

/** Lightweight launcher gate. The School WebView is created only after local unlock succeeds. */
public final class GateActivity extends Activity {
    private boolean opening;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(244,247,245));
        getWindow().setNavigationBarColor(Color.rgb(244,247,245));
        setContentView(launchView());
        new AppUnlock(this).open(this::openSchool);
    }

    private void openSchool() {
        if (opening || isFinishing()) return;
        opening = true;
        startActivity(new Intent(this, MainActivity.class));
        finish();
    }

    private FrameLayout launchView() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(244,247,245));
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setGravity(Gravity.CENTER);
        int pad = dp(30);
        card.setPadding(pad,pad,pad,pad);
        ImageView logo = new ImageView(this);
        logo.setImageResource(R.drawable.app_icon);
        LinearLayout.LayoutParams logoParams = new LinearLayout.LayoutParams(dp(86),dp(86));
        logoParams.bottomMargin=dp(22);
        card.addView(logo,logoParams);
        TextView title = new TextView(this);
        title.setText("Revolt School");
        title.setTextSize(24);
        title.setTextColor(Color.rgb(24,54,42));
        title.setGravity(Gravity.CENTER);
        card.addView(title);
        TextView copy = new TextView(this);
        copy.setText("Secure mobile access");
        copy.setTextSize(13);
        copy.setTextColor(Color.rgb(116,131,121));
        copy.setGravity(Gravity.CENTER);
        copy.setPadding(0,dp(8),0,dp(24));
        card.addView(copy);
        ProgressBar progress = new ProgressBar(this);
        card.addView(progress,new LinearLayout.LayoutParams(dp(34),dp(34)));
        root.addView(card,new FrameLayout.LayoutParams(-2,-2,Gravity.CENTER));
        return root;
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
