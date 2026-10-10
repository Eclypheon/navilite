/**
 * The native audio engine, used inside the Capacitor shell.
 *
 * @capgo/capacitor-native-audio gives us ExoPlayer (Android) / AVFoundation (iOS):
 * background playback and lock-screen controls, which is the reason the wrapped
 * builds exist at all.
 *
 * What it does *not* give us is samples. Its API is transport + metadata only
 * (preload/play/pause/stop, position events, Now Playing info) — there is no PCM or
 * spectrum callback — so a wrapped build cannot draw a real spectrum from native
 * playback. That is stated in the UI, not papered over.
 *
 * Android also needs a foreground service of its own: the plugin declares no service
 * and its docs say starting one is the app's job. `android/app/.../BackgroundAudioPlugin.java`
 * is that service; the bridge starts and stops it.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { OsName } from '../platform.ts';

interface BackgroundAudioPlugin {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface NativeTrackInfo {
  url: string;
  title: string;
  artist: string;
  album: string;
  artworkUrl: string | null;
}

export interface NativeBridge {
  load(info: NativeTrackInfo): Promise<void>;
  play(startSeconds: number): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  seek(seconds: number): Promise<void>;
  /** Last position the native engine reported, in milliseconds. */
  positionMs(): number;
}

export interface NativeBridgeEvents {
  onPosition(seconds: number): void;
  onState(state: 'playing' | 'paused' | 'stopped', isPlaying: boolean): void;
  onComplete(): void;
}

const BACKGROUND_AUDIO_SERVICE = 'BackgroundAudio';

export async function createNativeBridge(os: OsName, events: NativeBridgeEvents): Promise<NativeBridge | null> {
  if (os === 'web') return null;
  try {
    const { NativeAudio } = await import('@capgo/capacitor-native-audio');
    await NativeAudio.configure({
      // We are the primary audio source: take focus and show lock-screen controls.
      showNotification: true,
      background: true,
      backgroundPlayback: os === 'android',
      focus: true,
    });
    await NativeAudio.addListener('currentTime', (event) => events.onPosition(event.currentTime));
    await NativeAudio.addListener('playbackState', (event) => events.onState(event.state, event.isPlaying));
    await NativeAudio.addListener('complete', () => events.onComplete());

    const service = Capacitor.isPluginAvailable(BACKGROUND_AUDIO_SERVICE)
      ? registerPlugin<BackgroundAudioPlugin>(BACKGROUND_AUDIO_SERVICE)
      : null;

    const assetId = 'navilite-current';
    let lastPositionMs = 0;

    const startService = async () => {
      if (!service) return;
      try {
        await service.start();
      } catch (error) {
        console.warn('[navilite] could not start the Android foreground service', error);
      }
    };
    const stopService = async () => {
      if (!service) return;
      try {
        await service.stop();
      } catch (error) {
        console.warn('[navilite] could not stop the Android foreground service', error);
      }
    };

    return {
      async load(info) {
        try {
          await NativeAudio.unload({ assetId });
        } catch {
          // Nothing loaded yet — unload is best-effort.
        }
        await NativeAudio.preload({
          assetId,
          assetPath: info.url,
          isUrl: true,
          notificationMetadata: {
            title: info.title,
            artist: info.artist,
            album: info.album,
            artworkUrl: info.artworkUrl ?? undefined,
          },
        });
      },
      async play(startSeconds) {
        await startService();
        await NativeAudio.play({ assetId, time: Math.max(0, startSeconds) });
      },
      async pause() {
        await NativeAudio.pause({ assetId });
      },
      async resume() {
        await NativeAudio.resume({ assetId });
      },
      async stop() {
        await NativeAudio.stop({ assetId });
        await stopService();
        lastPositionMs = 0;
      },
      async seek(seconds) {
        await NativeAudio.setCurrentTime({ assetId, time: Math.max(0, seconds) });
      },
      positionMs() {
        return lastPositionMs;
      },
    };
  } catch (error) {
    console.warn('[navilite] native audio plugin unavailable; staying on Web Audio', error);
    return null;
  }
}
