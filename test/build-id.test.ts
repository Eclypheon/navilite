/**
 * The bundle must carry the build id, not the placeholder.
 *
 * `__BUILD_ID__` is a `define` in `vite.config.ts` and the Settings → About line prints it. Only
 * `dist/sw.js` used to be stamped, so every build (beta.23 included) shipped `Navilite __BUILD_ID__`
 * on that screen while the README and docs/verification.md claimed the app named its build. This
 * reads the built chunks the same way the browser tests serve them; `npm test` builds `dist/` first,
 * and a run of this file on its own skips when there is no build.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the shipped JavaScript carries the build id, not its placeholder', (t) => {
  if (!existsSync(join(root, 'dist/index.html'))) {
    t.skip('dist/ is not built — run `npm run build` first');
    return;
  }
  const assets = readdirSync(join(root, 'dist/assets')).filter((name) => name.endsWith('.js'));
  assert.ok(assets.length > 0, 'the build produced JavaScript');
  for (const name of assets) {
    const body = readFileSync(join(root, 'dist/assets', name), 'utf8');
    assert.ok(!body.includes('__BUILD_ID__'), `${name} still contains the build-id placeholder`);
  }
});
