/**
 * **A return to the app is a read of the one player — one bridge call** (unreleased, card
 * `t_975ca852`).
 *
 * The defect this replaces: the row was painted from one reading and the bars from another, so a
 * return could arrive with the transport filled in and 64 zero bars under it — "the row arrives, the
 * bars don't". With one player there is one reading: `NaviliteRemote.snapshot()` answers with the
 * entry the queue is on, the clock, the transport's word **and** that item's own frame, all dated to
 * the same item key. The web layer renders that answer and asks for nothing else.
 *
 * This file drives the real `AudioEngine` over a bridge that answers with exactly that shape, and
 * states the two facts the card is judged on:
 *
 *   1. **exactly one bridge call** while coming back on screen, and it is `snapshot`;
 *   2. the bands the canvas would draw are the frame dated to **the same item key** as the row.
 *
 * It is deliberately a small bridge of its own rather than the large `engine-native.test.ts` fake:
 * that fake models the *previous* architecture (a plugin start/stop per track, a `sync` read on the
 * return), and teaching it the one snapshot would have meant restating every one of its 39 cases.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AudioEngine } from '../src/player/engine.ts';
import type { EngineOptions } from '../src/player/engine-contract.ts';
import type { NativeBridge, NativeBridgeEvents, NativeTrackInfo } from '../src/player/native.ts';
import type { TrackRequest } from '../src/player/engine-contract.ts';

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

/** What the one player is doing, as the fake's own state — the thing a snapshot reports. */
interface Player {
  url: string;
  positionMs: number;
  playing: boolean;
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One bridge, in the shape the app has after S1: no plugin start/stop, no `sync` read on the way
 * back — a transport, and one `snapshot` that answers with everything at once.
 */
function oneBridge(calls: string[], player: Player, events: () => NativeBridgeEvents | null): NativeBridge {
  const key = (): string => (player.url ? `item:${player.url}` : '');
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
    /**
     * **The one read.** Everything the web layer renders, from the same instant: the entry the player
     * is holding, its place in the queue, the clock, the transport's word, and the frame that item's
     * own tap published. `entry.key` and `spectrum.itemKey` are one key minted per item, exactly as
     * `makeItem` mints them on the phone.
     */
    async snapshot() {
      calls.push('snapshot');
      await settle(20); // a real bridge round trip, so nothing here is timing-dependent luck
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
}

test('a foreground return is one read: exactly one bridge call, and the bars are dated to the same item as the row', async () => {
  /*
   * The engine builds its web element in its constructor even on the native path, so the two
   * globals the browser owns have to exist. Nothing in this test plays through them.
   */
  const globals = globalThis as unknown as Record<string, unknown>;
  const previousAudio = globals.Audio;
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

  const calls: string[] = [];
  const player: Player = { url: '', positionMs: 0, playing: false };
  let events: NativeBridgeEvents | null = null;
  const engine = new AudioEngine({
    platform: { os: 'ios', native: true },
    nativeFactory: (async (_os: string, sink: NativeBridgeEvents) => {
      events = sink;
      return oneBridge(calls, player, () => events);
    }) as unknown as EngineOptions['nativeFactory'],
  });

  try {
    await engine.play(TRACK);
    assert.equal(engine.status().state, 'playing', 'the track is playing before he leaves the app');

    // He leaves the app. The poll stops; the player keeps playing to nobody.
    await engine.handleVisibility(true);
    player.positionMs = 42_000;
    calls.length = 0;

    // He comes back. This is the whole of the return: one read.
    await engine.handleVisibility(false);

    assert.deepEqual(
      calls,
      ['snapshot'],
      `the return made exactly one bridge call, the snapshot (it made: ${calls.join(', ') || 'none'})`,
    );

    const status = engine.status();
    assert.equal(status.state, 'playing', 'the transport word is the player’s own');
    /*
     * And so is the clock — `player.currentTime()`, re-anchored on this read. The engine counts wall
     * clock since that anchor while the player is playing, so the claim is the reading itself within
     * one poll, not an equality on a ticking clock (which failed about 1 run in 3).
     */
    assert.ok(
      Math.abs(status.positionMs - 42_000) <= 50,
      `and so is the clock (${Math.round(status.positionMs)} ms against the player's own 42000 ms)`,
    );
    assert.equal(status.tap.entryKey, `item:${TRACK.url}`, 'the row is the item the player is holding');
    assert.equal(status.tap.itemKey, status.tap.entryKey, 'the bars are dated to that same item');

    const bands = engine.spectrumData();
    assert.ok(bands, 'a frame dated to the row is drawn rather than withheld');
    assert.deepEqual(Array.from(bands), BANDS, 'and the values drawn are the ones that item’s own tap produced');

    console.log(
      `    return: 1 bridge call (${calls.join(', ')}), row ${status.tap.entryKey} at ${Math.round(status.positionMs)} ms, ` +
        `bars keyed ${status.tap.itemKey}, ${bands.length} bands from the same answer`,
    );
  } finally {
    await engine.stop();
    await settle(60);
    await engine.stop();
    globals.Audio = previousAudio;
  }
});
