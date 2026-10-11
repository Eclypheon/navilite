#!/usr/bin/env node
/**
 * The foreground half of the v1.7.2 spectrum run: **really background the app and bring it back.**
 *
 * `tools/device-probe.mjs --scenario spectrum` measures the native spectrum, the clock and one
 * foreground round trip from inside the app. It can drive the whole thing itself by faking
 * `document.hidden`, and it says so in the report when it does — but the owner's report is about
 * what happens when the app *actually* leaves the screen, and a faked event is a weaker reading. A
 * simulator has no devtools port to drive it through, so this script is the finger: it watches the
 * mock's report channel until the probe says it is waiting, sends the app to the home screen, waits
 * long enough for the round trip to be a real gap, and brings it back.
 *
 *   node tools/spectrum-roundtrip.mjs --device <simulator-udid> [--port 4599] [--gap 4]
 *
 * Why AppleScript: `simctl` can launch an app but has no "go home" verb, and backgrounding is the
 * thing being tested. `simctl terminate` would *kill* the app, which is a different question
 * (cold start) and would not prove anything about a backgrounded player. The keystroke is the one
 * action that is exactly what a person does, and it needs the Simulator window and macOS
 * automation permission — if it is refused, this script fails loudly rather than quietly reporting
 * a round trip it never made.
 */
import { spawnSync } from 'node:child_process';

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
const BUNDLE_ID = argv.get('bundle-id') ?? 'app.navilite';
const GAP_SECONDS = Number(argv.get('gap') ?? 4);
const READY_BEAT = 'ready for the foreground round trip';
const READY_TIMEOUT_MS = Number(argv.get('ready-timeout') ?? 180) * 1000;
const FINAL_TIMEOUT_MS = Number(argv.get('final-timeout') ?? 120) * 1000;

if (!DEVICE) {
  console.error('usage: node tools/spectrum-roundtrip.mjs --device <simulator-udid-or-name>');
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function reports() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/__reports`);
    const body = await response.json();
    return Array.isArray(body.reports) ? body.reports.map((entry) => entry.report) : [];
  } catch {
    return [];
  }
}

function osascript(script) {
  const result = spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`osascript failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout.trim();
}

/**
 * Send the app to the background for real.
 *
 * The obvious driver is the home-screen keystroke, and macOS refuses it here (`osascript is not
 * allowed to send keystrokes`) unless the host has granted Accessibility permission to whatever is
 * running this. Launching a different app is the same thing from the app's point of view — SpringBoard
 * backgrounds the one in front — and needs no permission at all.
 */
function background() {
  try {
    osascript('tell application "Simulator" to activate');
    osascript('tell application "System Events" to keystroke "h" using {command down, shift down}');
    return 'the home screen (cmd-shift-h)';
  } catch {
    simctl('launch', DEVICE, 'com.apple.Preferences');
    return 'Apple Settings, brought to the front (cmd-shift-h was refused)';
  }
}

function simctl(...args) {
  const result = spawnSync('xcrun', ['simctl', ...args], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`simctl ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout.trim();
}

/** Wait for the probe's own announcement that it is holding a reading and wants the gap. */
async function waitForReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const seen = await reports();
    if (seen.some((report) => report && report.progress === READY_BEAT)) return true;
    await sleep(500);
  }
  return false;
}

async function waitForFinal(before) {
  const deadline = Date.now() + FINAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const seen = await reports();
    const found = seen.find((report) => report && report.spectrum);
    if (found && (!before || seen.length > before)) return found;
    await sleep(500);
  }
  return null;
}

const ready = await waitForReady();
if (!ready) {
  console.error(`the probe never asked for the round trip (no "${READY_BEAT}" beat on :${PORT})`);
  process.exit(1);
}

// The app is on screen and the probe has taken its "before" reading. Send it to the background.
const driver = background();
console.log(`backgrounding ${BUNDLE_ID} with ${driver}, for ${GAP_SECONDS}s`);
await sleep(GAP_SECONDS * 1000);
simctl('launch', DEVICE, BUNDLE_ID);
console.log('brought it back');
const report = await waitForFinal();
if (!report) {
  console.error('the probe never posted a spectrum report after the round trip');
  process.exit(1);
}
if (report.spectrum) report.spectrum.roundTrip.driver = driver;
console.log(JSON.stringify(report.spectrum ?? report, null, 2));
