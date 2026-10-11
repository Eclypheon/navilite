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

import { AudioEngine, reduce, type EngineOptions, type EngineState, type PlayerEvent } from '../src/player/engine.ts';
import type { NativeBridge, NativeBridgeEvents, NativeTrackInfo, NativeTruth } from '../src/player/native.ts';
import type { TrackRequest } from '../src/player/engine.ts';
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

interface Recording {
  calls: string[];
  /** Every URL the bridge was asked to load, in order — which track the one asset holds. */
  loads: string[];
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
    record.events = events;
    const action = async (name: string): Promise<void> => {
      record.calls.push(name);
      await wait(ROUND_TRIP_MS);
    };
    record.calls.push('configure');
    return {
      async load(info: NativeTrackInfo) {
        record.calls.push('load');
        record.loads.push(info.url);
        await wait(ROUND_TRIP_MS);
      },
      async play(seconds: number) {
        record.calls.push(`play@${Math.round(seconds)}`);
        await wait(ROUND_TRIP_MS);
        record.truth = { ...record.truth, playing: true };
      },
      pause: () => action('pause'),
      async resume() {
        record.calls.push('resume');
        await wait(ROUND_TRIP_MS);
        // The trap: the call is accepted, the player stays put. `refuseResume` says so.
        if (!record.refuseResume) record.truth = { ...record.truth, playing: true };
      },
      stop: () => action('stop'),
      async seek(seconds: number) {
        record.calls.push(`seek@${Math.round(seconds)}`);
        record.truth = { ...record.truth, positionMs: seconds * 1000 };
        await wait(5);
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
      hasNativeSpectrum: true,
      async startSpectrum(url: string, positionMs: number) {
        record.calls.push(`startSpectrum@${Math.round(positionMs)}`);
        record.spectrum.started = true;
        record.spectrum.startedUrl = url;
        record.spectrum.startedAtMs = positionMs;
        record.spectrum.startCalls += 1;
        record.spectrum.playing = true;
        return true;
      },
      async stopSpectrum() {
        record.spectrum.stopCalls += 1;
        record.spectrum.started = false;
      },
      async spectrumFrame() {
        // Every frame differs from the one before it, the way a real FFT of music does — and a
        // silent source reads as silence, which is the flat case the visualiser must detect.
        record.spectrum.frames += 1;
        const silent = record.spectrum.bands.every((value) => value === 0);
        const bands = silent
          ? record.spectrum.bands.slice()
          : record.spectrum.bands.map((value, index) => (value + record.spectrum.frames * 7 + index) % 251);
        if (!silent) record.spectrum.silentFrames = 0;
        else record.spectrum.silentFrames += 1;
        record.spectrum.live = !silent;
        return {
          bands,
          bandCount: bands.length,
          live: record.spectrum.live,
          frames: record.spectrum.frames,
          silentFrames: record.spectrum.silentFrames,
          positionMs: record.truth.positionMs,
          playing: record.spectrum.playing && record.truth.playing,
          // The plugin's own answer to "is the tap on the item the player is on now?" — flipped to
          // false by the orphan test, which is the case v1.7.7 could not see.
          itemIsCurrent: record.spectrum.itemIsCurrent,
          readable: true,
          sampleRate: 44_100,
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
function installFakes(): { connections: Connections; restore: () => void; setFrame(v: number): void; finishTrack(): void; currentSrc(): string | null } {
  const connections: Connections = { edges: [], gainValues: [] };
  const frame = { value: 128 };
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
    events: null,
    truth: { playing: true, positionMs: 1000, durationMs: 180_000 },
    refuseResume: false,
    silentSync: false,
    frameValue: 128,
    spectrum: {
      started: false,
      startedUrl: null,
      startedAtMs: 0,
      startCalls: 0,
      stopCalls: 0,
      frames: 0,
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
    assert.equal(atHide, 12_500, 'and what it shows is the last position the player actually reported, not a guess');

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

    // Silence reads as silence, and is reported as such rather than drawn.
    record.spectrum.bands = new Array(64).fill(0);
    await settle(500);
    assert.equal(engine.status().spectrum, false, `a tap reading digital silence is not a live spectrum (modeReason: ${engine.status().modeReason})`);
    assert.equal(engine.readSpectrum(), null, 'and nothing is handed to the canvas');

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
      record.calls.some((call) => call.startsWith('startSpectrum@')),
      `and re-arms the visualiser, which cannot have been fed while the web view was suspended — calls: ${record.calls.join(', ')}`,
    );
    assert.equal(record.spectrum.started, true, 'and the visualiser is armed again on the way back in');

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
    await engine.handleVisibility(false);
    assert.equal(engine.status().state, 'interrupted', 'an unreadable player is not reported as playing');
    // The one tap still fixes it, and it is the tap that sends the command.
    record.silentSync = false;
    record.truth = { playing: true, positionMs: 12_000, durationMs: 180_000 };
    await engine.toggle();
    assert.equal(engine.status().state, 'playing');
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
    assert.equal(stateOnPress, 'playing', 'the transport is playing on the tick of the press');

    await playing;
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

test('the displayed position does not run from the press to the first sound', async () => {
  const fakes = installFakes();
  const engines: AudioEngine[] = [];
  try {
    const record = recording();
    record.truth = { playing: true, positionMs: 0, durationMs: 180_000 };
    const engine = nativeEngine(record);
    engines.push(engine);
    await engine.play(TRACK);
    await settle(300);
    const beforeReport = engine.status().positionMs;
    say(`the clock between the press and the player's first report: ${Math.round(beforeReport)} ms after 300 ms of real time`);
    assert.equal(beforeReport, 0, `nothing is audible yet, so nothing has elapsed (${Math.round(beforeReport)} ms)`);

    // The player's own report is what starts it, and it counts from that position.
    record.events?.onPosition(0.4);
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
    assert.equal(record.spectrum.startCalls, 1, 'so the tap is not torn down and rebuilt for it');
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
    assert.equal(record.spectrum.startCalls, 1, 'the tap is installed once, when the track is loaded');
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
    assert.equal(record.spectrum.startCalls, 2, 'the resume confirms the tap rather than building a second one');
    assert.ok(
      record.calls.some((call) => call.startsWith('startSpectrum@')),
      `and the confirmation is what it sends — calls: ${record.calls.join(', ')}`,
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
      record.spectrum.startCalls,
      3,
      `returning verifies the tap it already has, once — calls: ${record.calls.join(', ')}`,
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
    assert.equal(record.spectrum.startCalls, 1, 'the first track installs the tap once');
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
      record.calls.some((call) => call.startsWith('startSpectrum@')),
      'and the install was asked for as part of the load, not from the transport transition',
    );
    assert.equal(engine.status().spectrum, true, 'the new song is fed from the start');

    /* ---- and the orphan the review found: the tap left on the outgoing item ---- */
    const startCallsBeforeOrphan = record.spectrum.startCalls;
    record.spectrum.itemIsCurrent = false;
    await settle(80);
    assert.equal(
      engine.readSpectrum(),
      null,
      'the previous song’s last frame is not a measurement of this one, so nothing is drawn from it',
    );
    // The re-attach is rate-limited to one a second (SPECTRUM_ORPHAN_RECHECK_MS), so the check waits
    // past that window before it insists the plugin was asked again.
    await settle(1_000);
    const reAttached = await until(() => record.spectrum.startCalls > startCallsBeforeOrphan, 400);
    assert.ok(reAttached !== null, 'a tap on the item the player has left is re-attached, on its own');
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
    assert.equal(record.loads[record.loads.length - 1], TRACK_URL('song-2'), 'the engine holds the next track’s stream');
    assert.ok(plays.length > 0, `audio for it started — calls: ${record.calls.join(', ')}`);
    assert.equal(engine.status().state, 'playing', 'and the machine is playing, not stuck on the end of the last one');
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
