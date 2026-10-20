/**
 * **The label and the sound cannot disagree (ported from beta.28 onto the pre-island tree).**
 *
 * The owner's report is not two players sounding to begin with: it is a press that moved the label
 * while the phone went on sounding the entry that was already playing — and then a foreground start
 * that began the entry the label named, at the other track's position. The island and the app bar
 * both render the app's state, so their agreement proved nothing; only the **player's own**
 * `currentItem` is evidence of what is sounding.
 *
 * The model driven here is `src/player/audio-owner.ts`'s `labelAfterPress`, which is the mirror of
 * what `NaviliteRemote.swift`'s `awayManualAdvance` does at the queue: the label is written from
 * `queueSoundingEntry()` — the queue's own item — and a press the queue did not follow leaves the
 * label exactly where it was.
 *
 * What this test cannot do is hear the phone; it claims the decision, which is the part that had the
 * bug. The last test ties the model to the Swift that the phone actually runs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { labelAfterPress } from '../src/player/audio-owner.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const swift = readFileSync(join(root, 'ios', 'App', 'App', 'NaviliteRemote.swift'), 'utf8');

test('a press the player did not follow leaves the label on the entry that is sounding', () => {
  /*
   * The defect, as one call: the press asked for `yama`, the player stayed on `young-girl-a`.
   * Moving the label here is how it ends up naming a track nothing is playing — and how the next
   * foreground start begins that track over the one that is.
   */
  const press = labelAfterPress({
    before: 'young-girl-a',
    intended: 'yama',
    sounding: 'young-girl-a',
    running: true,
  });
  assert.equal(press.label, 'young-girl-a');
  assert.equal(press.moved, false);
  assert.match(press.why, /the press was refused, not taken/);
});

test('a press the player did follow moves the label with the sound', () => {
  const press = labelAfterPress({ before: 'young-girl-a', intended: 'yama', sounding: 'yama', running: true });
  assert.equal(press.label, 'yama');
  assert.equal(press.moved, true);
});

test('nothing sounding never moves the label onto an entry that did not play', () => {
  const silent = labelAfterPress({ before: 'young-girl-a', intended: 'yama', sounding: null, running: false });
  assert.equal(silent.label, 'young-girl-a');
  assert.equal(silent.moved, false);

  // An unmappable answer ("running, but I cannot name it") is not a move either.
  const unknown = labelAfterPress({ before: 'young-girl-a', intended: 'yama', sounding: null, running: true });
  assert.equal(unknown.label, 'young-girl-a');
  assert.equal(unknown.moved, false);
});

test('the phone asks the PLAYER which entry is sounding, and moves the label only after it answered', () => {
  /*
   * `awayManualAdvance` is where the queue is asked to take a press it was named on. It reads the
   * queue's own `currentItem` (`queueSoundingEntry`), not the cursor it was handed, and it says so
   * on the press line when the queue did not move.
   */
  const from = swift.indexOf('private func awayManualAdvance');
  assert.ok(from > 0, 'awayManualAdvance is the door a press on the away queue goes through');
  const body = swift.slice(from, swift.indexOf('private func rebuildAwayQueue', from));
  assert.ok(body.includes('queueSoundingEntry()'), 'the label is read from the queue’s own item');
  assert.ok(body.includes('the label stays where the sound is'), 'a refused press says the label stayed');
});
