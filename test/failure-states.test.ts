/**
 * **Every playback failure names its state** (unreleased, card `t_a019d9f2`, design §5).
 *
 * The rule this file exists to hold: a `catch` in the playback path either maps to a named state or
 * is a bug — and an absence the row cannot name is the capability claim the owner kept reading. The
 * three cases here are the three ways the one player can refuse to answer, and each asserts the state
 * word **and** the absence of a claim the app cannot support:
 *
 *   1. a snapshot that cannot be read is `unavailable: '<step>'`, and the chip is `error` — never
 *      `spectrum`, never the transport's `playing` over a player nothing read;
 *   2. a return that finds the player stopped without a press is `interrupted`, not a silent
 *      `paused`;
 *   3. a seek whose answer never settles is `unsettled`, asked once more and then left alone — the
 *      bar keeps what the player last reported instead of the position the caller asked for.
 *
 * It is a bridge of its own rather than the large `engine-native.test.ts` fake: that file models the
 * previous architecture and is being restated under its own card (`t_36bbd3a2`), so nothing here
 * depends on it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AudioEngine } from '../src/player/engine.ts';
import type { EngineOptions, TrackRequest } from '../src/player/engine-contract.ts';
import type { NativeBridge, NativeBridgeEvents, NativeSnapshot, NativeTrackInfo, SnapshotRefusal } from '../src/player/native.ts';

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

/** The frame the item's tap published: 64 bands, a plausible loud passage. */
const BANDS = Array.from({ length: 64 }, (_, index) => 40 + ((index * 37) % 120));

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** What the one player is doing, as the fake's own state — the thing a snapshot reports. */
interface Player {
  url: string;
  positionMs: number;
  playing: boolean;
}

/** The snapshot the fake answers, dated to the item it is holding. */
function snapshotOf(player: Player, state: 'playing' | 'paused'): NativeSnapshot {
  const key = player.url ? `item:${player.url}` : '';
  return {
    generation: 0,
    entry: { songId: TRACK.id, index: 0, url: player.url, assetId: 'slot-0', key },
    positionMs: player.positionMs,
    durationMs: 180_000,
    rate: state === 'playing' ? 1 : 0,
    state,
    queue: { index: 0, count: 1, repeat: 'off' },
    spectrum: { bands: BANDS, itemKey: key, frames: 9, lastAnalysisAt: Date.now(), framePeriodMs: 33, attached: true },
  } as unknown as NativeSnapshot;
}

/**
 * One bridge, with three knobs: what the snapshot answers, what the seek's read answers, and how many
 * presses the player took. Everything else is the transport the app already knows.
 */
function bridge(options: {
  calls: string[];
  player: Player;
  events: () => NativeBridgeEvents | null;
  snapshot: () => NativeSnapshot | { unavailable: SnapshotRefusal };
  sync?: () => Promise<{ playing: boolean; positionMs: number; durationMs: number } | null>;
}): NativeBridge {
  const { calls, player, events } = options;
  return {
    async load(info: NativeTrackInfo) {
      calls.push('load');
      player.url = info.url;
    },
    async play(seconds: number) {
      calls.push(`play@${Math.round(seconds)}`);
      player.positionMs = seconds * 1000;
      player.playing = true;
      // The player reports where it is: the engine waits for that before it says "playing".
      events()?.onPosition(seconds);
    },
    async pause() {
      calls.push('pause');
      player.playing = false;
    },
    async resume() {
      calls.push('resume');
      player.playing = true;
    },
    async stop() {
      calls.push('stop');
      player.playing = false;
    },
    async seek(seconds: number) {
      calls.push(`seek@${Math.round(seconds)}`);
      player.positionMs = seconds * 1000;
    },
    positionMs: () => player.positionMs,
    async sync() {
      calls.push('sync');
      if (options.sync) return options.sync();
      return { playing: player.playing, positionMs: player.positionMs, durationMs: 180_000 };
    },
    async activateSession() {
      calls.push('activateSession');
      return true;
    },
    listenRemoteCommands() {
      return () => undefined;
    },
    hasNativeSpectrum: true,
    async snapshot() {
      calls.push('snapshot');
      return options.snapshot();
    },
  } as unknown as NativeBridge;
}

/** The engine needs the browser's element in its constructor; nothing here plays through it. */
function stubAudio(): () => void {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = globals.Audio;
  class StubAudio {
    src = '';
    duration = 0;
    currentTime = 0;
    paused = true;
    volume = 1;
    play(): Promise<void> {
      return Promise.resolve();
    }
    pause(): void {}
    load(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
    removeAttribute(): void {}
    setAttribute(): void {}
  }
  globals.Audio = StubAudio;
  return () => {
    globals.Audio = previous;
  };
}

function engineOver(options: Parameters<typeof bridge>[0]): AudioEngine {
  return new AudioEngine({
    platform: { os: 'ios', native: true },
    /* The sink the engine hands the bridge is the only way it hears the player's reports. */
    nativeFactory: (async (_os: string, sink: NativeBridgeEvents) =>
      bridge({ ...options, events: () => sink })) as unknown as EngineOptions['nativeFactory'],
  });
}

test('a snapshot that cannot be read is a named state, and the chip makes no claim about the player', async () => {
  const restore = stubAudio();
  const calls: string[] = [];
  const player: Player = { url: '', positionMs: 0, playing: false };
  const engine = engineOver({
    calls,
    player,
    events: () => null,
    snapshot: () => ({ unavailable: 'no_plugin' }),
  });
  engine.subscribe(() => undefined);
  try {
    await engine.play(TRACK);

    // One poll tick with an unreadable player. 33 ms cadence, so 120 ms is three of them.
    await settle(120);

    const status = engine.status();
    assert.ok(calls.includes('snapshot'), 'the poll really did ask — the state is not a vacuous one');
    assert.equal(status.state, 'error', `an unreadable player is an error, not a silent playing (was ${status.state})`);
    assert.equal(status.visualiser.word, 'error', `the chip wears the refusal, not a capability (was ${status.visualiser.word})`);
    assert.notEqual(status.visualiser.word, 'spectrum', 'never the spectrum on a player nothing read');
    assert.notEqual(status.visualiser.word, 'playing', 'and never the transport’s own word either');
    assert.match(String(status.error), /no_plugin/, 'the sentence names the step that failed');
    assert.match(status.modeReason, /no_plugin/, 'and so does the reason the row shows');
    console.log(`    unreadable snapshot: state ${status.state}, chip "${status.visualiser.word}", reason: ${status.modeReason.slice(0, 96)}…`);
  } finally {
    await engine.stop();
    await settle(60);
    restore();
  }
});

test('a return that finds the sound stopped says interrupted, never a pause nobody pressed', async () => {
  const restore = stubAudio();
  const calls: string[] = [];
  const player: Player = { url: '', positionMs: 0, playing: false };
  /* The player keeps its own word: it is playing until something else says so. */
  let phoneSays: 'playing' | 'paused' = 'playing';
  const engine = engineOver({
    calls,
    player,
    events: () => null,
    snapshot: () => snapshotOf(player, phoneSays),
  });
  try {
    await engine.play(TRACK);
    assert.equal(engine.status().state, 'playing', 'he is listening before the app goes away');

    await engine.handleVisibility(true);
    // He comes back and the phone reports the sound stopped, with no press from this app.
    phoneSays = 'paused';
    player.playing = false;
    await engine.handleVisibility(false);

    const status = engine.status();
    assert.equal(status.state, 'interrupted', `the sound stopped and nobody asked (was ${status.state})`);
    assert.equal(status.visualiser.word, 'interrupted', 'and the chip says so');
    assert.notEqual(status.visualiser.word, 'playing', 'no transport claim on a player that is not playing');
    assert.notEqual(status.visualiser.word, 'spectrum', 'and no measurement claim either');
    console.log(`    return on a stopped player: state ${status.state}, chip "${status.visualiser.word}"`);
  } finally {
    await engine.stop();
    await settle(60);
    restore();
  }
});

test('a seek whose answer never settles is unsettled, asked once more and refused by its own token', async () => {
  const restore = stubAudio();
  const calls: string[] = [];
  const player: Player = { url: '', positionMs: 0, playing: false };
  const engine = engineOver({
    calls,
    player,
    events: () => null,
    snapshot: () => snapshotOf(player, 'playing'),
    /* The player never says where it is after a seek — the defect the deadline exists for. */
    sync: async () => {
      calls.push('sync');
      return null;
    },
  });
  try {
    await engine.play(TRACK);
    calls.length = 0;
    await engine.seek(90_000);

    const seeks = calls.filter((call) => call.startsWith('seek@'));
    assert.deepEqual(seeks, ['seek@90', 'seek@90'], `one press is one seek and exactly one retry (it made: ${seeks.join(', ') || 'none'})`);
    const status = engine.status();
    assert.match(status.modeReason, /unsettled/, `the answer is the word unsettled (was: ${status.modeReason})`);
    assert.match(status.modeReason, /refused by this seek's own token/, 'and the second attempt is refused by the token');
    assert.notEqual(Math.round(status.positionMs), 90_000, 'the bar keeps the player’s last reading, never the request');
    console.log(`    unsettled seek: ${seeks.length} seek(s) for one press, bar at ${Math.round(status.positionMs)} ms, reason: ${status.modeReason.slice(0, 96)}…`);
  } finally {
    await engine.stop();
    await settle(60);
    restore();
  }
});
