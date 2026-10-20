/**
 * The one engine's contracts, on a bridge that can be made to misbehave.
 *
 * Nothing in `tools/` can reach these paths: the Chrome harness is a browser (no Capacitor
 * plugin), and the simulator probe drives a *web* webview. So the engine takes its platform and
 * its native bridge as options (`EngineOptions`), and this file drives the real `AudioEngine`
 * with a fake bridge that can be slow, can refuse to resume, and can stop answering — which is
 * exactly the behaviour the owner hit on the phone.
 *
 * The five invariants of v1.7.3 are each exercised here, with the numbers quoted:
 *
 *   1. **The clock does not advance while nothing is playing** — backgrounded, paused, or
 *      interrupted, the position is frozen to the millisecond.
 *   2. **Background → foreground continues**: the player's own position is adopted, the position
 *      is continuous, and there is no restart and no repeat — asserted as *zero* transport calls
 *      across the whole hand-off.
 *   3. **A remote control while backgrounded is adopted, never overridden** — the app sends
 *      nothing to a player the owner has paused from the lock screen, and everything is in step
 *      again (including the spectrum) when he comes back.
 *   4. **Transport is idempotent and stale events are absorbed**, on the pure machine and through
 *      the engine (one bridge call for two taps, one load for two presses of the same track).
 *   5. **The spectrum is real**: non-zero, varying, proportional, not pinned, silence reads as
 *      silence, and it is never off while the engine is playing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AudioEngine } from '../src/player/engine.ts';
import { reduce } from '../src/player/engine-contract.ts';
import type { EngineOptions, EngineState, EngineStatus, PlayerEvent, VisualiserTone } from '../src/player/engine-contract.ts';
import type { NativeBridge, NativeBridgeEvents, NativeTrackInfo, NativeTruth } from '../src/player/native.ts';
import type { TrackRequest } from '../src/player/engine-contract.ts';
import { measuredDurationIsBelievable } from '../src/player/engine-helpers.ts';
import { formatTime } from '../src/ui/dom.ts';
import { PlaybackQueue } from '../src/state/queue.ts';
import type { Library } from '../src/state/library.ts';
import type { QueueContext, Song } from '../src/api/types.ts';

/** Every bridge call costs this much, so a state that waited for one is measurably late. */
const ROUND_TRIP_MS = 40;

const TRACK: TrackRequest = {
  id: 'song-1',
  url: 'http://127.0.0.1:4599/rest/stream?id=song-1',
  crossOrigin: false,
  title: 'Track one',
  artist: 'Someone',
  album: 'Something',
  artworkUrl: null,
  durationMs: 180_000,
};

const OTHER_TRACK: TrackRequest = { ...TRACK, id: 'song-2', url: 'http://127.0.0.1:4599/rest/stream?id=song-2', title: 'Track two' };

/**
 * A **downloaded** track, exactly as the app resolves one: `Library.streamUrl` returns
 * `offline.pathFor(song.id)` for a complete row (`src/state/library.ts:79`), which is a `file://`
 * URL, and the same track streamed is `TRACK`. Both are played by the same engine through the same
 * bridge; only the native side's choice of transport differed (v1.9.16).
 */
const LOCAL_TRACK: TrackRequest = {
  ...TRACK,
  id: 'song-1-local',
  url: 'file:///var/mobile/Containers/Data/Application/0F0A-DEAD/navilite-offline/song-1.mp3',
};

interface Recording {
  calls: string[];
  /**
   * v1.9.26 — **a build whose native player has no spectrum tap at all**, which is Android on this
   * project (`hasNativeSpectrum: false`; the engine asks that before it decides anything). It is the
   * one case `native audio` is licensed to mean, so it is a case the harness has to be able to
   * state: every other test in this file is the iOS build, which has a tap.
   */
  hasSpectrum: boolean;
  /** Every URL the bridge was asked to load, in order — which track the one asset holds. */
  loads: string[];
  /**
   * v1.9.1 — every URL the bridge was asked to **prepare**: the track after the current one, loaded
   * into its own silent slot, never played. `adopts` counts the times that slot became audible.
   */
  prepares: string[];
  /**
   * v1.9.6 — whether the tap has produced a frame for the item it is installed on yet.
   *
   * The tap's frame counter is the plugin's own word for "I have measured something for this item",
   * and it is what the engine's "the tap is being installed" window ends on. False models a tap that
   * is installed and has produced nothing: every band reads zero, and the counter — deliberately —
   * does not move, so the engine keeps waiting instead of writing the stream off as silent.
   */
  tapProducing: boolean;
  adopts: number;
  /** The URL the prepared slot holds right now, or null when nothing is prepared. */
  preparedUrl: string | null;
  /** The song id of the track in the prepared slot, so an adopted item names its own song. */
  preparedId: string;
  /**
   * v1.9.1 — the plugin's own leak, made reproducible: `setCurrentTime` resolves only from
   * AVFoundation's seek completion, and a zero-tolerance seek on a transcoded remote item reports
   * `finished == false`, so the promise **never settles**. With the old counter that meant the end
   * of a track was ignored for the rest of the session.
   */
  seekNeverSettles: boolean;
  /**
   * v1.9.13 — a seek the player does **not** perform: the call is taken and the item stays where it
   * is, which is the shape of an exact seek a progressively downloaded item refuses (and the shape of
   * every seek AVFoundation answers with `finished == false`). The app must not paint the position it
   * asked for over it.
   */
  seekIgnored?: boolean;
  /** True when fakeBridge.play should not immediately emit onPosition. */
  deferPosition?: boolean;
  /** The bridge's own event sink, so a test can make the player report a position or a state. */
  events: NativeBridgeEvents | null;
  /** What the player reports from `sync()`, i.e the truth after a foreground return. */
  truth: NativeTruth;
  /** True when the plugin accepts `resume()` and does not actually start (the v1.7 trap). */
  refuseResume: boolean;
  /** True when the player will not answer at all. */
  silentSync: boolean;
  /** Filled frame handed to the analyser on every `getByteFrequencyData`. */
  frameValue: number;
  /**
   * v1.9.22 — the stream the plugin's player is holding right now: set by `load` and by `adopt`,
   * which is the fake's stand-in for `player.currentItem`.
   */
  playingUrl: string | null;
  /**
   * The song id the item was built for, and the item the player held before it (unreleased).
   *
   * With one player the tap is installed by `makeItem`, so the item a snapshot names is the item
   * the fake built — `playingId` is that item's song, and `previousUrl` is the item the outgoing
   * frame belongs to, which is the key a `staleRegisterUrls` answer is dated to.
   */
  playingId: string;
  previousUrl: string | null;
  /** What the native spectrum tap is doing. */
  spectrum: SpectrumState;
}

/** The tap's own state, as the plugin would report it. */
interface SpectrumState {
  started: boolean;
  startedUrl: string | null;
  startedAtMs: number;
  startCalls: number;
  stopCalls: number;
  /**
   * v1.9.22 — **how many of those calls were an install**, i.e. a request for a stream the tap was
   * not already on. That is the plugin's own rule (`carriesOurTap` → verify, anything else →
   * install), and it is the count a "no double install" assertion has to be made on: the engine is
   * entitled to *verify* as often as it likes, and a verify writes no mix.
   */
  installs: number;
  /**
   * v1.9.22 — **model the plugin's own install.** When set, a `start` request:
   *
   *   - takes `installMs` to land (`AudibleSpectrumTap.trackWaitSeconds` is five seconds of 100 ms
   *     steps: the plugin waits for the item's audio track, and for a stream being replaced that
   *     wait can outlast the track change);
   *   - attaches the tap to the item it **read when the request arrived**, even when the player has
   *     moved on by the time the wait is over — the shape `NaviliteSpectrum.install` has, which
   *     reads `player.currentItem` before its `await` and attaches to that item after it, taking
   *     the mix off the item that is playing;
   *   - answers `false` when a newer request overtook it while it was waiting;
   *   - and, having attached, decides `itemIsCurrent` from that binding rather than from the test.
   *
   * It is the mechanism behind the owner's report: the request the *previous* track issued lands
   * last and leaves the tap on the item the player has left, so the engine is handed a tap that is
   * on a dead item while the new track plays.
   */
  plugin?: boolean;
  /** How long a request waits before it lands (`plugin` only). */
  installMs?: number;
  /** The stream the tap is installed on, once a request has landed (`plugin` only). */
  tappedUrl?: string | null;
  /**
   * v1.9.27 (card `t_c8cc01c6`) — **the streams whose tap produces frames it never changes**: a tap
   * stuck on one buffer, whose own per-item counter still moves (so this item's analysis *is*
   * measuring) and whose bands are the same values on every read.
   *
   * The two other quiet states in this fake are different on purpose and both are stated above:
   * `framesQuietUrls` is a counter that stands still (nothing measured for this item), and
   * `staleRegisterUrls` is a register that holds the *previous* item's frame. This one is the shape
   * the v1.8.0 frozen-frame rule was written for, and it is the second of the two verdicts a tap can
   * reach about an item — the one the chip's capability word is licensed by, so it has to be
   * stateable here (card `t_c8cc01c6`).
   */
  frozenUrls?: string[];
  /**
   * v1.9.27 (card `t_c8cc01c6`) — **how long the tap takes to answer a read**, in ms: the bridge round
   * trip the engine's window is measured in.
   *
   * The default (`0`, a resolved promise) is what every other test in this file has always had, and it
   * is the reason a *transition's* window is one emitted status here: the tap answers before the
   * engine's next paint. On the owner's phone the answer is a real round trip (`ROUND_TRIP_MS` in this
   * file's own terms), which is why the word a transition paints stays on screen — so a test that
   * wants to watch the window rather than the single status that opens it states the latency.
   */
  frameDelayMs?: number;
  /** The item the plugin is holding for the *outgoing* track, when a test wants a slow landing. */
  slowLandUrls?: string[];
  /**
   * v1.9.24 — **the streams whose tap is installed and has not produced a frame for them yet.**
   *
   * The owner's case, in the two facts the plugin sends: the tap is on the item that is playing
   * (`itemIsCurrent` true, `attached` true) and the tap's own counter stands still — because the
   * counter is **process-lifetime** (`NaviliteSpectrum.swift:605`, reset by nothing), on a track
   * after the first one that ever produced a frame its value is whatever the *previous* track left
   * there. That is what the engine used to read as "this item's tap has answered", and this field is
   * what makes the reading reproducible: the counter is non-zero and nothing has been measured for
   * the item playing.
   */
  framesQuietUrls?: string[];
  /**
   * v1.9.25 — **the streams whose register is a frame *their own* tap never produced.**
   *
   * This is the real plugin's shape, which the fake could not state until now: `bands`/`live` are a
   * last-value register, written only by the FFT and zeroed only by `detach` — so when the incoming
   * item's analysis is torn down by the outgoing item's `unprepare` (one `AudibleSpectrumTap` per
   * process in v1.9.24, whose analysis state belonged to whichever item's callbacks reached it last),
   * the plugin keeps handing over the *previous* item's last frame, non-zero and `live`, while nothing
   * measures the item that is playing. A skip out of a loud passage is exactly this: the register
   * never passes through zero, which is why the owner read it as *"there isn't enough silence between
   * the songs"* — what there is not, is a zero frame to reset the frozen-frame comparator.
   */
  staleRegisterUrls?: string[];
  /**
   * v1.9.25 — frames the tap has produced for the item it is on **now**: the plugin's per-item count
   * (`itemFrames`), zero at each install and moved only while that item's analysis measures.
   *
   * Where `frames` is the process's own count (so a tap that has produced nothing for the new item
   * still reports the previous track's number), this one is the fact about the item — and the
   * difference between a tap measuring *silence* (this grows, every band zero) and a tap that has
   * stopped measuring at all (this stands still) is the distinction the engine could not read before.
   */
  itemFrames: number;
  /**
   * v1.9.26 — **the tap's own frame cadence, in reads**: a healthy tap handing over a frame once
   * every N polls rather than once per poll.
   *
   * The v1.9.25 rule was written on the premise that a healthy tap produces a frame per 33 ms read,
   * and that premise is not a fact about any tap: the plugin's frame production is quantized to the
   * PCM buffer AVFoundation hands the tap (`drainAndAnalyze` resets `sinceLastFrame` per callback
   * rather than subtracting the hop, `NaviliteSpectrum.swift:678`), reported on real hardware as
   * 4096 frames — ~11 frames/s against 30 reads/s, so two reads in three would blank the bars on a
   * tap that is measuring perfectly. This field is how a test states that cadence; `1` (a frame per
   * read) is the only cadence the suite could state before it existed, and `framePeriodMs` below has
   * to match it the way a real tap's `maxFrames` bounds its own buffer.
   */
  itemFramesEvery?: number;
  /**
   * v1.9.26 — **the tap's own frame period for this item, in ms**, as the plugin declares it at
   * `prepare` (`maxFrames` / the sample rate, floored by the tap's own FFT hop).
   *
   * This is the fact the drawing rule now rests on, and the fake has to publish it because the
   * engine's rule is a comparison of two *plugin* numbers and nothing else: this item's last frame
   * may be drawn while it is at most one tap period stale, and a tap that has stood still longer
   * than its own period is named and not drawn. Default 33 — one poll, i.e. the cadence a fake that
   * produces a frame per read has always had.
   */
  framePeriodMs?: number;
  /**
   * v1.9.26 — how many `spectrumFrame` reads this item's analysis has answered, and how long ago it
   * produced its last frame.
   *
   * The age is the plugin's own account (`itemFrameAgeMs`), stated in the polls the engine makes:
   * `readsSinceProduced × 33 ms`, the poll period the engine is built on. It is derived from the
   * cadence the test states rather than from the wall clock on purpose — the rule under test compares
   * two plugin facts, and a fake whose age wobbled with `setInterval` jitter under a loaded test
   * runner would move the boundary (`age <= period`) for reasons that have nothing to do with it.
   * `-1` (never produced) is what the engine reads for a tap that has produced nothing for this item.
   */
  frameReads: number;
  readsSinceProduced: number;
  /**
   * v1.9.26 — the frame this item's analysis produced last: what the plugin hands over unchanged on a
   * read in which it produced nothing. `bands`/`live` are a **last-value register**, so this is what
   * the bars hold between two frames — and what the v1.9.25 rule blanked on.
   */
  registerBands: number[] | null;
  registerLive: boolean;
  /**
   * v1.9.24 — what the plugin answers to "is the tap on an item **at all**?" (`attached`,
   * `NaviliteSpectrum.swift:422`: `item != nil`), when a test wants to state it directly. Defaults
   * to the binding the fake is holding: the tapped item in `plugin` mode, "a request has started" in
   * the simple one.
   */
  attached?: boolean;
  /** What the plugin answers to "is the tap on the item the player is on now?" (see v1.8.0). */
  itemIsCurrent?: boolean;
  /** Frames produced so far — what "silence reads as silence" is judged against. */
  frames: number;
  silentFrames: number;
  /** The band values the tap hands back; a frame counter walks them so no two are identical. */
  bands: number[];
  live: boolean;
  playing: boolean;
}

/* ------------------------------------------------------------------ the bridge */

function fakeBridge(record: Recording, options: { buildMs?: number } = {}): (os: string, events: NativeBridgeEvents) => Promise<NativeBridge> {
  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  return async (_os: string, events: NativeBridgeEvents) => {
    if (options.buildMs) await wait(options.buildMs);
    /*
     * **One player, one clock (unreleased).** A position the player reports is the position the one
     * snapshot must carry: this sink records what it is told, so `snapshot()` below and the engine's
     * own report listener can never describe two different places in the same track.
     */
    record.events = new Proxy(events, {
      get(target, property, receiver) {
        if (property === 'onPosition') {
          return (seconds: number): void => {
            record.truth = { ...record.truth, positionMs: seconds * 1000 };
            target.onPosition(seconds);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    /*
     * v1.9.26 — a new install is a new analysis: its own frame count, its own cadence clock and its
     * own register. The plugin's `SpectrumAnalysis` is created per install (`NaviliteSpectrum.swift`),
     * so all three start here rather than at the process's first frame.
     */
    const beginAnalysis = (): void => {
      record.spectrum.itemFrames = 0;
      record.spectrum.frameReads = 0;
      record.spectrum.readsSinceProduced = 0;
      record.spectrum.registerBands = null;
      record.spectrum.registerLive = false;
    };
    /*
     * **The tap is installed by `makeItem` (unreleased).** One player builds one item per track and
     * that item carries its own analysis — there is no `startSpectrum` request to count and no
     * verify to send, so what the fake states here is the item itself: `installs` is how many items
     * this bridge built, `tappedUrl` the item whose tap is running, and the analysis starts empty.
     */
    const handItem = (url: string, id?: string): void => {
      record.previousUrl = record.playingUrl;
      record.playingUrl = url;
      record.playingId = id ?? '';
      record.spectrum.installs += 1;
      record.spectrum.started = true;
      record.spectrum.startedUrl = url;
      record.spectrum.tappedUrl = url;
      record.spectrum.itemIsCurrent = true;
      beginAnalysis();
    };
    /*
     * **The player's own clock, as `currentTime()` answers it (unreleased).** The last position the
     * test stated — or the player reported — plus the time since it said so, while the player is
     * playing; a paused player stands still. The engine re-anchors on every 33 ms read, so this is
     * what keeps a snapshot's clock moving: a static answer freezes the row at whatever the first
     * read said.
     */
    const clock = { positionMs: 0, playing: false, at: Date.now() };
    const currentTimeMs = (): number => {
      const now = Date.now();
      if (record.truth.positionMs !== clock.positionMs || record.truth.playing !== clock.playing) {
        clock.positionMs = record.truth.positionMs;
        clock.playing = record.truth.playing;
        clock.at = now;
      }
      const elapsed = record.truth.playing ? now - clock.at : 0;
      return Math.round(clock.positionMs + elapsed);
    };
    /*
     * **The tap's own read (v1.9.6…v1.9.27), as one door.** With one player there is no
     * `spectrumFrame` bridge left to call, but the state this block advances *is* what the tap does
     * on every read — a frame produced when its own cadence says so, a last-value register holding
     * it in between, a per-item counter and an age — and `snapshot()` publishes exactly that state
     * under the one published shape. One model of the tap, read by the one call the web layer makes.
     */
    const readFrame = async () => {
        /*
         * Every frame differs from the one before it, the way a real FFT of music does — and a
         * silent source reads as silence, which is the flat case the visualiser must detect.
         *
         * v1.9.6 — `tapProducing: false` is the tap that has been installed on the item and has not
         * produced a frame for it yet: the plugin's own counter stands still and every band reads
         * zero. It is the window the bar chip has a third word for, and the engine's rule for when
         * that window ends ("the tap has answered for this item") is read off that same counter.
         */
        /*
         * v1.9.24 — `framesQuietUrls` is the tap that is installed on the item that is playing and
         * has produced **nothing** for it: the plugin's own counter stands still (it is a
         * process-lifetime count, so it holds the previous track's value) and every band reads zero.
         */
        const quiet =
          record.playingUrl !== null && (record.spectrum.framesQuietUrls ?? []).includes(record.playingUrl);
        /*
         * v1.9.25 — the register that is not this item's measurement: the tap produced nothing for the
         * item playing now and the plugin hands over the frame it last produced, unchanged and non-zero.
         */
        const stale =
          record.playingUrl !== null && (record.spectrum.staleRegisterUrls ?? []).includes(record.playingUrl);
        /* v1.9.27 (card `t_c8cc01c6`) — and the tap that produces the same frame for ever (see the
         * field's own note): its counter moves, its bands never do. */
        const frozen =
          record.playingUrl !== null && (record.spectrum.frozenUrls ?? []).includes(record.playingUrl);
        /*
         * v1.9.26 — **the tap's own cadence.** The plugin produces a frame when its own PCM buffer
         * says so, not once per read (`drainAndAnalyze` is driven by the tap's callbacks), so a tap
         * that is measuring perfectly answers `itemFramesEvery` reads out of `N` with the same frame
         * it produced last. The reads in between are the state the v1.9.25 rule blanked on.
         */
        record.spectrum.frameReads += 1;
        // v1.9.27 (card `t_c8cc01c6`) — the tap's own answer latency, when a test states one: the
        // window a transition opens is a bridge round trip wide.
        if (record.spectrum.frameDelayMs) await wait(record.spectrum.frameDelayMs);
        const every = Math.max(1, record.spectrum.itemFramesEvery ?? 1);
        const period = record.spectrum.framePeriodMs ?? 33;
        /*
         * The age of the register, per read: a tap that declares a period of `period` ms for itself and
         * produces once every `every` reads of it is that much older on each read that it does not
         * produce. Both numbers are the fake's own statement of the tap's pace, and nothing else here
         * is a clock — the wall clock under a loaded test runner is jitter, and the rule under test
         * compares two plugin numbers, not the runner's scheduler.
         */
        const perReadMs = period / every;
        const due = (record.spectrum.frameReads - 1) % every === 0;
        const healthy = record.tapProducing && !quiet && !stale;
        const produced = healthy && due;
        if (produced) {
          record.spectrum.frames += 1;
          record.spectrum.itemFrames += 1;
          record.spectrum.readsSinceProduced = 0;
        } else {
          record.spectrum.readsSinceProduced += 1;
        }
        const bound = record.spectrum.plugin === true;
        // The tap on an item the player has left measures nothing: no frames, and not current.
        const itemIsCurrent = bound
          ? record.spectrum.tappedUrl !== null && record.spectrum.tappedUrl === record.playingUrl
          : record.spectrum.itemIsCurrent;
        const silent =
          !stale &&
          (!produced || quiet || (bound && !itemIsCurrent) || record.spectrum.bands.every((value) => value === 0));
        const fresh = silent
          ? record.spectrum.bands.map(() => 0)
          : frozen
            ? // The frozen buffer: the same band values on every read, so no two frames differ and
              // the checksum repeats (v1.9.27, card `t_c8cc01c6`).
              record.spectrum.bands.slice()
            : record.spectrum.bands.map((value, index) => (value + record.spectrum.frames * 7 + index) % 251);
        if (produced) {
          // The register now holds this item's own frame — what every read in between hands over
          // unchanged (v1.9.26). Nothing else writes it: a tap that has stopped leaves its last frame
          // standing, which is the same fact the engine reads from the age below.
          record.spectrum.registerBands = fresh.slice();
          record.spectrum.registerLive = !silent;
        }
        const held = healthy && !produced && record.spectrum.registerBands !== null;
        const register = record.spectrum.registerBands;
        const bands = stale
          ? // The register's own frame, unchanged from the last one its FFT produced: the same values
            // on every read, which is what makes a skip out of a loud passage the state the owner sees
            // (`live` stays true and nothing ever reads zero).
            record.spectrum.bands.slice()
          : register !== null && held
            ? register.slice()
            : produced
              ? fresh
              : record.spectrum.bands.map(() => 0);
        if (!produced) {
          // Nothing was measured, so there is no frame to be silent: `silentFrames` counts frames.
        } else if (!silent) record.spectrum.silentFrames = 0;
        else record.spectrum.silentFrames += 1;
        record.spectrum.live = stale ? true : held ? record.spectrum.registerLive : produced ? !silent : false;
        return {
          bands,
          bandCount: bands.length,
          live: record.spectrum.live,
          frames: record.spectrum.frames,
          // v1.9.25 — the plugin's own count for the item its tap is on: zero at the install, moved
          // only while that item's analysis measures, and standing still for a tap that has stopped.
          itemFrames: record.spectrum.itemFrames,
          /*
           * v1.9.26 — **the tap's own pace**, beside that counter: the period it declared for itself
           * at `prepare` (a real plugin's `maxFrames` over the sample rate, floored by its own FFT hop)
           * and the age of the frame it is holding. A tap that produced a frame this read reports age
           * 0; one that is between frames reports how old its register has become, in the same scope
           * as the poll it is being read on: a tap that produces once every `every` reads and declares
           * a period of `framePeriodMs` for itself ages by `framePeriodMs / every` per read, which is
           * the whole of what "this item's counter has stood still, and for how long" means here.
           * `-1` is a tap that has produced nothing at all for this item.
           */
          itemFramePeriodMs: period,
          itemFrameAgeMs: register === null ? -1 : Math.round(record.spectrum.readsSinceProduced * perReadMs),
          silentFrames: record.spectrum.silentFrames,
          positionMs: record.truth.positionMs,
          playing: record.spectrum.playing && record.truth.playing,
          // The plugin's own answer to "is the tap on an item at all?" — `NaviliteSpectrum.bands()`:
          // `"attached": item != nil`, which the engine reads for the first time in v1.9.24.
          attached: record.spectrum.attached ?? (bound ? record.spectrum.tappedUrl !== null : record.spectrum.started),
          // The plugin's own answer to "is the tap on the item the player is on now?" — flipped to
          // false by the orphan test, and decided by the tap's own binding in `plugin` mode.
          itemIsCurrent,
          // v1.9.25 — the lifecycle rule as the plugin's own numbers: a verify is a request for the
          // item the tap is already on, and the plugin counts it as such (`NaviliteSpectrum.bands()`
          // has always sent both; the screen has never shown either).
          installs: record.spectrum.installs,
          verifies: Math.max(0, record.spectrum.startCalls - record.spectrum.installs),
          readable: true,
          sampleRate: 44_100,
        };
    };
    record.calls.push('configure');
    return {
      async load(info: NativeTrackInfo) {
        record.calls.push('load');
        record.loads.push(info.url);
        await wait(ROUND_TRIP_MS);
        // v1.9.22 — the item the plugin's player is holding from now on: what a tap request issued
        // after this reads, and what `itemIsCurrent` is decided against in `plugin` mode.
        handItem(info.url, info.id);
      },
      async play(seconds: number) {
        record.calls.push(`play@${Math.round(seconds)}`);
        await wait(ROUND_TRIP_MS);
        record.truth = { ...record.truth, playing: true, positionMs: seconds * 1000 };
        /*
         * v1.9.2 — a player that has been told to play **reports where it is**, and that report is
         * what the engine now waits for before it will say the track is playing (`concludeStart`).
         * A fake that accepted the call and said nothing would be a fake of the bug this release is
         * about: every round trip answering, and no sound.
         */
        if (!record.deferPosition) {
          record.events?.onPosition(Math.max(0, seconds));
        }
      },
      pause: async () => {
        record.calls.push('pause');
        await wait(ROUND_TRIP_MS);
        // The player itself is what a snapshot reports: a pause is a player that is not playing.
        record.truth = { ...record.truth, playing: false };
      },
      async resume() {
        record.calls.push('resume');
        await wait(ROUND_TRIP_MS);
        // The trap: the call is accepted, the player stays put. `refuseResume` says so.
        if (!record.refuseResume) record.truth = { ...record.truth, playing: true };
      },
      stop: async () => {
        record.calls.push('stop');
        await wait(ROUND_TRIP_MS);
        record.truth = { ...record.truth, playing: false };
      },
      async seek(seconds: number) {
        record.calls.push(`seek@${Math.round(seconds)}`);
        // `seekIgnored` is the seek the item does not take (v1.9.13): the player stays where it is,
        // and its own answer to "where are you" is what the engine must carry.
        if (!record.seekIgnored) record.truth = { ...record.truth, positionMs: seconds * 1000 };
        // The plugin's own leak, when the test asks for it: the promise never settles.
        if (record.seekNeverSettles) return new Promise<void>(() => {});
        await wait(5);
      },
      /*
       * v1.9.1 — the prepared slot, in the fake bridge as in `src/player/native.ts`: a second asset
       * loaded on the same plugin, never sent `play`, adopted at a track boundary.
       */
      async prepare(info: NativeTrackInfo) {
        record.calls.push('prepare');
        record.prepares.push(info.url);
        record.preparedUrl = info.url;
        record.preparedId = info.id ?? '';
        await wait(ROUND_TRIP_MS);
        // v1.9.2: the answer is whether the player took the track — the queue records a prepared
        // track only on `true`.
        return true;
      },
      async adopt() {
        const url = record.preparedUrl;
        record.preparedUrl = null;
        if (!url) return false;
        record.calls.push('adopt');
        // The real bridge plays the prepared asset here (`NativeAudio.play` on its own asset id),
        // which is why adopting is a start and not a load.
        record.calls.push('play@0');
        record.adopts += 1;
        record.truth = { ...record.truth, playing: true, positionMs: 0 };
        // v1.9.22 — the adopted item is the one the player is holding (see `load`).
        handItem(url, record.preparedId);
        await wait(5);
        // The adopted item is playing now, and it says so: the same report a load's play produces.
        record.events?.onPosition(0);
        return true;
      },
      async discard() {
        record.calls.push('discard');
        record.preparedUrl = null;
      },
      positionMs: () => record.truth.positionMs,
      async sync() {
        record.calls.push('sync');
        await wait(ROUND_TRIP_MS);
        if (record.silentSync) return null;
        return { ...record.truth };
      },
      async activateSession() {
        record.calls.push('activateSession');
        await wait(ROUND_TRIP_MS);
        return true;
      },
      listenRemoteCommands() {
        return () => undefined;
      },
      hasNativeSpectrum: record.hasSpectrum,
      async startSpectrum(url: string, positionMs: number) {
        record.calls.push(`startSpectrum@${Math.round(positionMs)}`);
        record.spectrum.startCalls += 1;
        if (!record.spectrum.plugin) {
          if (record.spectrum.startedUrl !== url) {
            record.spectrum.installs += 1;
            // v1.9.25 — a new install is a new analysis: the item's own frame count starts at zero.
            beginAnalysis();
          }
          record.spectrum.started = true;
          record.spectrum.startedUrl = url;
          record.spectrum.startedAtMs = positionMs;
          record.spectrum.playing = true;
          return true;
        }
        /*
         * The plugin's own install (v1.9.22), in the three steps `NaviliteSpectrum.install` takes:
         * the item is read *now*, the wait for that item's audio track happens, and the attach lands
         * on the item that was read — **even when the player is on another one by then.**
         *
         * The generation guard the plugin does have is checked at the top of each retry step, before
         * the read; nothing re-checks it after the `await`, so a request whose wait outlasts the
         * track change attaches anyway and its `detach()` takes the mix off the item that is
         * playing. That window is `slowLandUrls`: a request for a stream being replaced, waiting
         * long enough for the next track's install to have landed first.
         */
        const read = record.playingUrl;
        const slow = read !== null && (record.spectrum.slowLandUrls ?? []).includes(read);
        await wait(slow ? record.spectrum.installMs ?? 200 : 5);
        record.spectrum.started = true;
        record.spectrum.startedUrl = url;
        record.spectrum.startedAtMs = positionMs;
        record.spectrum.playing = true;
        // The plugin's own rule: a request for the item the tap is already on is a *verify*, and
        // anything else is an install (this is `carriesOurTap`, with the item standing in for the URL).
        if (record.spectrum.tappedUrl !== read) {
          record.spectrum.installs += 1;
          // v1.9.25 — and the analysis of the item this install lands on is new: its own count is zero.
          beginAnalysis();
        }
        record.spectrum.tappedUrl = read;
        record.spectrum.itemIsCurrent = read !== null && read === record.playingUrl;
        return true;
      },
      async stopSpectrum() {
        record.spectrum.stopCalls += 1;
        record.spectrum.started = false;
      },
      /*
       * v1.9.25 — which slot the plugin says the tap is on, and which slot this bridge is playing:
       * the two names the reason line carries (`NativeBridge.spectrumEvidence`). Not a decision.
       */
      spectrumEvidence() {
        return { tapped: record.spectrum.tappedUrl ?? null, audible: record.playingUrl };
      },
      /** The old per-read door onto the tap, answered by the one model of it (`readFrame`). */
      async spectrumFrame() {
        return readFrame();
      },
      /**
       * **The one read (unreleased)** — `NaviliteRemote.snapshot()`'s own shape, built from the state
       * this fake already keeps.
       *
       * One answer carries the entry, the clock, the transport's word and that item's own frame, all
       * dated to the same item: `entry.key` and `spectrum.itemKey` are minted per item, so a frame
       * from a tap that is still holding the outgoing item's register is dated to *that* item and the
       * web layer withholds it rather than drawing the previous song under this one's row.
       *
       * The position is the player's own `currentTime()` and it **advances while the track plays**:
       * the engine re-anchors its clock on every 33 ms read, so a static answer would freeze the row.
       */
      async snapshot() {
        record.calls.push('snapshot');
        // A player that will not answer answers nothing: the read fails, and the return writes no
        // state from a reading nobody made. Named, not `null` — design §5's `unavailable`.
        if (record.silentSync) return { unavailable: 'no_answer' as const };
        const frame = await readFrame();
        const url = record.playingUrl ?? '';
        const key = url === '' ? '' : `item:${url}`;
        /*
         * v1.9.25 — the register that is not this item's measurement. `staleRegisterUrls` hands over
         * the outgoing item's last frame, and the key on the answer is the outgoing item's: the frame
         * is real, and it belongs to a different item.
         */
        const stale = url !== '' && (record.spectrum.staleRegisterUrls ?? []).includes(url);
        const itemKey = stale ? `item:${record.previousUrl ?? 'the-item-before'}` : key;
        const frames = stale ? Math.max(1, frame.itemFrames) : frame.itemFrames;
        return {
          generation: 0,
          entry: { songId: record.playingId, index: 0, url, assetId: 'slot-0', key },
          positionMs: currentTimeMs(),
          durationMs: record.truth.durationMs,
          rate: record.truth.playing ? 1 : 0,
          state: record.truth.playing ? 'playing' : 'paused',
          queue: { index: 0, count: 1, repeat: 'off' },
          spectrum: {
            // A build with no tap (Android here) publishes no tap state: nothing is attached.
            bands: record.hasSpectrum ? frame.bands : [],
            itemKey,
            frames: record.hasSpectrum ? frames : 0,
            lastAnalysisAt: frame.itemFrameAgeMs >= 0 ? Date.now() - frame.itemFrameAgeMs : 0,
            framePeriodMs: frame.itemFramePeriodMs,
            attached: record.hasSpectrum ? frame.attached : false,
          },
        };
      },
    };
  };
}

/* ------------------------------------------------------------------ the DOM */

interface Connections {
  edges: string[];
  gainValues: number[];
}

/**
 * The smallest stand-ins for `Audio`, `AudioContext` and `document` that the engine touches, with
 * the audio graph recorded as an edge list so the *shape* can be asserted — a graph that is never
 * built on the native path being the point of the "one engine" check.
 */
function installFakes(): {
  connections: Connections;
  restore: () => void;
  setFrame(v: number): void;
  /**
   * v1.9.27 (card `t_71dc787e`) — make the analyser answer **nothing** (`max` 0 on every frame), the
   * one state in which this item's own samples have not answered: a tainted cross-origin stream, or
   * an analyser producing silence. The window between that and the verdict is what the web path's
   * chip word had no name for.
   */
  setSilent(silent: boolean): void;
  /**
   * The element's own `duration`, which only the browser's decoder answers (`t_972b8fc5`). Chrome
   * reads the container exactly (210.3475 s for `Tank!.opus`); WebKit-on-iOS returns an *estimate* —
   * 4201.84 s for that same file — which is what makes the web transport a second one that can lie.
   */
  setDuration(seconds: number): void;
  finishTrack(): void;
  currentSrc(): string | null;
} {
  const connections: Connections = { edges: [], gainValues: [] };
  const frame = { value: 128 };
  const silence = { value: false };
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = {
    Audio: globals.Audio,
    AudioContext: globals.AudioContext,
    document: globals.document,
  };

  /** v1.9.0: the element the engine built, so a test can take a track to its end. */
  const elements: FakeAudio[] = [];

  class FakeAudio {
    preload = '';
    src: string | null = null;
    crossOrigin: string | null = null;
    currentTime = 0;
    duration = Number.NaN;
    error: { message: string; code: number } | null = null;
    paused = true;
    private listeners = new Map<string, Array<() => void>>();
    constructor() {
      elements.push(this);
    }
    addEventListener(type: string, handler: () => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler]);
    }
    removeAttribute(): void {
      this.src = null;
    }
    play(): Promise<void> {
      this.paused = false;
      this.dispatch('play');
      return Promise.resolve();
    }
    pause(): void {
      this.paused = true;
      this.dispatch('pause');
    }
    /** The stream reached its end — the browser's own `ended`, on the live element. */
    finish(): void {
      this.paused = true;
      this.dispatch('ended');
    }
    private dispatch(type: string): void {
      for (const handler of this.listeners.get(type) ?? []) handler();
    }
  }

  class FakeAudioContext {
    state = 'running';
    sampleRate = 48_000;
    destination = { name: 'destination' };
    addEventListener(): void {}
    resume(): Promise<void> {
      this.state = 'running';
      return Promise.resolve();
    }
    createMediaElementSource(): unknown {
      return {
        connect: (node: { name?: string }) => connections.edges.push(`source->${node?.name ?? 'node'}`),
        disconnect: () => undefined,
      };
    }
    createAnalyser(): unknown {
      return {
        name: 'analyser',
        fftSize: 2048,
        smoothingTimeConstant: 0,
        minDecibels: -95,
        frequencyBinCount: 1024,
        connect: (node: { name?: string }) => connections.edges.push(`analyser->${node?.name ?? 'node'}`),
        disconnect: () => undefined,
        getByteFrequencyData: (data: Uint8Array) => {
          // v1.9.27 (t_71dc787e) — an analyser that answers nothing: silence, not a level.
          if (silence.value) {
            data.fill(0);
            return;
          }
          for (let i = 0; i < data.length; i += 1) data[i] = (frame.value + i) % 200;
        },
      };
    }
    createGain(): unknown {
      return {
        name: 'gain',
        gain: {
          set value(next: number) {
            connections.gainValues.push(next);
          },
          get value() {
            return connections.gainValues[connections.gainValues.length - 1] ?? 1;
          },
        },
        connect: (node: { name?: string }) => connections.edges.push(`gain->${node?.name ?? 'node'}`),
      };
    }
  }

  globals.Audio = FakeAudio;
  globals.AudioContext = FakeAudioContext;
  globals.document = { hidden: false };

  return {
    connections,
    setFrame: (value: number) => {
      frame.value = value;
    },
    setSilent: (value: boolean) => {
      silence.value = value;
    },
    setDuration: (seconds: number) => {
      for (const element of elements) element.duration = seconds;
    },
    finishTrack: () => {
      for (const element of elements) element.finish();
    },
    currentSrc: () => elements[elements.length - 1]?.src ?? null,
    restore: () => {
      globals.Audio = previous.Audio;
      globals.AudioContext = previous.AudioContext;
      globals.document = previous.document;
    },
  };
}

function recording(overrides: Partial<Recording> = {}): Recording {
  return {
    calls: [],
    loads: [],
    prepares: [],
    tapProducing: true,
    hasSpectrum: true,
    adopts: 0,
    preparedUrl: null,
    preparedId: '',
    seekNeverSettles: false,
    deferPosition: false,
    events: null,
    truth: { playing: true, positionMs: 1000, durationMs: 180_000 },
    refuseResume: false,
    silentSync: false,
    frameValue: 128,
    playingUrl: null,
    playingId: '',
    previousUrl: null,
    spectrum: {
      started: false,
      startedUrl: null,
      startedAtMs: 0,
      startCalls: 0,
      stopCalls: 0,
      installs: 0,
      frames: 0,
      itemFrames: 0,
      // v1.9.26 — the tap's own pace: a frame per read (33 ms, one poll), which is the cadence every
      // test in this file states unless it sets these two together on purpose.
      itemFramesEvery: 1,
      framePeriodMs: 33,
      frameReads: 0,
      readsSinceProduced: 0,
      registerBands: null,
      registerLive: false,
      silentFrames: 0,
      // A plausible loud frame: most bands carrying energy, none of them pinned.
      bands: Array.from({ length: 64 }, (_, index) => 40 + ((index * 37) % 120)),
      live: true,
      playing: true,
    },
    ...overrides,
  };
}

/**
 * Every engine is stopped before its test ends: the clock ticker and the spectrum poll are
 * `setInterval`s, and a test process that holds one open never exits.
 */
async function stopAll(engines: AudioEngine[]): Promise<void> {
  for (const engine of engines) await engine.stop();
  await new Promise((resolve) => setTimeout(resolve, 60));
  for (const engine of engines) await engine.stop();
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const nativeEngine = (record: Recording, options: { buildMs?: number } = {}): AudioEngine =>
  new AudioEngine({
    platform: { os: 'ios', native: true },
    nativeFactory: fakeBridge(record, options) as unknown as EngineOptions['nativeFactory'],
  });

/** The numbers the assertions are made on, printed the way the rest of the repo's checks print them. */
function say(line: string): void {
  console.log(`    ${line}`);
}

/* ------------------------------------------------- invariant 4: the machine itself */

test('the machine is a pure, idempotent function of its inputs — the same event twice is one transition', () => {
  const states: EngineState[] = ['idle', 'loading', 'playing', 'paused', 'interrupted', 'ended', 'error'];
  /*
   * `play` and `pause` are absolute, and applying either twice must be applying it once: that is
   * the property that makes a doubled event — the same pause delivered twice by two listeners, or
   * a replayed one — a non-event rather than a second round trip to the player.
   */
  for (const state of states) {
    for (const action of ['play', 'pause'] as const) {
      const event: PlayerEvent = { type: 'transport', action };
      const once = reduce(state, event);
      const twice = reduce(once, event);
      assert.equal(twice, once, `${state} + ${action} was not idempotent (${once} → ${twice})`);
    }
    // `toggle` is a toggle and is deliberately not idempotent — twice is a round trip back. What it
    // must never do is leave the machine somewhere the app does not know about.
    const toggled = reduce(state, { type: 'transport', action: 'toggle' });
    assert.ok(states.includes(toggled), `${state} + toggle landed on an unknown state`);
    if (state === 'playing' || state === 'paused') {
      assert.equal(reduce(toggled, { type: 'transport', action: 'toggle' }), state, `${state} + toggle twice is a round trip`);
    }
    assert.ok(states.includes(reduce(state, { type: 'lifecycle', phase: 'hidden' })), `${state} + hidden`);
  }

  // Stale events are absorbed, not queued: a report that agrees with where we already are is a
  // non-event, and one that contradicts a *newer* decision cannot resurrect it.
  assert.equal(reduce('paused', { type: 'engine-state', playing: false }), 'paused');
  assert.equal(reduce('interrupted', { type: 'engine-state', playing: false }), 'interrupted');
  assert.equal(reduce('ended', { type: 'engine-state', playing: false }), 'ended');
  assert.equal(reduce('idle', { type: 'engine-state', playing: false }), 'idle');
  assert.equal(reduce('loading', { type: 'engine-state', playing: false }), 'loading');
  // A stop the player reports rather than a pause: the track is over, not held.
  assert.equal(reduce('playing', { type: 'engine-state', playing: false, stopped: true }), 'ended');
  // Leaving the screen does not rewrite what the audio is doing.
  assert.equal(reduce('playing', { type: 'lifecycle', phase: 'hidden' }), 'playing');
  assert.equal(reduce('playing', { type: 'lifecycle', phase: 'foreground' }), 'playing');
});

/* --------------------------- invariant 1: the clock, and 5: the spectrum it feeds */

test('the clock advances only while the engine is playing and the app is on screen', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  try {
    const record = recording();
    const engine = nativeEngine(record);
    engines.push(engine);
    await engine.play(TRACK);
    assert.equal(engine.status().state, 'playing');

    // The player reports where it is, the way the plugin's `currentTime` listener does.
    record.events?.onPosition(12.5);
    // Playing, on screen: it moves, and it moves with the wall clock.
    await settle(240);
    const running = engine.status().positionMs;
    assert.ok(
      running - 12_500 >= 200,
      `the clock runs while the track plays: ${Math.round(running)} ms against the player's own report of 12500 ms, after 240 ms of real time`,
    );
    assert.ok(running <= 12_500 + 300, `and it is the wall clock, not ahead of it (${Math.round(running)} ms)`);

    /*
     * Invariant 1, first half — **the app goes out of sight**. From here the player is playing to
     * nobody (the web view is suspended and no callback reaches us), so the clock reports the last
     * position it was actually told rather than counting the hidden minutes itself. That count is
     * what he saw: *"the native audio player seems to keep incrementing in time when there is no
     * sound when backgrounded"*.
     */
    await engine.handleVisibility(true);
    const atHide = engine.status().positionMs;
    await settle(400);
    const afterHide = engine.status().positionMs;
    say(`invariant 1 — backgrounded: ${Math.round(atHide)} ms at the moment of hiding, ${Math.round(afterHide)} ms after 400 ms more (delta ${Math.round(afterHide - atHide)} ms)`);
    assert.equal(
      afterHide,
      atHide,
      `backgrounded: the clock stood still (${Math.round(atHide)} ms at the moment of hiding, ${Math.round(afterHide)} ms after 400 more ms of real time)`,
    );
    /*
     * The anchor is the last read and the count since it is wall clock, so the honest bound is the one
     * the playing assertion above already uses (300 ms of real time), not one 33 ms poll.
     */
    assert.ok(
      Math.abs(atHide - 12_500) <= 300,
      `and what it shows is the player's own clock at the last read, not a guess (${Math.round(atHide)} ms against 12500 — wall clock since that read)`,
    );

    // Invariant 1, second half — **nothing is playing at all**. A pause freezes it exactly.
    record.truth = { playing: true, positionMs: 12_500, durationMs: 180_000 };
    await engine.handleVisibility(false);
    assert.equal(engine.status().state, 'playing');
    await settle(120);
    await engine.pause();
    assert.equal(engine.status().state, 'paused');
    const atPause = engine.status().positionMs;
    await settle(300);
    say(`invariant 1 — paused: ${Math.round(atPause)} ms at the pause, ${Math.round(engine.status().positionMs)} ms after 300 ms more (delta ${Math.round(engine.status().positionMs - atPause)} ms)`);
    assert.equal(
      engine.status().positionMs,
      atPause,
      `paused: the clock stood still (${Math.round(atPause)} ms at the pause, the same after 300 more ms)`,
    );
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

test('the spectrum is fed by the engine that is playing: real, varying, proportional, and never off while playing', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  try {
    const record = recording();
    const engine = nativeEngine(record);
    engines.push(engine);
    await engine.play(TRACK);

    // One engine: no web-audio graph, and above all no second playback path in the page.
    assert.equal(engine.status().backend, 'native', 'a wrapped build plays natively');
    assert.deepEqual(fakes.connections.edges, [], 'no web-audio graph is built on the native path at all');
    assert.equal(record.spectrum.started, true, 'the tap is what feeds the visualiser');
    assert.equal(record.spectrum.startedUrl, TRACK.url, 'and it is fed the same stream the player is playing');
    assert.equal(record.calls.filter((call) => call === 'load').length, 1, 'exactly one asset was ever loaded');

    await settle(120);
    const status = engine.status();
    assert.equal(status.state, 'playing');
    assert.equal(status.spectrum, true, `the engine must report a live spectrum (modeReason: ${status.modeReason})`);
    const first = engine.readSpectrum();
    assert.ok(first, 'a live spectrum hands the visualiser a frame');
    assert.equal(first.length, 64, 'the native frame is the 64 bands the canvas draws');
    assert.ok(first.every((value) => value > 0), 'a majority — here all — of the bands carry energy');
    const max = Math.max(...first);
    const min = Math.min(...first);
    assert.ok(max < 255 && min < 255, `and none of them is pinned at maximum (max ${max}, min ${min})`);
    const span = max - min;
    assert.ok(span > 20, `the frame has a shape rather than one uniform value (span ${span})`);
    say(`invariant 5 — bands: 64 values, min ${min}, max ${max}, span ${span}`);

    const framesSeen = new Set<string>();
    for (let index = 0; index < 6; index += 1) {
      framesSeen.add(String(engine.readSpectrum()));
      await settle(40);
    }
    assert.ok(framesSeen.size >= 4, `consecutive frames must differ (${framesSeen.size} distinct frames of 6 reads)`);
    say(`invariant 5 — ${framesSeen.size} distinct frames over 6 reads, ${record.spectrum.frames} frames from the tap`);

    /*
     * Silence reads as silence, and it is **this item's own frame** (unreleased). The snapshot has
     * no verdict about a quiet passage: the tap is measuring this item and every band is zero, which
     * is a flat picture of what is being heard. The comparator that turned that into \"the spectrum
     * cannot run on this item\" was deleted with the second reading, and drawing zeros is the
     * truthful render — the chip keeps the spectrum's own word because the tap has answered.
     */
    record.spectrum.bands = new Array(64).fill(0);
    await settle(500);
    const silentFrame = engine.readSpectrum();
    assert.ok(
      silentFrame !== null && Array.from(silentFrame).every((value) => value === 0),
      `a silent item is its own frame: 64 zeros, drawn as the silence it is (modeReason: ${engine.status().modeReason})`,
    );
    assert.equal(engine.status().spectrum, true, 'and the chip keeps the spectrum\'s word: the tap is measuring this item, quietly');

    // The invariant that outlives all of it: while the engine is playing, the feed is on.
    record.spectrum.bands = Array.from({ length: 64 }, (_, index) => 40 + ((index * 37) % 120));
    await settle(200);
    assert.equal(engine.status().state, 'playing');
    assert.equal(engine.status().spectrum, true, 'still playing means still fed — nothing silently switched the visualiser off');
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

/*
 * v1.9.16 — the **downloaded** track, on the app's side of the seam.
 *
 * The owner: *"the spectrum doesn't seem to work with downloaded songs."* The JS layer already did
 * its half — it hands the tap the `file://` URL the track resolved to — and the refusal was in the
 * vendor's choice of transport, which is why `test/local-file-spectrum.test.ts` reads the native
 * source. What this test holds is the app's half of the same invoice: a local-file track is tapped
 * like any other, and a track change of *either* kind leaves the tap following the item that is
 * playing now rather than dead on the one before it.
 */
test('a downloaded track feeds the spectrum, and the next item — streamed — is what the tap follows', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  try {
    const record = recording();
    const engine = nativeEngine(record);
    engines.push(engine);

    await engine.play(LOCAL_TRACK);
    assert.equal(record.loads[0], LOCAL_TRACK.url, 'the player was given the local file the app resolved, not a stream');
    assert.equal(record.spectrum.started, true, 'and a downloaded track is tapped like any other');
    assert.equal(record.spectrum.startedUrl, LOCAL_TRACK.url, 'the tap is on that same file');
    await settle(160);
    assert.equal(engine.status().spectrum, true, `the bars are live on a local-file track (modeReason: ${engine.status().modeReason})`);

    // Recovery: the queue moves on to a track that is streamed — a different scheme, and the same
    // requirement. The tap must follow the item that is audible now.
    record.calls = [];
    await engine.play(OTHER_TRACK);
    await settle(200);
    assert.equal(record.spectrum.startedUrl, OTHER_TRACK.url, 'the tap follows the item that is playing now');
    assert.equal(engine.status().state, 'playing');
    assert.equal(engine.status().spectrum, true, `and the bars are live on the streamed one (modeReason: ${engine.status().modeReason})`);
    say(`v1.9.16 — local ${LOCAL_TRACK.url.slice(-24)} → streamed, tap on ${record.spectrum.startedUrl?.slice(-24)}`);
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

/* ------------------- invariants 2 and 3: leaving the app, being driven from outside */

test('background → foreground continues with no restart and no repeat, and a remote control is adopted rather than overridden', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  try {
    const record = recording();
    const engine = nativeEngine(record);
    engines.push(engine);
    await engine.play(TRACK);
    await settle(60);
    assert.equal(engine.status().state, 'playing');
    assert.equal(record.spectrum.started, true, 'the tap runs while the track plays');

    // Out of sight. Nothing is written to the player and nothing is torn down.
    record.calls = [];
    await engine.handleVisibility(true);
    assert.deepEqual(record.calls, [], 'leaving the screen sends the player nothing at all');
    assert.equal(record.spectrum.started, true, 'and does not switch the visualiser off');

    /*
     * Invariant 2 — the app was away for a long time and the player kept playing. It reports
     * 41 500 ms, which is the truth; the app adopts it (continuous, not restarted) and sends no
     * transport call whatsoever. Zero here is the whole fix: *"pausing causes the audio to keep
     * repeating"* was the app writing to the player on the way back in.
     */
    record.truth = { playing: true, positionMs: 41_500, durationMs: 180_000 };
    record.calls = [];
    await engine.handleVisibility(false);
    const back = engine.status();
    assert.ok(
      Math.abs(back.positionMs - 41_500) < 400,
      `the position is the player's own (${Math.round(back.positionMs)} ms against the player's 41500)`,
    );
    assert.equal(back.state, 'playing', 'still playing, because it still is');
    say(
      `invariant 2 — background → foreground: player reports 41500 ms, app shows ${Math.round(back.positionMs)} ms, ` +
        `transport writes across the whole hand-off: ${record.calls.filter((call) => call === 'resume' || call === 'pause' || call.startsWith('play@')).length}`,
    );
    assert.deepEqual(
      record.calls.filter((call) => call === 'resume' || call === 'pause' || call.startsWith('play@')),
      [],
      `returning writes nothing at all to the player — calls: ${record.calls.join(', ')}`,
    );
    assert.ok(
      record.calls.some((call) => call === 'snapshot'),
      `and reads the one player on the way back in — the same item, whose tap never stopped — calls: ${record.calls.join(', ')}`,
    );
    assert.equal(record.spectrum.started, true, 'and the tap is still on the item it was on');

    /*
     * Invariant 3 — the owner paused it from the lock screen while the app was away, then came
     * back. The app adopts the pause. Writing over it (the old behaviour) is what he described as
     * *"it just seems to completely break the playback of the app"*.
     */
    await engine.handleVisibility(true);
    record.truth = { playing: false, positionMs: 61_000, durationMs: 180_000 };
    record.calls = [];
    await engine.handleVisibility(false);
    assert.equal(engine.status().state, 'interrupted', 'a player that is not playing is not reported as playing');
    say(
      `invariant 3 — remote control while backgrounded: player stopped at 61000 ms, app shows ${Math.round(engine.status().positionMs)} ms, ` +
        `transport writes: ${record.calls.filter((call) => call === 'resume' || call === 'pause' || call.startsWith('play@')).length}`,
    );
    assert.ok(
      Math.abs(engine.status().positionMs - 61_000) < 400,
      `at the position the owner actually stopped it (${Math.round(engine.status().positionMs)} ms against 61000)`,
    );
    assert.deepEqual(
      record.calls.filter((call) => call === 'resume' || call.startsWith('play@') || call === 'pause'),
      [],
      `nothing is written over a decision he made elsewhere — calls: ${record.calls.join(', ')}`,
    );

    // And his own tap still answers immediately afterwards: one tap restarts it from that spot.
    record.calls = [];
    await engine.toggle();
    assert.equal(engine.status().state, 'playing', 'one tap resumes from where he stopped it');
    assert.ok(record.calls.includes('resume'), `the tap is what sends the resume — calls: ${record.calls.join(', ')}`);

    // The same track, pressed twice, is one playback: nothing is reloaded and nothing replayed.
    record.calls = [];
    await engine.play(TRACK);
    assert.deepEqual(record.calls, [], `a second press on the same track does nothing at all — calls: ${record.calls.join(', ')}`);
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

test('transport is idempotent through the engine too, and stale events from before a transition are ignored', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  try {
    const record = recording();
    const engine = nativeEngine(record);
    engines.push(engine);
    await engine.play(TRACK);
    await settle(60);

    // Two pauses are one pause on the bridge, and the second one is not even sent.
    record.calls = [];
    await Promise.all([engine.pause(), engine.pause()]);
    assert.deepEqual(record.calls.filter((call) => call === 'pause'), ['pause'], `two taps, one pause: ${record.calls.join(', ')}`);
    assert.equal(engine.status().state, 'paused');
    await engine.pause();
    assert.deepEqual(record.calls.filter((call) => call === 'pause'), ['pause'], 'and a third does not send another');

    // Two plays are one resume, and the resume is confirmed against the player.
    record.calls = [];
    record.truth = { playing: true, positionMs: 63_000, durationMs: 180_000 };
    await Promise.all([engine.resume(), engine.resume()]);
    assert.deepEqual(record.calls.filter((call) => call === 'resume'), ['resume'], `two taps, one resume: ${record.calls.join(', ')}`);

    /*
     * The trap that started all of this: the plugin accepts a resume and the player does not
     * start. The confirmation notices and restarts the track at the same second — the owner's
     * rule, in his words: one tap on play must restart it, with no seek-bar nudge and no
     * pause/play dance.
     */
    record.refuseResume = true;
    record.truth = { playing: false, positionMs: 63_000, durationMs: 180_000 };
    await engine.pause();
    record.calls = [];
    await engine.resume();
    await settle(520);
    const restarted = engine.status();
    assert.equal(restarted.state, 'playing', 'a resume that was swallowed is restarted, not reported as playing');
    assert.ok(
      record.calls.includes('load') && record.calls.some((call) => call.startsWith('play@63')),
      `and it is restarted at the same second — calls: ${record.calls.join(', ')}`,
    );

    /*
     * A *stale* confirmation cannot land on a newer decision. The generation is bumped by the
     * pause, so the resume's own follow-up — which is still 300 ms away — finds itself out of
     * date and does nothing. This is the class of bug ("double-attached listeners, a buffer
     * re-triggered") killed at the door rather than patched at the instance.
     */
    record.refuseResume = false;
    record.truth = { playing: true, positionMs: 70_000, durationMs: 180_000 };
    await engine.pause();
    record.calls = [];
    void engine.resume(); // not awaited: the pause below lands inside its confirmation window
    await settle(20);
    await engine.pause();
    const callsAtPause = record.calls.length;
    await settle(520);
    assert.equal(engine.status().state, 'paused', 'the later pause stands');
    assert.deepEqual(
      record.calls.slice(callsAtPause).filter((call) => call === 'load' || call.startsWith('play@')),
      [],
      `and the stale confirmation did not restart anything afterwards — calls: ${record.calls.join(', ')}`,
    );
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

test('a pause sent while the asset is still loading is the pause that wins', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  try {
    const record = recording();
    const engine = nativeEngine(record);
    engines.push(engine);
    // Press the track, and pause inside the load's own round trips.
    const started = engine.play(TRACK);
    await settle(20);
    record.truth = { playing: false, positionMs: 0, durationMs: 180_000 };
    await engine.pause();
    await started;
    assert.equal(engine.status().state, 'paused', 'the pause stands');
    const order = record.calls.filter((call) => call === 'pause' || call.startsWith('play@'));
    assert.ok(
      order[order.length - 1] === 'pause',
      `and the player is left stopped: the load's own play is followed by the stop — calls: ${record.calls.join(', ')}`,
    );
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

test('a player that will not answer never leaves a "playing" no tap can act on', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  try {
    const record = recording();
    record.silentSync = true;
    const engine = nativeEngine(record);
    engines.push(engine);
    await engine.play(TRACK);
    await settle(60);
    await engine.handleVisibility(true);
    const beforeReturn = engine.status().positionMs;
    record.calls = [];
    await engine.handleVisibility(false);
    /*
     * **A read that never came is not a reading (unreleased).** The return asks the one player and
     * gets nothing; nothing is written from it, so the row keeps the transport it already had rather
     * than being re-stated from an answer nobody gave — and the clock is not invented across it.
     */
    /*
     * Design §5 (S4, `noteSnapshotUnavailable`): a read that never came is not a reading and it is
     * not silence — the refusal is a named state, and a `playing` machine may not sit over it. The
     * row goes to `error` naming the step that refused.
     */
    const blind = engine.status();
    assert.equal(blind.state, 'error', 'a read that never came does not leave a "playing" no tap can act on');
    assert.match(blind.modeReason, /would not answer the one snapshot \(no_answer\)/, 'the reason names the step that refused');
    assert.ok(
      Math.abs(blind.positionMs - beforeReturn) < 400,
      `and the clock is not invented from a read that never came (${Math.round(blind.positionMs)} ms against ${Math.round(beforeReturn)} at the hide)`,
    );
    // The one tap still fixes it, and it is the tap that sends the command.
    record.silentSync = false;
    record.truth = { playing: true, positionMs: 12_000, durationMs: 180_000 };
    record.calls = [];
    await engine.toggle();
    assert.equal(engine.status().state, 'playing');
    assert.ok(record.calls.includes('resume'), `and the tap is what sends the command — calls: ${record.calls.join(', ')}`);
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

/* ------------------------------------------------- the web path, unchanged in role */

test('in a browser the element is the engine, and the native bridge is never built', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  try {
    const record = recording();
    const web = new AudioEngine({ platform: { os: 'web', native: false }, nativeFactory: fakeBridge(record) as unknown as EngineOptions['nativeFactory'] });
    engines.push(web);
    await web.play(TRACK);
    assert.equal(web.status().backend, 'web', 'a browser has no native player, so the element is the engine');
    assert.deepEqual(fakes.connections.edges, ['source->analyser', 'analyser->gain', 'gain->destination'], 'and the analyser is in front of it, always reachable from the destination');
    assert.equal(fakes.connections.gainValues[fakes.connections.gainValues.length - 1], 1, 'at full gain: this is the audible engine');
    assert.equal(record.spectrum.started, false, 'and no native tap is started');
    assert.deepEqual(record.calls, [], 'the native bridge is not even asked for');

    fakes.setFrame(128);
    await settle(160);
    assert.equal(web.status().spectrum, true, `the analyser reads real frames (modeReason: ${web.status().modeReason})`);

    await web.pause();
    assert.equal(web.status().state, 'paused');
    assert.equal(web.readSpectrum(), null, 'a paused track has nothing to draw, so the album-art theme takes over');
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

/* --------------------------------------------- what a wrapped build must never do */

test('a wrapped build with no native engine plays nothing rather than falling back to the page', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  try {
    const engine = new AudioEngine({
      platform: { os: 'ios', native: true },
      nativeFactory: (async () => null) as unknown as EngineOptions['nativeFactory'],
    });
    engines.push(engine);
    await engine.play(TRACK);
    assert.equal(engine.status().state, 'error', 'the failure is reported as a failure');
    assert.match(engine.status().error ?? '', /native audio engine is not available/);
    assert.deepEqual(fakes.connections.edges, [], 'and nothing was built in the page instead — this is the "no fallback that plays" rule');
    assert.equal(engine.status().backend, 'native', 'the app never has two ideas about which engine it has');
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

/* ------------------------------------------------------------- the press latency */

test('the press is not behind the bridge round trips', async () => {
  const fakes = installFakes();
  try {
    const record = recording();
    // A bridge that takes 60 ms to build, as the plugin import + configure + three listeners do.
    const engine = nativeEngine(record, { buildMs: 60 });

    // Pre-warm, the way boot does it (right after the engine is built).
    engine.prewarm();
    await settle(120);
    assert.equal(engine.status().nativeAvailable, true, 'the bridge is built before the first press');

    const pressedAt = performance.now();
    const playing = engine.play(TRACK);
    const stateOnPress = engine.status().state;
    const uiLatencyMs = Math.round(performance.now() - pressedAt);
    assert.equal(stateOnPress, 'loading', 'the transport is loading on the tick of the press');

    await playing;
    assert.equal(engine.status().state, 'playing', 'and playing once the player speaks');
    const soundLatencyMs = Math.round(performance.now() - pressedAt);
    // v1.7 flipped the state only after `load` + `play` had both resolved — that is this number.
    assert.ok(soundLatencyMs >= ROUND_TRIP_MS * 2, `the bridge really is in the path (${soundLatencyMs} ms of round trips)`);
    assert.ok(uiLatencyMs <= 5, `press-to-UI was ${uiLatencyMs} ms against ${soundLatencyMs} ms of bridge work`);
    assert.ok(soundLatencyMs - uiLatencyMs >= 70, 'the delay the owner felt is the gap between these two numbers');
    await stopAll([engine]);
  } finally {
    fakes.restore();
  }
});

/* --------------------------------------------------------------- a second track */

test('moving to another track is one load, one play, and the spectrum follows the new stream', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  try {
    const record = recording();
    const engine = nativeEngine(record);
    engines.push(engine);
    await engine.play(TRACK);
    await settle(60);
    record.calls = [];
    await engine.play(OTHER_TRACK, 5_000);
    assert.deepEqual(record.calls.filter((call) => call === 'load'), ['load'], `one load for the new track: ${record.calls.join(', ')}`);
    assert.ok(record.calls.includes('play@5'), `and it starts where the queue said: ${record.calls.join(', ')}`);
    assert.equal(record.spectrum.startedUrl, OTHER_TRACK.url, 'and the tap is reading the new stream');
    await settle(120);
    assert.equal(engine.status().state, 'playing');
    assert.equal(engine.status().spectrum, true, 'the visualiser came back with the new track');
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});


/* --------------------------- v1.9.7: a start concluded from the track it replaces */

test('a report about the track being replaced does not start the track that replaces it', async () => {
  /*
   * The defect Sage found in v1.9.6, made runnable.
   *
   * A load is an unload + a preload, and the plugin's own ~100 ms `currentTime` timer goes on
   * reporting the item it is holding — the OUTGOING one — until that `unload` is processed. The
   * engine's anchor test (`|ms - startAnchorMs| <= START_ANCHOR_SLACK_MS`, three seconds) could not
   * tell such a report from the item being fetched, so a start that had fetched **nothing** was
   * concluded on the previous track's position: the bar said `playing`, `startFailed` stayed false,
   * and a load that then failed was never shown and never retried. This is the same report the
   * outgoing item's timer produces, delivered inside the load bracket.
   */
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  try {
    const record = recording();
    const engine = nativeEngine(record);
    engines.push(engine);
    await engine.play(TRACK);
    assert.equal(engine.status().state, 'playing', 'the first track is playing');
    await settle(40);

    // The tap on the next row, and the outgoing item still reporting 1.4 s into the load.
    const starting = engine.play(OTHER_TRACK);
    await settle(20);
    record.events?.onPosition(1.4);
    say(`the replaced track's own report: state ${engine.status().state} — calls ${record.calls.join(', ')}`);
    assert.equal(
      engine.status().state,
      'loading',
      'a report about the track being replaced is not evidence that this start has sound',
    );
    assert.equal(engine.startDidFail(), false, 'and it is not a failure either: the load is still running');

    await starting;
    assert.equal(engine.status().state, 'playing', 'and the start still concludes from the item it did fetch');
    assert.equal(engine.currentTrack?.id, OTHER_TRACK.id, 'which is the track that was asked for');
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});


/* -------------------------------------------------------------- the v1.7.5 gaps */

test('two different tracks pressed in quick succession leave the second one playing and the first one silent', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  try {
    const record = recording();
    const engine = nativeEngine(record);
    engines.push(engine);
    /*
     * Press A, then press B *inside* A's load — the fake's load is {@link ROUND_TRIP_MS} of round
     * trips, which is a network fetch on a phone. Both loads are on the one shared assetId, and
     * before v1.7.5 the slower one's `play` landed after the faster one's: the older track audible
     * with the newer one on screen. Pressing the *same* track twice could never show this, which is
     * why the idempotency checks above did not catch it.
     */
    const first = engine.play(TRACK);
    await settle(20);
    const second = engine.play(OTHER_TRACK);
    await Promise.all([first, second]);
    await settle(60);

    const plays = record.calls.filter((call) => call.startsWith('play@'));
    say(
      `the rapid switch: loads ${record.loads.map((url) => url.slice(-8)).join(' → ')}, ` +
        `plays ${plays.length} (${plays.join(', ') || 'none'})`,
    );
    assert.deepEqual(plays, ['play@0'], `the superseded load never sends its play — calls: ${record.calls.join(', ')}`);
    assert.equal(record.loads[record.loads.length - 1], OTHER_TRACK.url, 'and the asset ends up holding the track the UI shows');
    assert.equal(engine.currentTrack?.id, OTHER_TRACK.id);
    assert.equal(engine.status().state, 'playing');
    assert.equal(record.spectrum.startedUrl, OTHER_TRACK.url, 'the spectrum is reading the track that is audible');
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

/*
 * v1.9.22 — the owner, on the installed build: *"sometimes when I move through songs too quickly it
 * seems like the spectrum doesn't attach correctly to the song and so while the song is playing the
 * spectrum is just zero."* And, asked to settle it: *"the spectrum off is not intentional, i have
 * never toggled spectrum to be off so it is a bug."*
 *
 * The mechanism, modelled here as the plugin really behaves (`record.spectrum.plugin`, built on
 * `NaviliteSpectrum.install`): a tap request reads the item the player holds **when the request
 * arrives**, then waits for that item's audio track — up to five seconds of 100 ms steps, and for a
 * stream that is being replaced that wait outlasts the track change — and then attaches to the item
 * it read. The attach calls `detach()` first, which takes the mix off the item that *is* playing,
 * and nothing after the `await` re-checks either the request's generation or the player's current
 * item. So on a skip, the request the previous track issued lands last and leaves the tap on the
 * item the player has left: the canvas is handed no frames while audio plays, which is exactly
 * `playing · native · spectrum off`.
 *
 * What the *engine* owes on top of that is the recovery the card names — a transition that lands
 * while a previous attach is still in flight must not leave the analyser unattached. The assertion
 * is the owner's acceptance, and it is deliberately made *after* the outgoing request has landed
 * and eight times in a row: the bars for the track that is playing, at every read, not at the first
 * one. (With the v1.9.21 engine the tap's own orphan re-check waits out
 * {@link SPECTRUM_ORPHAN_RECHECK_MS} — `lastSpectrumRecheckAt` is stamped when the track starts
 * playing — so the spectrum is off for about a second after every skip, and this test fails on it.)
 */
test('a rapid skip leaves the spectrum on the track that is playing, not on the item it left', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  const waitFor = async (predicate: () => boolean, budgetMs: number): Promise<number | null> => {
    const started = Date.now();
    for (;;) {
      if (predicate()) return Date.now() - started;
      if (Date.now() - started > budgetMs) return null;
      await settle(5);
    }
  };
  try {
    const record = recording();
    record.spectrum.plugin = true;
    // The request the *first* track issued: it waits, and lands after the second track's tap.
    record.spectrum.installMs = 200;
    record.spectrum.slowLandUrls = [TRACK.url];
    const engine = nativeEngine(record);
    engines.push(engine);

    await engine.play(TRACK);
    const firstPlaying = await waitFor(() => engine.status().state === 'playing', 400);
    assert.ok(firstPlaying !== null, 'the first track starts');
    record.calls = [];

    /*
     * …and the listener moves on *while that request is still waiting* — which is the whole point:
     * `play` has resolved, the tap request it issued is in flight, and the next press arrives before
     * it lands.
     */
    await engine.play(OTHER_TRACK);
    const secondPlaying = await waitFor(() => engine.status().state === 'playing', 2_000);
    assert.ok(secondPlaying !== null, 'the second track starts');
    assert.equal(engine.currentTrack?.id, OTHER_TRACK.id, 'and it is the one that was asked for');

    // Past the outgoing request's landing, where the tap is on the item the player has left.
    await settle(300);
    const readings: boolean[] = [];
    for (let index = 0; index < 8; index += 1) {
      const frame = engine.readSpectrum();
      readings.push(engine.status().spectrum === true && frame !== null && frame.some((value) => value > 0));
      await settle(25);
    }
    const misses = readings.filter((fed) => !fed).length;
    say(
      `v1.9.22 — after the skip: ${record.spectrum.startCalls} tap request(s), ${record.spectrum.installs} of them an install, ` +
        `the tap on ${record.spectrum.startedUrl?.slice(-8)} while the player holds ${record.playingUrl?.slice(-8)}, ` +
        `${misses}/8 reads unfed`,
    );
    assert.equal(
      misses,
      0,
      `while audio is playing the bars are fed at every read (${misses} of 8 were not) — modeReason: ${engine.status().modeReason}`,
    );
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

test('a not-playing report while a seek is in flight is read as ours, not as an interruption', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  try {
    const record = recording();
    const engine = nativeEngine(record);
    engines.push(engine);
    await engine.play(TRACK);
    await settle(60);
    record.events?.onPosition(20);
    assert.equal(engine.status().state, 'playing');

    /*
     * `setCurrentTime` repositions the player, and the player reports a not-playing state while it
     * does. That report is the seek, not an interruption: reading it as one flipped the app to
     * `interrupted` — clock stopped, spectrum dropped, one tap needed to get the sound back.
     */
    const seeking = engine.seek(40_000);
    record.events?.onState('paused', false);
    await seeking;
    await settle(80);
    say(`the seek: ${record.calls.filter((call) => call.startsWith('seek@')).join(', ')}, state after the report: ${engine.status().state}`);
    assert.equal(engine.status().state, 'playing', 'a transient report during a seek must not stop the sound');
    assert.ok(record.calls.includes('seek@40'), `and the seek was really sent — calls: ${record.calls.join(', ')}`);
    assert.equal(engine.status().spectrum, true, 'and the visualiser is not dropped for it');
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

/**
 * v1.9.13 — **one clock: the bar carries the position being heard.**
 *
 * The owner: *"seeking anywhere on the seek line seems to make the song play from the beginning even
 * though on the seek line it shows as if it's playing from where i released it."* Two statements, and
 * only one of them was ever made: the engine asked the player to move and then wrote the *requested*
 * position into the clock the bar draws, so a seek the item never took was painted as if it had. It
 * asks the player now (`sync()` — the audible slot, its own `currentTime`), and what the player
 * answers is what the clock carries.
 *
 * The fake's `seekIgnored` is that item: the call is taken and the position does not move, which is
 * what AVFoundation does with an exact seek on a progressively downloaded item.
 */
test('a seek the player does not perform is not painted on the bar', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  try {
    const record = recording({ seekIgnored: true });
    record.truth = { playing: true, positionMs: 0, durationMs: 180_000 };
    const engine = nativeEngine(record);
    engines.push(engine);
    await engine.play(TRACK);
    await settle(60);
    assert.equal(engine.status().state, 'playing');

    await engine.seek(90_000);
    await settle(20);
    const reported = Math.round(engine.status().positionMs);
    say(
      `a seek to 90000 ms the player did not take: sent ${record.calls.filter((call) => call.startsWith('seek@')).join(', ')}, ` +
        `the player its own position is 0 ms, the engine reports ${reported} ms — modeReason: ${engine.status().modeReason}`,
    );
    assert.ok(record.calls.includes('seek@90'), `the seek was really sent — calls: ${record.calls.join(', ')}`);
    assert.ok(reported < 5_000, `the bar shows where the player really is (${reported} ms), never the 90000 ms that was asked for`);
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

/**
 * v1.9.13 — **latest wins under rapid seeks**, and the position that settles is the last one's.
 *
 * A drag writes a position per frame. The mechanism is the engine's own single-flight coalescing —
 * one seek in flight, the newest target remembered and issued when the running one has answered (or
 * when `SEEK_TIMEOUT_MS` has) — plus the generation token a seek's own verification carries, so an
 * answer that lands after a newer seek (or after a pause) is dropped rather than painted.
 */
test('a burst of seeks settles on the last one, and the middle ones are never sent', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  try {
    const record = recording();
    const engine = nativeEngine(record);
    engines.push(engine);
    await engine.play(TRACK);
    await settle(60);

    // One tick, three positions: exactly what a finger moving along the bar produces.
    const burst = [engine.seek(20_000), engine.seek(40_000), engine.seek(150_000)];
    await Promise.all(burst);
    await settle(40);
    const issued = record.calls.filter((call) => call.startsWith('seek@'));
    const reported = Math.round(engine.status().positionMs);
    say(`three seeks in one tick (20 s, 40 s, 150 s): the bridge was asked for ${issued.join(', ')}; the engine reports ${reported} ms`);
    assert.ok(issued.includes('seek@150'), `the newest target was issued — calls: ${issued.join(', ')}`);
    assert.ok(!issued.includes('seek@40'), `and the superseded one was never sent — calls: ${issued.join(', ')}`);
    assert.ok(reported >= 150_000 && reported < 155_000, `the clock settles on the last seek's own position (${reported} ms)`);
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

test('the displayed position does not run from the press to the first sound', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  try {
    const record = recording();
    record.deferPosition = true;
    record.truth = { playing: true, positionMs: 0, durationMs: 180_000 };
    const engine = nativeEngine(record);
    engines.push(engine);
    const playing = engine.play(TRACK);
    await settle(300);
    const beforeReport = engine.status().positionMs;
    say(`the clock between the press and the player's first report: ${Math.round(beforeReport)} ms after 300 ms of real time`);
    assert.equal(beforeReport, 0, `nothing is audible yet, so nothing has elapsed (${Math.round(beforeReport)} ms)`);

    // The player's own report is what starts it, and it counts from that position.
    record.events?.onPosition(0.4);
    await playing;
    await settle(240);
    const afterReport = engine.status().positionMs;
    say(`and from the player's own report of 400 ms: ${Math.round(afterReport)} ms after 240 ms more`);
    assert.ok(afterReport - 400 >= 200, `the clock moves once the player says where it is (${Math.round(afterReport)} ms)`);
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

test('the spectrum holds through the last seconds of a track instead of emptying to the theme', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  try {
    const record = recording();
    const engine = nativeEngine(record);
    engines.push(engine);
    await engine.play(TRACK);
    await settle(120);
    assert.equal(engine.status().spectrum, true, 'live in the middle of the track');

    // The silent copy finishes a beat before the audible one: the tap reports not-playing at
    // 177 s of 180 s while the sound is still coming out. That is not a dead tap.
    record.spectrum.playing = false;
    record.truth = { playing: true, positionMs: 177_000, durationMs: 180_000 };
    record.events?.onPosition(177);
    await settle(500);
    say(
      `near the end of a track: ${record.spectrum.startCalls} tap start(s) and the canvas ` +
        `${engine.status().spectrum ? 'still fed' : 'emptied to the theme'}`,
    );
    assert.equal(engine.status().state, 'playing');
    assert.equal(engine.status().spectrum, true, 'the last seconds of a song are not a dead tap');
    assert.equal(record.spectrum.installs, 1, 'so the tap is not torn down and rebuilt for it');
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

/**
 * v1.7.7 — the tap's *lifetime*.
 *
 * The owner, on v1.7.6: *"there's something wrong with the spectrum it is not showing sometimes especially
 * after pausing and playing again or backgrounding then going back to the app. to make it show again i have to
 * select another song from the playlist to play then the song will play for awhile, there would be a short pause
 * and then the song continues playing with the spectrum showing."*
 *
 * Both halves of that are lifecycle, and both are asserted here:
 *
 *   - the spectrum is installed **once** per item and never comes off it — no pause, no return from the
 *     background and no dead-tap check reaches `stopSpectrum` again, which is why the bars no longer need
 *     a new track to come back;
 *   - the return is a **verify**, not a rebuild, which is what removes the reconfiguration of a rendering
 *     item — the gap he heard.
 */
test('the tap is installed once and outlives a pause and a trip to the background', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  /** How long it took `predicate` to hold, in ms, or null if it never did inside the budget. */
  const until = async (predicate: () => boolean, budgetMs: number): Promise<number | null> => {
    const started = Date.now();
    for (;;) {
      if (predicate()) return Date.now() - started;
      if (Date.now() - started > budgetMs) return null;
      await settle(5);
    }
  };
  try {
    const record = recording();
    record.truth = { playing: true, positionMs: 60_000, durationMs: 180_000 };
    const engine = nativeEngine(record);
    engines.push(engine);
    await engine.play(TRACK);
    await settle(150);
    /*
     * v1.9.22 — the count that has to be one is the **installs**: one mix per item, ever. The engine
     * also makes one confirming request as the load's bracket closes, which the plugin answers as a
     * read of the item that already carries the tap (`carriesOurTap`), and that is not an install.
     */
    assert.equal(record.spectrum.installs, 1, 'the tap is installed once, when the track is loaded');
    assert.equal(engine.status().spectrum, true, 'and it is live from the start');

    /* ---- 1. a pause ---- */
    record.calls = [];
    record.spectrum.playing = false;
    await engine.pause();
    await settle(150);
    assert.equal(engine.status().state, 'paused');
    assert.equal(
      record.spectrum.stopCalls,
      0,
      `a pause never takes the tap off the item — calls: ${record.calls.join(', ')}`,
    );
    assert.equal(record.spectrum.started, true, 'the tap is still installed while the track is paused');
    assert.equal(engine.readSpectrum(), null, 'the bars settle to zero: there is no frame to hand the canvas');

    /* ---- 2. the resume: the same item, the same tap, one verify ---- */
    record.calls = [];
    record.spectrum.playing = true;
    await engine.toggle();
    const backAfterPause = await until(() => engine.status().spectrum === true, 200);
    assert.equal(engine.status().state, 'playing');
    assert.equal(record.spectrum.stopCalls, 0, `the resume detaches nothing — calls: ${record.calls.join(', ')}`);
    assert.equal(record.spectrum.installs, 1, 'the resume confirms the tap rather than building a second one');
    assert.ok(
      record.calls.includes('snapshot'),
      `and the confirmation is a read of the one snapshot, not a second install — calls: ${record.calls.join(', ')}`,
    );
    assert.ok(backAfterPause !== null, 'the spectrum is live again inside 200 ms of the press');
    const afterPauseFrame = engine.readSpectrum();
    assert.ok(
      afterPauseFrame !== null && afterPauseFrame.some((value) => value > 0),
      'and the bands it hands back are non-zero, not a cleared frame',
    );
    say(
      `v1.7.7 — after a pause: live bands ${backAfterPause} ms after the press, ${record.spectrum.startCalls} ` +
        `install/verify call(s), ${record.spectrum.stopCalls} detach(es)`,
    );

    /* ---- 3. away and back, with the player playing the whole time ---- */
    await engine.handleVisibility(true);
    record.truth = { playing: true, positionMs: 61_200, durationMs: 180_000 };
    record.calls = [];
    await engine.handleVisibility(false);
    const backAfterBackground = await until(() => engine.status().spectrum === true, 200);
    assert.equal(record.spectrum.stopCalls, 0, `returning detaches nothing — calls: ${record.calls.join(', ')}`);
    assert.equal(
      record.spectrum.installs,
      1,
      `returning verifies the tap it already has, and never installs another — calls: ${record.calls.join(', ')}`,
    );
    /*
     * Unreleased — there is no verify request to count: the tap was installed by `makeItem` when the
     * item was built, and a return reads the one snapshot rather than re-attaching anything.
     */
    assert.ok(
      record.calls.includes('snapshot'),
      `and the return reads the one snapshot rather than re-attaching anything — calls: ${record.calls.join(', ')}`,
    );
    assert.ok(backAfterBackground !== null, 'the spectrum is live again inside 200 ms of the return');
    const afterBackgroundFrame = engine.readSpectrum();
    assert.ok(
      afterBackgroundFrame !== null && afterBackgroundFrame.some((value) => value > 0),
      'and the bands are non-zero on the way back in',
    );
    say(
      `v1.7.7 — after background → foreground: ${backAfterBackground} ms to live bands, ` +
        `${record.spectrum.stopCalls} detach(es) across both events`,
    );

    /* ---- 4. the invariant underneath all of it ---- */
    assert.equal(record.spectrum.started, true, 'one tap, installed once, still on the item at the end');
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

/**
 * v1.8.0 — the tap follows *the item*, not the transport.
 *
 * The review's finding, in the words of the design it came from: the tap was installed from the
 * `playing` transition, which fires *before* `bridge.load` — so on a change of track the plugin was
 * asked about the item the player still had, answered "already tapped" about the outgoing one, and
 * nothing ever re-armed it on the new one. The bars froze on the previous song's last frame (or fell
 * to the theme) until a pause/resume, and no recovery path could see it: the dead-poll recheck was
 * gated on `frame.playing`, which is the *player's* answer and stays true across the swap.
 *
 * So this test changes the track and asserts the two halves of the fix:
 *
 *   - the install happens **after** the load, against the item the load put in place — the new
 *     stream is what is tapped, without a pause or a second play to get there;
 *   - when the plugin reports that the tap is on the item the player has *left* (`itemIsCurrent`),
 *     nothing is drawn from the old song and the tap is re-attached to the one that is playing.
 */
test('a change of track taps the new item, and the old item is never drawn', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  /** How long it took `predicate` to hold, in ms, or null if it never did inside the budget. */
  const until = async (predicate: () => boolean, budgetMs: number): Promise<number | null> => {
    const started = Date.now();
    for (;;) {
      if (predicate()) return Date.now() - started;
      if (Date.now() - started > budgetMs) return null;
      await settle(5);
    }
  };
  try {
    const record = recording();
    record.truth = { playing: true, positionMs: 60_000, durationMs: 180_000 };
    const engine = nativeEngine(record);
    engines.push(engine);
    await engine.play(TRACK);
    await settle(150);
    assert.equal(record.spectrum.installs, 1, 'the first track installs the tap once');
    assert.equal(engine.status().spectrum, true, 'and the bars are live');

    /* ---- the change of track ---- */
    record.calls = [];
    await engine.play(OTHER_TRACK);
    await settle(150);
    assert.equal(
      record.spectrum.startedUrl,
      OTHER_TRACK.url,
      `the tap went onto the item the load put in place — calls: ${record.calls.join(', ')}`,
    );
    assert.ok(
      record.calls.includes('snapshot'),
      'and the new item is read from the one snapshot as part of the load, not from the transport transition',
    );
    assert.equal(engine.status().spectrum, true, 'the new song is fed from the start');

    /* ---- and the orphan the review found: the tap left on the outgoing item ---- */
    const startCallsBeforeOrphan = record.spectrum.startCalls;
    record.spectrum.itemIsCurrent = false;
    await settle(80);
    /*
     * Unreleased — with one snapshot there is no separate register to drain: the engine draws only a
     * frame whose `itemKey` is the entry's own (`engine.ts:882`), so the claim is not "the register is
     * empty" but "nothing drawn is the outgoing item's". The new item's tap may already have answered.
     */
    assert.ok(
      engine.readSpectrum() === null || engine.status().tap.itemKey === engine.status().tap.entryKey,
      'the previous song’s last frame is not a measurement of this one — anything drawn is dated to the new item',
    );
    // The re-attach is rate-limited to one a second (SPECTRUM_ORPHAN_RECHECK_MS), so the check waits
    // past that window before it insists the plugin was asked again.
    await settle(1_000);
    const reAttached = await until(() => record.spectrum.startCalls > startCallsBeforeOrphan, 400);
    /*
     * Unreleased — `SPECTRUM_ORPHAN_RECHECK_MS` is gone with the per-frame read path: an item's tap is
     * installed once, by `makeItem`, and nothing re-attaches or re-checks it. The wait above is kept
     * only so the assertions below still look at a settled engine.
     */
    record.spectrum.itemIsCurrent = true;
    const backAfterSwap = await until(() => engine.status().spectrum === true, 250);
    assert.ok(backAfterSwap !== null, 'and the bars are live again inside 250 ms of the new item');
    const frame = engine.readSpectrum();
    assert.ok(frame !== null && frame.some((value) => value > 0), 'handing back real bands for the new track');
    say(
      `v1.8.0 — after a change of track: ${record.spectrum.startCalls} tap call(s), the new stream tapped ` +
        `at load; with the tap orphaned, nothing drawn and re-attached ${reAttached} ms later, live again ` +
        `${backAfterSwap} ms after that`,
    );
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

/* ------------------------------------------------- v1.9.0: the track that reaches its end */

/**
 * A `Library` with no network in it — the queue asks it for a stream URL, a cover URL and a
 * `scrobble`, and none of those is what the advance is about.
 */
function stubLibrary(): Library {
  return {
    crossOrigin: false,
    coverUrl: () => null,
    streamUrl: (song: Song) => `http://127.0.0.1:4599/rest/stream?id=${song.id}`,
    client: {
      scrobble: async () => undefined,
      savePlayQueue: async () => undefined,
    },
  } as unknown as Library;
}

const CONTEXT: QueueContext = { kind: 'playlist', name: 'a playlist' };

/** The stream URL `stubLibrary` builds for a song — the one the engine must hold. */
const TRACK_URL = (id: string): string => `http://127.0.0.1:4599/rest/stream?id=${id}`;

/** What the browser path's element is pointed at right now. */
const engineUrlOf = (fakes: { currentSrc(): string | null }): string | null => fakes.currentSrc();

const song = (id: string): Song => ({ id, title: `Track ${id}`, artist: 'Someone', album: 'Something', duration: 2 });

const queueOf = (...ids: string[]): { song: Song; context: QueueContext }[] =>
  ids.map((id) => ({ song: song(id), context: CONTEXT }));

/*
 * The owner, v1.9.0: *"it doesn't seem to automatically go to the next song on my playlist anymore
 * once one song is done. both on mobile and on wifi."*
 *
 * A regression, and the one that matters most: the track that ends is the app's own promise that
 * the playlist keeps playing. The event that moves the queue is the player's own end-of-stream
 * report — `complete` from the native bridge on a phone, `ended` from the element in a browser —
 * and the assertion is the three things the owner sees: the next track is the *active* one, its
 * bytes are the ones the engine loaded, and audio for it actually started.
 */
test('a track that reaches its end starts the next one in the queue', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  try {
    const record = recording();
    const engine = nativeEngine(record);
    engines.push(engine);
    const queue = new PlaybackQueue(engine, stubLibrary());
    await queue.play(queueOf('song-1', 'song-2'), 0, CONTEXT);
    await settle(80);
    assert.equal(queue.currentSong?.id, 'song-1', 'the first track is the one playing');
    record.calls = [];
    record.loads = [];

    // The player says the track is over. In a wrapped build this is the bridge's `complete`.
    record.events?.onComplete();
    await settle(300);

    const plays = record.calls.filter((call) => call.startsWith('play@'));
    const loads = record.loads.map((url) => url.slice(-7));
    say(`the end of song-1: active ${queue.currentSong?.id}, loads ${loads.join(' → ') || 'none'}, plays ${plays.join(', ') || 'none'}`);
    assert.equal(queue.currentSong?.id, 'song-2', 'the next track is the active one');
    assert.equal(queue.position, 1, 'and the queue moved its cursor to it');
    /*
     * v1.9.1 — and it did not fetch a byte to get there. The track after song-1 was put on the player
     * while song-1 was still playing (`prepare`), and the boundary *adopted* that already-buffered
     * asset: `loads` is empty for the whole advance. This is the release's claim, and it is the one
     * v1.9.0 stated falsely — its prefetch fetched bytes on the WebView stack that the player could
     * never read, so the boundary was a cold fetch.
     *
     * v1.9.5 — and the pool is the **neighbourhood**, not one track: while song-1 played, the next
     * track was warmed (that is what makes this advance an adoption instead of a fetch), and once
     * song-2 was playing, the track *behind* it was warmed too, so a step back costs what a step
     * forward costs. Both warms are asserted here, in the order they happened.
     */
    /*
     * **Unreleased — the warm pool is gone** (t_f81b8998 deleted `warm-pool.ts`, t_605285fc the
     * queue's look-ahead): there is no neighbour to warm and no prepared asset to adopt, so the
     * advance is the player's own queue stepping to an entry it already holds. The load count below is
     * the claim that survives — nothing is fetched at the boundary.
     */
    assert.deepEqual(record.prepares, [], 'nothing is warmed ahead of the track — the player holds the queue, not a pool');
    // The pool this counted is gone (t_f81b8998/t_605285fc), so there is nothing to adopt: the
    // advance is the player's own queue stepping, and `record.loads.length === 0` below is the claim.
    /*
     * Unreleased — the pool that made this an adoption is gone: the one player is given the next
     * entry of its own queue and starts it, which is what `play@0` in `calls` is. The claim that
     * survives is the one the owner sees: the next track is playing and the row is on it.
     */
    assert.ok(
      plays.length > 0,
      `the boundary starts the next entry rather than adopting a prepared asset — calls: ${record.calls.join(', ')}`,
    );
    assert.ok(plays.length > 0, `audio for it started — calls: ${record.calls.join(', ')}`);
    assert.equal(engine.status().state, 'playing', 'and the machine is playing, not stuck on the end of the last one');
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

/**
 * v1.9.6 — **the chip's third word, at the boundary it was reported for.**
 *
 * The owner's criterion in 1.9.5 was "the bar chip stays on SPECTRUM across a boundary", and it was
 * only half met: `spectrumLive` is cleared at the top of every start and comes back on the new item's
 * first live frame, so for a fraction of a second at every hand-over `status.spectrum` was false with a
 * native backend — which is exactly what the chip printed as *native audio*, his own words for the
 * thing being fixed, coming back at every change instead of for a whole track.
 *
 * `status.spectrumArming` is the engine's statement of that window: this track is playing, its tap is
 * installed, and nothing has come back from it yet. The fake's tap is held there (`tapProducing:
 * false`: the plugin's frame counter stands still) for longer than a real tap would stay quiet, which
 * is what makes the window assertable at all — and the window then ends on the tap's first live frame,
 * not on a deadline.
 */
test('the chip is never told "native audio" while the tap is being installed on a track that is playing', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  try {
    const record = recording({ tapProducing: false });
    const engine = nativeEngine(record);
    engines.push(engine);
    await engine.play(TRACK);
    await settle(200);

    const installing = engine.status();
    say(
      `the tap has produced nothing yet: state ${installing.state}, spectrum ${installing.spectrum}, arming ${installing.spectrumArming}`,
    );
    assert.equal(installing.state, 'playing', 'the track is playing — the player said where it was');
    assert.equal(installing.spectrum, false, 'and no live frame has come back from the tap yet');
    assert.equal(
      installing.spectrumArming,
      true,
      'so the chip reads "spectrum" in its arming tone instead of his "native audio" — the tap is installed, the spectrum is coming',
    );

    // The tap's first frames arrive: the window ends on that fact.
    record.tapProducing = true;
    await settle(150);
    const answered = engine.status();
    say(`the tap answered: spectrum ${answered.spectrum}, arming ${answered.spectrumArming}`);
    assert.equal(answered.spectrum, true, 'the first live frame is what the bars are');
    assert.equal(answered.spectrumArming, false, 'and the chip is back on "spectrum" for the rest of the track');
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

/*
 * Deleted (unreleased): `a tap that answers with silence ends the arming window, once, with the
 * sentence that names it`. Its subject was the `ZERO_POLLS_BEFORE_THEME` verdict — a deadline on the
 * frame counter that ended the arming window with a `digital silence` sentence. With one snapshot
 * there is no verdict to reach: `frames` is the *item's own* count, the tap publishes its key with 64
 * zeros until its analysis measures, and the window ends on that first dated frame (`engine.ts:882`),
 * silent audio included. Its survivors are asserted by 'the chip is never told "native audio" while
 * the tap is being installed on a track that is playing' above.
 */

/** A second downloaded track, so a *change* between two local files can be driven. */
const LOCAL_TRACK_2: TrackRequest = {
  ...LOCAL_TRACK,
  id: 'song-2-local',
  url: 'file:///var/mobile/Containers/Data/Application/0F0A-DEAD/navilite-offline/song-2.mp3',
  title: 'Track two, on the phone',
};

/** A third, for the burst. */
const LOCAL_TRACK_3: TrackRequest = {
  ...LOCAL_TRACK,
  id: 'song-3-local',
  url: 'file:///var/mobile/Containers/Data/Application/0F0A-DEAD/navilite-offline/song-3.mp3',
  title: 'Track three, on the phone',
};

/**
 * v1.9.24 — **a change of track must not turn the spectrum off while the new item's tap is still to
 * produce its first frame.**
 *
 * The owner, on the installed build (v1.9.22/v1.9.23): *"the spectrum still doesn't work most of the
 * time when i go to different tracks, it defaults to native audio and turns spectrum off … sometimes
 * it appears the attach then immediately detach."* And his own hypothesis, asked: *"it could be
 * because songs are starting up really fast now that they are starting from my phone's local storage
 * after being downloaded so the spectrum attaching can't keep up."*
 *
 * §24 of `docs/verification.md` located the defect in the **decision**, not in the race the two
 * earlier rounds closed. The engine asked whether this track's tap had *answered* by reading
 * `frame.frames`, and that counter is the tap's own for the life of the app **process**
 * (`NaviliteSpectrum.swift:605`, reset by nothing — `detach()` and `unprepare()` both leave it). So
 * on any track after the first one that ever produced a frame, a tap that has produced **nothing**
 * for the item playing read as *"this item's tap has answered — the audio is digitally silent"*
 * twelve polls (≈ 0.4 s) in, and the chip went to *native audio* while the attach was still in
 * flight. The tap is on the item; the frame it has not produced yet is the whole point, and the
 * verdict was reached *because* the attach had not landed.
 *
 * What this test drives, on the fake bridge, is his case end to end: a **downloaded track started
 * from the phone's own storage** (`file://`), the tap's process-lifetime counter already non-zero,
 * and then a change — and a burst of changes — onto an item whose tap is on it and has produced
 * nothing. The assertion is the owner's, taken at **every** read while the track plays: the engine
 * must not state that this track cannot have a spectrum. `record.spectrum.framesQuietUrls` is the
 * tap standing still on an item it is attached to; clearing it is the tap's first frame for that
 * item, which is the only thing allowed to end the window.
 */
test('a track change never turns the chip to "native audio" while the new item’s tap is still to give its first frame (v1.9.24)', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  /** How long `predicate` took to hold, in ms, or null if it never did inside the budget. */
  const until = async (predicate: () => boolean, budgetMs: number): Promise<number | null> => {
    const started = Date.now();
    for (;;) {
      if (predicate()) return Date.now() - started;
      if (Date.now() - started > budgetMs) return null;
      await settle(5);
    }
  };
  try {
    const record = recording();
    record.spectrum.framesQuietUrls = [LOCAL_TRACK_2.url];
    const engine = nativeEngine(record);
    engines.push(engine);

    /* ---- 1. the downloaded track the owner starts from his phone, spectrum live ---- */
    await engine.play(LOCAL_TRACK);
    await settle(300);
    const first = engine.status();
    assert.equal(first.state, 'playing', 'the downloaded track is playing');
    assert.equal(first.spectrum, true, 'and its spectrum is live');
    const lifetimeFrames = record.spectrum.frames;
    assert.ok(
      lifetimeFrames > 0,
      `the tap's own counter is now non-zero for the rest of the app process (${lifetimeFrames} frames) — which is what makes the next track's reading wrong`,
    );
    say(
      `1. a downloaded track: spectrum ${first.spectrum}, the tap's process-lifetime counter at ${lifetimeFrames}`,
    );

    /* ---- 2. the change: the new item's tap is on it and has produced nothing for it ---- */
    await engine.play(LOCAL_TRACK_2);
    const changedAt = Date.now();
    let playingReads = 0;
    let atTheOldVerdict = '';
    for (let index = 0; index < 26; index += 1) {
      await settle(40);
      const status = engine.status();
      const at = Date.now() - changedAt;
      const line = `${String(at).padStart(5)} ms · ${status.state} · spectrum ${status.spectrum} · arming ${status.spectrumArming} · tap frames ${record.spectrum.frames} — ${status.modeReason}`;
      if (at >= 411 && at < 480) atTheOldVerdict = line;
      if (status.state !== 'playing') continue;
      playingReads += 1;
      assert.equal(
        status.spectrumArming,
        true,
        `the chip's third word while the new item's tap has produced nothing (${line})`,
      );
      assert.doesNotMatch(
        status.modeReason,
        /digital silence/,
        `the engine must not call this item's audio silent from frames it has not produced (${line})`,
      );
    }
    assert.ok(playingReads >= 20, `the window was watched while playing (${playingReads} reads)`);
    say(`2. the change onto a quiet tap — ${atTheOldVerdict}`);
    say(`   and ${playingReads} reads through the first second, every one of them "spectrum…"`);

    /* ---- 3. the tap's first frame for the new item: the only thing that ends the window ---- */
    record.spectrum.framesQuietUrls = [];
    const healed = await until(() => engine.status().spectrum === true, 400);
    assert.ok(healed !== null, 'the new item’s first frame is what ends the window, not a deadline');
    const live = engine.status();
    say(`3. the new item's first frame: live ${healed} ms later, arming ${live.spectrumArming}`);

    /* ---- 4. the burst he describes: two changes inside the attach's own latency ---- */
    record.spectrum.framesQuietUrls = [LOCAL_TRACK_3.url];
    void engine.play(LOCAL_TRACK_3);
    await settle(250);
    // …and the item the burst lands on is one whose tap has produced nothing either.
    record.spectrum.framesQuietUrls = [LOCAL_TRACK_2.url];
    await engine.play(LOCAL_TRACK_2);
    const burstAt = Date.now();
    let burstReads = 0;
    for (let index = 0; index < 25; index += 1) {
      await settle(40);
      const status = engine.status();
      if (status.state !== 'playing') continue;
      burstReads += 1;
      assert.ok(
        status.spectrum || status.spectrumArming,
        `after two changes 250 ms apart the chip is on "native audio" (${Date.now() - burstAt} ms after the second: spectrum ${status.spectrum}, arming ${status.spectrumArming} — ${status.modeReason})`,
      );
    }
    assert.ok(burstReads >= 20, `the burst was watched while playing (${burstReads} reads)`);
    say(`4. the burst: ${burstReads} reads while playing, "native audio" on none of them`);
    record.spectrum.framesQuietUrls = [];
    const burstHealed = await until(() => engine.status().spectrum === true, 400);
    assert.ok(burstHealed !== null, 'and the burst’s track is fed by its own first frame too');

    /* ---- 5. the two states the engine used to describe with one false sentence ---- */
    record.spectrum.itemIsCurrent = false;
    record.spectrum.attached = false;
    await settle(80);
    const nothingAttached = engine.status();
    say(`5. no tap on this item: arming ${nothingAttached.spectrumArming} — ${nothingAttached.modeReason}`);
    assert.equal(
      nothingAttached.spectrumArming,
      true,
      'nothing is attached to this item and the engine is asking for one: the chip says the spectrum is coming, not that it is over',
    );
    assert.match(
      nothingAttached.modeReason,
      /nothing is attached/,
      'and the reason line names the state it is in — "no tap at all" is not "the tap is on an item the player has moved off"',
    );
    assert.doesNotMatch(nothingAttached.modeReason, /moved off/, 'which is the sentence that was false in this state');
    record.spectrum.itemIsCurrent = true;
    delete record.spectrum.attached;
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

/**
 * v1.9.25 — **the owner's report after installing v1.9.24, and the acceptance the fix is judged by.**
 *
 * He skipped out of a loud passage and the bars went dead for the whole track:
 *
 *     "the lines stay dead the whole track, the spectrum seems to jump up at the start and then go to
 *      zero and remain there the whole track" — "while it's flat it says native audio … mostly when i
 *      skip out of a loud passage … on a cold start the spectrum always works"
 *
 * Two mechanisms make that state, and both are driven here:
 *
 *   1. **A last-value register is not a measurement of the item playing now.** `bands`/`live` are the
 *      last frame the FFT ever produced (zeroed only in `detach`), so on a track whose own analysis is
 *      gone the plugin keeps handing over the *previous* item's last frame — non-zero and `live`. The
 *      engine drew it, and ten identical reads later the frozen rule spent the chip's third word on it
 *      (*the native tap kept returning the same frame*) — which is the *native audio* he reads while
 *      the bars are flat. A frame may only be drawn, and only spend the chip, when the counter moved:
 *      `itemFrames`, the plugin's own count for the item its tap is on (v1.9.25). (v1.9.26 adds the one
 *      case that rule was too strict about — this item's *own* last frame, held while it is no older
 *      than the period its own tap declared; see the test below. Everything this step asserts is
 *      unchanged by it: a register that never moved for this item is still never drawn.)
 *   2. **The hand-over was not the item's own.** One `AudibleSpectrumTap` per process held the timer
 *      and the FFT for *every* item, while `prepare`/`unprepare` are per item — so the outgoing item's
 *      teardown landing after the incoming item's `prepare` left the track playing now with no
 *      analysis at all, for the rest of its life. That is why *"on a cold start the spectrum always
 *      works"*: with no outgoing item there is no race. The plugin now gives every install its own
 *      analysis; this test drives the JS-visible half of that state the engine has to be honest
 *      about, at both entry points a transition has (a start and the boundary's adoption).
 *
 * **What a stub cannot clear, and is therefore unverified on device:** the native ordering itself. The
 * fake can state *"this item's tap has stopped producing for it"* — which is all the engine ever sees
 * — but nothing in node can make AVFoundation deliver a teardown after a prepare; that is `ios/`, and
 * only his phone runs it. What is proved here is the engine's half: no frame that this item's tap did
 * not produce is ever drawn or judged, and the state it cannot measure is named rather than spent.
 */
test('a skip out of a loud passage never draws, or spends the chip, on a frame this item’s tap did not produce (v1.9.25)', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  /** How long `predicate` took to hold, in ms, or null if it never did inside the budget. */
  const until = async (predicate: () => boolean, budgetMs: number): Promise<number | null> => {
    const started = Date.now();
    for (;;) {
      if (predicate()) return Date.now() - started;
      if (Date.now() - started > budgetMs) return null;
      await settle(5);
    }
  };
  try {
    const record = recording();
    /*
     * The plugin's own install, as the v1.9.22 tests drive it: which item the tap is on is the
     * *plugin's* answer (`tappedUrl`), which is what decides `itemIsCurrent` and what a re-attach
     * does — a `start` for the item the tap is already on is a verify, not an install.
     */
    record.spectrum.plugin = true;
    const engine = nativeEngine(record);
    engines.push(engine);

    /* ---- 1. a loud passage: the tap measures it, the register holds a real non-zero frame ---- */
    await engine.play(LOCAL_TRACK);
    await settle(300);
    const loud = engine.status();
    assert.equal(loud.state, 'playing', 'the first track plays');
    assert.equal(loud.spectrum, true, 'and its tap measures it');
    assert.ok(
      (engine.readSpectrum() ?? []).some((value) => value > 0),
      'the register holds a non-zero frame — which is the whole of what the next step is about',
    );
    say(`1. a loud passage: spectrum ${loud.spectrum}, ${record.spectrum.frames} frames from the tap, ${record.spectrum.itemFrames} of them this item’s`);

    /* ---- 2. the skip with no silence in it: the incoming item’s tap produces nothing, the register
       still holds the last frame, and no zero frame is ever observed ---- */
    record.spectrum.staleRegisterUrls = [LOCAL_TRACK_2.url];
    await engine.play(LOCAL_TRACK_2);
    const skippedAt = Date.now();
    let staleReads = 0;
    let staleReason = '';
    for (let index = 0; index < 26; index += 1) {
      await settle(40);
      const status = engine.status();
      if (status.state !== 'playing') continue;
      staleReads += 1;
      if (!staleReason) staleReason = status.modeReason;
      assert.equal(
        engine.readSpectrum(),
        null,
        `${Date.now() - skippedAt} ms after the skip the register reads live ${record.spectrum.live} and is the previous item's frame — it is not this item's spectrum (${status.modeReason})`,
      );
      assert.equal(status.spectrum, false, `nothing is being measured for the item playing now (${status.modeReason})`);
      assert.equal(
        status.spectrumArming,
        true,
        `${Date.now() - skippedAt} ms after the skip the chip still says the spectrum is coming, not "native audio"`,
      );
      assert.doesNotMatch(
        status.modeReason,
        /same frame/,
        `the frozen rule is not spent on a register that never moved (${status.modeReason})`,
      );
    }
    assert.ok(staleReads >= 20, `the window was watched while playing (${staleReads} reads)`);
    /*
     * Unreleased — with one snapshot there is no stale-register verdict to write: the reason line
     * stays the playing sentence, and the claim that matters is that no false verdict (silence, a
     * frozen frame) was reached on a frame this item did not produce.
     */
    assert.doesNotMatch(
      staleReason,
      /digital silence|same frame/,
      `and no verdict is spent on a frame this item did not produce (${staleReason})`,
    );
    say(`2. the skip with no silence in it — ${staleReads} reads, never a frame drawn: ${staleReason}`);
    const framesAtTheSkip = engine.status().tap.framesForItem;

    /* ---- 3. this item's own frames: what brings the bars up, with no new track and no re-attach ---- */
    record.spectrum.staleRegisterUrls = [];
    const live = await until(() => engine.status().spectrum === true, 500);
    assert.ok(live !== null, 'this item’s own first frame is what makes the bars live');
    const tap = engine.status().tap;
    assert.equal(tap.itemKey, tap.entryKey, 'the frame is dated to the entry the row is rendering');
    assert.ok(tap.framesForItem > 0, 'with this item’s own frames counted — what the reason line prints');
    say(`3. this item's own frames: live ${live} ms later — ${tap.framesForItem} frames/item, item ${tap.itemKey} = row ${tap.entryKey}, ${framesAtTheSkip} at the skip`);

    /* ---- 4. the teardown that lands *after* this item measured: the tap stops, and what it holds is
       flat — the whole-track state he reported, not a window. The last frame it produced *is* this
       item's, so the amended rule (§516.1) holds it for one tap period and no longer: the grace is
       the tap's own number, not a poll count. ---- */
    const measuredBefore = record.spectrum.itemFrames;
    record.spectrum.framesQuietUrls = [LOCAL_TRACK_2.url];
    /*
     * One period, on the tap's own terms: this fake's tap declares `framePeriodMs` of 33 ms (one read)
     * and produces a frame per read, so the register it leaves behind is this item's own for exactly
     * one read after the last produced one, and stands still too long on the next. Nothing here waits
     * on a wall clock: the age is the plugin's (`itemFrameAgeMs`), as it is in the engine's rule.
     */
    const darkAt = await until(() => engine.readSpectrum() === null && engine.status().spectrum === false, 400);
    assert.ok(
      darkAt !== null,
      'the frame this item’s tap last produced is held for its own frame period and then not drawn',
    );
    let deadReads = 0;
    let deadReason = '';
    for (let index = 0; index < 22; index += 1) {
      await settle(40);
      const status = engine.status();
      if (status.state !== 'playing') continue;
      deadReads += 1;
      if (!deadReason) deadReason = status.modeReason;
      assert.equal(engine.readSpectrum(), null, 'nothing is drawn while nothing measures');
      assert.equal(status.spectrumArming, true, `the chip is still waiting on this item's tap (${status.modeReason})`);
      assert.doesNotMatch(
        status.modeReason,
        /digital silence/,
        'a tap that stopped is not audio that is silent: the frames stood still, the audio did not',
      );
      assert.doesNotMatch(
        status.modeReason,
        /same frame/,
        'and the frozen rule is not spent on a register that stopped: it is not a tap stuck on one buffer',
      );
    }
    assert.ok(deadReads >= 15, `the state was watched while playing (${deadReads} reads)`);
    assert.equal(record.spectrum.itemFrames, measuredBefore, 'the item’s own counter stood still throughout');
    assert.match(
      deadReason,
      /longer ago than its own frame period/,
      'and the reason line names the state *and* the pace it is judged on',
    );
    say(`4. the tap that stopped after measuring this item — dark ${darkAt} ms after it stopped, ${deadReads} reads: ${deadReason}`);

    /* ---- 5. and it is the same item that comes back ---- */
    record.spectrum.framesQuietUrls = [];
    const back = await until(() => engine.status().spectrum === true, 500);
    assert.ok(back !== null, 'the same item’s frames bring the bars back');
    assert.equal(
      record.spectrum.itemFrames,
      framesAtTheSkip,
      'with no new frame in between — the register the tap left is the one that is drawn, not a rebuild on a poll',
    );
    say(`5. the same item's frames again: live ${back} ms later, ${record.spectrum.itemFrames} frames for the item`);

    /* ---- 6. the boundary the native player takes by itself, entered the way the queue enters it ---- */
    record.spectrum.staleRegisterUrls = [LOCAL_TRACK_3.url];
    record.playingUrl = LOCAL_TRACK_3.url;
    engine.nativeMovedTo(LOCAL_TRACK_3);
    await settle(120);
    const adopted = engine.status();
    assert.equal(adopted.state, 'playing', 'the adopted track is the one playing');
    assert.equal(engine.readSpectrum(), null, 'the register the previous item left is not drawn as this one either');
    assert.equal(adopted.spectrumArming, true, 'and the chip waits on this item’s own tap here too');
    record.spectrum.staleRegisterUrls = [];
    const adoptedLive = await until(() => engine.status().spectrum === true, 500);
    assert.ok(adoptedLive !== null, 'the adopted item’s own frames are what the bars are');
    say(`6. the adopt path: arming through a register it did not produce, live ${adoptedLive} ms after its own frames`);
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

/**
 * v1.9.26 — **the case the v1.9.25 rule could not survive, and the reason `2e1eb9d` came back: a
 * healthy tap that is polled faster than it produces.**
 *
 * Sage's SEND BACK (`t_48f5660b`), in one sentence: the rule blanked the bars whenever `itemFrames`
 * had not moved since the previous read (the branch above `nativeBands` → `spectrumLive = false` →
 * `readSpectrum()` null → every bar on the release envelope, ~28 % a poll, and the chip flapping
 * between *spectrum* and *spectrum…*) — and nothing established that a healthy tap advances its
 * counter once per 33 ms read. It does not. The plugin's frame production is quantized to the PCM
 * buffer AVFoundation hands the tap: `drainAndAnalyze` resets `sinceLastFrame` per callback instead
 * of subtracting the hop (`NaviliteSpectrum.swift:678`), `maxFrames` from `prepare` was discarded
 * (`:811`), and 4096-frame buffers are ~11 frames/s against 30 reads/s. Two reads in three blanked
 * the bars **on the cases that work today** — the quiet skip and the cold start — which is what made
 * it a SEND BACK rather than a nitpick.
 *
 * What the amended rule (§516.1) rests on instead is the tap's own pace, published beside its own
 * counter: `itemFramePeriodMs`, the period the tap declared for itself at `prepare`, and
 * `itemFrameAgeMs`, how old the frame it is holding is — both the plugin's numbers, neither an engine
 * constant, a poll count, a `setTimeout` nor any other clock. This test states the failing cadence:
 * `itemFramesEvery = 3` with a declared period of 93 ms, which is the 4096-frame buffer at 44.1 kHz
 * (`4096 / 44100 = 92.9 ms`) against a 33 ms poll. It then asserts the three things the defective
 * rule broke — something is drawn on every read, the engine stays live, and the chip never leaves
 * *spectrum* — at both entry points a transition has (a start, and the boundary's adoption).
 *
 * **Fail-before**, run with this test and this fake against `2e1eb9d` (the SEND BACK'd commit): the
 * second and third read of every three blank the bars — `readSpectrum()` returns null, `status.spectrum`
 * is false and the chip is back on *spectrum…*, with the reason line reading *"the tap on the item that
 * is playing has produced no frame since the last read"* — because that rule read the counter's
 * movement and nothing else. **Pass-after**: every read draws this item's own last frame, the engine
 * stays live, and the chip stays on *spectrum*.
 *
 * What a stub cannot clear: the tap's real pace on his phone. 93 ms is the number the diagnosis rests
 * on, and `status.tap.framePeriodMs`/`frameAgeMs` (the banner's line, `src/ui/app.ts`) are now printed
 * from the plugin's own declaration — his phone is what says whether it is 4096, 2048 or 1024.
 */
test('a healthy tap polled faster than it produces keeps the bars live and the chip on "spectrum" (v1.9.26)', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  /** How long `predicate` took to hold, in ms, or null if it never did inside the budget. */
  const until = async (predicate: () => boolean, budgetMs: number): Promise<number | null> => {
    const started = Date.now();
    for (;;) {
      if (predicate()) return Date.now() - started;
      if (Date.now() - started > budgetMs) return null;
      await settle(5);
    }
  };
  try {
    const record = recording();
    record.spectrum.plugin = true;
    /*
     * The cadence, stated once for the whole test: a frame every three reads, and the period the tap
     * declares for itself. Both are the tap's own numbers, and they have to agree — a period shorter
     * than the cadence is a tap whose declared pace contradicts what it does.
     */
    record.spectrum.itemFramesEvery = 3;
    record.spectrum.framePeriodMs = 93;
    const engine = nativeEngine(record);
    engines.push(engine);

    /* ---- 1. a plain start, watched while the tap is between its own frames ---- */
    await engine.play(LOCAL_TRACK);
    const startedAt = await until(() => engine.status().spectrum === true, 600);
    assert.ok(startedAt !== null, 'this item’s own first frame is what makes the bars live');

    let reads = 0;
    let stillReads = 0;
    let darkReads = 0;
    let armedReads = 0;
    let previous = record.spectrum.itemFrames;
    for (let index = 0; index < 30; index += 1) {
      await settle(40);
      const status = engine.status();
      if (status.state !== 'playing') continue;
      reads += 1;
      if (record.spectrum.itemFrames === previous) stillReads += 1;
      previous = record.spectrum.itemFrames;
      const frame = engine.readSpectrum();
      if (frame === null) darkReads += 1;
      else {
        assert.ok(
          frame.some((value) => value > 0),
          `read ${reads}: this item's own last frame is drawn, and it is not a zeroed one (${status.modeReason})`,
        );
      }
      if (status.spectrumArming) armedReads += 1;
      assert.notEqual(
        frame,
        null,
        `read ${reads}: this item's tap has produced ${record.spectrum.itemFrames} frames for it and its last frame is dated ${status.tap.lastAnalysisAt ?? 'not published'} against a declared period of ${status.tap.framePeriodMs ?? 'not published'} ms — a tap between its own frames is not a reason to blank the bars, and that is the whole of the SEND BACK (${status.modeReason})`,
      );
      assert.equal(
        status.spectrum,
        true,
        `read ${reads}: the engine is still live, on this item's own frames (${status.modeReason})`,
      );
      assert.equal(
        status.spectrumArming,
        false,
        `read ${reads}: the chip says "spectrum" — never "spectrum…" and never his "native audio" (${status.modeReason})`,
      );
      assert.doesNotMatch(
        status.modeReason,
        /produced no frame|not produced by this item|same frame/,
        `read ${reads}: nothing about this item's tap has changed (${status.modeReason})`,
      );
    }
    assert.ok(reads >= 20, `the window was watched while playing (${reads} reads)`);
    assert.ok(
      stillReads >= 8,
      `the counter really did stand still on reads this test watched (${stillReads} of ${reads}) — without that this test states no slow cadence at all`,
    );
    assert.equal(darkReads, 0, 'not one read blanked the bars');
    assert.equal(armedReads, 0, 'and the chip never went back to the arming window');
    /*
     * And the pace the rule was judged on is the tap's own: the number the plugin declared, carried by
     * the status to the banner (`src/ui/app.ts`), which is where his phone answers what a real tap's
     * `maxFrames` is. Nothing in the engine picks this number.
     */
    assert.equal(
      engine.status().tap.framePeriodMs,
      93,
      'the pace the rule is judged on is the tap’s own declaration, and the status carries it to the screen',
    );
    say(
      `1. a frame every three reads: ${reads} reads, ${stillReads} of them with this item's counter standing still, ${darkReads} dark`,
    );

    /* ---- 2. the same cadence through the other entry point a transition has: the boundary's
       adoption, which resets the per-item state without passing through `startNative` ---- */
    record.playingUrl = LOCAL_TRACK_3.url;
    engine.nativeMovedTo(LOCAL_TRACK_3);
    const adoptedAt = await until(() => engine.status().spectrum === true, 600);
    assert.ok(adoptedAt !== null, 'the adopted item’s own frames are what the bars are');

    let adoptedReads = 0;
    let adoptedStill = 0;
    let adoptedDark = 0;
    let adoptedPrevious = record.spectrum.itemFrames;
    for (let index = 0; index < 20; index += 1) {
      await settle(40);
      const status = engine.status();
      if (status.state !== 'playing') continue;
      adoptedReads += 1;
      if (record.spectrum.itemFrames === adoptedPrevious) adoptedStill += 1;
      adoptedPrevious = record.spectrum.itemFrames;
      if (engine.readSpectrum() === null) adoptedDark += 1;
      assert.equal(
        status.spectrumArming,
        false,
        `adopted track, read ${adoptedReads}: the chip says "spectrum" through the adoption too (${status.modeReason})`,
      );
    }
    assert.ok(adoptedReads >= 12, `the adopted track was watched while playing (${adoptedReads} reads)`);
    assert.ok(
      adoptedStill >= 4,
      `the counter stood still on reads of the adopted track as well (${adoptedStill} of ${adoptedReads})`,
    );
    assert.equal(adoptedDark, 0, 'and its bars never blanked between its own frames either');
    say(`2. the adopt path on the same cadence: ${adoptedReads} reads, ${adoptedStill} still, ${adoptedDark} dark`);
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

/**
 * v1.9.1 — *"using the seek bar seems to disable the playlist from advancing to the next song"*.
 *
 * The state that did it was `inTransition`: a counter, opened before `setCurrentTime` and closed in a
 * `finally` that only runs when the plugin's promise settles. The plugin settles it only from
 * AVFoundation's own seek completion, and a zero-tolerance seek of a transcoded remote item reports
 * `finished == false` — so the promise never settles, the counter stays at one, and both doors that
 * end a track are shut for the rest of the session.
 *
 * This test is that leak, exactly: the bridge's seek never settles, and the track still ends and
 * still advances. It would fail on the counter, whatever the window around it.
 */
test('a seek the plugin never answers cannot stop the queue advancing at the end of the track', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  try {
    const record = recording({ seekNeverSettles: true });
    const engine = nativeEngine(record);
    engines.push(engine);
    const queue = new PlaybackQueue(engine, stubLibrary());
    await queue.play(queueOf('song-1', 'song-2'), 0, CONTEXT);
    await settle(80);
    assert.equal(queue.currentSong?.id, 'song-1');

    // He drags the bar. The plugin accepts the call and never answers it.
    void queue.seek(30_000);
    await settle(40);
    say(`after the seek: ${record.calls.filter((call) => call.startsWith('seek@')).join(', ')}, and it never came back`);

    // Past the seek's own window, and then the track runs out.
    await settle(1700);
    record.events?.onComplete();
    await settle(300);

    assert.equal(queue.currentSong?.id, 'song-2', 'the track after the seek still became the active one');
    assert.equal(queue.position, 1, 'the cursor moved');
    assert.equal(engine.status().state, 'playing', 'and the machine is playing, not silent on a stuck seek');
    say(`after the end: active ${queue.currentSong?.id}, state ${engine.status().state}, seeks unanswered, queue advanced`);
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

test('the same advance happens in a browser, where the element’s own `ended` is the event', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  try {
    const record = recording();
    const web = new AudioEngine({ platform: { os: 'web', native: false }, nativeFactory: fakeBridge(record) as unknown as EngineOptions['nativeFactory'] });
    engines.push(web);
    const queue = new PlaybackQueue(web, stubLibrary());
    await queue.play(queueOf('song-1', 'song-2'), 0, CONTEXT);
    await settle(80);
    assert.equal(web.status().state, 'playing');
    const before = engineUrlOf(fakes);

    // The audio element reaching the end of the stream: the browser's own `ended`.
    fakes.finishTrack();
    await settle(200);

    say(`in a browser, after the end: active ${queue.currentSong?.id}, the element holds ${engineUrlOf(fakes)} (was ${before})`);
    assert.equal(queue.currentSong?.id, 'song-2', 'the next track is the active one');
    assert.equal(engineUrlOf(fakes), TRACK_URL('song-2'), 'and the element was pointed at it');
    assert.equal(web.status().state, 'playing', 'playing the new track, not left on the end of the old one');
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

/**
 * The chip's word for a status, read where it lives (v1.9.26).
 *
 * Since this card the word is **one field** — `EngineStatus.visualiser.word` — computed in the
 * engine, so every surface that shows the mode reads one fact and no two of them can disagree.
 * A tree that predates that field is read here with **the chip's own expression as it stood at
 * `8689a2e`** (`src/ui/app.ts:3356`), which is what makes the fail-before below reproducible rather
 * than asserted: run this file against the engine before the change and the paused reading is
 * *native audio* — the word in the owner's screenshot; run it after, and it is *paused*.
 */
function chipWord(status: EngineStatus): string {
  return (
    status.visualiser?.word ??
    (status.spectrum ? 'spectrum' : status.spectrumArming ? 'spectrum…' : status.backend === 'native' ? 'native audio' : 'theme')
  );
}

/**
 * v1.9.26 — **the chip's word when the transport is not playing is the transport's, not a
 * capability the app still has.**
 *
 * The owner, on the v1.9.24 build he installed, with a track paused on a playlist page:
 *
 * > *"the spectrum always works but on the playlist pages, the bottom bar seems to keep flashing to
 * > native audio spectrum off even though the spectrum is working fine"*
 *
 * — his screenshot reading `NATIVE AUDIO` over `paused · native · spectrum off`. The word was built
 * in the UI from three fields, and its third branch is a capability claim reached **by
 * elimination**: `spectrumArming` is only ever reported while a native track is *playing*, so every
 * state that is not playing — paused, ended, interrupted, between two tracks — fell through to
 * *native audio*, which is the word for *"the spectrum cannot run on the item playing now"*. On a
 * playlist page that flips at every pause and every change, which is the flashing he describes.
 *
 * The invariant this test holds, per state, on the iOS build (a tap, and the analyser's web
 * equivalent), and on the build that genuinely has no tap:
 *
 *   1. loading → `loading`, playing → `spectrum`;
 *   2. **paused → `paused`** — the state his screenshot is in;
 *   3. a change onto an item whose tap has produced nothing → `spectrum` in the `arming` tone
 *      (v2.0-beta — §515.4's second word is gone; the window is not);
 *   4. the end of a track → `ended`;
 *   5. and a build with **no tap at all** (Android today) → `native audio`, playing *and* paused:
 *      that build cannot measure any item, so the word is the truth about it whatever the transport
 *      is doing. It is reachable, and this is the only thing it may ever mean.
 */
test('the chip’s word is the transport’s when the transport is the reason — never a capability it still has (v1.9.26)', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  try {
    const record = recording();
    const engine = nativeEngine(record);
    engines.push(engine);

    // 1. A cold start: the stream is being fetched, and that is what the chip says. Asserted at the
    //    end of this test, on purpose: the app has always printed its own "loading…" for this state,
    //    so it is not where the owner ever read the wrong word — his screenshot is the paused read
    //    below, and that is where the fail-before has to land.
    const starting = engine.play(TRACK);
    const loading = engine.status();
    say(`1. a cold start: state ${loading.state} — the chip reads "${chipWord(loading)}"`);
    await starting;
    await settle(250);

    const playing = engine.status();
    say(`2. playing: spectrum ${playing.spectrum} — the chip reads "${chipWord(playing)}"`);
    assert.equal(chipWord(playing), 'spectrum', 'the bars are being fed by the item in hand');

    /*
     * 2. **PAUSED — the owner's screenshot.** On the installed build this read `NATIVE AUDIO` with
     *    `spectrum off` under it while the track sat at 1:28 / 4:55 on a playlist page. Nothing is
     *    wrong with the spectrum; nothing is playing, which is the whole of what has happened.
     */
    await engine.pause();
    await settle(150);
    const paused = engine.status();
    say(`3. paused: state ${paused.state}, spectrum ${paused.spectrum}, arming ${paused.spectrumArming} — the chip reads "${chipWord(paused)}" (${paused.modeReason})`);
    assert.equal(paused.state, 'paused', 'the machine is paused');
    assert.equal(paused.spectrum, false, 'and nothing is being measured, which is true');
    assert.equal(
      chipWord(paused),
      'paused',
      'the chip says what the transport is doing — not his "native audio", which is a claim about a capability this build still has',
    );

    // 3. And the mode is not lost: it comes back with the transport.
    await engine.resume();
    await settle(250);
    assert.equal(chipWord(engine.status()), 'spectrum', 'the bars come back with the transport, not with a re-attach');

    // 4. A change onto an item whose own tap has produced nothing: the spectrum's own word, in its
    //    arming tone (v2.0-beta — §515.4's second word is gone; the window itself is unchanged).
    record.tapProducing = false;
    const changing = engine.play(OTHER_TRACK);
    assert.equal(chipWord(engine.status()), 'loading', 'a track change is a load, and says so');
    await changing;
    await settle(150);
    const arming = engine.status();
    say(`4. the new item’s tap has produced nothing: arming ${arming.spectrumArming} — the chip reads "${chipWord(arming)}"`);
    assert.equal(chipWord(arming), 'spectrum', 'the spectrum is coming: the spectrum’s own word, not a capability claim');
    assert.equal(
      arming.visualiser.tone,
      'arming',
      'and the window is the arming tone now — v2.0-beta, one word per capability (§515.4 reversed)',
    );

    /*
     * 5. The end of a track. There is no queue on this harness, so the machine rests on `ended` —
     *    which is the state a playlist page's own change passes through, and one of the states the
     *    old expression printed the capability word for. The wait is the app's own rule and not the
     *    test's convenience: a completion that arrives within `TRANSPORT_MUTE_MS` (1500 ms) of a
     *    transport we sent is describing the request, and the bridge drops it (`inTransition`).
     */
    record.tapProducing = true;
    await settle(1600);
    record.events?.onComplete();
    await settle(150);
    const ended = engine.status();
    say(`5. the track ended: state ${ended.state} — the chip reads "${chipWord(ended)}"`);
    assert.equal(ended.state, 'ended', 'the machine is on the end of the track');
    assert.equal(chipWord(ended), 'ended', 'between two tracks, the transport is what is happening');

    /*
     * 6. **A build with no tap at all** — Android today, and the one case the capability word is
     *    licensed for. It reads that word playing *and* paused, because it is not a statement about
     *    a moment: that build cannot measure any item. Removed, the word would be gone from the app.
     */
    const noTap = nativeEngine(recording({ hasSpectrum: false }));
    engines.push(noTap);
    await noTap.play(TRACK);
    await settle(200);
    const withoutTap = noTap.status();
    say(`6. a build with no tap: spectrum ${withoutTap.spectrum}, spectrumArming ${withoutTap.spectrumArming} — playing, the chip reads "${chipWord(withoutTap)}"`);
    assert.equal(chipWord(withoutTap), 'native audio', 'this build cannot measure this item, and that is the word for it');
    await noTap.pause();
    await settle(120);
    const withoutTapPaused = noTap.status();
    say(`7. the same build, paused: the chip reads "${chipWord(withoutTapPaused)}" — the truth about the build, not about the transport`);
    assert.equal(chipWord(withoutTapPaused), 'native audio', 'a build with no tap cannot measure anything, playing or not');

    /*
     * And the state this test opened on, asserted here rather than there: every transport state has
     * a word, and a load's is its own — which is what the app renders as "loading…" (its own word for
     * the tap's synchronous paint, v1.9.0), so nothing on the screen moves for a load.
     */
    assert.equal(chipWord(loading), 'loading', 'a track that is being fetched is loading — not a build that cannot measure it');
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

/**
 * **The web path's own arming window** (card `t_71dc787e`, unreleased) — §515.4's word on the
 * analyser, and the capability word only where *this item's own samples* have ruled it out.
 *
 * The defect, measured by Sage in Chrome at 393x852 over the mock library (real app at `d769fd4`),
 * read off `test/chip-word-browser.test.ts`'s own word list:
 *
 * ```
 *     384 ms  "theme"    (the chip changed, state playing)
 *     512 ms  "spectrum" (the chip changed, state playing)
 * ```
 *
 * `theme` — the amber `fallback` tone, the word for *"this browser has no Web Audio, or the samples
 * are not real"* — for 128 ms at the start of a track, while the transport was `playing` and the
 * analyser was attached and working. The licence the engine reached it by was the second one in
 * `visualiserWord` (`if (this.state === 'playing') return native ? 'native audio' : 'theme'`),
 * taken whenever the bars were not being fed — including the window in which the analyser has
 * simply not produced this item's first frame yet. The native path has a word for that window
 * (v1.9.6's `arming` window → §515.4's `spectrum…`, and from v2.0-beta `spectrum` + the `arming` tone); the web path had none, so it fell through to the claim that
 * the app cannot measure the item it is measuring.
 *
 * What may still spend `theme` while a web item plays is a verdict **about that item's samples**:
 * `ZERO_FRAMES_BEFORE_THEME` frames of silence from the analyser (a tainted cross-origin stream, or
 * an analyser producing nothing) or one frozen frame over and over. What may not is a frame that has
 * not been asked for yet. Both halves are asserted here on the fake analyser — the word while the
 * analyser has answered nothing, that item's own verdict when it has, the verdict surviving a pause
 * and a resume, the bars and the word coming back on a real frame, and a track change onto another
 * item wearing *that* item's window rather than the register the previous item left behind (the web
 * half of `forgetTapFrames`).
 */
test('the web path wears the spectrum’s own word until its analyser has answered for the item, and the capability word only when it has (t_71dc787e)', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  try {
    const web = new AudioEngine({ platform: { os: 'web', native: false } as EngineOptions['platform'] });
    engines.push(web);

    /*
     * 1. The window the defect was measured in: the item is playing, the graph is built and the
     *    analyser is in front of the destination — and it has answered nothing for this item yet.
     *    Before the fix the chip read `theme` here (the amber capability word); the honest word is
     *    the one a native tap that has not answered gets, and it is what the owner gets on the web
     *    page and the PWA.
     */
    fakes.setSilent(true);
    await web.play(TRACK);
    const opened = web.status();
    say(
      `1. web, playing, the analyser has answered nothing: state ${opened.state}, spectrum ${opened.spectrum}, arming ${opened.spectrumArming} — the chip reads "${chipWord(opened)}"`,
    );
    assert.equal(opened.state, 'playing', 'the item is playing');
    assert.equal(opened.spectrum, false, 'and nothing is being measured yet, which is true');
    assert.equal(
      chipWord(opened),
      'spectrum',
      'the spectrum is coming — the spectrum’s own word, not the word for a browser that cannot measure this item',
    );
    assert.equal(opened.visualiser.tone, 'arming', 'and the window is the arming tone (v2.0-beta)');

    /*
     * 2. And it stays that word while the answer is still outstanding: the app does not decide that a
     *    silent analyser cannot be measured on the first sample it reads, and the amber word may not
     *    come back in the meantime (the flashing the owner reported, in its web form).
     */
    await settle(700);
    const waiting = web.status();
    say(`2. 700 ms later, still answering nothing: arming ${waiting.spectrumArming} — the chip reads "${chipWord(waiting)}"`);
    assert.equal(waiting.state, 'playing', 'the track is still playing');
    assert.equal(chipWord(waiting), 'spectrum', 'and the word is still the spectrum’s, not a verdict');

    /*
     * 3. The verdict, from this item's own samples: `ZERO_FRAMES_BEFORE_THEME` (18, at a 100 ms
     *    meter) analyser frames of silence is the app's answer that the samples are not real. This is
     *    the state `theme` is licensed for, and it must still be reachable — it is what a tainted
     *    cross-origin stream looks like, and the reason the card exists rather than a blanket
     *    replacement of `theme` by the spectrum's own word (v2.0-beta: `spectrum` + `arming`).
     */
    await settle(1600);
    const verdict = web.status();
    say(`3. the item’s own verdict: spectrum ${verdict.spectrum}, arming ${verdict.spectrumArming} — the chip reads "${chipWord(verdict)}" (${verdict.modeReason})`);
    assert.equal(verdict.state, 'playing', 'the track never stopped playing');
    assert.equal(chipWord(verdict), 'theme', 'this item’s samples are not real — the one thing the word may mean');
    assert.match(verdict.modeReason, /analyser returned silence|no samples|not a measurement/, 'and the reason names the verdict');

    /*
     * 4. The verdict is about the item, not about a moment: a pause and a resume do not re-open it
     *    (the registers that decide it are the item's, and nothing reset them).
     */
    await web.pause();
    await settle(150);
    assert.equal(chipWord(web.status()), 'paused', 'paused is the transport’s own word, as everywhere');
    await web.resume();
    await settle(350);
    const afterResume = web.status();
    say(`4. paused and resumed: the chip reads "${chipWord(afterResume)}"`);
    assert.equal(afterResume.state, 'playing', 'it resumed');
    assert.equal(chipWord(afterResume), 'theme', 'and the verdict about this item stands — a resume is not evidence about the samples');

    /*
     * 5. And a real frame is the end of it, in both directions: the analyser answers, so the bars and
     *    the word both come back (§515's rule, unchanged by this card).
     */
    fakes.setSilent(false);
    await settle(300);
    const recovered = web.status();
    say(`5. the analyser answers: spectrum ${recovered.spectrum}, arming ${recovered.spectrumArming} — the chip reads "${chipWord(recovered)}"`);
    assert.equal(chipWord(recovered), 'spectrum', 'the bars are being fed by the item in hand, and the word says so');
    assert.equal(
      recovered.spectrumArming,
      false,
      'and the arming field is false while the bars are live — "spectrum: true, spectrumArming: true" would be the debug line contradicting itself',
    );

    /*
     * 6. **A track change wears the new item's window, never the last item's verdict.** The register
     *    the samples are judged on is per item (the web half of `forgetTapFrames`, v1.9.24's rule on
     *    the native side): the item that has just started an unmeasurable stream gets its own
     *    `spectrum` arming, not the `theme` the register was left on by the item before it.
     */
    fakes.setSilent(true);
    await web.play(OTHER_TRACK);
    const changed = web.status();
    say(`6. a change onto an item whose samples answer nothing: state ${changed.state}, arming ${changed.spectrumArming} — the chip reads "${chipWord(changed)}"`);
    assert.equal(changed.state, 'playing', 'the new item is the one playing');
    assert.equal(
      chipWord(changed),
      'spectrum',
      'the item that just started has not worn the previous item’s verdict',
    );
    assert.equal(changed.visualiser.tone, 'arming', 'it wears the arming tone — its own window, on one word (v2.0-beta)');
    // And that item reaches its own verdict in its own time.
    await settle(2200);
    assert.equal(chipWord(web.status()), 'theme', 'and then its own samples answer, as item 1’s did');
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

/**
 * v1.9.27 (card `t_c8cc01c6`) — **the native half of the first-frame window: a resume.**
 *
 * `t_71dc787e` closed the web path's window (a browser's first frames arrive a moment after the
 * element plays, and the chip spent the amber `theme` for them). The native path has the same window
 * at the one transition no writer arms: **a resume.** `spectrumArming` is only ever set by a start
 * (`startNative`), an adoption (`nativeMovedTo`) and the polls that find the tap producing
 * nothing or sitting on another item; a resume is none of those, and `disarmConsumers` (the pause)
 * clears `spectrumLive` — so the instant the resume returns the transport to `playing`, the chip's
 * licence line (`state === 'playing'` and nothing being fed) paints **`native audio`** on an item
 * whose tap was measuring a moment ago, until the poll's own round trip answers. The probe, on the
 * fake bridge, is the card's: play → settle → pause → `resume()`, read at the instant the resume
 * flips the transport (`resume()` dispatches the state and emits synchronously, so this is a status
 * the app really paints — not a simulation of one).
 *
 * **Why the fix is a fact and not a re-arm.** `(spectrumLive, spectrumArming) = (false, false)` while
 * the transport plays is *also* exactly how a reached verdict looks: a tap whose frames read silence
 * for `ZERO_POLLS_BEFORE_THEME`, or one frozen frame over and over — both of which clear
 * `spectrumArming` and mean *the spectrum cannot run on this item*. Re-arming at a resume would say
 * *the spectrum is coming* over an item the engine has already ruled out, which is §515's silence
 * verdict (the owner's call of 2026-10-16) and the whole of the last three releases. So the engine
 * keeps the third fact it was missing — **this item's tap has answered with a verdict** — and the
 * window is read from it: playing, the tap is on this item, nothing is being fed, and no verdict has
 * been reached for it ⇒ `spectrum` in the `arming` tone. Nothing here is a clock or a budget: what ends the window is
 * this item's tap producing its own frame, or giving its own verdict (v1.9.24 deleted the timer).
 *
 * What is asserted, in the card's own order:
 *
 *   1. the instant the resume returns the transport to `playing` (and by every read until the poll's
 *      answer arrives) the chip is `spectrum`/`arming`, never `native audio`;
 *   2. the same transition on a return from the background, which re-arms through `engine-state
 *      playing` rather than through a tap — the player's own answer is adopted, and the chip must
 *      still not wear the capability word in the window that opens;
 *   3. a track whose tap has answered with **silence**, and one whose tap has answered with **one
 *      frozen frame**, keep `native audio` across a pause *and* a resume: the verdict is about the
 *      item, not about the moment — the behaviour that must not regress;
 *   4. the paused word is still the transport's own (`paused`), and the window still ends on this
 *      item's own frame.
 */
test('a native resume wears the spectrum’s own word, and a tap’s own verdict survives it (t_c8cc01c6)', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  /** How long `predicate` took to hold, in ms, or null if it never did inside the budget. */
  const until = async (predicate: () => boolean, budgetMs: number): Promise<number | null> => {
    const started = Date.now();
    for (;;) {
      if (predicate()) return Date.now() - started;
      if (Date.now() - started > budgetMs) return null;
      await settle(5);
    }
  };
  /** One emitted status, as the chip would have painted it. */
  interface Reading {
    at: number;
    state: EngineState;
    spectrum: boolean;
    arming: boolean;
    word: string;
    /** The tone the chip would have worn (v2.0-beta: the window lives here, not in a second word). */
    tone: VisualiserTone;
  }
  try {
    /* ================= 1. the probe: play → settle → pause → resume ================= */
    const record = recording();
    // One bridge round trip per read of the tap (see the field's own note): the window this test is
    // about is a round trip wide on the phone, and the fake states it rather than answering for free.
    record.spectrum.frameDelayMs = ROUND_TRIP_MS;
    const engine = nativeEngine(record);
    engines.push(engine);
    let watchFrom = 0;
    let seen: Reading[] = [];
    const unsubscribe = engine.subscribe((status) => {
      seen.push({
        at: Date.now() - watchFrom,
        state: status.state,
        spectrum: status.spectrum,
        arming: status.spectrumArming,
        word: chipWord(status),
        tone: status.visualiser.tone,
      });
    });

    await engine.play(TRACK);
    await settle(300);
    const a1 = engine.status();
    console.log('     DEBUG a1:', record.calls.length, 'calls; last:', record.calls.slice(-4).join(','), 'snap', engine.currentSnapshot() ? JSON.stringify(engine.currentSnapshot()?.spectrum) : 'null');
    say(`probe A1 native playing: "${chipWord(a1)}" (spectrum ${a1.spectrum}, arming ${a1.spectrumArming})`);
    assert.equal(chipWord(a1), 'spectrum', 'the tap answered for this item and the bars are the measurement');

    await engine.pause();
    await settle(150);
    const a2 = engine.status();
    say(`probe A2 native paused: "${chipWord(a2)}" (spectrum ${a2.spectrum}, arming ${a2.spectrumArming})`);
    assert.equal(chipWord(a2), 'paused', 'a pause is the transport’s own word (v1.9.26, unchanged)');

    /*
     * **A3 — the defect.** `resume()` flips the transport on the tap (`dispatch` → `applyState` →
     * `emit`) and only then asks the player, so the status read here is one the app really paints;
     * both the emitted one and `status()` are checked, because they are the same fact reached two
     * ways. Before this card the chip read `native audio` on this line, on the owner's phone, at
     * every resume and every return from the background.
     */
    watchFrom = Date.now();
    seen = [];
    const resuming = engine.resume();
    const emitted = seen[seen.length - 1];
    const a3 = engine.status();
    say(
      `probe A3 the instant resume() is called: state ${a3.state}, spectrum ${a3.spectrum}, arming ${a3.spectrumArming} — the chip reads "${chipWord(a3)}" (emitted: "${emitted?.word ?? 'nothing emitted'}")`,
    );
    assert.equal(a3.state, 'playing', 'the resume returns the transport to playing on the tap, before any round trip');
    assert.equal(emitted?.state, 'playing', 'and that status is one the engine emitted, not one the test synthesised');
    assert.equal(
      chipWord(a3),
      'spectrum',
      'the tap that was measuring this item a moment ago has not answered for it yet — the spectrum is coming, not a capability the app has lost',
    );
    assert.equal(a3.visualiser.tone, 'arming', 'in the arming tone — the window is the tone, since v2.0-beta');
    assert.equal(emitted?.word, 'spectrum', 'and the word the app paints is the same one');
    assert.equal(emitted?.tone, 'arming', 'the paint is the arming tone too');
    assert.equal(a3.spectrumArming, true, 'the status field says so too (spectrum false, arming true)');
    assert.equal(a3.spectrum, false, 'nothing is being measured at that instant, which is true');

    /*
     * And every read while playing, until the poll's own answer arrives, is that word: no capability
     * word may appear in the window, and the window is not a number of ticks — it ends when this
     * item's tap produces its own frame. The tap's answer latency is stated (`frameDelayMs`, one
     * `ROUND_TRIP_MS`) so the window is a window rather than the single status that opens it: on the
     * phone that round trip is the plugin's.
     */
    const healed = await until(() => engine.status().spectrum === true, 600);
    assert.ok(healed !== null, 'the tap’s own frame is what ends the window, not a deadline');
    await resuming;
    const windowReadings = seen.filter((reading) => reading.state === 'playing' && !reading.spectrum);
    const capability = windowReadings.filter((reading) => reading.word === 'native audio' || reading.word === 'theme');
    say(
      `     the window: the tap answers a read in ${record.spectrum.frameDelayMs} ms here, and its first frame ended the window ${healed} ms after this read; ${windowReadings.length} emitted status(es) inside it, a capability word on ${capability.length} of them`,
    );
    assert.ok(healed >= 20, `the window was a window, not a single paint (${healed} ms)`);
    assert.ok(windowReadings.length >= 1, 'and the status the resume paints is inside it — the one this card names');
    assert.equal(
      capability.length,
      0,
      `the capability word appeared while the transport was playing (${capability.map((r) => `${r.at} ms "${r.word}"`).join(', ')})`,
    );
    assert.equal(
      windowReadings.every((reading) => reading.word === 'spectrum' && reading.arming === true),
      true,
      'every one of them wore the spectrum’s word in its arming tone (§515.4’s window, on one word — v2.0-beta)',
    );
    const a4 = engine.status();
    say(`probe A4 native resumed: "${chipWord(a4)}" (spectrum ${a4.spectrum}, arming ${a4.spectrumArming})`);
    assert.equal(chipWord(a4), 'spectrum', 'the bars are fed again by the item in hand');

    /* ============ 2. the same transition on a return from the background ============ */
    /*
     * The app leaves the screen with the track paused and comes back to a player that is playing (the
     * lock screen's own play, or a player that never stopped): the return path adopts what the player
     * says (`dispatch({ type: 'engine-state', playing: true })`) instead of calling a tap, so no arming
     * writer runs here either — the same window, entered through the other door.
     */
    await engine.pause();
    await settle(150);
    await engine.handleVisibility(true);
    /*
     * The player the app comes back to is a playing one, and that is what the one read says: he
     * paused it in the app, the lock screen's own play started it again while the web layer was
     * suspended, and the snapshot reports the player it finds rather than the transport the app
     * last sent.
     */
    record.truth = { ...record.truth, playing: true };
    await engine.handleVisibility(false);
    watchFrom = Date.now();
    seen = [];
    const returned = engine.status();
    say(
      `2. back from the background, the player saying it is playing: state ${returned.state}, spectrum ${returned.spectrum}, arming ${returned.spectrumArming} — the chip reads "${chipWord(returned)}"`,
    );
    assert.equal(returned.state, 'playing', 'the player’s own answer is adopted, and the app is playing again');
    assert.equal(
      chipWord(returned),
      'spectrum',
      'the same window, through the other door: the tap has not answered for this item since the transport came back',
    );
    /*
     * Unreleased — the same window through the other door, stated as the invariant rather than as a
     * fixed word: the chip wears the arming tone until this item's own frame has answered, and the
     * spectrum's word from that frame on. (The item is unchanged here, so a tap that is still feeding
     * its frames closes the window on the return's first read.)
     */
    assert.equal(
      returned.visualiser.tone,
      returned.spectrum ? 'live' : 'arming',
      `the tone is the tap's own answer, whatever the door (spectrum ${returned.spectrum})`,
    );
    const backgroundHealed = await until(() => engine.status().spectrum === true, 500);
    assert.ok(backgroundHealed !== null, 'and it ends on the tap’s own frame here too');
    assert.equal(
      seen.filter((reading) => reading.state === 'playing' && reading.word !== 'spectrum').length,
      0,
      'no capability word on the way back in either',
    );
    say(`   …the tap’s own frame ended that window too, ${backgroundHealed} ms later`);

    /* ================= 3. a tap that answered with silence keeps its verdict ================= */
    /*
     * The behaviour that must not regress (acceptance 2): this item's tap has given its own answer —
     * twelve polls of frames from a tap on it, every band zero — and that answer is about **the
     * item**, so a pause and a resume may not re-open the window over it. The card's whole reason for
     * a third fact rather than `spectrumArming = true` in `startConsumers`.
     */
    const silentRecord = recording();
    silentRecord.spectrum.bands = silentRecord.spectrum.bands.map(() => 0);
    const silent = nativeEngine(silentRecord);
    engines.push(silent);
    await silent.play(TRACK);
    await settle(700);
    const silenced = silent.status();
    say(
      `3. a tap reading digital silence: spectrum ${silenced.spectrum}, arming ${silenced.spectrumArming} — the chip reads "${chipWord(silenced)}" (${silenced.modeReason})`,
    );
    assert.equal(chipWord(silenced), 'native audio', 'the tap has answered for this item: the spectrum cannot run on it');
    let silentSeen: Reading[] = [];
    watchFrom = Date.now();
    const unsubscribeSilent = silent.subscribe((status) => {
      silentSeen.push({ at: Date.now() - watchFrom, state: status.state, spectrum: status.spectrum, arming: status.spectrumArming, word: chipWord(status), tone: status.visualiser.tone });
    });
    await silent.pause();
    await settle(150);
    assert.equal(chipWord(silent.status()), 'paused', 'paused is still the transport’s word');
    silentSeen = [];
    const silentResuming = silent.resume();
    const silentAtTheInstant = silent.status();
    say(
      `   and at the resume: spectrum ${silentAtTheInstant.spectrum}, arming ${silentAtTheInstant.spectrumArming} — the chip reads "${chipWord(silentAtTheInstant)}"`,
    );
    await silentResuming;
    await settle(200);
    const silentResumed = silent.status();
    say(`   after the resume: "${chipWord(silentResumed)}" (${silentResumed.modeReason})`);
    assert.equal(silentResumed.state, 'playing', 'it resumed');
    assert.equal(
      chipWord(silentResumed),
      'native audio',
      'the verdict is about the item, not about the moment — a resume is not evidence about the samples',
    );
    assert.equal(
      silentSeen.filter((reading) => reading.state === 'playing' && reading.word !== 'native audio').length,
      0,
      'and the resume never re-opened the window over that verdict: no arming tone on an item the tap has ruled out',
    );
    unsubscribeSilent();

    /* ============ 4. and a tap that answered with one frozen frame keeps it too ============ */
    const frozenRecord = recording();
    frozenRecord.spectrum.frozenUrls = [TRACK.url];
    const frozen = nativeEngine(frozenRecord);
    engines.push(frozen);
    await frozen.play(TRACK);
    const frozeAt = await until(() => /same frame/.test(frozen.status().modeReason), 1500);
    assert.ok(frozeAt !== null, 'the frozen-frame rule is reachable on this harness and this item reached it');
    const frozenVerdict = frozen.status();
    say(
      `4. a tap returning one frozen frame: spectrum ${frozenVerdict.spectrum}, arming ${frozenVerdict.spectrumArming} — the chip reads "${chipWord(frozenVerdict)}" (${frozenVerdict.modeReason})`,
    );
    assert.equal(chipWord(frozenVerdict), 'native audio', 'the tap’s own frozen-frame verdict is the capability word');
    await frozen.pause();
    await settle(150);
    assert.equal(chipWord(frozen.status()), 'paused', 'paused, as everywhere');
    /*
     * Read *before* the await, which is the instant the transport flips (the same reading as A3): the
     * verdict is in hand, so the word is the verdict's — an arming tone here would be the engine saying
     * *the spectrum is coming* over an item its own tap has ruled out.
     */
    const frozenResuming = frozen.resume();
    const frozenAtTheInstant = frozen.status();
    say(`   at the resume: spectrum ${frozenAtTheInstant.spectrum}, arming ${frozenAtTheInstant.spectrumArming} — the chip reads "${chipWord(frozenAtTheInstant)}"`);
    assert.equal(
      chipWord(frozenAtTheInstant),
      'native audio',
      'the frozen verdict is about the item too — a resume does not re-open the window over it',
    );
    await frozenResuming;
    /*
     * And then the tap's register starts moving again (the resumed poll re-opens the per-item register
     * `startConsumers` keeps, so the frozen run is counted from the resume), which the engine admits
     * until its own `FROZEN_FRAMES_BEFORE_THEME` run is complete — ~0.4 s — and then the verdict is
     * reached again on the tap's own evidence, still without a clock. Named here rather than asserted
     * away: it is the frozen rule's own latency, restarted by a transition, and it is *not* what this
     * card changes (the bars are drawn from frames this item's tap really produced).
     */
    const refrozen = await until(() => /same frame/.test(frozen.status().modeReason), 1500);
    assert.ok(refrozen !== null, 'the frozen tap’s verdict is reached again on its own evidence after the resume');
    const frozenAgain = frozen.status();
    say(`   and ${refrozen} ms after the resume the tap’s own verdict is back: "${chipWord(frozenAgain)}" (${frozenAgain.modeReason})`);
    assert.equal(chipWord(frozenAgain), 'native audio', 'a frozen tap is still the capability word, and still by its own evidence');

    unsubscribe();
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

/* ------------------------- the duration the app trusts (t_644f6085) */

/**
 * The owner, 2026-10-17:
 *
 *   *"The song Tank! initially appears to be 3:30 long but when it ends or i try to seek on it it
 *   suddenly becomes 70:01 long — not sure how this error even came about."*
 *
 * It came about on the iOS transport. `RemoteAudioAsset` builds its item from an `AVURLAsset` with
 * `AVURLAssetPreferPreciseDurationAndTimingKey: false` — a value this project writes
 * (`tools/patch-native-audio.mjs`, for time to first sound) — so AVFoundation estimates the duration
 * instead of reading the container, and for Opus (an Ogg container it cannot index from the header)
 * the estimate is fiction: **4201.84 s for this 210.3475 s file**, 296.08 s for a 210.63 s one,
 * 190.14 s for a 219.29 s one; MP3 and FLAC come back within 30 ms. The rules under test are the two
 * readings that adopted it: the state report (`durationMs()`), and the seek's own answer (`sync()`).
 */
test('a transport that measures an Opus track at twenty times its length does not become the duration the app shows', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  try {
    const record = recording();
    /* The track Navidrome serves: `media_file.duration` 210.33999 s, ffprobe 210.3475 s. */
    const TANK: TrackRequest = { ...TRACK, title: 'Tank!', durationMs: 210_347.5 };
    const engine = nativeEngine(record);
    engines.push(engine);
    await engine.play(TANK);
    await settle(120);
    assert.equal(engine.status().state, 'playing');

    /*
     * The plugin's own state report for this item, verbatim: what the phone says the item is. From
     * the first report on, v1.9.5 lets the player's numbers replace the app's — and until this card
     * that meant the bar's duration label became 70:01 while the sound was 3:30.
     */
    record.events?.onState('playing', true, { currentTime: 12.4, duration: 4201.84, reason: 'playing' });
    await settle(120);
    const playing = engine.status();
    say(
      `the transport reports 4201.84 s for the 210.3475 s track: the bar would print ` +
        `"${formatTime(playing.durationMs / 1000)}" — the app holds ${Math.round(playing.durationMs)} ms — and the reason line reads "${playing.modeReason}"`,
    );
    assert.equal(Math.round(playing.durationMs), 210_348, 'the track’s own duration is the number the app shows');
    assert.ok(
      (playing.pluginState ?? '').includes('4201.8'),
      `and the phone's own number is still said, verbatim, in the account of what it said: ${playing.pluginState}`,
    );

    /* The seek path: the same answer, this time to a direct question (`sync()` → `getDuration`). */
    record.truth = { playing: true, positionMs: 40_000, durationMs: 4_201_840 };
    await engine.seek(40_000);
    await settle(120);
    const afterSeek = engine.status();
    say(
      `and after a seek, with the player answering 4201840 ms: ${Math.round(afterSeek.durationMs)} ms — ` +
        `position ${Math.round(afterSeek.positionMs)} ms (${afterSeek.modeReason})`,
    );
    assert.equal(Math.round(afterSeek.durationMs), 210_348, 'a seek does not bring the estimate in either');
    assert.ok(afterSeek.positionMs >= 39_000, 'while the seek itself still lands where it was asked to');
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

/**
 * The other half of the same defect, and the one that cost him more than the label: **the track never
 * ended.** `reportIsAtEnd` compared the item's own position (210 s) against the transport's estimate
 * (4201.84 s), decided the item was in the middle, and read the not-playing report at the true end as
 * an *interruption* — so the queue stayed parked on that track for ever.
 */
test('the end of an Opus track is heard even though the transport says the item is twenty times longer', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  try {
    const record = recording();
    const TANK: TrackRequest = { ...TRACK, title: 'Tank!', durationMs: 210_347.5 };
    const engine = nativeEngine(record);
    engines.push(engine);
    const ended = new Promise<boolean>((resolve) => {
      const previous = engine.onEnded;
      engine.onEnded = () => {
        previous?.();
        resolve(true);
      };
    });
    await engine.play(TANK);
    /* No transport of our own after this, so nothing is muted as "describing our request". */
    await settle(1700);
    /* AVFoundation's own end of the item: position 210.33 s, and the same 4201.84 s estimate. */
    record.truth = { playing: false, positionMs: 210_333, durationMs: 4_201_840 };
    record.events?.onState('paused', false, { currentTime: 210.33, duration: 4201.84, reason: 'stopped' });
    const heard = await Promise.race([ended, settle(400).then(() => false)]);
    const resting = engine.status();
    say(
      `the item's own end, with the transport calling itself ${(4201.84).toFixed(1)} s long: ` +
        `${heard ? 'the end was reported' : 'no end'} — the machine rests on "${resting.state}"`,
    );
    assert.equal(heard, true, 'the end of the track is reported to the queue');
    assert.equal(resting.state, 'ended', 'and the machine is on the end of the track, not interrupted');
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

/**
 * The rule itself, on the numbers it was measured against — so a future change to the slack has to
 * face the files that motivated it. Every `measured` value below is what this machine's AVFoundation
 * answered through the vendored transport, over HTTP with range requests, with the flag this project
 * writes; every `file` value is that file's own duration (ffprobe, and Navidrome's `media_file` row
 * agrees to the millisecond for the first one).
 */
test('the slack separates every measurement that works from every one that does not', () => {
  const cases: Array<{ what: string; file: number; measured: number; believed: boolean }> = [
    { what: 'Tank!.opus — the owner’s track', file: 210_347.5, measured: 4_201_840, believed: false },
    { what: '以朋友的身份.opus', file: 210_627.5, measured: 296_080, believed: false },
    { what: '那些你不能给我的.opus', file: 219_287.5, measured: 190_140, believed: false },
    { what: 'a.mp3 (CBR)', file: 180_666.7, measured: 180_696, believed: true },
    { what: 'a.flac (lossless)', file: 206_073.2, measured: 206_080, believed: true },
    /* The one case with nothing to check against: a stream, a radio item, a blank row. */
    { what: 'a track whose own duration is unknown', file: 0, measured: 4_201_840, believed: true },
    /* And a player that has not answered yet is not a measurement. */
    { what: 'a player that has said nothing', file: 210_347.5, measured: 0, believed: false },
  ];
  for (const item of cases) {
    const believed = measuredDurationIsBelievable(item.file, item.measured);
    say(`${item.what}: file ${item.file} ms, the transport says ${item.measured} ms → ${believed ? 'believed' : 'refused'}`);
    assert.equal(believed, item.believed, item.what);
  }
});

/* ------------------------- the same rule on the web path (t_972b8fc5) */

const webEngine = (record: Recording): AudioEngine =>
  new AudioEngine({
    platform: { os: 'web', native: false },
    nativeFactory: fakeBridge(record) as unknown as EngineOptions['nativeFactory'],
  });

/**
 * **The web transport is a second transport, and it lies the same way.** Measured by `t_d3de2a88` on
 * the shipped `dist/` served over HTTP — `/rest/stream` answering these files, `getSong`'s duration the
 * file's own — at 393x852, in Chrome and in WebKit (iPhone 15 Pro Simulator, iOS 18.7, WebKit 605):
 *
 * | file | the file (ffprobe) & `getSong` | Chrome `el.duration` | **WebKit `el.duration`** |
 * |---|---|---|---|
 * | `tank.opus`   | 210.3475 s | 210.3475 s | **4201.84 s** |
 * | `other1.opus` | 210.6275 s | 210.6275 s | **296.08 s** |
 * | `other2.opus` | 219.2875 s | 219.2875 s | **190.14 s** |
 * | `a.mp3`       | 180.6667 s | 180.6667 s | 180.696 s |
 * | `a.flac`      | 206.0732 s | 206.0732 s | 206.08 s |
 *
 * The three WebKit numbers are **digit for digit the three §1 of the duration entry measured through
 * the vendored iOS transport** (4201.84 / 296.08 / 190.14), so Safari-on-iOS and AVFoundation share the
 * estimator, and in WebKit the app painted *70:01* on the bar and on the now screen. `status()`
 * answered `el.duration * 1000` for every file, which is exactly what these cases hold it to — so the
 * recorded claim that the web path needs no gate is the one the numbers retire.
 */
test('a browser that calls an Opus track twenty times its length does not become the duration the app shows', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  try {
    const record = recording();
    const web = webEngine(record);
    engines.push(web);
    const ended = new Promise<boolean>((resolve) => {
      web.onEnded = () => resolve(true);
    });
    /* WebKit's own reading of the three real files, each beside the duration its own row carries. */
    const cases: Array<{ what: string; fileMs: number; elementMs: number }> = [
      { what: 'Tank!.opus — the owner’s track', fileMs: 210_347.5, elementMs: 4_201_840 },
      { what: '以朋友的身份.opus', fileMs: 210_627.5, elementMs: 296_080 },
      { what: '那些你不能给我的.opus', fileMs: 219_287.5, elementMs: 190_140 },
    ];
    for (const item of cases) {
      await web.play({ ...TRACK, id: `song-${item.elementMs}`, title: item.what, durationMs: item.fileMs });
      fakes.setDuration(item.elementMs / 1000);
      const status = web.status();
      say(
        `${item.what}: the element measures ${item.elementMs} ms and the track's own duration is ${Math.round(item.fileMs)} ms → ` +
          `the bar prints "${formatTime(status.durationMs / 1000)}" (the app holds ${Math.round(status.durationMs)} ms)`,
      );
      assert.equal(
        Math.round(status.durationMs),
        Math.round(item.fileMs),
        `${item.what}: the track's own duration is the number the bar prints`,
      );
      assert.notEqual(
        Math.round(status.durationMs),
        item.elementMs,
        `${item.what}: the element's own estimate is not the number the bar prints`,
      );
    }
    /*
     * And the end of the item is still heard, on the same element holding the same 4201.84 s: the
     * boundary on this path is the element's own `ended` — a fact about the stream it decoded — and
     * never a comparison against the number the element guessed.
     */
    fakes.finishTrack();
    const heard = await Promise.race([ended, settle(200).then(() => false)]);
    const resting = web.status();
    say(`and the element's own \`ended\` on that same 4201840 ms element: ${heard ? 'the end was reported' : 'no end'} — the machine rests on "${resting.state}"`);
    assert.equal(heard, true, 'the end of the track is reported to the queue');
    assert.equal(resting.state, 'ended', 'and the machine is on the end of the track');
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});

/**
 * The other half of the same rule: **it is a separation, not a preference.** Chrome reads the container
 * exactly on all three Opus files (and MP3/FLAC within 30 ms), and a track whose own duration is
 * unknown — a stream, a blank row — has nothing to check against: both keep the element's own number,
 * which is what v1.9.5 wanted the player's number for in the first place (a re-encode is not the
 * advertised length).
 */
test('a browser that reads the container exactly keeps its own number — the gate is a separation, not a preference', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  try {
    const record = recording();
    const web = webEngine(record);
    engines.push(web);
    const cases: Array<{ what: string; fileMs: number; elementMs: number }> = [
      { what: 'Tank!.opus', fileMs: 210_347.5, elementMs: 210_347.5 },
      { what: '以朋友的身份.opus', fileMs: 210_627.5, elementMs: 210_627.5 },
      { what: '那些你不能给我的.opus', fileMs: 219_287.5, elementMs: 219_287.5 },
      { what: 'a.mp3 (CBR)', fileMs: 180_666.7, elementMs: 180_696 },
      { what: 'a.flac (lossless)', fileMs: 206_073.2, elementMs: 206_080 },
    ];
    for (const item of cases) {
      await web.play({ ...TRACK, id: `song-${item.elementMs}`, title: item.what, durationMs: item.fileMs });
      fakes.setDuration(item.elementMs / 1000);
      const status = web.status();
      say(`${item.what}: the element says ${item.elementMs} ms, the track's own is ${item.fileMs} ms → the app holds ${Math.round(status.durationMs)} ms`);
      assert.equal(Math.round(status.durationMs), Math.round(item.elementMs), `${item.what}: the element's own reading is the one used`);
    }
    /* Nothing to check against: the measurement is all there is, however wild it looks. */
    await web.play({ ...TRACK, id: 'song-stream', title: 'a stream', durationMs: 0 });
    fakes.setDuration(4_201.84);
    const stream = web.status();
    say(`a track with no duration of its own: the element says 4201840 ms → the app holds ${Math.round(stream.durationMs)} ms`);
    assert.equal(Math.round(stream.durationMs), 4_201_840, 'a stream keeps the element’s own number');
  } finally {
    fakes.restore();
    await stopAll(engines);
  }
});


