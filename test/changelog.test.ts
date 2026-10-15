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

test('the changelog is the owner-visible list: v1.0 through v1.9.16, and nothing internal', () => {
  assert.deepEqual(CHANGELOG.map((release) => release.version), ['1.0', '1.1', '1.2', '1.3', '1.4', '1.5', '1.5.1', '1.6', '1.6.1', '1.6.2', '1.7', '1.7.1', '1.7.3', '1.7.4', '1.7.5', '1.7.6', '1.7.7', '1.8.0', '1.8.1', '1.9.0', '1.9.1', '1.9.2', '1.9.3', '1.9.4', '1.9.5', '1.9.6', '1.9.7', '1.9.8', '1.9.9', '1.9.10', '1.9.11', '1.9.12', '1.9.13', '1.9.14', '1.9.15', '1.9.16']);
  for (const release of CHANGELOG) {
    assert.ok(release.items.length > 0, `${release.version} has no entries`);
    for (const item of release.items) {
      // Things that are invisible to him do not belong in this list.
      assert.doesNotMatch(item, /service worker|CORS|vite|webpack|refactor|bundle|esbuild|TypeScript/i);
    }
  }
});

test('every v1.7.3 report the owner made is described in his own terms', () => {
  const v173 = CHANGELOG.find((release) => release.version === '1.7.3');
  const text = v173?.items.join('\n') ?? '';
  /*
   * His report, in the order he made it: two engines he could end up on, coming back to the app
   * being "very buggy", pausing that kept repeating, a visualiser that switched itself off, and a
   * clock that counted on with no sound. Plus the one carried over from the reclaimed v1.7.2 card:
   * the time under the seek bar following his finger.
   */
  assert.match(text, /One audio engine now/, 'his report: it is buggy, and it is buggy in one mode or the other');
  assert.match(text, /Coming back to the app always keeps playing/, 'his report: backgrounding and coming back');
  assert.match(text, /paused from the lock screen/, 'his report: driving the player from outside the app while it was away');
  assert.match(text, /The visualiser is always in step/, 'his report: the spectrum switching itself off');
  assert.match(text, /The clock follows the sound/, 'his report: the clock incrementing with no sound');
  assert.match(text, /time follows your finger/, 'the seek-bar time he asked to see while dragging');
  assert.match(text, /drag is cancelled/, 'and the cancelled drag, which must put the real time back');
  for (const item of v173?.items ?? []) {
    // Invisible plumbing does not belong in his list: no engine names, no state machines.
    assert.doesNotMatch(item, /FFT|vDSP|AVFoundation|ExoPlayer|plugin|analyser|Web Audio|bridge|state machine|WebKit|media element/i);
  }
});

test('the v1.7.5 entry names the four things that were wrong, in his terms', () => {
  const v175 = CHANGELOG.find((release) => release.version === '1.7.5');
  const text = v175?.items.join('\n') ?? '';
  /*
   * The four gaps the review found, each named as the thing he can see rather than the mechanism:
   * the wrong track after a quick switch, the sound stopping for a moment on a scrub, the time
   * running before the music did, and the bars vanishing at the end of a song.
   */
  assert.match(text, /never plays the wrong one/, 'the two-rapid-presses race, as a symptom');
  assert.match(text, /no longer risks stopping the sound/, 'the seek that flipped the app to interrupted');
  assert.match(text, /before the music has actually started/, 'the clock that ran during the load');
  assert.match(text, /to the end of a song/, 'the bars emptying in the last seconds');
  for (const item of v175?.items ?? []) {
    assert.doesNotMatch(item, /generation|transition|asset|state machine|clock|tap|interruption/i);
  }
});

test('every v1.7.4 report the owner made is described in his own terms', () => {
  const v174 = CHANGELOG.find((release) => release.version === '1.7.4');
  const text = v174?.items.join('\n') ?? '';
  /*
   * His four reports off v1.7.3, in the order he made them: a seek bar that only answered a tap, a
   * spectrum that was jittery and laggy, colours that were "one blue color no matter what" and not
   * the album art's, and a pause that replaced the spectrum with the placeholder.
   */
  assert.match(text, /Drag the bar to seek/, 'his report: dragging the seek bar did nothing');
  assert.match(text, /smoother/, 'his report: jittery and laggy');
  assert.match(text, /album's colours/, 'his report: the colours do not match the album art');
  assert.match(text, /Pausing lets the spectrum settle/, 'his report: the placeholder appearing on pause');
  // The numbers this release is proved on have to be in the text he reads.
  assert.match(text, /where you press to where you let go/, 'the dragged proportion, in his terms');
  assert.match(text, /a third of a second/, 'the release he asked for, in his terms');
  for (const item of v174?.items ?? []) {
    assert.doesNotMatch(item, /envelope|pointer|palette|requestAnimationFrame|canvas|filter|hook|state/i);
  }
});

test('every v1.4 defect the owner reported is described in his own terms', () => {
  const v14 = CHANGELOG.find((release) => release.version === '1.4');
  const text = v14?.items.join('\n') ?? '';
  // His two reports, in the order he made them.
  assert.match(text, /no longer scrolls the list behind it/, 'his first report, in his words');
  assert.match(text, /cannot grow, stretch or scroll away/, 'his second report: the top bar');
  // The numbers this release is proved on have to be in the text he reads.
  assert.match(text, /58 px/, 'the top bar height that was measured, not asserted');
  assert.match(text, /1,660 px|0 px/, 'v1.3 scrolled the page; v1.4 has no page to scroll');
  for (const item of v14?.items ?? []) {
    assert.doesNotMatch(item, /overscroll|overflow|flex|container query|scrollTop|viewport/i);
  }
});

test('every v1.5 change the owner asked for is described in his own terms', () => {
  const v15 = CHANGELOG.find((release) => release.version === '1.5');
  const text = v15?.items.join('\n') ?? '';
  // His reports, in the order he made them: the settings screen that moved under him, the first
  // lyric line under the top edge, and the screens he asked to be able to swipe between.
  assert.match(text, /settings screen stays put/, 'his first report: the settings screen');
  assert.match(text, /first line of the lyrics/, 'his second report: the clipped first line');
  assert.match(text, /three screens you swipe between/, 'the swipe he asked for');
  // The numbers this release is proved on have to be in the text he reads.
  assert.match(text, /15 px takes it at 16 px/, 'the focus size that caused the zoom');
  assert.match(text, /18 px/, 'where the first lyric line sits now');
  assert.match(text, /200 px of sideways travel/, 'the diagonal gesture that must not turn a page');
  for (const item of v15?.items ?? []) {
    assert.doesNotMatch(item, /viewport|focus-zoom|transform|translate|flex|gesture handler|visual viewport/i);
  }
});

test('the settings screen he could still drag sideways is described in his own terms', () => {
  const v151 = CHANGELOG.find((release) => release.version === '1.5.1');
  const text = v151?.items.join('\n') ?? '';
  // His report carried over from v1.5: the settings screen still slid sideways under his finger.
  assert.match(text, /settings screen can no longer be dragged sideways/, 'his report: the screen that still moved');
  // The numbers this release is proved on have to be in the text he reads.
  assert.match(text, /301 px before, 0 px after/, 'the before/after measured on his phone');
  for (const item of v151?.items ?? []) {
    assert.doesNotMatch(item, /viewport|focus-zoom|transform|translate|flex|gesture handler|visual viewport|overflow|CSS/i);
  }
});

test('every v1.6 report the owner made is described in his own terms', () => {
  const v16 = CHANGELOG.find((release) => release.version === '1.6');
  const text = v16?.items.join('\n') ?? '';
  // His reports, in the order he made them: the scroll that selected a song, the settings screen
  // that paged sideways, and playback after coming back to the app.
  assert.match(text, /Scrolling a list no longer taps a song/, 'his report: a scroll was starting tracks');
  assert.match(text, /Settings is not a swipe page any more/, 'his report: swiping in settings');
  assert.match(text, /Playback survives coming back to the app/, 'his report: background and resume');
  // The numbers this release is proved on have to be in the text he reads.
  assert.match(text, /200 px of thumb travel/, 'the drag that must select nothing');
  assert.match(text, /nothing on screen moved/, 'the settings drag that must move nothing');
  for (const item of v16?.items ?? []) {
    assert.doesNotMatch(item, /visibilitychange|handoff|hand-off|pointer|touchstart|touchmove|transform|translate|EventListener|queue index/i);
  }
});

test('the tap the owner lost is described in his own terms', () => {
  const v161 = CHANGELOG.find((release) => release.version === '1.6.1');
  const text = v161?.items.join('\n') ?? '';
  // His report, in his words: he could not tap a playlist to open it after v1.6.
  assert.match(text, /Tapping works again/, 'his report: tapping stopped working');
  assert.match(text, /a tap on a playlist opens it/, 'the playlist he could not open');
  assert.match(text, /Dragging to scroll still only scrolls/, 'the other direction, which must not come back');
  for (const item of v161?.items ?? []) {
    assert.doesNotMatch(item, /touchstart|touchmove|touchend|pointer|EventListener|gesture handler|threshold|transform|use-select|CSS/i);
  }
});

test('the press highlight the owner asked to remove is described in his own terms', () => {
  const v162 = CHANGELOG.find((release) => release.version === '1.6.2');
  const text = v162?.items.join('\n') ?? '';
  // His report, in his words: he presses a row to drag, and the row lights up while he does.
  assert.match(text, /Holding a song no longer highlights it/, 'his report: the track highlighted on a press');
  assert.match(text, /while your finger was down|for as long as your finger was down/, 'that it happened on contact, not on the swipe');
  // The one thing that must not change has to be named, so nobody reads this as "highlights are gone".
  assert.match(text, /the only row that stands out is the one playing/, 'the now-playing highlight, which stays');
  for (const item of v162?.items ?? []) {
    // Invisible plumbing does not belong in this list.
    assert.doesNotMatch(item, /:active|:hover|CSS|selector|stylesheet|media query|tap-highlight|TAP_SLOP|px of movement/i);
  }
});

test('the background playback the owner asked for is described in his own terms', () => {
  const v17 = CHANGELOG.find((release) => release.version === '1.7');
  const text = v17?.items.join('\n') ?? '';
  // His ask, in his words: "try to make backgrounding work all the time seamlessly without the pause".
  assert.match(text, /keeps playing when you leave the app/, 'the ask: leaving the app must not stop the music');
  assert.match(text, /lock screen/, 'the lock-screen controls the card promises him');
  assert.match(text, /same second/, 'the exact resume, which v1.6 already got right and must keep');
  // The spectrum is his signature feature: a v1.7 entry that does not say it survived would read as a loss.
  assert.match(text, /spectrum is still the real one/, 'the real spectrum, which must not regress');
  for (const item of v17?.items ?? []) {
    // Invisible plumbing does not belong in his list.
    assert.doesNotMatch(item, /AVAudioSession|AVFoundation|MPRemoteCommandCenter|plugin|visibilitychange|ExoPlayer|analyser|Web Audio|snapshot|localStorage/i);
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

test('every v1.3 change is described in the owner\'s own terms, from his own report', () => {
  const v13 = CHANGELOG.find((release) => release.version === '1.3');
  const text = v13?.items.join('\n') ?? '';
  assert.match(text, /load directly from your library/, 'the card asks for this sentence');
  assert.match(text, /came back empty|empty/, 'his report was tracks staying blank');
  assert.match(text, /library/);
  assert.match(text, /no romaji lyrics for this track yet/, 'the honest empty state has to be named');
  for (const item of v13?.items ?? []) {
    // Invisible plumbing does not belong in this list.
    assert.doesNotMatch(item, /CORS|localhost|Capacitor|cache key|localStorage|endpoint|API|JSON/i);
  }
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

test('the v1.7.6 entry names the second copy of the song, in his terms', () => {
  const v176 = CHANGELOG.find((release) => release.version === '1.7.6');
  const text = v176?.items.join('\n') ?? '';
  /*
   * The review's structural finding, said as the thing that happened to the owner: a second, silent
   * copy of the same song was fetched and decoded underneath the one he can hear. The entry names
   * that copy and its removal — not the tap, not the player object, not the plugin.
   */
  assert.match(text, /second, silent copy/, 'the second decode has to be named as what it was');
  assert.match(text, /fetched and decoded alongside it/, 'it was a second fetch of the same stream');
  assert.match(text, /one player, the one you can hear/, 'and what is left is the one he hears');
  assert.match(text, /stutter/, 'the symptom it could cause');
  for (const item of v176?.items ?? []) {
    assert.doesNotMatch(item, /AVPlayer|MTAudioProcessingTap|tap|plugin|FFT|vDSP|AVFoundation|engine/i);
  }
});

test('the v1.7.7 entry names the two things he saw — the bars that would not come back, and the gap', () => {
  const v177 = CHANGELOG.find((release) => release.version === '1.7.7');
  const text = v177?.items.join('\n') ?? '';
  /*
   * His report, said as the thing that happened to him: the spectrum that stayed dark until he picked
   * another song, and the small gap in the music just before the bars returned. The entry names both,
   * and neither is described as a mechanism — no tap, no plugin, no player object, no lifecycle.
   */
  assert.match(text, /no longer need a new song before they come back/, 'the workaround he had to use');
  assert.match(text, /stayed dark until you picked another track/, 'the symptom, in his terms');
  assert.match(text, /leaving the app and returning/, 'and the second way he saw it');
  assert.match(text, /small gap in the music/, 'the gap he heard on the phone');
  for (const item of v177?.items ?? []) {
    assert.doesNotMatch(item, /AVPlayer|MTAudioProcessingTap|tap|plugin|FFT|vDSP|AVFoundation|engine|lifecycle|mix/i);
  }
});

test('the v1.8.0 entry names the two things he saw — the bar he could not drag, and the bars on the old song', () => {
  const v180 = CHANGELOG.find((release) => release.version === '1.8.0');
  const text = v180?.items.join('\n') ?? '';
  /*
   * His report, as the thing that happened to him: *"the seek bar still doesn't let me drag it i can
   * only tap to seek"*, and the visualiser that stayed on the previous song's bars after a change of
   * track. Both entries say what he did and what it does now; neither says how — no touch channel, no
   * pointer events, no item identity, no render thread — because none of that is visible to him.
   */
  assert.match(text, /seek bar takes your thumb/, 'the drag he could not do');
  assert.match(text, /Dragging it moves the song now, on the phone/, 'and that it is fixed on the phone, where he reported it');
  assert.match(text, /only a quick touch worked/, 'his words: he could only tap to seek');
  assert.match(text, /never turns the page/, 'and the other half of his report, the swipe that won instead');
  assert.match(text, /bars keep up with the sound/, 'the visualiser, by the name he uses for it');
  assert.match(text, /sitting on the one before it/, 'the symptom after a change of track');
  assert.match(text, /settle down to nothing/, 'and the pause, which must decay rather than show a placeholder');
  for (const item of v180?.items ?? []) {
    assert.doesNotMatch(item, /pointer|touch event|channel|item|tap|plugin|FFT|vDSP|AVFoundation|engine|thread|bridge|iOS Safari|WebKit/i);
  }
});
