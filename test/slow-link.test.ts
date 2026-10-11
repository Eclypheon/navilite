/**
 * v1.9.0 — the slow link, and the two ways the app answers it.
 *
 * The owner's bar for this release is *"performant enough to run smoothly on mobile data … the load
 * times should be nigh imperceptible"*, and off wifi his phone reaches the house through a relay:
 * desktop-class latency, mobile-class throughput. Two client-side answers, neither of which needs a
 * server change or a minute of downtime:
 *
 *   - **`maxBitRate` on the stream request.** Subsonic streams the original unless the client says
 *     otherwise; Navidrome transcodes on demand. It is *never* a silent cap: it starts modest on an
 *     unmeasured link, rises when the app has measured the link doing better, disappears entirely
 *     when the link is fast (the original plays), and while it is in force the player bar prints the
 *     number (`queue.streamKbps`, the chip).
 *   - **queue-ahead**, which is `test/queue-ahead.test.ts` — on a high-latency link the number of
 *     round trips matters more than the bandwidth.
 *
 * Everything here is pure or URL-shaped, so it runs in milliseconds and cannot be flaky.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BITRATE_LADDER, ByteRate, STARTING_KBPS, chooseMaxBitRate, kbpsOf } from '../src/state/bitrate.ts';
import { Library } from '../src/state/library.ts';
import { SubsonicClient } from '../src/api/subsonic.ts';
import type { Song } from '../src/api/types.ts';

// The client reads `location` to decide whether a deployment is cross-origin.
(globalThis as unknown as { location: { origin: string } }).location = { origin: 'https://navilite.example' };

/** 10 KB in 400 ms is 200 kbps — a phone on a relay, in one sample. */
const SLOW = { bytes: 10_000, ms: 400 };
/** 250 KB in 400 ms is 5000 kbps — wifi, comfortably past the top of the ladder. */
const FAST = { bytes: 250_000, ms: 400 };

const song = (id: string): Song => ({ id, title: `Track ${id}`, duration: 2 });

test('an unmeasured link starts modest, and says so rather than guessing fast', () => {
  assert.equal(chooseMaxBitRate([]), STARTING_KBPS, 'nothing measured yet is not a licence to ask for the original');
  assert.ok(STARTING_KBPS < BITRATE_LADDER[BITRATE_LADDER.length - 1]!, 'and the start is not the top of the ladder');
  // Every stream request therefore carries the parameter — see test/queue-ahead.test.ts, which
  // asserts the URL a real tap produces.
  const url = new URL(new Library(new SubsonicClient({ serverUrl: 'https://navilite.example', username: 'k', password: 'p' })).streamUrl(song('song-1'), STARTING_KBPS));
  assert.equal(url.searchParams.get('maxBitRate'), String(STARTING_KBPS));
});

test('a measured slow link is asked to transcode; a measured fast one is not', () => {
  const slow = chooseMaxBitRate([SLOW]);
  assert.equal(kbpsOf(SLOW), 200, 'the sample says 200 kbps');
  assert.equal(slow, 96, 'and the app asks for 96 kbps — below what the link measured, with room to buffer');
  assert.ok((slow ?? 0) < 200, 'never more than the link was measured doing');

  assert.equal(chooseMaxBitRate([FAST]), null, 'a fast link gets the original: no cap, nothing transcoded');
  assert.equal(chooseMaxBitRate([SLOW, FAST]), 96, 'and one slow sample is enough to keep the cap in force');
});

test('the window keeps the recent link, and refuses samples that cannot describe one', () => {
  const rate = new ByteRate();
  assert.equal(rate.effectiveKbps, null, 'nothing measured: no number to show');
  assert.equal(rate.count, 0);
  const client = new SubsonicClient({ serverUrl: 'https://navilite.example', username: 'k', password: 'p' });
  const library = new Library(client);
  for (const sample of [SLOW, SLOW, SLOW, SLOW, SLOW, SLOW, FAST]) rate.add(sample);
  assert.equal(rate.count, 5, 'the window is bounded — an hour-old sample is not where you are now');
  assert.equal(rate.effectiveKbps, 200, 'so the median is still the slow link, not the one fast transfer');
  assert.equal(rate.maxBitRate, 96);
  // Nothing honest to measure: a cached answer (too fast), an empty body, a broken one.
  for (const sample of [{ bytes: 0, ms: 400 }, { bytes: 50_000, ms: 2 }, { bytes: Number.NaN, ms: 400 }]) {
    assert.equal(kbpsOf(sample), null, `${JSON.stringify(sample)} is not a measurement of the link`);
    rate.add(sample);
  }
  assert.equal(rate.count, 5, 'so none of them entered the window');
  assert.equal(library.streamUrl(song('song-1')).includes('maxBitRate'), false, 'no cap means the original file, and no parameter at all');
  assert.equal(new URL(library.streamUrl(song('song-1'), 96)).searchParams.get('maxBitRate'), '96');
});
