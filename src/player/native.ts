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
  /**
   * Whether the item the tap is installed on is still the player's current item — v1.8.0.
   *
   * The one signal that separates "the tap is broken" from "the player has moved on to another item
   * and left the tap behind": `playing` cannot tell them apart, because the *player* is playing the
   * new track throughout. Optional so that a bridge without it (an older plugin) reads as "not known"
   * and nothing is concluded from it.
   */
  itemIsCurrent?: boolean;
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
  /**
   * Put the **next** track on the player, prepared and silent (v1.9.1).
   *
   * Its own asset id, its own `AVPlayerItem`, its own `AVPlayer` — and nothing ever sends that
   * player `play`. It is not a second engine: it makes no sound, it is not tapped for the spectrum,
   * and it is not in the engine's state machine. What it is, is buffered: adopted at the boundary,
   * the track starts within a seek's time instead of paying for a cold fetch after the previous
   * track has already stopped.
   *
   * Optional, so a bridge without it (an older plugin, the fake bridge in the tests) is a bridge
   * that still plays — with a cold fetch at the track boundary, which is where v1.9.0 left it.
   */
  prepare?(info: NativeTrackInfo): Promise<void>;
  /**
   * Make the prepared track the audible one and free the slot it came from (v1.9.1).
   *
   * Answers `false` when there is nothing prepared to adopt, and the caller then loads normally.
   */
  adopt?(): Promise<boolean>;
  /** Throw the prepared track away — the queue is not going where it was prepared for. */
  discard?(): Promise<void>;
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

/**
 * How long a bridge call may hold a JS `await` before the engine is told to carry on without it.
 *
 * Every transport call is bounded (v1.9.1). A plugin call that never settles used to leave the
 * engine's `await` pending for the rest of the session — which is one half of the owner's *"using
 * the seek bar seems to disable the playlist from advancing"*: `setCurrentTime` resolves only from
 * AVFoundation's own seek completion, and a zero-tolerance seek on a transcoded remote item can
 * report `finished == false`, which the plugin turns into a promise that never settles. Nothing in
 * this app's state machine may depend on a bridge call coming back.
 */
const BRIDGE_TIMEOUT_MS = 5000;
/** A seek is short by nature, and the position the UI shows is written optimistically. */
const SEEK_TIMEOUT_MS = 1500;
/**
 * How long after a slot is written a completion for it is still the plugin's own doing (v1.9.1).
 *
 * `unload` stops the asset it holds, and the plugin reports a **completion** for it — on its own
 * audio queue, so the report can land after the call has already resolved. With two slots in the
 * player, one of them prepared and silent, that is a completion nobody asked for arriving at the
 * exact moment the listener has changed track: the engine's one event that moves the queue would act
 * on it and skip a track. A real completion inside this window is not music.
 */
const SLOT_WRITE_GRACE_MS = 800;

/**
 * Run a bridge call under a deadline: it resolves with `fallback` if the plugin does not answer.
 *
 * A rejected call is not an error the listener should see either — it is reported and the fallback
 * stands, exactly as the plugin's own `missing-plugin` path does.
 */
async function bounded<T>(work: Promise<T>, fallback: T, what: string, ms = BRIDGE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      work.catch((error: unknown) => {
        console.warn(`[navilite] the native bridge call "${what}" failed`, error);
        return fallback;
      }),
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          console.warn(`[navilite] the native bridge call "${what}" did not answer within ${ms} ms`);
          resolve(fallback);
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

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

    /*
     * Two slots, one name each, and **the names swap at a track boundary** (v1.9.1).
     *
     * One slot is what the listener hears; the other holds the track after it, loaded on the same
     * plugin and never sent `play` — prepared and silent, not a second engine. Adopting the
     * prepared slot at the boundary is what makes the end of a track instant: the bytes are
     * already there, so the first audio of the next track is a seek's time away.
     *
     * Because the roles swap, every call in this file is keyed on `audibleId` and never on a
     * literal — a literal would address the silent half once the swap has happened.
     */
    const SLOTS: readonly string[] = ['navilite-current', 'navilite-next'];
    let audibleId = SLOTS[0] ?? 'navilite-current';
    let preparedId = SLOTS[1] ?? 'navilite-next';
    /** When a slot was last written. See {@link SLOT_WRITE_GRACE_MS}. */
    let slotWrittenAt = 0;

    /**
     * Whether an event is about the asset the listener is hearing.
     *
     * With a prepared asset in the player, *its* events are not the engine's business: unloading a
     * slot makes the plugin emit a completion for it (so a stale slot would otherwise advance the
     * queue), and a playback state belonging to a silent item says nothing about what is playing.
     * An event with no `assetId` (an older plugin) is passed through, as it always was.
     */
    const isAudible = (event: { assetId?: string } | undefined): boolean => !event?.assetId || event.assetId === audibleId;

    await NativeAudio.addListener('currentTime', (event) => {
      if (!isAudible(event)) return;
      events.onPosition(event.currentTime);
    });
    await NativeAudio.addListener('playbackState', (event) => {
      if (!isAudible(event)) return;
      events.onState(event.state, event.isPlaying);
    });
    await NativeAudio.addListener('complete', (event) => {
      if (!isAudible(event)) return;
      // A slot we wrote a moment ago: this completion is the plugin stopping the asset we replaced.
      if (Date.now() - slotWrittenAt < SLOT_WRITE_GRACE_MS) return;
      events.onComplete();
    });

    const service = Capacitor.isPluginAvailable(BACKGROUND_AUDIO_SERVICE)
      ? registerPlugin<BackgroundAudioPlugin>(BACKGROUND_AUDIO_SERVICE)
      : null;
    const remote = Capacitor.isPluginAvailable(NAVILITE_REMOTE) ? registerPlugin<NaviliteRemotePlugin>(NAVILITE_REMOTE) : null;
    // iOS only, and only from v1.7.2: the FFT tap on the audio the player is playing.
    const spectrum = Capacitor.isPluginAvailable(NAVILITE_SPECTRUM)
      ? registerPlugin<NaviliteSpectrumPlugin>(NAVILITE_SPECTRUM)
      : null;

    let lastPositionMs = 0;

    /*
     * One lane for the two asset slots, so two writes to a slot can never be in flight at once.
     *
     * A track is loaded with `unload`+`preload` under its slot's name, which makes an unfinished
     * `preload` and the next track's `unload`+`preload` two writers on one slot: the older one can
     * finish last and leave the plugin holding the wrong stream. The engine already refuses to
     * *play* a superseded load (`startNative`); this is the other half — the loads themselves run in
     * the order the taps were made, so the last preload to complete is the last one asked for. The
     * prepared slot goes through the same lane, so an adopt at a boundary cannot be overtaken by the
     * preload for the track after it.
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

    /** What the lock-screen card shows for a track, in one place — the audible and prepared alike. */
    const metadata = (info: NativeTrackInfo) => ({
      title: info.title,
      artist: info.artist,
      album: info.album,
      artworkUrl: info.artworkUrl ?? undefined,
    });

    /** Put `info` into `slot`, replacing whatever it held. Best-effort: the plugin rejects both on an empty slot. */
    const fillSlot = async (slot: string, info: NativeTrackInfo): Promise<void> => {
      slotWrittenAt = Date.now();
      try {
        await NativeAudio.unload({ assetId: slot });
      } catch {
        // Nothing loaded under that name yet — unload is best-effort.
      }
      await NativeAudio.preload({ assetId: slot, assetPath: info.url, isUrl: true, notificationMetadata: metadata(info) });
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
        await bounded(inAssetLane(() => fillSlot(audibleId, info)), undefined, 'load');
      },
      async prepare(info) {
        /*
         * The prepared slot, and **only** it: nothing here touches what is playing, starts anything,
         * or writes the queue. It is a preload on the same plugin, under the other asset id, and the
         * player it creates is never sent `play` — which is the whole difference between this and the
         * second engine v1.7.6 deleted.
         */
        await bounded(inAssetLane(() => fillSlot(preparedId, info)), undefined, 'prepare');
      },
      async adopt() {
        const from = preparedId;
        const to = audibleId;
        /*
         * Order matters, and it is the order the plugin's own bookkeeping needs.
         *
         * The prepared asset is played first: from that instant it is what the listener hears, so
         * the *next* thing — freeing the slot the old track held — fires the plugin's synthetic
         * completion for an asset id that is no longer the audible one, reports nothing to the
         * engine's transport state, and leaves the now-playing card alone. Unloading first would
         * take the audio session and the card down between the two tracks, audibly.
         */
        const started = await bounded(
          inAssetLane(async () => {
            await NativeAudio.play({ assetId: from, time: 0 });
            return true;
          }),
          false,
          'adopt',
        );
        if (!started) return false;
        audibleId = from;
        preparedId = to;
        await startService();
        slotWrittenAt = Date.now();
        await bounded(
          inAssetLane(async () => {
            try {
              await NativeAudio.unload({ assetId: to });
            } catch {
              // The slot may already be empty (a cold first track) — nothing to free.
            }
          }),
          undefined,
          'adopt-unload',
        );
        lastPositionMs = 0;
        return true;
      },
      async discard() {
        slotWrittenAt = Date.now();
        await bounded(
          inAssetLane(async () => {
            try {
              await NativeAudio.unload({ assetId: preparedId });
            } catch {
              // Nothing prepared — nothing to throw away.
            }
          }),
          undefined,
          'discard',
        );
      },
      async play(startSeconds) {
        await startService();
        // Behind the same lane: the play for a track whose preload is still running must not
        // overtake it, and it must not start the previous track's asset either.
        await bounded(inAssetLane(() => NativeAudio.play({ assetId: audibleId, time: Math.max(0, startSeconds) })), undefined, 'play');
      },
      async pause() {
        await bounded(NativeAudio.pause({ assetId: audibleId }), undefined, 'pause');
      },
      async resume() {
        await bounded(NativeAudio.resume({ assetId: audibleId }), undefined, 'resume');
      },
      async stop() {
        await bounded(NativeAudio.stop({ assetId: audibleId }), undefined, 'stop');
        await stopService();
        lastPositionMs = 0;
      },
      async seek(seconds) {
        /*
         * The one call with a short deadline, and the one that has been proved to hang: the plugin
         * settles `setCurrentTime` only from AVFoundation's own seek completion, and a zero-tolerance
         * seek reports `finished == false` on a transcoded remote item — the completion is never
         * called, the promise never settles, and everything that waited on it waited for ever. The
         * position the UI shows is written on the engine's side, so nothing is lost by giving up on
         * the answer.
         */
        await bounded(NativeAudio.setCurrentTime({ assetId: audibleId, time: Math.max(0, seconds) }), undefined, 'seek', SEEK_TIMEOUT_MS);
      },
      positionMs() {
        return lastPositionMs;
      },
      async sync() {
        try {
          const [playing, current, duration] = await Promise.all([
            NativeAudio.isPlaying({ assetId: audibleId }),
            NativeAudio.getCurrentTime({ assetId: audibleId }),
            NativeAudio.getDuration({ assetId: audibleId }),
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
