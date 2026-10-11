#!/usr/bin/env node
/**
 * The 393 px layout audit, driver two of two: **real iOS WebKit, in the iPhone 15 Pro
 * Simulator.**
 *
 * This is the run that answered the owner's report. Chrome at 393 x 852 with the stress
 * library was clean while his phone was not, and the only honest explanation is the engine:
 * an iPhone is WebKit, and WebKit sizes a few things differently (form controls, and the
 * min-content effect of `overflow-wrap: anywhere`). So the audit has to run *in* WebKit.
 *
 * How it reaches it, given that a simulator has no devtools port to attach to:
 *
 *   1. `dist/` is copied to a temp directory and one `<script>` tag is added to index.html.
 *   2. That script (tools/layout-probe-browser.js + a small bootstrap) seeds the app's own
 *      localStorage with the mock's fixture credentials, reloads into the real cold-start
 *      path, walks every route and both modes, and POSTs its measurements to `/__report`.
 *   3. The mock serves that copy (`--dist <probe dir>`) and holds the reports; this harness
 *      opens the URL in the simulator's Safari and polls the mock for the answer.
 *
 *   node tools/device-probe.mjs --device <simulator-udid-or-name>     # drive a simulator
 *   node tools/device-probe.mjs --manual                             # print the URL and wait for
 *                                                                   # any device to open it
 *
 * `--manual` is the real-device path: the phone (or any browser on the LAN) opens the printed
 * URL, runs the same audit, and this harness prints the numbers when they arrive.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatReport, formatScrollContainment, formatFocusSettings, formatSettingsOverflow, formatDeviceGestures } from './layout-audit.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const argv = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const token = process.argv[i];
  if (!token || !token.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith('--')) {
    argv.set(token.replace(/^--/, ''), next);
    i += 1;
  } else {
    argv.set(token.replace(/^--/, ''), 'true');
  }
}

const PORT = Number(argv.get('port') ?? 4599);
const DEVICE = argv.get('device');
const MANUAL = argv.has('manual');
/** Path to a built `.app` to install and launch instead of opening the URL in Safari. */
const APP_PATH = argv.get('app');
const BUNDLE_ID = argv.get('bundle-id') ?? 'app.navilite';
const WAIT_SECONDS = Number(argv.get('wait') ?? 180);
/**
 * `walk-and-scroll` (default) runs the whole route walk and then the scroll scenario.
 *
 * `scroll` runs only the scroll scenario. Safari in the simulator freezes a tab it does not
 * consider visible — and the Simulator window is behind the terminal for most of a headless run —
 * so a four-minute walk can stop half way with no report at all. The short scenario finishes well
 * inside that budget; the walk itself is covered by the 393 suite, which runs it in Chrome.
 *
 * `focus` measures the owner's two v1.5 reports on their own (the settings focus-zoom and the first
 * lyric line); `settings-overflow` takes the settings screen's sideways content apart, rule by rule,
 * in the shipping engine (v1.5 follow-up, docs/verification.md §14.1); `gesture` runs the pager's
 * gestures in this engine and posts the readings `tools/pager-check.mjs --device` judges
 * (§14.2). All three are short for the same reason `scroll` is.
 */
const SCENARIO = argv.get('scenario') ?? 'walk-and-scroll';
/**
 * `--native-audio` runs the app with its **native** player, which is the only way the v1.7.2
 * spectrum (an FFT tap inside the app) and the foreground round trip can be exercised at all.
 *
 * It flips two things about the probe, and both of them are the point: the native bridge is left
 * visible (the layout runs hide it, because an unsigned simulator build has no Keychain and the
 * app's credential store is the one thing that needs it), and the app is seeded with
 * `playback: 'auto'` rather than `'web'`, so a tapped row goes to AVFoundation instead of to the
 * `<audio>` element. Everything the layout scenarios measure is untouched by this flag.
 */
const NATIVE_AUDIO = argv.has('native-audio');
// Default: the workspace build. `--dist` points the probe at some other payload — an older
// release's assets, say, so the same scenario can be run before and after a change without
// swapping anything in and out of the tree.
const DIST = argv.get('dist') ?? join(root, 'dist');

function sh(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr?.trim() || result.stdout?.trim()}`);
  }
  return result;
}

/* ------------------------------------------------- the probe copy of dist/ */

function buildProbeBundle() {
  if (!existsSync(join(DIST, 'index.html'))) throw new Error('dist/index.html is missing — run `npm run build` first');
  const probeDir = mkdtempSync(join(tmpdir(), 'navilite-layout-probe-'));
  cpSync(DIST, probeDir, { recursive: true });

  const bootstrap = `
(function () {
  var cfg = window.__naviliteProbeConfig || {};
  var audit = window.__naviliteLayoutAudit;
  /** Readings taken before a failure, so the last post can still carry them. */
  var partial = null;
  var SEED_KEY = 'navilite.layout-probe.seeded';

  function post(payload) {
    try {
      return fetch('/__report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      return Promise.resolve(null);
    }
  }

  function beat(step) {
    return post({ progress: step, href: location.href, at: new Date().toISOString() });
  }

  try {
    /**
     * An unsigned simulator build has no Keychain entitlement, so the app's own credential
     * store cannot write: "An OS error occurred (-34018)" (errSecMissingEntitlement) — a fact
     * about the *build*, not about the app, and nothing to do with layout. The probe therefore
     * hides the native bridge before the app's module runs, which puts the app on its
     * web-storage fallback so it can sign in and be walked.
     *
     * What this changes: where the password is kept, and which audio backend the visualiser
     * uses. What it does not change: the webview, the viewport, the safe areas, the CSS, the
     * DOM — i.e. everything this audit measures. It is the only dimension in which this build
     * is not the shipped app, and it is reported with the numbers.
     */
    if (cfg.hideNativeBridge) {
      // Two levers, because either may be the one the bridge leaves us: a custom platform name
      // is what @capacitor/core reads *before* it sniffs the bridge, and the bridge itself can
      // sometimes be hidden outright.
      try {
        window.CapacitorCustomPlatform = { name: 'web' };
      } catch (error) {
        /* reported below */
      }
      try {
        if (window.webkit && window.webkit.messageHandlers) {
          try {
            delete window.webkit.messageHandlers.bridge;
          } catch (error) {
            /* fall through to the replacement below */
          }
          if (window.webkit.messageHandlers.bridge) {
            Object.defineProperty(window, 'webkit', { configurable: true, value: { messageHandlers: {} } });
          }
        }
      } catch (error) {
        /* reported below */
      }
      beat(
        'probe setup: ' +
          JSON.stringify({
            customPlatform: Boolean(window.CapacitorCustomPlatform),
            bridgeHidden: !(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.bridge),
            capacitorPlatform: (window.Capacitor && window.Capacitor.platform) || null,
          }),
      );
    }
  } catch (error) {
    /* a bridge that refuses to be hidden simply means the connect step reports -34018 */
  }

  try {
    // Seeded here, *before* the app's own module script runs: this classic script sits at the
    // end of <body> and the app is a deferred module, so writing the credentials now is the
    // same thing a first-run form submission would have done — and it avoids a reload, which
    // is one more thing that can go wrong on a device.
    localStorage.setItem(
      'navilite.settings',
      JSON.stringify({ serverUrl: location.origin, username: cfg.username || 'navidrome', playback: cfg.playback || 'web' }),
    );
    localStorage.setItem('navilite.subsonic-password', cfg.password || 'navidrome');
  } catch (error) {
    post({ error: 'could not seed the credentials: ' + error.message });
    return;
  }

  if (!audit) {
    post({ error: 'the layout probe did not load', href: location.href });
    return;
  }
  beat('booted with the audit present');

  /**
   * The connect screen. In the browser the seeded localStorage is enough and the app comes up
   * already connected; **in the native shell it is not** — there the password lives in the iOS
   * Keychain, not in web storage — so the probe fills the form the way a person would and taps
   * "Save and continue". That is the honest first-run path, and it exercises the same code the
   * owner does.
   */
  function signedIn() {
    return Boolean(window.__navilite && window.__navilite.libraryReady());
  }

  function fillAndSubmit() {
    var fields = document.querySelectorAll('.connect .field');
    if (fields.length < 3) return false;
    var values = [cfg.serverUrl || location.origin, cfg.username || 'navidrome', cfg.password || 'navidrome'];
    for (var i = 0; i < 3; i += 1) {
      fields[i].value = values[i];
      fields[i].dispatchEvent(new Event('input', { bubbles: true }));
      fields[i].dispatchEvent(new Event('change', { bubbles: true }));
    }
    var save = document.querySelector('.connect .button.primary');
    if (!save) return false;
    save.click();
    // Whatever the app says back — "Connected as …", or the credential-store error an unsigned
    // simulator build produces — is worth having in the report rather than guessing at.
    setTimeout(function () {
      var row = document.querySelector('.connect .row');
      var status = row && row.nextElementSibling ? row.nextElementSibling.textContent : '(no status)';
      beat('form result: ' + status);
    }, 8000);
    return true;
  }

  audit
    .waitFor("Boolean(document.querySelector('.connect .field')) || " + 'Boolean(window.__navilite && window.__navilite.libraryReady())', 'the app shell', 60000)
    .then(function () {
      if (signedIn()) return true;
      beat('connect screen: signing in through the form');
      if (!fillAndSubmit()) return true;
      return audit.waitFor('Boolean(window.__navilite && window.__navilite.libraryReady())', 'the library to connect', 45000);
    })
    .then(function () {
      if (cfg.scenario === 'spectrum') {
        /*
         * v1.7.2: the spectrum, the clock and the foreground return, inside the app with its native
         * player — the paths no browser and no hidden-bridge probe can reach. The probe measures all
         * three and posts them; the harness behind it (tools/spectrum-sim.sh) is what actually
         * backgrounds and relaunches the app in the middle, and the report says which driver ran.
         */
        partial = { device: audit.DEVICE, environment: audit.environment(), states: {}, spectrumOnly: true };
        beat('connected; measuring the native spectrum, the clock and the round trip');
        /*
         * A watchdog, because the measurement can hang: a Capacitor call that never settles, a
         * platform that freezes a timer. Whatever was read before the hang is still the evidence, so
         * it gets posted rather than lost.
         */
        setTimeout(function () {
          var partial = audit.nativeSpectrumProbe.lastResult;
          if (!partial || partial.posted) return;
          partial.posted = true;
          partial.watchdog = 'the run did not finish; this is what had been read';
          post({ device: audit.DEVICE, environment: audit.environment(), spectrum: partial, spectrumOnly: true });
        }, Number(cfg.spectrumWatchdogMs || 90000));
        return audit.nativeSpectrumProbe().then(function (probe) {
          probe.posted = true;
          partial.spectrum = probe;
          beat('spectrum readings taken');
          return partial;
        });
      }
      if (cfg.scenario === 'scroll') {
        // See the --scenario scroll option: the scroll readings on their own, for a browser that
        // freezes a tab it cannot see before a full walk would finish.
        beat('connected; running the scroll-containment scenario on its own');
        return { device: audit.DEVICE, environment: audit.environment(), states: {}, scrollOnly: true };
      }
      if (cfg.scenario === 'settings-overflow') {
        /*
         * The v1.5 follow-up's first question, on its own: the settings scroll surface still carried
         * 301 px of sideways content with the playback dropdown focused, and no run had named the
         * element it came from. Short like the focus scenario, and for the same reason — Safari in
         * the simulator freezes a tab it cannot see, and this has to finish well inside that budget.
         */
        partial = { device: audit.DEVICE, environment: audit.environment(), states: {}, settingsOverflowOnly: true };
        beat('connected; taking the settings screen apart');
        location.hash = '#/settings';
        return audit
          .waitFor("Boolean(document.querySelector('select.field'))", 'the playback select', 20000)
          .then(function () {
            return audit.settingsOverflowProbe();
          })
          .then(function (probe) {
            partial.settingsOverflow = probe;
            beat('settings: surface ' + probe.baseline.surfaceOverflow + ' px of sideways content, widest ' + (probe.baseline.widest ? probe.baseline.widest.selector : 'none'));
            return partial;
          });
      }
      if (cfg.scenario === 'gesture') {
        /*
         * The v1.5 follow-up's second question: the gestures have never been measured in the engine
         * that ships. No CDP reaches a simulator's Safari, so the sweep drives the app's own
         * listeners with TouchEvents from inside the page and posts what it measured — see the
         * note above fingerDrag in layout-probe-browser.js for what that can and cannot show.
         */
        partial = { device: audit.DEVICE, environment: audit.environment(), states: {}, gestureOnly: true };
        beat('connected; running the gestures in this engine');
        return audit.deviceGestureSweep().then(function (sweep) {
          partial.gestures = sweep;
          beat('the gesture sweep finished');
          return partial;
        });
      }
      if (cfg.scenario === 'focus') {
        /*
         * The owner's two reports, in real WebKit, on their own.
         *
         * The four-minute walk is what Safari in the simulator cannot sit through, but these two
         * readings need this engine specifically rather than Chrome: an iOS focus-zoom is a
         * *visual viewport* zoom that Chrome never performs, and the first lyric line's place in the
         * panel is a layout result only the shipping engine can produce. So: sign in, go to
         * settings, focus the playback dropdown, then play a stress track and measure the lyrics.
         *
         * Each reading is put into the partial report as soon as it is taken, and a failure after that
         * still posts what was measured — a run that dies at the second reading must not throw away
         * the first.
         */
        partial = { device: audit.DEVICE, environment: audit.environment(), states: {}, focusOnly: true };
        beat('connected; measuring the settings focus-zoom and the first lyric line');
        location.hash = '#/settings';
        return audit
          .waitFor("Boolean(document.querySelector('select.field'))", 'the playback select', 20000)
          .then(function () {
            return audit.focusProbe('select.field');
          })
          .then(function (focus) {
            partial.settings = focus;
            beat('settings: ' + focus.selector + ' focuses at ' + focus.fontSize + ', visual viewport x' + focus.zoom);
            location.hash = '#/album/album-ja-1';
            return audit
              .waitFor("document.querySelectorAll('.row.song').length > 0", 'the stress album', 20000)
              .then(function () {
                return audit.playRow(0);
              })
              .then(function () {
                return audit.waitFor("location.hash === '#/now'", 'the now screen', 20000);
              })
              .then(function () {
                return audit.setPillMode(1).catch(function () {
                  return null;
                });
              })
              .then(function () {
                return audit.waitFor("Boolean(document.querySelector('.lyric-line'))", 'the lyric lines', 25000);
              })
              .then(function () {
                return audit.lyricsDensity();
              })
              .then(function (lyrics) {
                partial.lyrics = lyrics;
                return partial;
              });
          });
      }
      beat('connected, walking the routes');
      return audit.walk({
        onStep: function (label) {
          beat('step: ' + label);
        },
      });
    })
    .then(function (report) {
      if (report.focusOnly || report.settingsOverflowOnly || report.gestureOnly) return report;
      beat('layout walk done; running the v1.4 scroll-containment scenario');
      return audit.scrollContainment().then(
        function (scroll) {
          report.scroll = scroll;
          return report;
        },
        function (error) {
          report.scroll = { error: String((error && error.message) || error) };
          return report;
        },
      );
    })
    .then(function (report) {
      report.probe = { source: 'page', href: location.href, at: new Date().toISOString() };
      return post(report);
    })
    .catch(function (error) {
      var report = partial || {};
      report.error = String((error && error.message) || error);
      report.stack = error && error.stack;
      report.environment = audit.environment();
      report.at = new Date().toISOString();
      return post(report);
    });
})();
`;

  const probeFile = join(probeDir, '__probe.js');
  writeFileSync(probeFile, readFileSync(join(here, 'layout-probe-browser.js'), 'utf8'));
  writeFileSync(join(probeDir, '__probe-boot.js'), bootstrap);

  const index = join(probeDir, 'index.html');
  const html = readFileSync(index, 'utf8');
  const configLiteral = `{ username: 'navidrome', password: 'navidrome', hideNativeBridge: ${APP_PATH && !NATIVE_AUDIO ? 'true' : 'false'}, scenario: '${SCENARIO}', playback: '${NATIVE_AUDIO ? 'auto' : 'web'}' }`;
  // The two probe scripts carry a query: Safari caches them by URL, and a stale probe is a silent
  // failure — the page loads, the probe script parses an error into the console, and the run ends
  // with "the layout probe did not load" while the code on disk is perfectly good.
  const stamp = Date.now().toString(36);
  const injected = html.replace(
    '</body>',
    `  <script>window.__naviliteProbeConfig = ${configLiteral};</script>\n    <script src="./__probe.js?v=${stamp}"></script>\n    <script src="./__probe-boot.js?v=${stamp}"></script>\n  </body>`,
  );
  if (injected === html) throw new Error('could not inject the probe into index.html');
  writeFileSync(index, injected);
  return probeDir;
}

/* ---------------------------------------------------------------- the mock */

function startMock(probeDir) {
  const child = spawn(
    process.execPath,
    [join(root, 'tools', 'mock-subsonic.mjs'), '--port', String(PORT), '--dist', probeDir, '--stress'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', (chunk) => process.stdout.write(`[mock] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[mock] ${chunk}`));
  return child;
}

async function waitForServer() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/__reports`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`the mock did not come up on ${PORT}`);
}

async function reportCount() {
  const response = await fetch(`http://127.0.0.1:${PORT}/__reports`);
  const body = await response.json();
  return body.count;
}

/**
 * The mock stores each post as `{ receivedAt, report }`, so the reading is one level down.
 *
 * v1.5 shipped with this harness reading the wrapper as if it were the report: `report.device` was
 * always undefined, every run ended in "no report arrived" *after* the page had posted its full
 * report, and the only way to see the numbers was to fetch `/__reports` by hand. That is why the
 * 301 px reading in the v1.5 handoff came with no element named — the field that names it was in a
 * report nothing printed.
 */
function unwrap(entry) {
  return entry && entry.report ? entry.report : entry;
}


async function waitForReport(existing) {
  const deadline = Date.now() + WAIT_SECONDS * 1000;
  let seen = existing;
  while (Date.now() < deadline) {
    const counted = await reportCount();
    if (counted > seen) {
      const response = await fetch(`http://127.0.0.1:${PORT}/__reports`);
      const body = await response.json();
      const reports = body.reports ?? [];
      /*
       * Every entry posted since the last look, in order — not just the newest one.
       *
       * A progress beat is not a report: the bootstrap posts one `beat` per step so a caller can
       * watch a run it cannot see, and the last post of the run is the report itself (`device` and
       * the readings, or `error`). But the page posts its report and the beat that follows it in the
       * same millisecond, so reading only the newest entry when the count moves *after* both have
       * landed reads the beat, sets `seen` past the report, and waits out the whole timeout with the
       * answer sitting in the store — which is exactly how the v1.5 card lost its 301 px report.
       */
      for (let index = seen; index < reports.length; index += 1) {
        const report = unwrap(reports[index]);
        if (report && (report.device || report.error)) return report;
        process.stdout.write(`  beat: ${report?.progress ?? JSON.stringify(report)}\n`);
      }
      seen = reports.length;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return null;
}

/* ------------------------------------------------------------------- main */

async function main() {
  const probeDir = buildProbeBundle();
  const mock = startMock(probeDir);
  let device = DEVICE;
  if (argv.has('serve')) {
    // Keep the probe server up so the caller can install/launch the app itself — the mode the
    // native-shell run uses, because the app has to be built pointing at this port.
    await waitForServer();
    process.stdout.write(`probe bundle: ${probeDir}\nmock: http://127.0.0.1:${PORT}/ (stress library)\n`);
    process.stdout.write('serving until killed…\n');
    await new Promise(() => {});
  }
  try {
    await waitForServer();
    const url = `http://127.0.0.1:${PORT}/`;
    const existing = await reportCount();

    if (MANUAL) {
      process.stdout.write(`probe serving on ${url}\nopen that URL on the device under test; waiting ${WAIT_SECONDS}s for its report…\n`);
    } else {
      if (!device) {
        const listed = sh('xcrun', ['simctl', 'list', 'devices', 'available']).stdout;
        const booted = /\(Booted\)/.exec(listed) ? listed.split('\n').find((line) => line.includes('(Booted)')) : null;
        const named = listed.split('\n').find((line) => line.includes('iPhone 15 Pro'));
        const line = booted ?? named;
        if (!line) throw new Error('no booted simulator and no iPhone 15 Pro device — create one with `xcrun simctl create`');
        device = (line.match(/\(([0-9A-F-]{36})\)/) ?? [])[1];
        if (!device) throw new Error(`could not read a device id out of: ${line.trim()}`);
      }
      sh('xcrun', ['simctl', 'boot', device], { allowFailure: true });
      sh('xcrun', ['simctl', 'bootstatus', device, '-b']);
      if (APP_PATH) {
        // The native shell path: install the real app and launch it, so the webview is a
        // WKWebView inside the app (its own safe areas, its own contentInset) rather than
        // Safari with a URL bar. The app has to be built with `server.url` pointing at this
        // probe port — see docs/verification.md.
        sh('xcrun', ['simctl', 'install', device, APP_PATH]);
        sh('xcrun', ['simctl', 'launch', device, BUNDLE_ID]);
        process.stdout.write(`installed and launched ${APP_PATH} (${BUNDLE_ID}) on ${device}; waiting ${WAIT_SECONDS}s for its report…\n`);
      } else {
        sh('xcrun', ['simctl', 'openurl', device, url]);
        process.stdout.write(`opened ${url} in the simulator's Safari (${device}); waiting ${WAIT_SECONDS}s for its report…\n`);
      }
    }

    const received = await waitForReport(existing);
    if (!received) {
      process.stderr.write('no report arrived. On a simulator: check that Safari opened and the app connected.\n');
      process.exitCode = 2;
      return;
    }
    const report = unwrap(received);
    if (report.error) {
      process.stdout.write(`the probe failed: ${report.error}\n`);
      if (report.stack) process.stdout.write(`${report.stack}\n`);
      // Whatever was measured before the failure is still a measurement.
      if (report.settings) {
        const focus = report.settings;
        process.stdout.write(
          `  measured before the failure — ${focus.selector}: focuses at ${focus.fontSize}, ` +
            `visual viewport ${focus.before.vvWidth}x${focus.before.vvHeight} (scale ${focus.before.vvScale}) -> ` +
            `${focus.after.vvWidth}x${focus.after.vvHeight} (scale ${focus.after.vvScale}), x${focus.zoom}\n`,
        );
        if (focus.surfaceWhileFocused) {
          const s = focus.surfaceWhileFocused;
          process.stdout.write(
            `    ${s.surface}: ${s.surfaceClientWidth} -> ${s.surfaceScrollWidth} px (${s.surfaceOverflow} px to scroll sideways), ` +
              `document ${s.documentOverflow} px\n`,
          );
        }
        if (focus.widestWhileFocused) {
          const w = focus.widestWhileFocused;
          process.stdout.write(
            `    widest inside the scroller: ${w.selector} — box ${w.clientWidth} px, content ${w.scrollWidth} px (${w.overflow} px wider)\n`,
          );
        }
      }
      if (report.lyrics) {
        const lyrics = report.lyrics;
        process.stdout.write(
          `  measured before the failure — lyrics: ${lyrics.visibleLines} of ${lyrics.lines} lines fit whole in ${Math.round(lyrics.panelHeight)} px, ` +
            `first line ${(lyrics.firstLineTop - lyrics.panelTop).toFixed(1)} px in, in the faded band: ${lyrics.firstLineInFade}\n`,
        );
      }
      process.stdout.write(`${JSON.stringify(report.environment ?? {}, null, 2)}\n`);
      process.exitCode = 3;
      return;
    }
    if (!report || typeof report.device !== 'object' || report.device === null) {
      // The bootstrap posts what it has, even when the walk never got going — show it as-is
      // rather than dying inside the formatter with "cannot read properties of undefined".
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      throw new Error(`the probe posted no layout readings${report?.error ? `: ${report.error}` : ''}`);
    }
    const scrollOnly = report.scrollOnly === true;
    const focusOnly = report.focusOnly === true;
    const settingsOnly = report.settingsOverflowOnly === true;
    const gestureOnly = report.gestureOnly === true;
    let failures = 0;
    if (focusOnly) {
      // The owner's two v1.5 reports, measured on their own: the settings focus-zoom and the first
      // lyric line. Both are readings, and both are failures when they come back wrong.
      const formatted = formatFocusSettings(report);
      failures = formatted.failures;
      process.stdout.write(`${formatted.text}\n`);
    } else if (settingsOnly) {
      const formatted = formatSettingsOverflow(report.settingsOverflow);
      failures = formatted.failures;
      process.stdout.write(`${formatted.text}\n`);
    } else if (gestureOnly) {
      const formatted = formatDeviceGestures(report.gestures);
      failures = formatted.failures;
      process.stdout.write(`${formatted.text}\n`);
    } else if (!scrollOnly) {
      const formatted = formatReport(report, 'real iOS WebKit — env() comes from the OS');
      failures = formatted.failures;
      process.stdout.write(`${formatted.text}\n`);
    } else {
      const env = report.environment ?? {};
      process.stdout.write(`Device under test: ${report.device.name} — ${report.device.width}x${report.device.height} CSS px, dpr ${report.device.deviceScaleFactor}\n`);
      process.stdout.write(`  innerWidth ${env.innerWidth} · innerHeight ${env.innerHeight} · dpr ${env.devicePixelRatio} · visualViewport ${env.visualViewportWidth} (scale ${env.visualViewportScale})\n`);
      process.stdout.write('  (scroll scenario only — the route walk is covered by the 393 suite, which runs it in Chrome)\n\n');
    }
    let scrollFailed = false;
    if (!focusOnly && !settingsOnly && !gestureOnly) {
      const scrollLines = formatScrollContainment(report.scroll);
      process.stdout.write(`${scrollLines.join('\n')}\n`);
      scrollFailed = Boolean(report.scroll) && (Boolean(report.scroll.error) || report.scroll.passed === false);
    }
    const reportName = scrollOnly
      ? 'layout-393-scroll-device-report.json'
      : focusOnly
        ? 'layout-393-focus-device-report.json'
        : settingsOnly
          ? 'layout-393-settings-overflow-device-report.json'
          : gestureOnly
            ? 'layout-393-gesture-device-report.json'
            : 'layout-393-device-report.json';
    const out = join(root, 'docs', reportName);
    writeFileSync(out, JSON.stringify(report, null, 2));
    // `--json` is for a caller that wants the readings rather than the prose: `tools/pager-check.mjs
    // --device` runs this command and judges the sweep itself, so both drivers print the same labels.
    const jsonCopy = argv.get('json');
    if (jsonCopy) writeFileSync(jsonCopy, JSON.stringify(report, null, 2));
    process.stdout.write(`\nraw measurements: ${out}\n`);
    process.exitCode = failures === 0 && !scrollFailed ? 0 : 1;
  } finally {
    mock.kill('SIGTERM');
    rmSync(probeDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 4;
});
