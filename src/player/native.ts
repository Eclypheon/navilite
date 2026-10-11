/**
 * The native audio engine, used inside the Capacitor shell — and since v1.7 it is the engine
 * itself, not a background stand-in.
 *
 * @capgo/capacitor-native-audio gives us AVFoundation (iOS) / ExoPlayer (Android): one
 * `AVAudioSession` in the `.playback` category, activated, with the Now Playing card and the
 * remote command centre (the plugin's own iOS sources do exactly that — `Plugin.swift` sets
 * `.playback` and `setActive(true)` when `showNotification` is on, and targets
 * `MPRemoteCommandCenter`), which is what makes the lock-screen controls and background playback
 * possible at all.
 *
 * What it does *not* give us: samples. Its API is transport + metadata only — no PCM and no
 * spectrum callback — so the spectrum cannot be read from the native player. v1.7 keeps the
 * spectrum by demoting the web `<audio>` element to `src/player/engine.ts`'s *analysis source*:
 * a second, silent copy of the stream, routed into the analyser and never into the speakers,
 * running only while the app is on screen. See the engine for why.
 *
 * §NaviliteRemote: the plugin targets play/pause/stop/toggle/skip-15s and the playback-position
 * scrub, but it does **not** enable `nextTrackCommand` / `previousTrackCommand`, so a lock screen
 * driven by it alone has no next/previous buttons. `ios/App/App/NaviliteRemotePlugin.swift` (our
 * own, tiny, local Capacitor plugin — registered in `ViewController.capacitorDidLoad`) adds exactly
 * those two commands and forwards them here; nothing else about the session is touched twice.
 *
 * Android also needs a foreground service of its own: the plugin declares no service and its docs
 * say starting one is the app's job. `android/app/.../BackgroundAudioPlugin.java` is that service;
 * the bridge starts and stops it.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import type { OsName } from '../platform.ts';

interface BackgroundAudioPlugin {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Our own iOS plugin: the two remote commands the native-audio plugin leaves unwired. */
interface NaviliteRemotePlugin {
  attach(): Promise<void>;
  detach(): Promise<void>;
  /** Bring the audio session back up after a foreground return (idempotent). */
  activateSession(): Promise<{ active: boolean }>;
  addListener(eventName: 'next' | 'previous', listenerFunc: () => void): Promise<PluginListenerHandle>;
}

export interface NativeTrackInfo {
  url: string;
  title: string;
  artist: string;
  album: string;
  artworkUrl: string | null;
}

/** What the native player says it is doing — the truth after a foreground return. */
export interface NativeTruth {
  playing: boolean;
  positionMs: number;
  durationMs: number;
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
  /**
   * Ask the player itself, rather than trusting our copy of the state. Used on every return to
   * the foreground: if the app was suspended (or the session was interrupted by a call), the JS
   * side's idea of "playing" and the player's can disagree, and the player is right.
   */
  sync(): Promise<NativeTruth | null>;
  /** Re-arm the audio session without changing what is playing. */
  activateSession(): Promise<boolean>;
  /** Lock-screen next/previous, when the platform can deliver them. */
  listenRemoteCommands(handlers: { next(): void; previous(): void }): () => void;
}

export interface NativeBridgeEvents {
  onPosition(seconds: number): void;
  onState(state: 'playing' | 'paused' | 'stopped', isPlaying: boolean): void;
  onComplete(): void;
}

const BACKGROUND_AUDIO_SERVICE = 'BackgroundAudio';
const NAVILITE_REMOTE = 'NaviliteRemote';

export async function createNativeBridge(os: OsName, events: NativeBridgeEvents): Promise<NativeBridge | null> {
  if (os === 'web') return null;
  try {
    const { NativeAudio } = await import('@capgo/capacitor-native-audio');
    await NativeAudio.configure({
      // We are the primary audio source: take focus, take the `.playback` session, show the
      // lock-screen card and accept its transport commands.
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
    const remote = Capacitor.isPluginAvailable(NAVILITE_REMOTE) ? registerPlugin<NaviliteRemotePlugin>(NAVILITE_REMOTE) : null;

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
      async sync() {
        try {
          const [playing, current, duration] = await Promise.all([
            NativeAudio.isPlaying({ assetId }),
            NativeAudio.getCurrentTime({ assetId }),
            NativeAudio.getDuration({ assetId }),
          ]);
          lastPositionMs = Number.isFinite(current.currentTime) ? current.currentTime * 1000 : lastPositionMs;
          return {
            playing: playing.isPlaying === true,
            positionMs: lastPositionMs,
            durationMs: Number.isFinite(duration.duration) ? duration.duration * 1000 : 0,
          };
        } catch (error) {
          console.warn('[navilite] could not read the native transport state', error);
          return null;
        }
      },
      async activateSession() {
        if (!remote) return false;
        try {
          const result = await remote.activateSession();
          return result.active;
        } catch (error) {
          console.warn('[navilite] could not re-arm the audio session', error);
          return false;
        }
      },
      listenRemoteCommands(handlers) {
        if (!remote) return () => undefined;
        const handles: PluginListenerHandle[] = [];
        let detached = false;
        void remote
          .attach()
          .then(() => Promise.all([remote.addListener('next', () => handlers.next()), remote.addListener('previous', () => handlers.previous())]))
          .then((added) => {
            if (detached) {
              void remote.detach().catch(() => undefined);
              return;
            }
            handles.push(...added);
          })
          .catch((error: unknown) => {
            console.warn('[navilite] lock-screen next/previous unavailable', error);
          });
        return () => {
          detached = true;
          for (const handle of handles) void handle.remove().catch(() => undefined);
          handles.length = 0;
          void remote.detach().catch(() => undefined);
        };
      },
    };
  } catch (error) {
    console.warn('[navilite] native audio plugin unavailable; staying on Web Audio', error);
    return null;
  }
}
