/**
 * The away boundary as AVFoundation's own advance — the three facts the owner's log made mandatory.
 *
 * The log (beta.16, build 64) shows the route that had to be abandoned: `ahead-issued` with
 * `awake:false`, a slot that never held an item (`buffered:0`), a reload per attempt that bumped the
 * generation, and a seam that then paid a cold fetch it could not complete. What replaces it is a real
 * queue whose entries are attached while the app is awake, so the boundary is the platform advancing
 * to an item it already holds. These tests drive the model in `src/player/away-queue.ts`, which states
 * the same rules `NaviliteRemote.swift` implements, and each one is a defect the phone would show:
 *
 *   1. **a seam that advances from the queue issues no fetch** — three boundaries in a row, all
 *      `path: "queue"`, `fetches` still empty (the 19.7 s `end`→`boundary` was a fetch);
 *   2. **a queue whose next item will not load falls back to the fetch path and reports it** — the
 *      boundary is still taken, and the line carries the reason rather than silence;
 *   3. **cancelling a queued-but-not-playing entry does not leave it attached** — a cancelled track
 *      must not stay in a player that would still sound it later.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attachedFor,
  awayPlan,
  crossAwayBoundary,
  decideAwaySeam,
  nextTarget,
  queueHolds,
  type AwayEntry,
  type AwaySeamState,
  type AwayStatement,
} from '../src/player/away-queue.ts';

const entry = (songId: string): AwayEntry => ({ songId, url: `http://127.0.0.1:4599/rest/stream?id=${songId}` });
const order = (...ids: string[]): AwayStatement => ({ list: ids.map(entry), index: 0, repeat: 'off' });

/** A statement prepared the way the native side prepares it: the tail attached, nothing sounded yet. */
const armed = (statement: AwayStatement): AwaySeamState => ({
  attached: attachedFor(statement),
  cursor: -1,
  owned: false,
  fetches: [],
});

test('the queue holds the entries after the one playing, and nothing before it', () => {
  const statement = order('a', 'b', 'c', 'd', 'e');
  assert.deepEqual(attachedFor(statement), ['b', 'c']);
  assert.deepEqual(awayPlan({ ...statement, index: 3 }), [entry('e')]);
  // Repeat off at the end of the order: there is nothing to attach, and the seam says so.
  assert.deepEqual(attachedFor({ ...statement, index: 4 }), []);
  // Repeat all wraps, which is what the queue's own advance does.
  assert.deepEqual(attachedFor({ ...statement, index: 4, repeat: 'all' }), ['a', 'b']);
});

test('a seam that advances from the queue issues no fetch', () => {
  let statement = order('a', 'b', 'c', 'd');
  let state = armed(statement);
  const paths: string[] = [];

  /* Three boundaries in a row with the app away: no fetch on any of them. */
  for (let i = 0; i < 3; i += 1) {
    const crossed = crossAwayBoundary({ statement, state });
    assert.equal(crossed.decision.kind, 'queue');
    assert.equal(crossed.state.fetches.length, 0);
    paths.push(crossed.path);
    state = crossed.state;
    statement = { ...statement, index: crossed.decision.target };
  }

  assert.deepEqual(paths, ['queue', 'queue', 'queue']);
  assert.deepEqual(state.fetches, []);
  // It moved through the order by itself: a, b, c, d — the fourth entry is playing.
  assert.equal(statement.index, 3);
});

test('the queue that owns the sound is never asked to fetch on a later boundary', () => {
  const statement = order('a', 'b', 'c');
  const state: AwaySeamState = { attached: ['b', 'c'], cursor: 0, owned: true, fetches: [] };
  // AVFoundation has already advanced to `c`: the boundary is a fact, not an instruction.
  const decision = decideAwaySeam({ statement: { ...statement, index: 1 }, state });
  assert.equal(decision.kind, 'queue');
  assert.equal(decision.kind === 'queue' && decision.songId, 'c');
});

test('a queue whose next item will not load falls back to the fetch path and reports it', () => {
  const statement = order('a', 'b', 'c');
  const state = armed(statement);
  const crossed = crossAwayBoundary({ statement, state, failed: new Set(['b']) });

  assert.equal(crossed.decision.kind, 'fetch');
  assert.equal(crossed.path, 'fetch');
  // The fallback is reported with the entry and the reason — never a silent stop.
  assert.equal(crossed.decision.kind === 'fetch' && crossed.decision.songId, 'b');
  assert.match(crossed.decision.kind === 'fetch' ? crossed.decision.why : '', /would not load/);
  // And the entry it could not play is the one recorded as fetched, so the log can name it.
  assert.deepEqual(crossed.state.fetches, ['b']);
  // The queue stops owning the sound, which is what lets the existing fetch path take the boundary.
  assert.equal(crossed.state.owned, false);
});

test('a queue that does not hold the entry the boundary needs falls back rather than guessing', () => {
  const statement = order('a', 'b', 'c');
  const decision = decideAwaySeam({ statement, state: { attached: [], cursor: -1, owned: false, fetches: [] } });
  assert.equal(decision.kind, 'fetch');
  assert.match(decision.kind === 'fetch' ? decision.why : '', /does not hold/);
});

test('cancelling a track that is queued but not yet playing does not leave it attached', () => {
  const statement = order('a', 'b', 'c', 'd');
  assert.deepEqual(attachedFor(statement), ['b', 'c']);

  // The app cancels `b` (a warm slot it gave up, or an entry taken out of the order) and re-states.
  const cancelled: AwayStatement = { ...statement, list: statement.list.filter((item) => item.songId !== 'b') };
  assert.deepEqual(attachedFor(cancelled), ['c', 'd']);

  // And the seam no longer offers `b`: the boundary goes where the statement now points.
  const crossed = crossAwayBoundary({ statement: cancelled, state: armed(statement) });
  assert.equal(crossed.decision.kind, 'fetch');
  assert.equal(crossed.decision.kind === 'fetch' && crossed.decision.songId, 'c');
});

test('the next entry of the order, with repeat off, all and one', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(nextTarget({ list: ids.map(entry), index: 0, repeat: 'off' }), 1);
  assert.equal(nextTarget({ list: ids.map(entry), index: 2, repeat: 'off' }), -1);
  assert.equal(nextTarget({ list: ids.map(entry), index: 2, repeat: 'all' }), 0);
  assert.equal(nextTarget({ list: ids.map(entry), index: 2, repeat: 'one' }), 2);
  assert.equal(nextTarget({ list: ids.map(entry), index: -1, repeat: 'off' }), -1);
});

/*
 * The rework after Sage's send-back on c7b4c72. Each of these is a state the phone reaches and the
 * old model could not describe; the first two are the ones that produced silence.
 */

test('a dead item inside the owned queue takes the fetch path rather than stopping', () => {
  /*
   * `AVQueuePlayer` stops at an item that will not play and posts no end-of-item notification, so the
   * owned state used to answer `queue` unconditionally and the boundary never ran at all. The reading
   * that decides it is the item's own failure — `status == .failed`, or
   * `AVPlayerItemFailedToPlayToEndTime` arriving for it — and it must be asked before ownership.
   */
  const statement = order('a', 'b', 'c');
  const state: AwaySeamState = { attached: ['b', 'c'], cursor: 0, owned: true, fetches: [] };
  const crossed = crossAwayBoundary({ statement: { ...statement, index: 0 }, state, failed: new Set(['b']) });

  assert.equal(crossed.path, 'fetch');
  assert.equal(crossed.decision.kind === 'fetch' && crossed.decision.songId, 'b');
  assert.match(crossed.decision.kind === 'fetch' ? crossed.decision.why : '', /would not load/);
  assert.deepEqual(crossed.state.fetches, ['b']);
  // The queue stops owning the sound, so only the fetch path's player can make it.
  assert.equal(crossed.state.owned, false);
});

test('a drained queue still advances: no boundary answers `queue` without holding the entry', () => {
  /*
   * Three routes drain it — repeat-all at the last entry (the wrapped entry was never attached), a
   * top-up that added nothing, and any boundary before a top-up ran. Every one of them used to end in
   * `end-ignored` against the synthetic slot name, with no fetch, no advance and no card change.
   */
  const statement = order('a', 'b', 'c');
  // The queue owns `c`, and holds nothing after it: the wrap a repeat-all boundary would need.
  const state: AwaySeamState = { attached: ['b', 'c'], cursor: 1, owned: true, fetches: [] };
  const wrapped = crossAwayBoundary({ statement: { ...statement, index: 2, repeat: 'all' }, state });
  assert.equal(wrapped.path, 'fetch');
  assert.match(wrapped.decision.kind === 'fetch' ? wrapped.decision.why : '', /drained/);
  // And it still names the entry the boundary needs, so the fetch is for the right track.
  assert.equal(wrapped.decision.kind === 'fetch' && wrapped.decision.songId, 'a');

  // Nothing attached at all, repeat off: also a live path, never a silent stop.
  const empty: AwaySeamState = { attached: [], cursor: 0, owned: true, fetches: [] };
  const decision = decideAwaySeam({ statement: { ...statement, index: 0 }, state: empty });
  assert.equal(decision.kind, 'fetch');
});

test('an entry cancelled while the queue owns the sound is not left attached to sound later', () => {
  /*
   * While owned, the statement may only top up — rebuilding would stop the audible track — so the
   * replace rule has to work on the attached tail instead: what is no longer in the plan is a
   * cancellation, and it must come out of the queue rather than play at a later boundary.
   */
  const statement = order('a', 'b', 'c', 'd');
  const state: AwaySeamState = { attached: ['b', 'c'], cursor: 0, owned: true, fetches: [] };

  // The app takes `c` out of the order while `b` is sounding from the queue.
  const cancelled: AwayStatement = { ...statement, index: 1, list: statement.list.filter((item) => item.songId !== 'c') };
  const plan = awayPlan(cancelled).map((held) => held.songId);
  assert.deepEqual(plan, ['d']);
  assert.ok(!plan.includes('c'));

  // The keep-list the native top-up removes against: only `d` may stay attached after the cursor.
  const kept = state.attached.slice(Math.max(state.cursor + 1, 0)).filter((id) => plan.includes(id));
  assert.deepEqual(kept, []);
});

test('the look-ahead does not fetch an entry the queue already holds', () => {
  /*
   * `preloadAhead` ran on every `awake:false` statement while `armAwayQueue` attached the same URL, so
   * the next track was decoded twice over one connection — and the loser was the boundary.
   */
  const statement = order('a', 'b', 'c', 'd');
  const armedState = armed(statement);
  assert.equal(queueHolds(armedState, 'b'), true);
  assert.equal(queueHolds(armedState, 'd'), false);

  // Once `b` is the one sounding, it is no longer a look-ahead target; `c` still is.
  const sounding: AwaySeamState = { ...armedState, cursor: 0, owned: true };
  assert.equal(queueHolds(sounding, 'b'), false);
  assert.equal(queueHolds(sounding, 'c'), true);
});
