/**
 * A row must not paint anything while a finger is on it.
 *
 * This is the check for v1.6.2's report — *"the track is still highlighted when i press to drag"* —
 * and it reads the stylesheet rather than the screen, for a reason worth recording.
 *
 * `tools/v16-check.mjs` does watch the screen during the gesture: it samples the computed paint of
 * every row across a 1-second press-and-hold followed by a 204 px drag, which is the exact gesture the
 * owner described. What it *cannot* see in Chrome is this rule, and that was measured rather than
 * assumed: with the old `.row.song:active` plate put back into `dist` and the harness re-run, the
 * paint check still passed, and a direct probe showed why —
 * `document.querySelectorAll('.row.song:active').length` was 0 while a touch was held down *and* while
 * the mouse button was held, so this engine never enters `:active` for input it is handed through
 * `Input.dispatchTouchEvent`. On the phone the rule did fire; that is the whole bug. So the browser
 * harness guards the rest of the gesture and this file guards the rule.
 *
 * If a future release genuinely needs a pressed style on a control, this is the test to argue with —
 * deliberately, in one place, rather than by adding a rule somewhere in a 1,100-line stylesheet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'src/styles.css'), 'utf8');
/** The rules, without the comments that explain them (the explanation in there *names* `:active`). */
const live = css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The index of the brace that closes the block opened at `open`. */
function blockEnd(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return text.length;
}

test('no rule in the stylesheet paints anything in the :active (finger-down) state', () => {
  const press = [...live.matchAll(/:active/g)].length;
  assert.equal(
    press,
    0,
    `${press} \`:active\` selector(s) are back: the owner asked for a press on a row to highlight nothing at all`,
  );
});

test('the system tap flash is off on every tap target', () => {
  const flashes = [...live.matchAll(/-webkit-tap-highlight-color\s*:\s*([^;]+);/g)].map((match) => (match[1] ?? '').trim());
  assert.ok(flashes.length > 0, 'nothing sets -webkit-tap-highlight-color, so WKWebView flashes its own grey');
  for (const value of flashes) {
    assert.equal(value, 'transparent', `one target flashes ${value} on touch-down`);
  }
});

test('the hover paint on a row sits behind a hover-capable pointer, where a finger never matches it', () => {
  const occurrences = [...live.matchAll(/\.row:hover/g)].length;
  assert.ok(occurrences > 0, '.row:hover has been deleted outright — the phone was not the only thing using this');
  const media = live.indexOf('@media (hover: hover) and (pointer: fine)');
  assert.ok(media > 0, 'the hover-only block is gone');
  const end = blockEnd(live, live.indexOf('{', media));
  const outside = [...live.matchAll(/\.row:hover/g)].filter((match) => match.index! < media || match.index! > end);
  assert.equal(outside.length, 0, `${outside.length} of ${occurrences} \`.row:hover\` rule(s) are outside the hover block`);
});

test('the highlight that says which track is playing is untouched', () => {
  // The card is explicit that this one is a different statement and must not change with the rest.
  assert.match(live, /\.row\.song\.playing\s*\{[^}]*background:/, 'the playing row lost its background');
  assert.match(live, /\.row\.song\.playing \.row-title\s*\{[^}]*color:/, 'the playing row lost its title colour');
});
