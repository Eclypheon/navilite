/**
 * v2.0.0-beta.5 stamp — one pass over the version files, the two changelogs, the release check, the
 * two tests whose expectations the fix moved, and the DECISIONS entry. Every edit asserts it landed;
 * a missing anchor aborts with a non-zero exit instead of leaving a half-stamped tree.
 */
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url).pathname;
const read = (p) => readFileSync(ROOT + p, 'utf8');
const write = (p, s) => writeFileSync(ROOT + p, s);
const report = [];

function edit(path, from, to, times = 1) {
  const before = read(path);
  const count = before.split(from).length - 1;
  if (count !== times) throw new Error(`${path}: expected ${times} of ${JSON.stringify(from.slice(0, 60))}, found ${count}`);
  write(path, before.split(from).join(to));
  report.push(`${path}: ${times}x ${JSON.stringify(from.slice(0, 48))}`);
}

/* ---------------------------------------------------------------- the version, all of it (§3) */

edit('package.json', '"version": "2.0.0-beta.4"', '"version": "2.0.0-beta.5"');
edit('android/app/build.gradle', 'versionCode 52', 'versionCode 53');
edit('android/app/build.gradle', 'versionName "2.0.0-beta.4"', 'versionName "2.0.0-beta.5"');
edit('ios/App/App.xcodeproj/project.pbxproj', 'CURRENT_PROJECT_VERSION = 53;', 'CURRENT_PROJECT_VERSION = 54;', 2);
edit('ios/App/App.xcodeproj/project.pbxproj', 'MARKETING_VERSION = 2.0.0-beta.4;', 'MARKETING_VERSION = 2.0.0-beta.5;', 2);

/* ---------------------------------------------------------------- the owner's list, both copies */

const ITEMS = [
  'One tap downloads the playlist and its covers, and then it is finished: the button goes to the tick and the exact size and never asks you for the covers as a second step. A cover still arriving was what the old button read as "download covers".',
  'The size on the download button is exact, to one decimal: 4.8 GB rather than "up to 5 GB".',
  'You can see the download working. The button shows the bytes that have arrived against the total, with a bar that fills as they land, updated while the download runs.',
  'Retry appears only when the download has actually stopped moving, never while it is still working, and a retry carries on from where it was: the files already on the phone are not downloaded again.',
];
const DATE = '2026-10-17';
const VERSION = '2.0-beta.5';

const appChangelog = read('src/ui/changelog.ts');
const appEntry = `    {\n      version: '${VERSION}',\n      date: '${DATE}',\n      items: [\n${ITEMS.map((item) => `        '${item.replace(/'/g, "\\'")}',`).join('\n')}\n      ],\n    },\n`;
if (!appChangelog.trimEnd().endsWith('];')) throw new Error('changelog.ts no longer ends with the array');
write('src/ui/changelog.ts', appChangelog.replace(/\n\];\s*$/, `\n${appEntry}  ];\n`));
report.push('src/ui/changelog.ts: one release appended');

const md = read('CHANGELOG.md');
write('CHANGELOG.md', `${md.trimEnd()}\n\n## ${VERSION} — ${DATE}\n\n${ITEMS.map((item) => `- ${item}`).join('\n')}\n`);
report.push('CHANGELOG.md: one release appended');

/*
 * The release check's own list: it is chronological, so the new version goes last — asserted by the
 * position of `1.0` relative to the previous newest entry rather than assumed.
 */
const testPath = 'test/changelog.test.ts';
const testSource = read(testPath);
const prev = "'2.0-beta.4'";
const at = testSource.indexOf(prev);
if (at < 0) throw new Error('changelog.test.ts: 2.0-beta.4 not found in the expected list');
const ascending = testSource.indexOf("'1.0'") < at;
write(testPath, ascending ? testSource.replace(prev, `${prev}, '${VERSION}'`) : testSource.replace(prev, `'${VERSION}', ${prev}`));
report.push(`${testPath}: expected list ${ascending ? 'appended' : 'prepended'}`);

/* ---------------------------------------------------------------- the two tests the fix moved */

edit(
  'test/download-269.test.ts',
  `  await settle();
  assert.equal(offline.record('pl-1')?.state, 'complete', 'the job finishes on its own');`,
  `  await settle();
  /*
   * v2.0.0-beta.5 — the covers of the same tap are still in flight, and that is exactly the state the
   * owner was offered a second tap in. They are part of this job now, so it stays open until they land.
   */
  assert.equal(offline.record('pl-1')?.state, 'downloading', 'the covers of the same tap hold the job open');
  for (const job of artJobs(bridge)) {
    bridge.emit('done', { songId: job.songId, kind: 'art', bytes: 200_000 });
  }
  await settle();
  assert.equal(offline.record('pl-1')?.state, 'complete', 'the job finishes on its own, covers included');`,
);

edit(
  'test/offline-store.test.ts',
  `  const songs = [covered('a', 'cover-1')];
  await store.download('pl-1', songs, { name: 'Driving' });
  landAudioAndLyrics(bridge, songs);
  assert.equal(store.record('pl-1')?.state, 'complete');`,
  `  const songs = [covered('a', 'cover-1')];
  await store.download('pl-1', songs, { name: 'Driving' });
  landAudioAndLyrics(bridge, songs);
  // v2.0.0-beta.5 — the cover is a transfer of this same job, and it is still in flight.
  assert.equal(store.record('pl-1')?.state, 'downloading', 'the cover holds the one job open');`,
);

/* ---------------------------------------------------------------- the decision, written down */

appendFileSync(
  ROOT + 'DECISIONS.md',
  `

## The stall window (v2.0.0-beta.5)

The owner: *"the retry should not appear if the download is still actively working"*. So \`retry\` is
no longer a function of the record's state name; it is a function of whether the job has said
anything recently, and the sentence is built from that verdict (\`OfflineStore.stallOf\`,
\`DownloadControlFacts.stalled\`).

- **N = 20 s**, exported as \`STALL_MS\` in \`src/state/offline.ts\`. A job that has recorded a signal
  (a \`progress\` event from any of its transfers — native emits one per chunk — a transfer settling,
  or a reconcile from a pass of its own) inside that window is working, and the control prints
  \`n of m · 1.2 GB of 4.8 GB\` instead of \`· retry\`.
- **A pump pass it scheduled for itself counts as working.** The self-completion pump's backoff
  reaches 20 s (1.5 → 4 → 10 → 20), and a tap on a download the pump is already re-asking would
  re-enqueue over it (native \`enqueue\` cancels the task it replaces). A scheduled pass therefore
  withholds \`retry\` even when the clock is past the window.
- **A cancelled download has recorded no signal** (\`cancel\` is not a signal), so it reads as stalled
  the moment it is cancelled: nothing is running, so there is nothing to wait for.
- **Nothing left to fetch is never stalled**, and a \`complete\` record is never stalled, whatever the
  clock says.
- The same window answers the live indicator: the control repaints from the job's own
  \`progress\` events, throttled to one repaint per 250 ms (\`PROGRESS_NOTIFY_MS\`), so the byte figure
  and the bar move about as fast as the eye can use them without a download becoming a render loop.

**The covers are part of the finish, not a second step.** \`reconcileRecord\` used to declare a
playlist \`complete\` as soon as its audio was in, which — because the art transfers it had just
enqueued were still \`pending\` — made \`missingCovers() > 0\` true for a job that was still running and
printed \`✓ 4.8 GB · ↓ covers\`. A cover in flight now holds the record on \`downloading\` exactly as a
\`staging\` track does, and art events reconcile the record (\`onArtDone\`/\`onArtFailed\`). A cover that
settled \`none\` or genuinely \`failed\` does not hold it: a missing picture must never leave a playlist
on \`· retry\` for ever, and a failed cover is re-asked by the pump.
`,
);
report.push('DECISIONS.md: the stall window and the covers rule appended');

console.log(report.join('\n'));
