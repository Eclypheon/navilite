/**
 * The native engine's two contracts, on a bridge that can be made to misbehave.
 *
 * Nothing in `tools/` can reach these paths: the Chrome harness is a browser (no Capacitor plugin),
 * and the simulator probe drives a *web* webview. So the engine takes its platform and its native
 * bridge as options (`EngineOptions`), and this file drives the real `AudioEngine` with a fake
 * bridge that can be slow, can refuse to resume, and can stop answering — which is exactly the
 * behaviour the owner hit on the phone. Three things are measured, not asserted in prose:
 *
 *   1. **The spectrum's graph is live while the native player is the one being heard.** v1.7 left the
 *      analyser disconnected on that path, and a graph with no path to the destination is not
 *      rendered — the analyser returns zeros with no error. The check is the shape of the graph
 *      (`source → analyser → gain(0) → destination`) *and* a real non-zero frame arriving from it.
 *   2. **Returning to the app reconciles with the player, and one tap restarts it.** A bridge that
 *      reports "not playing" after a foreground return must leave the transport on `paused`; a tap
 *      then has to end with the track actually playing — including the case where the resume is
 *      accepted and silently ignored, which is the state v1.7 got stuck in.
 *   3. **The press is not behind the round trips.** With every bridge call costing 40 ms, the
 *      transport must be `playing` on the same tick as the press (v1.7 flipped it after `load` +
 *      `play` resolved) and the bridge must already exist before the press (v1.7 built it inside it).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AudioEngine, type EngineOptions } from '../src/player/engine.ts';
import type { NativeBridge, NativeBridgeEvents, NativeTrackInfo, NativeTruth } from '../src/player/native.ts';
import type { TrackRequest } from '../src/player/engine.ts';

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

interface Recording {
  calls: string[];
  /** What the player reports from `sync()`, i.e. the truth after a foreground return. */
  truth: NativeTruth;
  /** True when the plugin accepts `resume()` and does not actually start (the v1.7 trap). */
  refuseResume: boolean;
  /** True when the player will not answer at all. */
  silentSync: boolean;
  /** Filled frame handed to the analyser on every `getByteFrequencyData`. */
  frameValue: number;
}

/* ------------------------------------------------------------------ the bridge */

function fakeBridge(record: Recording, options: { buildMs?: number } = {}): (os: string, events: NativeBridgeEvents) => Promise<NativeBridge> {
  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  return async (_os: string, _events: NativeBridgeEvents) => {
    if (options.buildMs) await wait(options.buildMs);
    const action = async (name: string): Promise<void> => {
      record.calls.push(name);
      await wait(ROUND_TRIP_MS);
    };
    record.calls.push('configure');
    return {
      async load(_info: NativeTrackInfo) {
        record.calls.push('load');
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
        await wait(roundTripForSeek());
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
    };
  };
}

/** Seeks are cheap here: the throttle in the app is what matters, not the bridge's latency. */
function roundTripForSeek(): number {
  return 5;
}

/* ------------------------------------------------------------------ the DOM */

interface Connections {
  edges: string[];
  gainValues: number[];
}

/**
 * The smallest stand-ins for `Audio`, `AudioContext` and `document` that the engine touches, with
 * the audio graph recorded as an edge list so the *shape* can be asserted (a disconnected analyser
 * and a muted one are not the same thing, and that difference is the whole fix).
 */
function installFakes(): { connections: Connections; restore: () => void; setFrame(v: number): void } {
  const connections: Connections = { edges: [], gainValues: [] };
  const frame = { value: 128 };
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = {
    Audio: globals.Audio,
    AudioContext: globals.AudioContext,
    document: globals.document,
  };

  class FakeAudio {
    preload = '';
    src: string | null = null;
    crossOrigin: string | null = null;
    currentTime = 0;
    duration = Number.NaN;
    error: { message: string; code: number } | null = null;
    paused = true;
    private listeners = new Map<string, Array<() => void>>();
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
      const analyser = {
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
      return analyser;
    }
    createGain(): unknown {
      const gain = {
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
      return gain;
    }
  }

  globals.Audio = FakeAudio;
  globals.AudioContext = FakeAudioContext;
  // `startAnalysis` refuses to run while the document is hidden; a test is not a hidden tab.
  globals.document = { hidden: false };

  return {
    connections,
    setFrame: (value: number) => {
      frame.value = value;
    },
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
    truth: { playing: true, positionMs: 1000, durationMs: 180_000 },
    refuseResume: false,
    silentSync: false,
    frameValue: 128,
    ...overrides,
  };
}

/**
 * Every engine is stopped before its test ends: the analyser meter is a `setInterval`, and a test
 * process that holds one open never exits.
 */
async function stopAll(engines: AudioEngine[]): Promise<void> {
  for (const engine of engines) await engine.stop();
  // A restart that was already in flight can start the meter again; give it a beat, then stop the
  // engines once more so nothing is holding the event loop open when the test returns.
  await new Promise((resolve) => setTimeout(resolve, 60));
  for (const engine of engines) await engine.stop();
}

const nativeEngine = (record: Recording, options: { buildMs?: number } = {}): AudioEngine =>
  new AudioEngine({
    platform: { os: 'ios', native: true },
    nativeFactory: fakeBridge(record, options) as unknown as EngineOptions['nativeFactory'],
  });

/* ------------------------------------------------------------------ the tests */

test('the spectrum is fed while the native player is what you hear', async () => {
  const fakes = installFakes();
  try {
    const record = recording();
    const engine = nativeEngine(record);
    await engine.play(TRACK);
    assert.equal(engine.status().backend, 'native', 'a wrapped build plays natively');

    // The graph has to be reachable from the destination, and muted by gain rather than by a
    // missing edge — v1.7 left the analyser disconnected and no samples ever arrived.
    assert.deepEqual(fakes.connections.edges, ['source->analyser', 'analyser->gain', 'gain->destination']);
    assert.equal(fakes.connections.gainValues[fakes.connections.gainValues.length - 1], 0, 'the analysis copy is silent');

    // ...and the analyser is a real measurement: give the meter a couple of ticks and read it the
    // way the visualiser does, per frame.
    await new Promise((resolve) => setTimeout(resolve, 260));
    const status = engine.status();
    assert.equal(status.spectrum, true, `the engine must report a live spectrum (modeReason: ${status.modeReason})`);
    const frame = engine.readSpectrum();
    assert.ok(frame, 'a live spectrum hands the visualiser a frame');
    assert.ok(Math.max(...frame) > 0, 'and the frame is not a flatline');

    // The audible path keeps the same shape with the gain open.
    fakes.connections.edges.length = 0;
    fakes.connections.gainValues.length = 0;
    const webRecord = recording();
    const web = new AudioEngine({ platform: { os: 'web', native: false }, nativeFactory: fakeBridge(webRecord) });
    await web.play(TRACK);
    assert.deepEqual(fakes.connections.edges, ['source->analyser', 'analyser->gain', 'gain->destination']);
    assert.equal(fakes.connections.gainValues[fakes.connections.gainValues.length - 1], 1, 'the web copy is heard');
    await stopAll([engine, web]);
  } finally {
    fakes.restore();
  }
});

test('coming back to the app believes the player, and one tap restarts a track that did not', async () => {
  const fakes = installFakes();
  try {
    const record = recording();
    const engine = nativeEngine(record);
    await engine.play(TRACK);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(engine.status().state, 'playing');

    // Out of sight, then back — and the player says it is stopped mid-track.
    await engine.handleVisibility(true);
    record.truth = { playing: false, positionMs: 62_000, durationMs: 180_000 };
    await engine.handleVisibility(false);
    const reconciled = engine.status();
    assert.equal(reconciled.state, 'paused', 'the UI must match the player, not the other way round');
    assert.equal(Math.round(reconciled.positionMs), 62_000, 'and hold the position the player is really at');

    // The trap: the resume is accepted and the player does not start.
    record.refuseResume = true;
    record.calls.length = 0;
    await engine.toggle(); // one tap
    await new Promise((resolve) => setTimeout(resolve, 520));
    assert.equal(engine.status().state, 'playing', 'one tap must end with it playing');
    assert.ok(
      record.calls.includes('load') && record.calls.some((call) => call.startsWith('play@62')),
      `a refused resume must be followed by a real restart at the same second — calls: ${record.calls.join(', ')}`,
    );

    // And a player that will not answer must never leave a "playing" no tap can act on.
    record.silentSync = true;
    record.truth = { playing: true, positionMs: 70_000, durationMs: 180_000 };
    await engine.handleVisibility(true);
    await engine.handleVisibility(false);
    assert.equal(engine.status().state, 'paused', 'an unreadable player is shown as paused, not as playing');
    await stopAll([engine]);
  } finally {
    fakes.restore();
  }
});

test('the press is not behind the bridge round trips', async () => {
  const fakes = installFakes();
  try {
    const record = recording();
    // A bridge that takes 60 ms to build, as the plugin import + configure + three listeners do.
    const engine = nativeEngine(record, { buildMs: 60 });

    // Pre-warm, the way boot does it (`setPreference` right after the engine is built).
    engine.setPreference('auto');
    await new Promise((resolve) => setTimeout(resolve, 120));
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
