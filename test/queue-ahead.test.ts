/**
 * v1.9.0 — the tap, and the queue it leaves behind.
 *
 * Four things are asserted here, and they are the four the owner's reports are about:
 *
 *   1. **The tap paints before any network work.** `select()` is the synchronous half of a tap —
 *      the row highlight, the title, the artist, the artwork and the loading state — and it must
 *      reach the screen with the engine having been asked for *nothing*. The engine's `play` in
 *      this file does not resolve until the test lets it, so "before the request resolves" is not
 *      a race that happens to be won: it is the state of the world the assertions run in.
 *   2. **A selection states the whole queue to the engine** (v1.9.9) — the resolved play order, the
 *      entry the listener is on, the repeat mode — and asks it for no other track. That statement
 *      is the queue's whole outward contract now: the native side walks it and fetches what it
 *      holds no slot for. **There is no warm look-ahead any more** (unreleased): the app used to
 *      hand the engine the previous song and the next two to prepare, and both halves of that (the
 *      queue's ask and the engine's pool) are gone, so a selection that asks the engine for a
 *      second track is a regression this file can see.
 *   3. **A start is the original file, even on a demoted link.** The ladder measures starts; since
 *      the look-ahead went it decides a readout and nothing else, and a `maxBitRate` in a URL the
 *      app asks for would be a transcode in front of the first note.
 *   4. **A rapid change leaves exactly one fetch in flight, for the item he chose.** Two taps in
 *      quick succession must not leave the abandoned track's stream downloading in the background,
 *      must not re-order the queue, and must not change what is playing.
 *
 * No DOM, no network, no Chrome: the engine and the library are stubs of the surface the queue
 * actually touches, so this runs in milliseconds and cannot be flaky.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackQueue } from '../src/state/queue.ts';
import type { AudioEngine } from '../src/player/engine.ts';
import type { QueueStatement, TrackRequest } from '../src/player/engine-contract.ts';
import type { Library } from '../src/state/library.ts';
import type { QueueContext, Song } from '../src/api/types.ts';

const CONTEXT: QueueContext = { kind: 'playlist', name: 'a playlist' };
const song = (id: string): Song => ({ id, title: `Track ${id}`, artist: 'Someone', album: 'Something', duration: 2 });
const queueOf = (...ids: string[]) => ids.map((id) => ({ song: song(id), context: CONTEXT }));
const urlOf = (id: string): string => `http://127.0.0.1:4599/rest/stream?id=${id}`;

/**
 * The engine, reduced to what the queue uses. `play` returns a promise the test holds, which is
 * how a slow link is represented without a network: nothing resolves until the test says so.
 */
function stubEngine(): {
  engine: AudioEngine;
  plays: TrackRequest[];
  /** Every statement of the queue the engine was given (v1.9.9) — the queue's outward contract. */
  statements: QueueStatement[];
  /** Make the next start report no sound at all, which is what demotes the ladder (v1.9.9). */
  failNextStart: () => void;
  releasePlay: () => void;
} {
  const plays: TrackRequest[] = [];
  const statements: QueueStatement[] = [];
  let engineState: 'idle' | 'playing' = 'idle';
  let release: (() => void) | null = null;
  /** Whether the next start ends without sound — one rung down the ladder (v1.9.9). */
  let fails = false;
  const engine = {
    onEnded: null as null | (() => void),
    onProgress: null as null | ((positionMs: number, durationMs: number) => void),
    onNextRequested: null as null | (() => void),
    onPreviousRequested: null as null | (() => void),
    status: () => ({
      state: engineState,
      backend: 'web',
      spectrum: false,
      modeReason: '',
      positionMs: 0,
      durationMs: 0,
      error: null,
      nativeAvailable: false,
    }),
    play: (track: TrackRequest) => {
      plays.push(track);
      return new Promise<void>((resolve) => {
        release = () => {
          engineState = 'playing';
          resolve();
        };
      });
    },
    /** The queue's statement, recorded whole: it is what the native side would be told to walk. */
    setQueue: (statement: QueueStatement) => {
      statements.push({ list: [...statement.list], index: statement.index, repeat: statement.repeat });
    },
    /**
     * The engine's own answer to "did that start produce sound" (v1.9.2), and the one measurement
     * the ladder is allowed to be fed. `failNextStart` below is how a start that produced nothing is
     * modelled — the case that demotes the ladder one rung.
     */
    startDidFail: () => fails,
    lastStartOutcome: () => (fails ? ('timeout' as const) : ('player' as const)),
    retryPlayInPlace: async () => {
      // The retry is the same item asked again: it produces sound, so the start is not a failure.
      fails = false;
      return true;
    },
    pause: async () => {},
    seek: async () => {},
    resume: async () => {},
    stop: async () => {},
    toggle: async () => {},
  };
  return {
    engine: engine as unknown as AudioEngine,
    plays,
    statements,
    failNextStart: () => {
      fails = true;
    },
    releasePlay: () => release?.(),
  };
}

/** The library, reduced to what the queue uses. `streamUrl` honours a cap, so a cap would show. */
function stubLibrary(): { library: Library } {
  const library = {
    crossOrigin: false,
    coverUrl: () => null,
    streamUrl: (track: Song, maxBitRate?: number | null) =>
      maxBitRate == null ? urlOf(track.id) : `${urlOf(track.id)}&maxBitRate=${maxBitRate}`,
    client: { scrobble: async () => undefined, savePlayQueue: async () => undefined },
  };
  return { library: library as unknown as Library };
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test('a tap paints the selection and the loading state before anything is requested', async () => {
  const { engine, plays, releasePlay } = stubEngine();
  const { library } = stubLibrary();
  const queue = new PlaybackQueue(engine, library);
  let paints = 0;
  queue.onChanged = () => {
    paints += 1;
  };

  // The tap, and only the tap: `select` is the synchronous half.
  queue.select(queueOf('song-1', 'song-2'), 0, CONTEXT);

  assert.equal(queue.currentSong?.id, 'song-1', 'the row he touched is the song on screen');
  assert.equal(queue.isLoading, true, 'and it is drawn in its loading state');
  assert.ok(paints > 0, 'the screen was redrawn by the tap itself');
  assert.equal(plays.length, 0, 'and nothing had been asked of the engine yet — no fetch, no I/O');

  void queue.start();
  await tick();
  assert.equal(plays.length, 1, 'the request for the stream follows the paint, not the other way round');
  assert.equal(plays[0]!.url, urlOf('song-1'), 'and it is the stream of the track he tapped, asked for as the original file — no maxBitRate, so no transcode in front of the first note');
  assert.equal(plays[0]!.url.includes('maxBitRate'), false, 'the tap path carries no bitrate parameter at all');
  assert.equal(queue.isLoading, true, 'still loading while the engine has not answered');

  releasePlay();
  await tick();
  await tick();
  assert.equal(queue.isLoading, false, 'the loading state comes off when the engine has the stream');
});

test('a selection states the whole queue to the engine, and asks it for no other track', async () => {
  const { engine, releasePlay, plays, statements } = stubEngine();
  const { library } = stubLibrary();
  const queue = new PlaybackQueue(engine, library);

  void queue.play(queueOf('song-1', 'song-2', 'song-3'), 0, CONTEXT);
  await tick();
  releasePlay();
  await tick();
  await tick();

  /*
   * The statement is the queue's whole outward contract now: every entry of the resolved order, in
   * the order it will be played, the entry the listener is on, and the rules. No entry carries a
   * `maxBitRate` — an entry is only ever a URL the native side could fetch as it sits on the server.
   */
  const last = statements.at(-1)!;
  assert.deepEqual(last.list.map((entry) => entry.songId), ['song-1', 'song-2', 'song-3'], 'the resolved order, whole');
  assert.deepEqual(last.list.map((entry) => entry.url), ['song-1', 'song-2', 'song-3'].map(urlOf), 'each entry as the file sits on the server');
  assert.equal(last.index, 0, 'and the entry he is on');
  assert.equal(last.repeat, 'off', 'with the repeat mode the queue is actually in');
  assert.equal(last.list[0]!.title, 'Track song-1', 'with the metadata the lock-screen card will need');

  /*
   * v1.9.5's warm look-ahead is gone (unreleased), both halves: the queue no longer asks the engine
   * to prepare anything, and the engine no longer holds a pool. One play, then, is one request —
   * three tracks in the queue and the engine asked for exactly the one that is playing.
   */
  assert.equal(plays.length, 1, 'the engine was asked for the track playing, and for nothing around it');
  assert.equal(queue.currentSong?.id, 'song-1', 'and none of this changed what is playing');
});

test('a start on a demoted link is still the original file', async () => {
  /*
   * The owner's rule, in his words: *"transcoding is slow heavy work if possible avoid it if it leads
   * to delays there should be no need to transcode the songs unless it's being done while another
   * song is playing so it doesn't affect the user experience"*. The ladder is driven one rung down
   * here by a start that produced no sound, and what is asserted is that the rung reaches no URL: the
   * lookup a tap makes is the track's own file, and so is every entry of the published statement.
   */
  const { engine, releasePlay, plays, failNextStart, statements } = stubEngine();
  const { library } = stubLibrary();
  const queue = new PlaybackQueue(engine, library);

  failNextStart();
  void queue.play(queueOf('song-1', 'song-2', 'song-3'), 0, CONTEXT);
  await tick();
  releasePlay();
  await tick();
  await tick();

  assert.ok(queue.streamKbps !== null, 'the start that produced no sound demoted the ladder');
  assert.equal(plays.length, 1, 'the retry is in place, so the rejected track was not fetched again');
  assert.equal(plays[0]!.url, urlOf('song-1'), 'and the track he is waiting for was asked for as the original file');
  assert.deepEqual(
    statements.at(-1)!.list.map((entry) => entry.url),
    ['song-1', 'song-2', 'song-3'].map(urlOf),
    'nor does the rung reach the queue the native side would walk',
  );
});

test('ten taps in a row each paint the row he touched, and the waiting state never clears itself', async () => {
  const { engine, releasePlay } = stubEngine();
  const { library } = stubLibrary();
  const queue = new PlaybackQueue(engine, library);
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  const items = queueOf(...ids);
  const painted: string[] = [];
  let paints = 0;
  queue.onChanged = () => {
    paints += 1;
  };

  for (let i = 0; i < ids.length; i += 1) {
    /*
     * The tap: `select` is synchronous and this read happens in the same turn — no await between
     * them, so what is read is what the screen was given.
     */
    queue.select(items, i, CONTEXT);
    painted.push(queue.currentSong?.id ?? 'nothing');
    assert.equal(queue.isLoading, true, `tap ${i + 1}: the row is drawn as waiting`);
    void queue.start();
    releasePlay();
    await tick();
    await tick();
    assert.equal(queue.isLoading, false, `tap ${i + 1}: and it settles when the engine answers`);
  }

  assert.deepEqual(painted, ids, `${ids.length} consecutive taps, ${painted.length} painted selections`);
  assert.ok(paints >= ids.length * 2, `every tap repainted the screen — ${paints} repaints for ${ids.length} taps`);
});

test('a second tap on the row whose load is still in flight is not a missed tap', async () => {
  const { engine, releasePlay, plays, statements } = stubEngine();
  const { library } = stubLibrary();
  const queue = new PlaybackQueue(engine, library);
  const items = queueOf('song-1', 'song-2');

  queue.select(items, 0, CONTEXT);
  void queue.start();
  await tick();
  assert.equal(plays.length, 1, 'the first tap asked the engine for the stream');
  const publishedByTheTap = statements.length;

  // …and he taps the same row again, while that load has not answered.
  queue.select(items, 0, CONTEXT);
  void queue.start();
  await tick();
  assert.equal(plays.length, 1, 'the second tap is the same request, not a second one');
  assert.equal(queue.isLoading, true, 'and the row stays drawn as waiting rather than settling on the instant');
  assert.equal(statements.at(-1)!.index, 0, 'the queue is still stated on the row he touched');

  releasePlay();
  await tick();
  await tick();
  assert.equal(queue.isLoading, false, 'the state comes off when the load it was waiting for answers');
  assert.equal(queue.currentSong?.id, 'song-1', 'and what is playing is the row he touched');
  assert.ok(statements.length >= publishedByTheTap, 'the statement was never left on a different row');
});

test('a rapid double tap re-states the queue on the row he chose, and asks for nothing else', async () => {
  const { engine, releasePlay, plays, statements } = stubEngine();
  const { library } = stubLibrary();
  const queue = new PlaybackQueue(engine, library);

  // He taps track 1: its stream starts, and the queue is stated as being on track 1.
  queue.select(queueOf('song-1', 'song-2', 'song-3'), 0, CONTEXT);
  void queue.start();
  await tick();
  releasePlay();
  await tick();
  await tick();
  assert.equal(statements.at(-1)!.index, 0, 'the queue is stated on the track he chose');

  // …and immediately taps track 2, before anything resolved.
  queue.select(queueOf('song-1', 'song-2', 'song-3'), 1, CONTEXT);
  void queue.start();
  await tick();
  releasePlay();
  await tick();
  await tick();

  /*
   * The second selection re-states the same list at the new position — one statement per move, and
   * a whole list every time, so the native side never holds a picture of a queue the listener has
   * left. Two taps are two requests for sound; there is no warm ask left to make a third.
   */
  const last = statements.at(-1)!;
  assert.deepEqual(last.list.map((entry) => entry.songId), ['song-1', 'song-2', 'song-3'], 'the same queue, whole');
  assert.equal(last.index, 1, 'stated on the track he is on now');
  assert.equal(plays.length, 2, 'and the engine was asked for the two tracks he tapped — nothing around them');
  assert.equal(queue.currentSong?.id, 'song-2', 'what is playing is what he chose');
  assert.equal(queue.position, 1, 'and the queue is in the order he left it in');
});
