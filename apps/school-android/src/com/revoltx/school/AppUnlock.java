package com.revoltx.school;

import android.app.Activity;
import android.app.AlertDialog;
import android.hardware.biometrics.BiometricPrompt;
import android.os.Build;
import android.os.CancellationSignal;
import android.text.InputFilter;
import android.text.InputType;
import android.widget.EditText;
import android.widget.Toast;
import java.util.concurrent.Executor;

/** Device-level gate for the Android client. App data still requires the normal School session. */
final class AppUnlock {
    private static final String DEMO_CODE = "0000";
    private final Activity activity;

    AppUnlock(Activity activity) { this.activity = activity; }

    void open(Runnable onUnlocked) {
        if (Build.VERSION.SDK_INT < 28) {
            showDemoOtp(onUnlocked);
            return;
        }
        try {
            Executor executor = activity.getMainExecutor();
            boolean[] settled = new boolean[]{false};
            BiometricPrompt prompt = new BiometricPrompt.Builder(activity)
                    .setTitle("Unlock Revolt School")
                    .setSubtitle("Use your fingerprint or face")
                    .setDescription("Biometric data stays on your device.")
                    .setNegativeButton("Use demo OTP", executor, (dialog, which) -> {
                        if (settled[0]) return;
                        settled[0] = true;
                        showDemoOtp(onUnlocked);
                    })
                    .build();
            prompt.authenticate(new CancellationSignal(), executor, new BiometricPrompt.AuthenticationCallback() {
                @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                    if (settled[0]) return;
                    settled[0] = true;
                    onUnlocked.run();
                }
                @Override public void onAuthenticationFailed() {
                    Toast.makeText(activity, "Biometric not recognised. Try again or use the demo OTP.", Toast.LENGTH_SHORT).show();
                }
                @Override public void onAuthenticationError(int errorCode, CharSequence errString) {
                    if (settled[0]) return;
                    settled[0] = true;
                    showDemoOtp(onUnlocked);
                }
            });
        } catch (Throwable ignored) {
            showDemoOtp(onUnlocked);
        }
    }

    private void showDemoOtp(Runnable onUnlocked) {
        EditText code = new EditText(activity);
        code.setSingleLine(true);
        code.setHint("0000");
        code.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        code.setFilters(new InputFilter[]{new InputFilter.LengthFilter(4)});
        int padding = Math.round(22 * activity.getResources().getDisplayMetrics().density);
        code.setPadding(padding, padding / 2, padding, padding / 2);

        AlertDialog dialog = new AlertDialog.Builder(activity)
                .setTitle("Demo OTP")
                .setMessage("Biometric unlock is unavailable or was skipped. Enter the demo code 0000.")
                .setView(code)
                .setPositiveButton("Unlock", null)
                .setNegativeButton("Close app", (d, which) -> activity.finish())
                .setCancelable(false)
                .create();
        dialog.setOnShowListener(ignored -> dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(view -> {
            if (DEMO_CODE.equals(code.getText().toString().trim())) {
                dialog.dismiss();
                onUnlocked.run();
            } else {
                code.setError("Incorrect code. Use 0000.");
                code.requestFocus();
            }
        }));
        dialog.show();
        code.requestFocus();
    }
}
