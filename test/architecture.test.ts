/**
 * **The four structural greps, as assertions (design §1, `docs/design-one-player.md`).**
 *
 * The one-player change is a claim about the *tree* rather than about a class: two players cannot
 * sound at once because the second player's constructor is not in the app any more, because the
 * plugin that carried it is not a dependency, and because the browser's element is built in one
 * place. Those were four greps a reviewer ran by hand at the end of a slice — and a guard nobody
 * runs is a guard that comes back — so they run with `npm test` from here.
 *
 * They search **tracked files only** (`git grep`): a `.bak-` copy beside the file being edited, or
 * the built bundle under `ios/App/App/public`, is not what ships, and counting either would make the
 * guard fail for a reason that has nothing to do with the app. Comment lines are dropped where the
 * grep names a constructor, because this file's own documentation names them.
 *
 * What these cannot do: they say nothing about what the shipping player *does* — only that there is
 * one way to build it. The playback tests are where behaviour is claimed.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPM = 'ios/App/CapApp-SPM';

/** `git grep` over the tracked tree; grep's own "no match" is an empty list, not a failure. */
function grep(pattern: string, ...paths: string[]): string[] {
  try {
    const found = execFileSync('git', ['grep', '-n', '-I', '-E', pattern, '--', ...paths], {
      cwd: root,
      encoding: 'utf8',
    });
    return found.split('\n').filter((line) => line !== '');
  } catch (error) {
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

/** `path:12: // …`, `path:12: * …`, `path:12: /* …` — a mention in a comment is not a construction. */
const isComment = (line: string): boolean => /:\d+: *(?:\/\/|\/\*|\*)/.test(line);

const where = (lines: string[]): string => lines.map((line) => `  ${line}`).join('\n');

test('one player is constructed in the whole Swift tree we ship', () => {
  const paths = existsSync(join(root, SPM)) ? ['ios/App/App', SPM] : ['ios/App/App'];
  const constructed = grep('AVQueuePlayer\\(|AVPlayer\\(', ...paths).filter((line) => !isComment(line));
  assert.equal(
    constructed.length,
    1,
    `exactly one player may be constructed; this tree builds ${constructed.length}:\n${where(constructed)}`,
  );
  assert.match(constructed[0]!, /^ios\/App\/App\/NaviliteRemote\.swift:\d+:/, 'and it is the app’s own queue');
});

test('one item is constructed, in the one factory that installs the tap', () => {
  const built = grep('AVPlayerItem\\(asset:', 'ios/App/App').filter((line) => !isComment(line));
  assert.equal(
    built.length,
    1,
    `exactly one item factory may exist; this tree builds ${built.length}:\n${where(built)}`,
  );
  assert.match(built[0]!, /^ios\/App\/App\/NaviliteRemote\.swift:\d+:/, 'and it is `makeItem`’s');
});

test('the removed native-audio plugin is gone, not idle', () => {
  const named = [
    ...grep('@capgo/capacitor-native-audio', 'package.json', 'package-lock.json', 'ios/App'),
    ...grep('NativeAudio\\.', 'src'),
  ];
  assert.equal(
    named.length,
    0,
    `no manifest, no lockfile, no native source and no call site may name it:\n${where(named)}`,
  );
});

test("the browser's player is constructed in exactly one place, and it is the web backend's", () => {
  const elements = grep("new Audio\\(|createElement\\('audio'\\)", 'src').filter((line) => !isComment(line));
  assert.equal(
    elements.length,
    1,
    `the browser has one player and it is built once; this tree builds ${elements.length}:\n${where(elements)}`,
  );
  assert.match(elements[0]!, /^src\/player\/engine\.ts:\d+:/, 'inside the engine’s one web-only factory');
});
