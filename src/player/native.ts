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
 * spectrum callback — so the spectrum is read from `ios/App/App/NaviliteSpectrum.swift`'s tap on
 * the audio the player is playing (our own local plugin, iOS only). A build without that tap has
 * no spectrum and says so; v1.7 answered it by playing a second, silent copy of the stream in the
 * page, which is the second engine v1.7.3 deleted. The web `<audio>` element is built by
 * `src/player/engine.ts` only in a browser, where it *is* the audible engine.
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

/**
 * Our own iOS plugin, second job: the spectrum, taken from a tap (`MTAudioProcessingTap`) on the
 * **audible** player's own item — the same `AVPlayer` that makes the sound, borrowed read-only for
 * its samples. See `ios/App/App/NaviliteSpectrum.swift`: the web layer cannot read this stream's
 * samples (a CORS-cross-origin media element hands over silence, by spec, and WebKit's session
 * handling was what paused playback on return), so the FFT is done natively with vDSP and handed
 * over as the 64 bands the canvas draws. Until v1.7.6 the tap was on a *second*, silent player
 * playing the same stream; that copy is deleted, so there is one decode and one clock.
 */
interface NaviliteSpectrumPlugin {
  start(options: { url: string; positionMs: number }): Promise<{ started: boolean; sampleRate: number; bandCount: number }>;
  stop(): Promise<{ stopped: boolean }>;
  resync(options: { positionMs: number }): Promise<{ driftMs: number }>;
  bands(): Promise<NativeSpectrumFrame>;
}

/** One frame of the native spectrum, plus what the tap thinks about it. */
export interface NativeSpectrumFrame {
  /** 64 band values, 0…255 — the same scale `getByteFrequencyData()` reports. */
  bands: number[];
  bandCount: number;
  /** True when the last frame carried energy: a real measurement of a real sound. */
  live: boolean;
  /** FFT frames the tap has produced since it started. */
  frames: number;
  /** Of those, how many were digital silence — what a *flat* audio signal looks like. */
  silentFrames: number;
  positionMs: number;
  playing: boolean;
  readable: boolean;
  sampleRate: number;
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
  /**
   * The native spectrum tap, when the platform has one. Optional: a build without our iOS plugin
   * (an older APK, the PWA) simply has no `startSpectrum`, and the visualiser falls back to its
   * album-art theme exactly as it does when there are no samples for any other reason.
   */
  startSpectrum?(url: string, positionMs: number): Promise<boolean>;
  stopSpectrum?(): Promise<void>;
  resyncSpectrum?(positionMs: number): Promise<number>;
  spectrumFrame?(): Promise<NativeSpectrumFrame | null>;
  /** Whether this platform can produce the spectrum from the native player at all. */
  readonly hasNativeSpectrum: boolean;
}

export interface NativeBridgeEvents {
  onPosition(seconds: number): void;
  onState(state: 'playing' | 'paused' | 'stopped', isPlaying: boolean): void;
  onComplete(): void;
}

const BACKGROUND_AUDIO_SERVICE = 'BackgroundAudio';
const NAVILITE_REMOTE = 'NaviliteRemote';
const NAVILITE_SPECTRUM = 'NaviliteSpectrum';

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
    // iOS only, and only from v1.7.2: the FFT tap on the audio the player is playing.
    const spectrum = Capacitor.isPluginAvailable(NAVILITE_SPECTRUM)
      ? registerPlugin<NaviliteSpectrumPlugin>(NAVILITE_SPECTRUM)
      : null;

    const assetId = 'navilite-current';
    let lastPositionMs = 0;

    /*
     * One lane for the asset, so two loads can never be in flight at once.
     *
     * Every track is loaded under this single `assetId`, which makes an unfinished `preload` and the
     * next track's `unload`+`preload` two writers on one slot: the older one can finish last and
     * leave the plugin holding the wrong stream. The engine already refuses to *play* a superseded
     * load (`startNative`); this is the other half — the loads themselves run in the order the taps
     * were made, so the last preload to complete is the last one asked for.
     */
    let assetLane: Promise<unknown> = Promise.resolve();
    const inAssetLane = <T>(work: () => Promise<T>): Promise<T> => {
      const next = assetLane.then(work, work);
      assetLane = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    };

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
        await inAssetLane(async () => {
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
        });
      },
      async play(startSeconds) {
        await startService();
        // Behind the same lane: the play for a track whose preload is still running must not
        // overtake it, and it must not start the previous track's asset either.
        await inAssetLane(() => NativeAudio.play({ assetId, time: Math.max(0, startSeconds) }));
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
      /*
       * The native spectrum. `hasNativeSpectrum` is what the engine asks before it decides how to
       * feed the visualiser: with the tap it never starts a second player in the web layer at all,
       * which is what removes the double-engine handoff the owner described.
       */
      hasNativeSpectrum: spectrum !== null,
      async startSpectrum(url, positionMs) {
        if (!spectrum) return false;
        try {
          const result = await spectrum.start({ url, positionMs });
          return result.started === true;
        } catch (error) {
          console.warn('[navilite] the native spectrum tap did not start', error);
          return false;
        }
      },
      async stopSpectrum() {
        if (!spectrum) return;
        try {
          await spectrum.stop();
        } catch (error) {
          console.warn('[navilite] the native spectrum tap did not stop', error);
        }
      },
      async resyncSpectrum(positionMs) {
        if (!spectrum) return 0;
        try {
          const result = await spectrum.resync({ positionMs });
          return Number.isFinite(result.driftMs) ? result.driftMs : 0;
        } catch {
          return 0;
        }
      },
      async spectrumFrame() {
        if (!spectrum) return null;
        try {
          const frame = await spectrum.bands();
          if (!frame || !Array.isArray(frame.bands)) return null;
          return frame;
        } catch {
          return null;
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
