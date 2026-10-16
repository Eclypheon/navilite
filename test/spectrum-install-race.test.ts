/**
 * v1.9.22 — the native half of the owner's rapid-skip flatline, held where it can be held.
 *
 * The defect: *"sometimes when I move through songs too quickly it seems like the spectrum doesn't
 * attach correctly to the song and so while the song is playing the spectrum is just zero"* — and,
 * asked, *"the spectrum off is not intentional, i have never toggled spectrum to be off so it is a
 * bug."*
 *
 * `NaviliteSpectrum.install` reads `player.currentItem`, then `await`s that item's own track list
 * (`AudibleSpectrumTap.audioTrack`, async, and up to `trackWaitSeconds` — five seconds — for a
 * stream that is being replaced), and then attaches to the item it read. The generation guard that
 * exists is checked **before** that read, so a request whose wait outlasted a track change attached
 * to the item the player had left — and `attach` opens with `detach()`, which takes the mix off the
 * item that *is* playing. `itemIsCurrent` then reads false for the whole track: no frames, and the
 * canvas handed nothing while the audio played.
 *
 * This file reads the native source, because the race needs a real `AVPlayer` and a real item
 * replacement to happen — the same reason `test/local-file-spectrum.test.ts` reads it. It is a
 * source-shape check and says so: what it pins is that **both** conditions are re-tested between the
 * await and the attach, and that the attach is reachable only from inside them. The behavioural half
 * — that the engine is fed for the track that is playing after a rapid skip — is
 * `test/engine-native.test.ts`, on the fake bridge, with the plugin's own install modelled.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const spectrum = readFileSync(join(root, 'ios', 'App', 'App', 'NaviliteSpectrum.swift'), 'utf8');

/** The body of `install`, up to the closing brace of the method (it is the last one in its class). */
function installBody(): string {
  const start = spectrum.indexOf('private func install(call: CAPPluginCall, player: AVPlayer, assetId: String, requested: URL?, generation: Int, waited: Double) async {');
  assert.ok(start > 0, '`install` is where the tap is put on an item');
  const rest = spectrum.slice(start);
  const end = rest.indexOf('\n    }\n');
  assert.ok(end > 0, '`install` has a body with an end');
  return rest.slice(0, end);
}

test('the item is read again, and the generation re-tested, after the await that waits for its track', () => {
  const body = installBody();
  const readAt = body.indexOf('let item = player.currentItem');
  const awaitAt = body.indexOf('await AudibleSpectrumTap.audioTrack(of: item)');
  const attachAt = body.indexOf('spectrum.attach(to: item');
  assert.ok(readAt >= 0 && awaitAt > readAt, 'the item is read before the wait, as it always was');
  assert.ok(attachAt > awaitAt, 'and the attach comes after the wait');

  const guarded = body.slice(awaitAt, attachAt);
  assert.match(
    guarded,
    /generation == self\.generation/,
    'the request re-tests whether a newer one overtook it *after* the wait — the guard at the top of `install` runs before the read and cannot see a track change that happened during it',
  );
  assert.match(
    guarded,
    /player\.currentItem === item/,
    'and it re-tests that the item it read is still the item the player is on, so a stale install cannot land on the item the player has left',
  );
});

test('the attach is reachable only from inside those two re-tests', () => {
  const body = installBody();
  const attachAt = body.indexOf('spectrum.attach(to: item');
  const guardAt = body.indexOf('if generation == self.generation, player.currentItem === item {');
  assert.ok(guardAt > 0, 'the two re-tests are one condition, inside `install`');
  assert.ok(
    guardAt < attachAt,
    'and the attach sits behind it — an unguarded attach is the stale install that takes the mix off the item being heard',
  );
  // The one attach there is: a second one outside the guard would be the same defect again.
  assert.equal(body.split('spectrum.attach(to: item').length - 1, 1, 'one attach in the method');
});

test('what must not break: the read-then-wait shape, and the bounded retry that follows it', () => {
  const body = installBody();
  // The retry is what makes an item whose track list is not built yet still get its tap, and it is
  // bounded by the same budget as before: v1.9.1's await, and `trackWaitSeconds` as the deadline.
  assert.match(body, /try\? await Task\.sleep\(nanoseconds: 100_000_000\)/, 'the retry still steps by 100 ms');
  assert.match(body, /guard waited < AudibleSpectrumTap\.trackWaitSeconds else \{/, 'and still gives up at the deadline');
  assert.match(body, /if track != nil \|\| spectrum\.isTapped\(item\) \{/, 'an item that already carries the tap is still verified rather than re-installed');
  assert.match(spectrum, /static let trackWaitSeconds = 5\.0/, 'the deadline itself is unchanged');
});
