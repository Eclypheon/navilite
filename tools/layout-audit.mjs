#!/usr/bin/env node
/**
 * The 393 px layout audit, driver one of two: headless Chrome over CDP.
 *
 * Why this exists: v1.1 was reported "clean" at 390 and 360 CSS px, and the owner still saw
 * a sideways scroll on the real device. 390 is *narrower* than his 393, so a harness that only
 * looked at 390 was never reproducing his conditions. Two things were missing:
 *
 *   1. **393 x 852 at dpr 3**, the iPhone 15 Pro's own numbers, under
 *      `Emulation.setDeviceMetricsOverride` (including the safe-area insets, when Chrome
 *      supports `Emulation.setSafeAreaInsetsOverride`).
 *   2. **Content that can actually push a layout wide**: a long Japanese title (CJK has no
 *      spaces to break at) and long playlist names, on every route, in both the Spectrum and
 *      Lyrics modes, and mid-swipe. The old fixture was all "Track 1 · 110/330/1320 Hz" and
 *      a playlist called "Late night", so nothing in it could ever stress a layout. Run the
 *      mock with `--stress` for that library.
 *
 * The measurement itself lives in tools/layout-probe-browser.js, which is injected into the
 * page — the same file the iOS Simulator probe uses, because Chrome is not WebKit and the
 * owner's phone is. This driver is the fast loop; `tools/device-probe.mjs` is the honest one.
 *
 *   node tools/layout-audit.mjs --url http://127.0.0.1:4533 [--json report.json]
 *
 * Exit code is non-zero when the document is wider than the viewport, which is what
 * `test/layout-393.test.ts` relies on so this cannot come back quietly.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PROBE_SOURCE = readFileSync(join(here, 'layout-probe-browser.js'), 'utf8');

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

export function findChrome() {
  return CHROME_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

/* ------------------------------------------------------------ CDP plumbing */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${JSON.stringify(message.error)})`));
        else resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), timeoutMs);
      const listener = (params) => {
        clearTimeout(timer);
        this.listeners.set(method, (this.listeners.get(method) ?? []).filter((item) => item !== listener));
        resolve(params);
      };
      this.listeners.set(method, [...(this.listeners.get(method) ?? []), listener]);
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already gone */
    }
  }
}

async function waitForDevtools(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return await response.json();
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`Chrome did not open a devtools port on ${port}`);
}

/** Boot headless Chrome, hand a connected page to `fn`, and always shut the browser down. */
export async function withChromePage(fn, options = {}) {
  const chrome = options.chromePath ?? findChrome();
  if (!chrome) throw new Error('no Chrome/Chromium binary found');
  const port = options.port ?? 9500 + Math.floor(Math.random() * 400);
  const profile = mkdtempSync(join(tmpdir(), 'navilite-chrome-'));
  const child = spawn(
    chrome,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--hide-scrollbars',
      '--autoplay-policy=no-user-gesture-required',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  let cdp = null;
  try {
    await waitForDevtools(port);
    const created = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(created.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('could not open the devtools socket')), { once: true });
    });
    cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // 393 x 852, dpr 3: the owner's iPhone 15 Pro, not a desktop window resized by hand.
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: options.width ?? 393,
      height: options.height ?? 852,
      deviceScaleFactor: options.deviceScaleFactor ?? 3,
      mobile: true,
      screenWidth: options.width ?? 393,
      screenHeight: options.height ?? 852,
      screenOrientation: { type: 'portraitPrimary', angle: 0 },
    });
    // The Dynamic Island and the home indicator. Chrome reports `env()` as 0 without this, and
    // a harness that cannot see the insets cannot claim it reproduced a notched iPhone.
    let safeArea = null;
    try {
      await cdp.send('Emulation.setSafeAreaInsetsOverride', {
        insets: { top: 59, bottom: 34, left: 0, right: 0 },
      });
      safeArea = 'Emulation.setSafeAreaInsetsOverride (top 59, bottom 34)';
    } catch {
      safeArea = null;
    }
    // The measurement itself: injected before any page script runs, so it is available on the
    // very first paint.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE_SOURCE });
    return await fn({ cdp, port, safeArea });
  } finally {
    cdp?.close();
    child.kill('SIGKILL');
    // Chrome may still be writing into its profile when it gets the signal; a leftover temp
    // directory is not worth failing a passing run over.
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* the OS will reap it */
    }
  }
}

export async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(`page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  }
  return result.result.value;
}

export async function navigate(cdp, url) {
  const loaded = cdp.once('Page.loadEventFired');
  await cdp.send('Page.navigate', { url });
  await loaded;
}

/**
 * Seed the app's own storage with the mock's published fixture credentials and run the whole
 * walk. This is the path a real install takes — cold start, stored session, restored queue —
 * not a debug hook.
 */
export async function runAudit(cdp, options) {
  const baseUrl = options.url;
  await navigate(cdp, baseUrl);
  await evaluate(
    cdp,
    `(() => {
      localStorage.setItem('navilite.settings', JSON.stringify({ serverUrl: ${JSON.stringify(baseUrl)}, username: ${JSON.stringify(options.username ?? 'navidrome')}, playback: 'web' }));
      localStorage.setItem('navilite.subsonic-password', ${JSON.stringify(options.password ?? 'navidrome')});
      return true;
    })()`,
  );
  await navigate(cdp, baseUrl);
  await evaluate(
    cdp,
    `window.__naviliteLayoutAudit.waitFor('Boolean(window.__navilite && window.__navilite.libraryReady())', 'the library to connect')`,
  );
  return await evaluate(cdp, 'window.__naviliteLayoutAudit.walk()');
}

/* ----------------------------------------------------------------- reporting */

export function formatReport(report, safeArea) {
  const lines = [];
  const env = report.environment;
  lines.push(`Device under test: ${report.device.name} — ${report.device.width}x${report.device.height} CSS px, dpr ${report.device.deviceScaleFactor}`);
  lines.push(`  innerWidth ${env.innerWidth} · innerHeight ${env.innerHeight} · dpr ${env.devicePixelRatio} · visualViewport ${env.visualViewportWidth} (scale ${env.visualViewportScale})`);
  lines.push(`  env(safe-area-inset-*) top ${env.safeAreaInsets.top} right ${env.safeAreaInsets.right} bottom ${env.safeAreaInsets.bottom} left ${env.safeAreaInsets.left}`);
  lines.push(`  viewport meta: ${env.viewportMeta}`);
  lines.push(`  safe-area emulation: ${safeArea ?? 'NOT applied — env() would read 0 in this Chrome'}`);
  lines.push('');
  let failures = 0;
  for (const result of report.results) {
    const ok = result.horizontalOverflow <= 0;
    if (!ok) failures += 1;
    lines.push(`${ok ? 'ok  ' : 'FAIL'}  ${result.label}`);
    lines.push(
      `      innerWidth ${result.innerWidth} · document clientWidth ${result.documentClientWidth} · scrollWidth ${result.documentScrollWidth} · overflow ${result.horizontalOverflow} px`,
    );
    for (const offender of result.actualOffenders) {
      lines.push(`      OFFENDER: ${offender.selector}`);
      lines.push(
        `        right ${offender.right} > innerWidth ${result.innerWidth} (+${offender.overflow} px) · width ${offender.width} · css width “${offender.cssWidth}” min-width “${offender.minWidth}” · position ${offender.position} · “${offender.text}”`,
      );
    }
    for (const inner of result.selfOverflow) {
      lines.push(`      content wider than its box: ${inner.selector} (scrollWidth ${inner.scrollWidth} > clientWidth ${inner.clientWidth})`);
    }
    for (const edge of (result.tightestEdges ?? []).slice(0, 3)) {
      lines.push(`      tightest: ${edge.selector} — right ${edge.right}, slack ${edge.slack} px (width ${edge.width})`);
    }
    for (const clippedItem of result.overflowersInsideScrollers) {
      lines.push(`      inside a horizontal scroller (not a page offender): ${clippedItem.selector} in ${clippedItem.insideScroller}`);
    }
    if (result.detail && typeof result.detail.visibleLines === 'number') {
      const d = result.detail;
      lines.push(
        `      lyrics: ${d.visibleLines} of ${d.lines} lines fit whole · line box ${d.lineHeight} px at ${d.fontSize} · panel ${d.panelHeight} px · cover ${d.coverVisible ? `${d.coverHeight} px (visible)` : 'hidden'}`,
      );
    }
    if (result.detail && typeof result.detail.loudPixels === 'number') {
      const d = result.detail;
      lines.push(
        `      spectrum pixels: ${d.loudPixels} lit while playing → ${d.pixelsNextFrameAfterSilence} on the very next frame after silence (canvas ${d.canvas})`,
      );
      lines.push(
        `        two consecutive silent frames: ${d.silentFramesIdentical ? 'identical' : 'DIFFERENT'} · ${d.bytesDifferingBetweenSilentFrames} differing bytes`,
      );
    }
  }
  lines.push('');
  lines.push(failures === 0 ? 'RESULT: no horizontal overflow anywhere.' : `RESULT: ${failures} state(s) overflow the viewport.`);
  return { text: lines.join('\n'), failures };
}

/* ----------------------------------------------------------------------- CLI */

/**
 * The width sweep: the same app, the same content, every width from `from` to `to`.
 *
 * It exists because "does it fit on my phone" has a second half nobody asked about — *which
 * widths* it fits at. iOS can report a narrower `device-width` than the hardware's 393 (Display
 * Zoom / Larger Text changes the logical screen to 320 pt), and a layout that only fits at one
 * width is not responsive, it is tuned. The sweep names the first width that overflows.
 */
async function sweep(cdp, options) {
  const { from, to, step = 1, baseUrl } = options;
  const routes = [
    ['#/artists', "document.querySelectorAll('.row').length > 0", 'the artist list'],
    ['#/artist/artist-ja', "document.querySelectorAll('.card').length > 0", 'the stress artist'],
    ['#/album/album-ja-1', "document.querySelectorAll('.row.song').length > 0", 'the stress album'],
    ['#/playlists', "document.querySelectorAll('.row').length > 2", 'the playlist list'],
    ['#/playlist/pl-stress-ja', "document.querySelectorAll('.row.song').length > 0", 'the stress playlist'],
    ['#/settings', "document.querySelector('select') !== null", 'settings'],
    ['#/changelog', "document.querySelector('.release') !== null", 'the changelog'],
    ['#/now', "Boolean(document.querySelector('.now-canvas'))", 'the now screen'],
  ];
  const failures = [];
  const clean = [];
  for (let width = from; width <= to; width += step) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: options.height ?? 852,
      deviceScaleFactor: 3,
      mobile: true,
      screenWidth: width,
      screenHeight: options.height ?? 852,
      screenOrientation: { type: 'portraitPrimary', angle: 0 },
    });
    const bad = [];
    for (const [hash, waitExpression, label] of routes) {
      await evaluate(cdp, `(() => { if (location.hash === ${JSON.stringify(hash)}) location.hash = ''; location.hash = ${JSON.stringify(hash)}; return true; })()`);
      await evaluate(cdp, `window.__naviliteLayoutAudit.waitFor(${JSON.stringify(waitExpression)}, ${JSON.stringify(label)}, 8000)`);
      await new Promise((resolve) => setTimeout(resolve, 220));
      const measured = await evaluate(cdp, 'window.__naviliteLayoutAudit.measure()');
      if (measured.horizontalOverflow > 0) {
        bad.push({
          route: hash,
          overflow: measured.horizontalOverflow,
          offenders: measured.actualOffenders.map((item) => `${item.selector} (right ${item.right}, width ${item.width}, css width ${item.cssWidth})`),
        });
      }
    }
    if (bad.length > 0) failures.push({ width, bad });
    else clean.push(width);
  }
  return { from, to, step, clean, failures };
}

async function main() {
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
  const url = argv.get('url') ?? 'http://127.0.0.1:4533';
  const jsonPath = argv.get('json');
  const sweepRange = argv.get('sweep');
  if (sweepRange) {
    const [from, to] = String(sweepRange).split(':').map(Number);
    const height = Number(argv.get('height') ?? 852);
    await withChromePage(async ({ cdp }) => {
      await runAudit(cdp, { url, width: 393, height });
      const result = await sweep(cdp, { from, to, step: Number(argv.get('step') ?? 1), baseUrl: url, height });
      process.stdout.write(`width sweep ${result.from}–${result.to} px (step ${result.step}), height ${height} px\n`);
      process.stdout.write(`clean at ${result.clean.length} width(s): ${result.clean[0] ?? '—'}–${result.clean[result.clean.length - 1] ?? '—'}\n`);
      if (result.failures.length === 0) process.stdout.write('no width in the range overflows the viewport.\n');
      for (const failure of result.failures) {
        process.stdout.write(`FAIL at ${failure.width} px\n`);
        for (const item of failure.bad) {
          process.stdout.write(`   ${item.route}: overflow ${item.overflow} px — ${item.offenders.join('; ') || 'no element offender'}\n`);
        }
      }
      if (jsonPath) writeFileSync(jsonPath, JSON.stringify(result, null, 2));
      process.exitCode = result.failures.length === 0 ? 0 : 1;
    }, { width: 393, height });
    return;
  }
  await withChromePage(async ({ cdp, safeArea }) => {
    const report = await runAudit(cdp, { url });
    const { text, failures } = formatReport(report, safeArea);
    process.stdout.write(`${text}\n`);
    if (jsonPath) {
      writeFileSync(jsonPath, JSON.stringify(report, null, 2));
      process.stdout.write(`\nraw measurements: ${jsonPath}\n`);
    }
    process.exitCode = failures === 0 ? 0 : 1;
  });
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''));
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 2;
  });
}
