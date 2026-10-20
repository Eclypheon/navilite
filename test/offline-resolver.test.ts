/**
 * §S1 — the resolver: `Library.streamUrl` is the one place a track's URL is decided, and it now
 * consults the offline resolver first.
 *
 *   - a complete row → a `file://` path, and `maxBitRate` is ignored (a local file is already a
 *     file; asking for a transcode of it is meaningless);
 *   - no row → the Subsonic URL, byte-for-byte the same as before this change (string equality
 *     against `client.streamUrl`);
 *   - recovery (§6 E3): the resolver answers with that path — it is synchronous and never touches
 *     the filesystem, so a missing file cannot throw here and cannot be noticed here either. What
 *     notices is a **start that produced no sound for a `file://` track**: the queue reports it
 *     (`onLocalFileUnplayable`) and the store voids the row (`OfflineStore.voidMissingFile`), so
 *     the *next* start of that song resolves to the stream instead of the file that is not there.
 *     v1.9.17 is what added that. This header used to claim "the existing failure branch in the
 *     engine is what falls back to the stream", which named a code path that did not exist in the
 *     app at all — a downloaded track whose file had gone played nothing for ever, and the only
 *     way out was deleting the download. The claim was the bug's other half; the assertion below
 *     is now the shape of the code.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Library } from '../src/state/library.ts';
import { PlaybackQueue } from '../src/state/queue.ts';
import { SubsonicClient } from '../src/api/subsonic.ts';
import type { AudioEngine } from '../src/player/engine.ts';
import type { TrackRequest } from '../src/player/engine-contract.ts';
import type { QueueContext, Song } from '../src/api/types.ts';

const song: Song = { id: 'abc123', title: 'A track', artist: 'Someone', duration: 231 };
const context: QueueContext = { kind: 'playlist', name: 'a playlist' };
const client = new SubsonicClient({ serverUrl: 'https://music.example.com', username: 'u', password: 'p' });

test('a complete row resolves to a file path and ignores maxBitRate', () => {
  const library = new Library(client, (id) => (id === song.id ? 'file:///path/to/abc123.flac' : null));
  assert.equal(library.streamUrl(song, 128), 'file:///path/to/abc123.flac');
  assert.equal(library.streamUrl(song, undefined), 'file:///path/to/abc123.flac');
});

test('no row returns the unchanged Subsonic URL, byte for byte', () => {
  const library = new Library(client, () => null);
  assert.equal(library.streamUrl(song), client.streamUrl(song.id));
  // And with a bitrate cap, the cap still reaches the stream URL.
  assert.equal(library.streamUrl(song, 128), client.streamUrl(song.id, { maxBitRate: 128 }));
});

test('the default resolver is null-safe: an unhydrated index returns the stream URL, never undefined', () => {
  const library = new Library(client);
  assert.equal(typeof library.streamUrl(song), 'string');
  assert.equal(library.streamUrl(song), client.streamUrl(song.id));
});

/**
 * The engine, reduced to the two answers the failed-start path reads. `startDidFail` is true — the
 * player got the file and produced no sound — and the in-place retry (v1.9.8) produces no sound
 * either, which is what makes the failure final for this attempt.
 */
function engineWithoutSound(played: string[]): AudioEngine {
  return {
    onEnded: null,
    onProgress: null,
    onNextRequested: null,
    onPreviousRequested: null,
    status: () => ({
      state: 'idle',
      backend: 'web',
      spectrum: false,
      modeReason: '',
      positionMs: 0,
      durationMs: 0,
      error: null,
      nativeAvailable: false,
    }),
    play: async (track: TrackRequest) => void played.push(track.url),
    startDidFail: () => true,
    lastStartOutcome: () => 'timeout' as const,
    retryPlayInPlace: async () => false,
    warmedUrl: () => null,
    pruneWarmed: () => undefined,
    discardPrepared: async () => undefined,
    prepareNext: async () => true,
    setQueue: () => undefined,
    pause: async () => undefined,
    resume: async () => undefined,
    stop: async () => undefined,
    seek: async () => undefined,
    toggle: async () => undefined,
  } as unknown as AudioEngine;
}

test('a start that produced no sound for a downloaded track voids the row, so the next start is the stream', async () => {
  /*
   * §6 E3 recovery, and the direction the other tests must not break: the row here names a file that
   * has gone. What is asserted is that this is not the end of the song — the resolution for the
   * start that is in flight is still the file (synchronously, without throwing), the failure is
   * reported as the evidence it is, the row stops being a copy to play, and the next resolution is
   * the Subsonic URL. The `local` flip is `OfflineStore.voidMissingFile`'s effect on the index.
   */
  let local: string | null = 'file:///gone/abc123.mp3';
  const library = new Library(client, (id) => (id === song.id ? local : null));
  const played: string[] = [];
  const voided: string[] = [];
  const queue = new PlaybackQueue(engineWithoutSound(played), library, {
    onLocalFileUnplayable: (songId) => {
      voided.push(songId);
      local = null;
    },
  });

  assert.equal(library.streamUrl(song), 'file:///gone/abc123.mp3', 'the dead row still resolves the start that is already in flight');

  await queue.play([{ song, context }], 0, context);
  assert.equal(played[0], 'file:///gone/abc123.mp3', 'and that file URL is exactly what the start that produced no sound was asked for');
  assert.deepEqual(voided, [song.id], 'the failed start is the one signal that the file has gone, and it is reported for that song');
  assert.equal(library.streamUrl(song), client.streamUrl(song.id), 'so the next start of that song is the stream — the song is not left unplayable');
});

test('a failed start for a streamed track voids nothing: there is no download row in it', async () => {
  // The same failing engine, a library with no offline copy — the guard is the URL scheme, so a
  // link or a server that would not start is not mistaken for a file that has gone.
  const library = new Library(client, () => null);
  const played: string[] = [];
  const voided: string[] = [];
  const queue = new PlaybackQueue(engineWithoutSound(played), library, {
    onLocalFileUnplayable: (songId) => void voided.push(songId),
  });

  await queue.play([{ song, context }], 0, context);
  assert.equal(played[0], client.streamUrl(song.id), 'the start that failed was a stream');
  assert.deepEqual(voided, [], 'and no download row was touched by it');
});
