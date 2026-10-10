/**
 * The in-app "What's new" text and CHANGELOG.md must be the same document.
 *
 * Two copies of one list is fine as long as something fails when they drift — otherwise the
 * app quietly tells the owner a different story from the repository. This test is that
 * something: it parses the markdown and compares headings and bullets, in order.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CHANGELOG } from '../src/ui/changelog.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseChangelogMd(text: string): Array<{ version: string; date: string; items: string[] }> {
  const releases: Array<{ version: string; date: string; items: string[] }> = [];
  for (const line of text.split('\n')) {
    const heading = /^##\s+(\S+)\s+—\s+(\S+)\s*$/.exec(line.trim());
    if (heading) {
      releases.push({ version: heading[1] ?? '', date: heading[2] ?? '', items: [] });
      continue;
    }
    const bullet = /^-\s+(.*)$/.exec(line.trim());
    if (bullet && releases.length > 0) releases[releases.length - 1]?.items.push(bullet[1] ?? '');
  }
  return releases;
}

test('CHANGELOG.md and the in-app changelog say the same thing, in the same order', () => {
  const releases = parseChangelogMd(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'));
  assert.deepEqual(releases, CHANGELOG);
});

test('the changelog is the owner-visible list: v1.0, v1.1, v1.2, and nothing internal', () => {
  assert.deepEqual(CHANGELOG.map((release) => release.version), ['1.0', '1.1', '1.2']);
  for (const release of CHANGELOG) {
    assert.ok(release.items.length > 0, `${release.version} has no entries`);
    for (const item of release.items) {
      // Things that are invisible to him do not belong in this list.
      assert.doesNotMatch(item, /service worker|CORS|vite|webpack|refactor|bundle|esbuild|TypeScript/i);
    }
  }
});

test('every v1.1 entry the owner asked for is actually in the list', () => {
  const v11 = CHANGELOG.find((release) => release.version === '1.1');
  const text = v11?.items.join('\n') ?? '';
  assert.match(text, /sideways scrolling/);
  assert.match(text, /Library, Playlists and the settings gear/);
  assert.match(text, /logo/);
  assert.match(text, /Swipe left/);
  assert.match(text, /cover art, the spectrum/);
  assert.match(text, /shuffle and repeat/);
  assert.match(text, /playing is highlighted/);
  assert.match(text, /Lyrics/);
  assert.match(text, /blank/);
});

test('every v1.2 defect the owner reported is described in his own terms', () => {
  const v12 = CHANGELOG.find((release) => release.version === '1.2');
  const text = v12?.items.join('\n') ?? '';
  // The three v1.2 reports, in the order they were reported.
  assert.match(text, /sideways|390 px/);
  assert.match(text, /393 px/, 'the width the report was made at has to be named');
  for (const item of v12?.items ?? []) {
    assert.doesNotMatch(item, /viewport|overflow-x|flex box|CSS|localStorage|analyser/i);
  }
  assert.match(text, /spectrum/i);
});
