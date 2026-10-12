# Revolt School for Android

Signed Android client for `https://revolt-x-school.onrender.com/mobile`. Supports
Android 8.0 and newer. This client uses the existing live School accounts and
records. An internet connection is required. No accounts or passwords are
embedded in the APK.

Features include Android back navigation, file attachments through the system
picker, PDF and spreadsheet downloads through the Android save dialog, native
printing, a refresh menu and external checkout links. The app requests only
internet access. Downloaded files are limited to 16 MiB; use the Open in browser
menu for larger exports. Device cameras and push notifications are not requested.

School navigation is restricted to the exact HTTPS School origin. Other HTTPS,
telephone and email links open in their respective external applications. SSL
errors are rejected. The document message channel targets only the exact School
origin and is replaced on every document navigation. Native Java objects are
not exposed to page JavaScript.

The initial APK is intended for direct installation. Signing and package checks
are performed during the build; physical Android device testing remains required.
This is not a Play Store publication.

## Build

Use Java 17 and official Android platform 35/build tools 35.0.0. Set
`REVOLT_ANDROID_SDK`, `REVOLT_ANDROID_SIGNING_DIR` and optionally
`REVOLT_ANDROID_OUTPUT`, then run `python3 build.py`. The tools and platform paths
can be overridden with `REVOLT_ANDROID_BUILD_TOOLS` and `REVOLT_ANDROID_PLATFORM`.

The signing directory must stay outside Git. Retain its keystore and password
privately: subsequent APK updates must use the same certificate and a higher
manifest versionCode. Do not commit signing files or generated APKs.

Run the Java navigation test by compiling `SecurityRules.java` and
`test/SecurityRulesTest.java`, then running `SecurityRulesTest`. Run
`node test/bridge.smoke.mjs` for native document download and message-channel checks.
