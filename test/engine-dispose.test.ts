/**
 * **Every initiated thing expires, and one teardown gives all of it back** (unreleased, card
 * `t_346af318`).
 *
 * The design's §4 expiry table is the spec, and two rows in it had no cancel path at all: `Engine`
 * had no `dispose()` (four `clearInterval` calls, each inside one path, so a screen that outlived
 * the engine kept the meter and the poll), and the snapshot poll was not bound to visibility. This
 * file states the two facts the card is judged on, on the **real** `AudioEngine`:
 *
 *   1. five mounts and five disposes leave **zero live intervals and zero live timeouts** — counted,
 *      not assumed, by the fake clock in `test/support/fake-clock.ts`;
 *   2. a hidden engine makes **no bridge call** over ten poll periods, and one return makes
 *      **exactly one** — the immediate read, with the poll back on screen behind it.
 *
 * It is deliberately a small bridge of its own: the engine's handle ownership is one thing to
 * state, and `engine-native.test.ts`'s fake models the transport in far more detail than that.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AudioEngine } from '../src/player/engine.ts';
import type { EngineOptions, TrackRequest } from '../src/player/engine-contract.ts';
import type { NativeBridge, NativeBridgeEvents, NativeTrackInfo } from '../src/player/native.ts';
import { installFakeClock, stubAudio } from './support/fake-clock.ts';

/** The cadence the poll runs at — `SNAPSHOT_POLL_MS` in `engine.ts`. */
const POLL_MS = 33;

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

const BANDS = Array.from({ length: 64 }, (_, index) => 40 + ((index * 37) % 120));

/** What the one player is doing, as the fake's own state — the thing a snapshot reports. */
interface Player {
  url: string;
  positionMs: number;
  playing: boolean;
}

interface Rig {
  engine: AudioEngine;
  /** Every bridge call this engine made, in order. */
  calls: string[];
  player: Player;
  /** Whether the lock-screen registration was given back (the disposer `listenRemoteCommands` returns). */
  remoteDetached(): boolean;
}

/**
 * One mount of the player: the real engine, a bridge that answers the transport and one snapshot,
 * and the two records a test reads — the calls it made and whether its command registration was
 * returned. Nothing here is mocked inside the engine.
 */
function mount(): Rig {
  const calls: string[] = [];
  const player: Player = { url: '', positionMs: 0, playing: false };
  let events: NativeBridgeEvents | null = null;
  let detached = false;
  const key = (): string => (player.url ? `item:${player.url}` : '');

  const bridge = {
    async load(info: NativeTrackInfo) {
      calls.push('load');
      player.url = info.url;
    },
    async play(seconds: number) {
      calls.push('play');
      player.positionMs = seconds * 1000;
      player.playing = true;
      // The player reports where it is: the engine waits for that before it says "playing".
      events?.onPosition(seconds);
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
      calls.push('seek');
      player.positionMs = seconds * 1000;
    },
    positionMs: () => player.positionMs,
    async sync() {
      calls.push('sync');
      return { playing: player.playing, positionMs: player.positionMs, durationMs: 180_000 };
    },
    async activateSession() {
      calls.push('activateSession');
      return true;
    },
    listenRemoteCommands() {
      return () => {
        detached = true;
      };
    },
    hasNativeSpectrum: true,
    async snapshot() {
      calls.push('snapshot');
      return {
        generation: 0,
        entry: { songId: TRACK.id, index: 0, url: player.url, assetId: 'slot-0', key: key() },
        positionMs: player.positionMs,
        durationMs: 180_000,
        rate: player.playing ? 1 : 0,
        state: player.playing ? 'playing' : 'paused',
        queue: { index: 0, count: 1, repeat: 'off' },
        spectrum: {
          bands: BANDS,
          itemKey: key(),
          frames: 9,
          lastAnalysisAt: Date.now(),
          framePeriodMs: 33,
          attached: true,
        },
      };
    },
  } as unknown as NativeBridge;

  const engine = new AudioEngine({
    platform: { os: 'ios', native: true },
    nativeFactory: (async (_os: string, sink: NativeBridgeEvents) => {
      events = sink;
      return bridge;
    }) as unknown as EngineOptions['nativeFactory'],
  });

  return { engine, calls, player, remoteDetached: () => detached };
}

test('five mounts and five disposes leave no interval and no timeout behind', async () => {
  const clock = installFakeClock();
  const restoreAudio = stubAudio();
  const counts: string[] = [];
  try {
    for (let index = 1; index <= 5; index += 1) {
      const rig = mount();
      await rig.engine.play(TRACK);
      assert.equal(rig.engine.status().state, 'playing', `mount ${index}: the player is playing before it is torn down`);
      assert.equal(clock.intervals(), 1, `mount ${index}: the one poll is the only interval the engine holds`);

      // The poll runs while the screen is up: three periods, three reads, all on one handle.
      rig.calls.length = 0;
      await clock.advance(POLL_MS * 3);
      const polled = rig.calls.filter((call) => call === 'snapshot').length;
      assert.equal(polled, 3, `mount ${index}: three periods of the poll made ${polled} read(s)`);

      rig.engine.dispose();
      assert.equal(clock.intervals(), 0, `mount ${index}: ${clock.intervals()} interval(s) survived dispose()`);
      assert.equal(clock.timeouts(), 0, `mount ${index}: ${clock.timeouts()} timeout(s) survived dispose()`);
      assert.equal(rig.remoteDetached(), true, `mount ${index}: the lock-screen registration was not given back`);

      // A second teardown is not a second one: nothing is left to give back, and nothing throws.
      rig.engine.dispose();
      assert.equal(clock.intervals(), 0);
      assert.equal(clock.timeouts(), 0);

      counts.push(`mount ${index}: 1 interval while playing → 0/0 after dispose()`);
    }
    console.log(`    five mounts, five disposes: ${clock.intervals()} live intervals, ${clock.timeouts()} live timeouts`);
    for (const line of counts) console.log(`    ${line}`);
  } finally {
    clock.restore();
    restoreAudio();
  }
});

test('a hidden engine makes no bridge call over ten poll periods, and one return makes exactly one', async () => {
  const clock = installFakeClock();
  const restoreAudio = stubAudio();
  const rig = mount();
  try {
    await rig.engine.play(TRACK);
    assert.equal(rig.engine.status().state, 'playing', 'the player is playing before he leaves the app');

    await rig.engine.handleVisibility(true);
    assert.equal(clock.intervals(), 0, 'going out of sight stops the one interval');

    rig.calls.length = 0;
    await clock.advance(POLL_MS * 10);
    assert.deepEqual(
      rig.calls,
      [],
      `a hidden engine made ${rig.calls.length} bridge call(s) over ten periods: ${rig.calls.join(', ') || 'none'}`,
    );
    assert.equal(clock.intervals(), 0, 'and nothing re-armed it while it was hidden');

    // The return: one read, and the poll behind it. No immediate second read from the restart.
    await rig.engine.handleVisibility(false);
    assert.deepEqual(
      rig.calls,
      ['snapshot'],
      `the return made ${rig.calls.length} bridge call(s): ${rig.calls.join(', ') || 'none'}`,
    );
    assert.equal(clock.intervals(), 1, 'the poll is back on screen, once');

    rig.calls.length = 0;
    await clock.advance(POLL_MS * 2);
    assert.equal(rig.calls.filter((call) => call === 'snapshot').length, 2, 'and it is reading again at the one cadence');

    console.log(
      `    hidden: 0 bridge calls over 10 × ${POLL_MS} ms, 0 intervals; return: ${1} read immediately, then 2 over 2 periods`,
    );
  } finally {
    rig.engine.dispose();
    clock.restore();
    restoreAudio();
  }
});
