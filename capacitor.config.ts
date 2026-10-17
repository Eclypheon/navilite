import type { CapacitorConfig } from '@capacitor/cli';

/**
 * One web build, three artifacts: dist/ is the PWA, and the same dist/ is the payload of
 * the Android APK and the iOS IPA (see README).
 *
 * Notes that matter:
 *   - The webview loads the app from https://localhost, i.e. a secure context, which is
 *     what the service worker and the Web Audio analyser both need.
 *   - The app never ships a library URL or a credential. Everything is entered on first
 *     run and kept in the OS keystore (src/storage/secret.ts).
 *   - HLS is switched off: @capgo/capacitor-native-audio pulls in media3-exoplayer-hls by
 *     default, which is ~4 MB of APK for a feature Navidrome does not need (it streams
 *     progressive audio). This is the "keep it light" choice, made explicit.
 */
const config: CapacitorConfig = {
  appId: 'app.navilite',
  appName: 'Navilite',
  webDir: 'dist',
  android: {
    backgroundColor: '#0b0b10',
    allowMixedContent: false,
  },
  ios: {
    backgroundColor: '#0b0b10',
    /*
     * `never` (v2.0.0-beta.4). This was `always`, which is `UIScrollView.contentInsetAdjustmentBehavior
     * = .always` on the web view — UIKit then pads the *scroll view* for the safe area on top of the
     * `env(safe-area-inset-top)` the CSS already pads `.topbar` and `.now` with, so the app began
     * 2 × 59 px down (measured: 118 px, 13.8 % of 852 — the owner's "large gap at the top") and only
     * a relaunch, which re-laid the scroll view, put it back. Capacitor's own default is `never`, and
     * it is the only correct value for a `viewport-fit=cover` app whose insets are the CSS's job:
     * one authoritative source, no native pixel value to cache. `tools/inset-gap.mjs` reads the band
     * both ways at 393 × 852.
     */
    contentInset: 'never',
  },
  plugins: {
    NativeAudio: {
      hls: false,
    },
  },
};

/*
 * **The probe hook (v1.9.9).**
 *
 * `tools/device-probe.mjs --app <App.app>` drives the *installed app* inside the simulator, and the
 * probe page it runs against is served by the mock (`node tools/mock-subsonic.mjs`). For the web view
 * to be that page rather than the bundle, the build has to be made with `server.url` pointing at it —
 * which is why the native-shell run has always needed a build of its own (docs/verification.md §12.6).
 *
 * Until now that meant editing this file and remembering to edit it back. It is an environment
 * variable instead: the release builds (`npm run ipa:unsigned`, `npm run apk`) never set it, and
 * `NAVILITE_PROBE_URL=http://localhost:4599 npm run ipa:simulator` is the whole of the probe build.
 * The shipped bundle is checked for it after the fact all the same — see docs/verification.md.
 */
const probeUrl = process.env.NAVILITE_PROBE_URL;
if (probeUrl) {
  config.server = { url: probeUrl, cleartext: true };
}

export default config;
