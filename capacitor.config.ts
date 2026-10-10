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
    contentInset: 'always',
  },
  plugins: {
    NativeAudio: {
      hls: false,
    },
  },
};

export default config;
