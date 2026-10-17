/**
 * The top gap on first run (owner, v2.0.0-beta.4): one authoritative inset, and it is the CSS's.
 *
 * "look at the top bar there always seem to be a large gap at the top on the first run of this app
 * in live container. i can get rid of it by closing it and then reopening it from live container.
 * this gap also appears if the app is backgrounded for a long while and then pulled up again."
 *
 * Two sources of the same 59 px were stacked: `ios.contentInset: 'always'` asked UIKit to pad the web
 * view's scroll view for the safe area, and `env(safe-area-inset-top)` padded `.topbar` and `.now`
 * inside the page. `tools/inset-gap.mjs` reads the result in real Chrome at 393 x 852 with the
 * iPhone 15 Pro's insets emulated: **118 px** of empty screen before the app's first content pixel
 * with the native inset in play (13.8 % of 852), 59 px without it.
 *
 * These are the rules that keep it at one source — no native pixel value to cache, and therefore
 * nothing that can be measured wrong on the first frame and corrected only by a relaunch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = readFileSync(join(root, 'capacitor.config.ts'), 'utf8');
const css = readFileSync(join(root, 'src', 'styles.css'), 'utf8');

test('the native scroll view adds no inset: the CSS is the single source', () => {
  assert.match(config, /contentInset: 'never'/, 'Capacitor\'s default, and the only correct value here');
  assert.doesNotMatch(config, /contentInset: 'always'/, '`always` pads the scroll view the CSS already pads');
  assert.doesNotMatch(config, /contentInset: 'automatic'/, '`automatic` is the same double count, conditionally');
});

test('exactly two rules consume the top inset — the shell and the now-playing screen', () => {
  // Every occurrence in a comment is fine; what matters is the declarations.
  const declarations = css
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('/*') && line.includes('env(safe-area-inset-top)'));
  assert.equal(declarations.length, 2, `expected .topbar and .now, got:\n${declarations.join('\n')}`);
  assert.match(declarations[0], /padding: max\(10px, env\(safe-area-inset-top\)\)/, 'the top bar clears the status bar itself');
  assert.match(declarations[1], /padding-top: env\(safe-area-inset-top\)/, 'the now-playing screen does the same');
});

test('no JavaScript measures, caches or writes a top inset', () => {
  /*
   * The rule the owner's fix asked for: the first paint is already right because nothing is measured.
   * A cached pixel value is what needs re-deriving on pageshow / visibilitychange / visualViewport
   * and is what made a relaunch necessary. There is none to re-derive.
   */
  const sources = ['src/main.ts', 'src/ui/app.ts', 'src/ui/shell.ts', 'src/platform.ts'].map((file) => ({
    file,
    text: readFileSync(join(root, file), 'utf8'),
  }));
  for (const { file, text } of sources) {
    assert.doesNotMatch(text, /visualViewport/, `${file} must not measure the viewport for an inset`);
    assert.doesNotMatch(text, /safeArea|safe-area|--inset-top|--safe-top/, `${file} must not cache an inset`);
  }
});
