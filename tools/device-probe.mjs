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
import { formatReport } from './layout-audit.mjs';

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
const DIST = join(root, 'dist');

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
      JSON.stringify({ serverUrl: location.origin, username: cfg.username || 'navidrome', playback: 'web' }),
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
      beat('connected, walking the routes');
      return audit.walk({
        onStep: function (label) {
          beat('step: ' + label);
        },
      });
    })
    .then(function (report) {
      report.probe = { source: 'page', href: location.href, at: new Date().toISOString() };
      return post(report);
    })
    .catch(function (error) {
      return post({
        error: String((error && error.message) || error),
        stack: error && error.stack,
        environment: audit.environment(),
        at: new Date().toISOString(),
      });
    });
})();
`;

  const probeFile = join(probeDir, '__probe.js');
  writeFileSync(probeFile, readFileSync(join(here, 'layout-probe-browser.js'), 'utf8'));
  writeFileSync(join(probeDir, '__probe-boot.js'), bootstrap);

  const index = join(probeDir, 'index.html');
  const html = readFileSync(index, 'utf8');
  const configLiteral = `{ username: 'navidrome', password: 'navidrome', hideNativeBridge: ${APP_PATH ? 'true' : 'false'} }`;
  const injected = html.replace(
    '</body>',
    `  <script>window.__naviliteProbeConfig = ${configLiteral};</script>\n    <script src="./__probe.js"></script>\n    <script src="./__probe-boot.js"></script>\n  </body>`,
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

async function latestReport() {
  const response = await fetch(`http://127.0.0.1:${PORT}/__reports`);
  const body = await response.json();
  return body.reports[body.reports.length - 1];
}

async function waitForReport(existing) {
  const deadline = Date.now() + WAIT_SECONDS * 1000;
  while (Date.now() < deadline) {
    if ((await reportCount()) > existing) return await latestReport();
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
    const report = received.report;
    if (report.error) {
      process.stdout.write(`the probe failed: ${report.error}\n`);
      if (report.stack) process.stdout.write(`${report.stack}\n`);
      process.stdout.write(`${JSON.stringify(report.environment ?? {}, null, 2)}\n`);
      process.exitCode = 3;
      return;
    }
    const { text, failures } = formatReport(report, 'real iOS WebKit — env() comes from the OS');
    process.stdout.write(`${text}\n`);
    const out = join(root, 'docs', 'layout-393-device-report.json');
    writeFileSync(out, JSON.stringify(report, null, 2));
    process.stdout.write(`\nraw measurements: ${out}\n`);
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    mock.kill('SIGTERM');
    rmSync(probeDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 4;
});
