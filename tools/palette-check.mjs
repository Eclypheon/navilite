#!/usr/bin/env node
/**
 * The palette-apply check: does a track change actually re-theme the app?
 *
 * Why this exists. Since v1.1 `boot()` handed `restoreSession()` the *function* `applyPalette`
 * where its `hooks` parameter wanted an object with an `apply` method — and a function satisfies
 * `{ apply }` structurally, because that is `Function.prototype.apply`. So on every cold start
 * (the stored-session path, i.e. every normal launch), `syncPalette()` calling `hooks.apply(...)`
 * called `applyPalette(undefined)` instead, `applyPaletteVars` threw on `palette.primary` inside a
 * floating promise, and the album-art colours were never applied again for the whole session.
 * TypeScript could not see it (the shapes are compatible) and no test looked at what colour the
 * app actually ended up, so it shipped in v1.1, v1.2, v1.3 and v1.4.
 *
 * A DOM assertion cannot catch that: the symptom is not "an element has the wrong class", it is
 * "the theme never changes and a promise rejects where nobody is listening". So this driver runs
 * the real app in real Chrome, signs in through the stored session the way a relaunch does, taps a
 * row's play button, and then reads two things the app cannot fake:
 *
 *   1. what palette it holds (`window.__navilite.palette()`, the read-only seam in `app.ts`);
 *   2. what colour the document actually carries (`--accent-primary`), which is only set when
 *      the apply hook really ran;
 *   3. every uncaught error and unhandled rejection the page saw, collected from before the
 *      app's own bundle runs — the floating-promise throw is one of those.
 *
 * Both cases the acceptance asks for, in one session:
 *
 *   - **art reachable** — play a row with the mock library's cover art: the palette must come
 *     back `fromArt: true` and the document must be carrying *that* primary colour, not the
 *     default, with nothing thrown;
 *   - **art unreachable** — play a different row with `getCoverArt` made to fail: the app must
 *     quietly land on the defaults (`fromArt: false`), still apply them, and still not throw.
 *
 *   node tools/mock-subsonic.mjs --port 4633 --stress --dist dist
 *   node tools/palette-check.mjs --url http://127.0.0.1:4633 [--json report.json]
 *
 * Exit code is non-zero when the theme did not follow the track, or when the page threw.
 */
import { writeFileSync } from 'node:fs';
import { withChromePage, navigate, evaluate } from './layout-audit.mjs';

const DEFAULT_PRIMARY = '#7cd2ff';
const ALBUM_ROUTE = '#/album/album-ja-1';

/**
 * Installed before the app's bundle runs, so nothing that happens during `boot()` is missed.
 * Unhandled rejections are the important half: `queue.onChanged` calls `void syncPalette(...)`,
 * so the defect surfaced as a rejected promise nobody was holding, not as a caught error.
 */
const COLLECT_ERRORS = `(() => {
  window.__navilitePaletteErrors = window.__navilitePaletteErrors || [];
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    window.__navilitePaletteErrors.push((reason && reason.stack) || String(reason));
  });
  window.addEventListener('error', (event) => {
    window.__navilitePaletteErrors.push((event.error && event.error.stack) || String(event.message));
  });
  return true;
})()`;

const readPalette = `(() => {
  const palette = window.__navilite.palette() || null;
  const style = document.documentElement.style;
  return {
    palette: palette,
    cssPrimary: style.getPropertyValue('--accent-primary'),
    cssSecondary: style.getPropertyValue('--accent-secondary'),
    cssAccent: style.getPropertyValue('--accent-tertiary'),
    playing: window.__navilite.tracks().playing,
    errors: window.__navilitePaletteErrors.slice(),
  };
})()`;

/** Wait for the artwork palette to land, without throwing when it never does. */
const waitForArtwork = (ms) => `(async () => {
  const deadline = Date.now() + ${ms};
  while (Date.now() < deadline) {
    const palette = window.__navilite.palette();
    if (palette && palette.fromArt) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
})()`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const argv = new Map();
  for (let i = 2; i < process.argv.length; i += 1) {
    const token = process.argv[i];
    if (!token?.startsWith('--')) continue;
    const next = process.argv[i + 1];
    if (next && !next.startsWith('--')) {
      argv.set(token.replace(/^--/, ''), next);
      i += 1;
    } else {
      argv.set(token.replace(/^--/, ''), 'true');
    }
  }
  const url = argv.get('url') ?? 'http://127.0.0.1:4633';
  const jsonPath = argv.get('json');
  const username = argv.get('username') ?? 'navidrome';
  const password = argv.get('password') ?? 'navidrome';
  const settleMs = Number(argv.get('settle') ?? 1500);

  const lines = [];
  const failures = [];
  const readings = { url, phases: {}, checks: {} };
  const say = (text) => lines.push(text);

  const check = (label, ok, detail) => {
    readings.checks[label] = { ok, detail };
    if (!ok) failures.push(`${label} — ${detail}`);
    say(`${ok ? 'ok  ' : 'FAIL'}  ${label}`);
    if (detail) say(`      ${detail}`);
    return ok;
  };

  await withChromePage(
    async ({ cdp }) => {
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: COLLECT_ERRORS });

      /*
       * The cold start a real relaunch takes: the credentials are already in the app's own
       * storage, so `boot()` goes down the `restoreSession()` path — the one that was wired to
       * the wrong hook shape. No debug hook, no query parameter.
       */
      await navigate(cdp, url);
      await evaluate(
        cdp,
        `(() => {
          localStorage.setItem('navilite.settings', JSON.stringify({ serverUrl: ${JSON.stringify(url)}, username: ${JSON.stringify(username)}, playback: 'web' }));
          localStorage.setItem('navilite.subsonic-password', ${JSON.stringify(password)});
          return true;
        })()`,
      );
      await navigate(cdp, url);
      await evaluate(cdp, 'window.__naviliteLayoutAudit.waitFor("Boolean(window.__navilite && window.__navilite.libraryReady())", "the library to connect")');

      const resumed = await evaluate(cdp, '({ route: location.hash, palette: window.__navilite.palette(), errors: window.__navilitePaletteErrors.slice() })');
      readings.phases.onBoot = resumed;
      say(`Palette apply check — ${url}`);
      say(`  cold start through the stored session: route ${resumed.route || '(none)'} · palette ${JSON.stringify(resumed.palette)}`);
      check(
        'a normal launch lands in the app without throwing',
        resumed.errors.length === 0,
        resumed.errors.length === 0 ? 'no unhandled rejection or error during boot' : resumed.errors.join(' | '),
      );
      say('');

      /* --------------------------------------- 1. a track change with art reachable */
      await evaluate(cdp, `(() => { location.hash = ''; location.hash = ${JSON.stringify(ALBUM_ROUTE)}; return true; })()`);
      await evaluate(cdp, 'window.__naviliteLayoutAudit.waitFor("document.querySelectorAll(\'.row.song .row-play\').length > 1", "the album\'s rows")');
      const beforeArt = await evaluate(cdp, readPalette);
      const played = await evaluate(
        cdp,
        `(() => {
          const buttons = document.querySelectorAll('.row.song .row-play');
          buttons[0].click();
          return { rows: buttons.length, song: window.__navilite.tracks().playing };
        })()`,
      );
      const artworkArrived = await evaluate(cdp, waitForArtwork(10_000));
      await sleep(400);
      const afterArt = await evaluate(cdp, readPalette);
      readings.phases.artReachable = { before: beforeArt, played, artworkArrived, after: afterArt };
      say(`Track change with cover art reachable: played ${played.song} of ${played.rows} rows`);
      say(`  palette ${JSON.stringify(beforeArt.palette)} -> ${JSON.stringify(afterArt.palette)}`);
      say(`  document --accent-primary ${beforeArt.cssPrimary || '(unset)'} -> ${afterArt.cssPrimary || '(unset)'}`);
      check(
        'a track change does not throw from queue.onChanged',
        afterArt.errors.length === beforeArt.errors.length,
        afterArt.errors.length === beforeArt.errors.length
          ? `nothing thrown across the track change (errors: ${afterArt.errors.length})`
          : `the page threw: ${afterArt.errors.slice(beforeArt.errors.length).join(' | ')}`,
      );
      check(
        'the palette applied is the artwork one (fromArt: true)',
        afterArt.palette?.fromArt === true,
        `palette after the track change: ${JSON.stringify(afterArt.palette)} — fromArt ${afterArt.palette?.fromArt}`,
      );
      check(
        'the document is actually carrying the artwork colours',
        afterArt.palette?.fromArt === true &&
          afterArt.cssPrimary === afterArt.palette.primary &&
          afterArt.cssPrimary !== DEFAULT_PRIMARY,
        `--accent-primary is “${afterArt.cssPrimary || '(unset)'}”, the palette says “${afterArt.palette?.primary ?? '(no palette)'}”, the default is “${DEFAULT_PRIMARY}”`,
      );
      check(
        'the artwork palette is not the default palette wearing a different name',
        afterArt.palette?.primary !== DEFAULT_PRIMARY,
        `primary ${afterArt.palette?.primary ?? '(no palette)'}`,
      );
      say('');

      /* ------------------------------------ 2. a track change with art unreachable */
      await evaluate(cdp, `(() => { location.hash = ''; location.hash = ${JSON.stringify(ALBUM_ROUTE)}; return true; })()`);
      await evaluate(cdp, 'window.__naviliteLayoutAudit.waitFor("document.querySelectorAll(\'.row.song .row-play\').length > 1", "the album\'s rows again")');
      // The same library, with its cover art door shut: the app has to fall back, not throw.
      await evaluate(
        cdp,
        `(() => {
          if (!window.__naviliteOriginalFetch) window.__naviliteOriginalFetch = window.fetch;
          const original = window.__naviliteOriginalFetch;
          window.fetch = function (input, init) {
            const target = typeof input === 'string' ? input : (input && input.url) || '';
            if (target.indexOf('getCoverArt') !== -1) return Promise.reject(new Error('palette check: cover art unreachable'));
            return original.call(this, input, init);
          };
          return true;
        })()`,
      );
      const beforeFallback = await evaluate(cdp, readPalette);
      const playedNoArt = await evaluate(
        cdp,
        `(() => {
          const buttons = document.querySelectorAll('.row.song .row-play');
          buttons[1].click();
          return { song: window.__navilite.tracks().playing };
        })()`,
      );
      await sleep(settleMs);
      const afterFallback = await evaluate(cdp, readPalette);
      readings.phases.artUnreachable = { before: beforeFallback, played: playedNoArt, after: afterFallback };
      say(`Track change with cover art unreachable: played ${playedNoArt.song}`);
      say(`  palette ${JSON.stringify(beforeFallback.palette)} -> ${JSON.stringify(afterFallback.palette)}`);
      say(`  document --accent-primary ${beforeFallback.cssPrimary || '(unset)'} -> ${afterFallback.cssPrimary || '(unset)'}`);
      check(
        'the second track change is a different track (so the check is not vacuous)',
        playedNoArt.song !== played.song && playedNoArt.song !== null,
        `${played.song} -> ${playedNoArt.song}`,
      );
      check(
        'a track change with no reachable cover art does not throw either',
        afterFallback.errors.length === beforeFallback.errors.length,
        afterFallback.errors.length === beforeFallback.errors.length
          ? `nothing thrown (errors: ${afterFallback.errors.length})`
          : `the page threw: ${afterFallback.errors.slice(beforeFallback.errors.length).join(' | ')}`,
      );
      check(
        'with no cover art the app falls back to the defaults, and applies them',
        afterFallback.palette?.fromArt === false &&
          afterFallback.palette.primary === DEFAULT_PRIMARY &&
          afterFallback.cssPrimary === DEFAULT_PRIMARY,
        `palette ${JSON.stringify(afterFallback.palette)} · --accent-primary “${afterFallback.cssPrimary || '(unset)'}”`,
      );

      // And the whole session, not just the two moments we looked at.
      const final = await evaluate(cdp, readPalette);
      readings.phases.final = final;
      check(
        'nothing thrown anywhere in the session',
        final.errors.length === 0,
        final.errors.length === 0 ? 'no unhandled rejection or error, from boot to the second track change' : final.errors.join(' | '),
      );
      say('');
    },
    { width: 393, height: 852, deviceScaleFactor: 3 },
  );

  say(failures.length === 0 ? 'RESULT: the theme follows the track, and nothing threw.' : `RESULT: ${failures.length} palette check(s) failed.`);
  for (const failure of failures) say(`  - ${failure}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify(readings, null, 2));
    process.stdout.write(`\nraw measurements: ${jsonPath}\n`);
  }
  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 2;
});
