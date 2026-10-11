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

/**
 * Did focusing a control on this step zoom the page in? (v1.5.)
 *
 * A ratio of the visual viewport before and after focus: > 1 is an iOS focus-zoom, which is the
 * mechanism behind "i still seem to be able to scroll horizontally" on a screen whose layout width
 * is clean. `null`/`undefined` details (steps that focused nothing) are never zoomed.
 */
export function focusZoom(detail) {
  if (!detail || typeof detail.zoom !== 'number') return false;
  return detail.zoom > 1.001;
}

export function formatReport(report, safeArea) {
  const lines = [];
  const env = report.environment;
  lines.push(`Device under test: ${report.device.name} — ${report.device.width}x${report.device.height} CSS px, dpr ${report.device.deviceScaleFactor}`);
  lines.push(`  innerWidth ${env.innerWidth} · innerHeight ${env.innerHeight} · dpr ${env.devicePixelRatio} · visualViewport ${env.visualViewportWidth} (scale ${env.visualViewportScale})`);
  lines.push(`  env(safe-area-inset-*) top ${env.safeAreaInsets.top} right ${env.safeAreaInsets.right} bottom ${env.safeAreaInsets.bottom} left ${env.safeAreaInsets.left}`);
  lines.push(`  viewport meta: ${env.viewportMeta}`);
  lines.push(`  safe-area emulation: ${safeArea ?? 'NOT applied — env() would read 0 in this Chrome'}`);
  lines.push(`  scroll surface measured: ${report.results[0]?.scrollSurface ?? '(unknown)'} — since v1.4 the app's own scroll container, not the document`);
  lines.push('');
  let failures = 0;
  for (const result of report.results) {
    // v1.5: a route is clean when it neither overflows nor zooms under a finger. An iOS focus-zoom
    // leaves the layout width untouched and makes the page pannable anyway — the owner's settings
    // report — so it counts as a failure here.
    const zoom = focusZoom(result.detail);
    const ok = result.horizontalOverflow <= 0 && !zoom;
    if (!ok) failures += 1;
    lines.push(`${ok ? 'ok  ' : 'FAIL'}  ${result.label}`);
    lines.push(
      `      innerWidth ${result.innerWidth} · document clientWidth ${result.documentClientWidth} · scrollWidth ${result.documentScrollWidth} · overflow ${result.horizontalOverflow} px`,
    );
    if (zoom) {
      lines.push(
        `      ZOOMS: ${result.detail.selector} at ${result.detail.fontSize} font — visual viewport ×${result.detail.zoom} (${result.detail.before.vvWidth} → ${result.detail.after.vvWidth} px): an iOS focus-zoom makes the screen pannable sideways`,
      );
    }
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
      if (typeof d.firstLineTop === 'number') {
        lines.push(
          `        first line: top ${d.firstLineTop} vs panel top ${d.panelTop} (${Math.round((d.firstLineTop - d.panelTop) * 100) / 100} px in) · inside the panel's ${d.firstLineFullyInside ? 'yes' : 'NO'} · in the faded 16 px band: ${d.firstLineInFade ? 'YES' : 'no'}`,
        );
      }
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

/**
 * The v1.4 scroll-containment readings, as a report. In-page on a device — where nothing can
 * synthesise a gesture — the checks are geometric instead of gestural: the header rectangle, the
 * document's scroll position, and which element hit-testing returns at each point of the screen.
 */
export function formatScrollContainment(scroll) {
  const lines = [];
  if (!scroll) return ['scroll containment: no readings arrived'];
  if (scroll.error) return [`scroll containment: FAILED — ${scroll.error}`];
  lines.push('Scroll containment (v1.4) — what moved when the screen was asked to scroll:');
  const opened = scroll.before;
  if (opened) {
    lines.push(`  scroll surface: ${opened.scrollSurface} (overflow-y ${opened.overflowY}, overscroll-behavior-y ${opened.overscrollY})`);
    lines.push(`  the list: scrollTop ${opened.scrollTop} of ${opened.scrollable} px scrollable`);
    lines.push(`  the document: scrollTop ${opened.documentScrollTop}, scrollable ${opened.documentScrollable} px, window.scrollY ${opened.windowScrollY}`);
    lines.push(`  the top bar: top ${opened.header.top} · height ${opened.header.height} · position ${opened.headerPosition}`);
  }
  if (scroll.after) {
    lines.push(`  after the spectrum was opened, everything scrolled and closed again:`);
    lines.push(`    the list: scrollTop ${scroll.after.scrollTop} (was ${opened.scrollTop}) — ${scroll.listRestored ? 'restored exactly' : 'NOT restored'}`);
    lines.push(`    the top bar: top ${scroll.after.header.top} · height ${scroll.after.header.height} — ${scroll.headerUnchanged ? 'identical' : 'CHANGED'}`);
    lines.push(`    the document: scrollTop ${scroll.after.documentScrollTop} · scrollable ${scroll.after.documentScrollable} px`);
  }
  if (scroll.programmatic) {
    lines.push(`  scrolling the frozen container programmatically moved it by ${scroll.programmatic.moved} px (browser behaviour for overflow: hidden) — the offset was still restored exactly`);
  }
  for (const [label, ok] of Object.entries(scroll.checks ?? {})) {
    lines.push(`  ${ok === true ? 'ok  ' : 'FAIL'}  ${label}`);
  }
  lines.push('');
  lines.push(scroll.passed ? 'RESULT: the scroll did not reach anything it should not have.' : 'RESULT: FAIL — something moved that should not have.');
  return lines;
}

/* ------------------------------ the device driver's readings (v1.5 follow-up) */

/**
 * The owner's two v1.5 reports as they came off the device: the settings screen's focus-zoom and
 * the first lyric line inside the panel's faded band.
 *
 * Kept apart from `formatReport` because a `--scenario focus` report carries two readings and no
 * route walk, and because both of these are *failures* when they come back wrong: a zoom of 1.07 is
 * a pannable settings screen however clean its width is, and a first line inside the fade is the
 * clipping the owner photographed.
 */
export function formatFocusSettings(report) {
  const lines = [];
  const failures = [];
  const settings = report.settings;
  const lyrics = report.lyrics;
  if (settings) {
    lines.push('The settings screen, focused the way a finger focuses it:');
    lines.push(`  ${settings.selector} at ${settings.fontSize} (control box ${settings.control.clientWidth} px, content ${settings.control.scrollWidth} px)`);
    lines.push(
      `  visual viewport ${settings.before.vvWidth}x${settings.before.vvHeight} (scale ${settings.before.vvScale}) -> ` +
        `${settings.after.vvWidth}x${settings.after.vvHeight} (scale ${settings.after.vvScale}) — zoom x${settings.zoom}`,
    );
    if (settings.zoom > 1.001) {
      failures.push(`${settings.selector} zooms the visual viewport x${settings.zoom} when it takes focus`);
    }
    const surface = settings.surfaceWhileFocused;
    if (surface) {
      lines.push(
        `  scroll surface ${surface.surface}: ${surface.surfaceClientWidth} -> ${surface.surfaceScrollWidth} px ` +
          `(${surface.surfaceOverflow} px of sideways content), document ${surface.documentOverflow} px`,
      );
      if (surface.surfaceOverflow > 0) {
        failures.push(`the settings scroll surface carries ${surface.surfaceOverflow} px of sideways content`);
      }
    }
    const widest = settings.widestWhileFocused;
    if (widest) {
      lines.push(
        `  widest inside the scroller: ${widest.selector} — box ${widest.clientWidth} px, content ${widest.scrollWidth} px (+${widest.overflow} px)`,
      );
    }
  }
  if (lyrics) {
    lines.push('The lyrics panel:');
    lines.push(
      `  ${lyrics.visibleLines} of ${lyrics.lines} lines fit whole in ${Math.round(lyrics.panelHeight)} px; ` +
        `first line ${(lyrics.firstLineTop - lyrics.panelTop).toFixed(1)} px below the panel top`,
    );
    if (lyrics.firstLineFullyInside !== true || lyrics.firstLineInFade === true) {
      failures.push('the first lyric line is not drawn whole and clear of the panel\u2019s faded band');
    }
  }
  lines.push('');
  lines.push(failures.length === 0 ? 'RESULT: both of the owner\u2019s reports are clean in real WebKit.' : `RESULT: ${failures.length} reading(s) still wrong in real WebKit.`);
  for (const failure of failures) lines.push(`  - ${failure}`);
  return { text: lines.join('\n'), failures: failures.length };
}

/**
 * The settings screen's 301 px, as a table of measured candidates.
 *
 * The *shipping* rule set is the baseline line: every candidate below it is a measurement of what
 * one change would do, taken in the same engine in the same run. The verdict is about the baseline,
 * because that is what the owner is running — a candidate is how the fix is chosen, not evidence
 * that it was applied.
 */
export function formatSettingsOverflow(probe) {
  const lines = [];
  const failures = [];
  if (!probe) return { text: 'the settings overflow probe posted nothing', failures: 1 };
  lines.push(`The settings screen's sideways content — select.field at ${probe.fontSize}`);
  lines.push(
    `  the control: box ${probe.select.clientWidth} px, content ${probe.select.scrollWidth} px, rect ${probe.select.rectWidth} px (+${probe.select.overflow} px of content)`,
  );
  for (const option of probe.options ?? []) {
    lines.push(`  option ${option.index}${option.selected ? ' (selected)' : ''}: ${Math.round(option.width)} px of text — "${option.text}"`);
  }
  lines.push('');
  lines.push('  what each rule would do, measured on the live page (surface = the app\u2019s scroll container):');
  lines.push('    rule                                                                   surface  side-scroll   widest inside');
  for (const candidate of probe.candidates ?? []) {
    const label = String(candidate.label).padEnd(68).slice(0, 68);
    const over = `${candidate.surfaceOverflow} px`.padStart(7);
    const scroll = `${candidate.sideScroll ? candidate.sideScroll.sideScroll : 0} px`.padStart(11);
    const widest = candidate.widest ? candidate.widest.replace(/^[^ ]+ > /, '') : '—';
    lines.push(`    ${label} ${over} ${scroll}   ${widest}`);
  }
  const baseline = probe.baseline;
  lines.push('');
  if (baseline) {
    const style = baseline.sideScroll ?? {};
    lines.push(
      `  the shipping rule set: surface ${style.clientWidth} -> ${style.scrollWidth} px, overflow-x ${style.overflowX}, ` +
        `a push moves it ${style.sideScroll} px`,
    );
    if (baseline.surfaceOverflow > 0) {
      failures.push(`the settings screen still carries ${baseline.surfaceOverflow} px of sideways content`);
    }
  }
  /*
   * The control, and it is not decoration: with the clip removed the same reading has to come back
   * at 301 px. A probe that reports 0 for every rule is not measuring the settings screen any more —
   * the element moved, the route changed, the build is not the one the harness thinks it is — and
   * without this line that would read as a pass.
   */
  const control = (probe.candidates ?? []).find((candidate) => candidate.control === true);
  if (control) {
    lines.push(`  the control (pre-fix rule, same run, same element): ${control.surfaceOverflow} px`);
    if (!(control.surfaceOverflow > 0)) {
      failures.push('the pre-fix control measured no overflow at all — this probe is not measuring the settings screen');
    }
  } else {
    failures.push('the probe ran no pre-fix control, so its zero readings prove nothing');
  }
  if (probe.restoredMatchesBaseline !== true) {
    failures.push('the probe did not put the page back after its candidates — the readings above cannot be trusted');
  }
  lines.push('');
  lines.push(failures.length === 0 ? 'RESULT: the settings screen has nothing to drag sideways.' : `RESULT: ${failures.length} reading(s) still wrong.`);
  for (const failure of failures) lines.push(`  - ${failure}`);
  return { text: lines.join('\n'), failures: failures.length };
}

/**
 * The v1.5 gestures, judged from a device run.
 *
 * `tools/pager-check.mjs` asks these questions of Chrome through `Input.dispatchTouchEvent`; this is
 * the same list asked of the readings a device run posts, so both drivers print the same labels for
 * the same two behaviours: *a mostly-vertical drag turns no page*, and *the pane follows the finger
 * with the swipe map right*.
 */
export function judgeDeviceGestures(sweep) {
  const checks = [];
  if (!sweep) return [{ label: 'the device gesture sweep posted readings', ok: false, detail: 'nothing arrived' }];
  if (sweep.unsupported) {
    return [{ label: 'the build under test has a pager to measure', ok: false, detail: sweep.unsupported }];
  }
  const steps = sweep.steps ?? {};
  const list = steps.diagonalOnList;
  if (list) {
    const rest = list.pagerAfter ?? {};
    const prevented = (list.drag?.prevented ?? []).some(Boolean);
    checks.push({
      label: 'a mostly-vertical drag over the playlist turns no page',
      ok: rest.position === 0 && Math.abs(rest.offset - rest.position) < 0.01 && (list.listTranslate ?? 0) === 0 && !prevented,
      detail:
        `a ${Math.abs(list.drag.from.x - list.drag.to.x)} x ${Math.abs(list.drag.from.y - list.drag.to.y)} px drag on ${list.drag.target}: ` +
        `pager pane ${rest.position} offset ${rest.offset}, the list transform ${list.listTranslate === 0 ? 'never written' : list.listTranslate}, ` +
        `preventDefault called ${prevented ? 'yes' : 'no'} (a scroll is handed back untouched)`,
    });
  }
  const onLyrics = steps.diagonalOnLyrics;
  if (onLyrics) {
    const before = onLyrics.pagerBefore ?? {};
    const after = onLyrics.pagerAfter ?? {};
    checks.push({
      label: 'and the same drag over the lyrics turns no page either',
      ok: before.position === 2 && after.position === 2 && Math.abs(after.offset - after.position) < 0.01,
      detail:
        `started on pane ${before.position} (the lyrics pane ${onLyrics.paneFound ? 'on screen' : 'MISSING'}), ended on pane ${after.position} at offset ${after.offset} — ` +
        `a finger's travel of 0 panes, ` +
        `over ${onLyrics.drag.target} (${onLyrics.drag.prevented.filter(Boolean).length} of ${onLyrics.drag.prevented.length} moves prevented)`,
    });
  }
  const follow = steps.follow;
  const width = sweep.device?.width ?? 393;
  if (follow) {
    checks.push({
      label: 'the panes follow the finger: the offset is the finger\u2019s own travel, move by move',
      ok: follow.offsetErrorPx < 2 && follow.monotonic === true,
      detail: `worst error ${follow.offsetErrorPx.toFixed(1)} px over ${follow.drag.samples.length} samples, monotonic ${follow.monotonic} — offsets ${follow.drag.samples.map((sample) => sample.pager?.offset).join(' \u2192 ')}`,
    });
    checks.push({
      label: 'the strip is transformed by exactly that travel, and the panes still tile edge to edge',
      ok: follow.stripErrorPx < 2 && follow.tilingWorstPx < 1,
      detail: `strip x vs expected: worst ${follow.stripErrorPx.toFixed(1)} px · spectrum.right vs lyrics.left, the window edges: worst ${follow.tilingWorstPx.toFixed(2)} px`,
    });
    checks.push({
      label: 'the drag is committed and lands on the lyrics, with the route following the pane',
      // At rest on the lyrics the strip is one whole pane to the left (the window shows its second
      // child), so "the strip is at rest on the pane" is -width, not 0.
      ok: follow.rest?.position === 2 && follow.rest?.route === '#/now/lyrics' && Math.abs(Math.abs(follow.rest?.strip ?? 0) - width) < 1,
      detail: `rest pane ${follow.rest?.position} on ${follow.rest?.route}, strip ${follow.rest?.strip} px (one pane is ${width} px)`,
    });
  }
  const snap = steps.shortDrag;
  if (snap) {
    checks.push({
      label: 'a short drag moves the pane under the finger and then snaps back to the same pane',
      ok: (snap.offsets ?? []).some((offset) => offset > 2.05) && snap.rest?.position === 2,
      detail: `offsets ${(snap.offsets ?? []).join(' \u2192 ')} over ${snap.ms} ms (a slow 0.12 panes, so the commit point is distance only) \u2192 rest pane ${snap.rest?.position}`,
    });
  }
  const flick = steps.flick;
  if (flick) {
    checks.push({
      label: 'a flick commits on velocity: the same shallow travel, released fast, turns the page',
      ok:
        flick.flick !== null &&
        (flick.flick?.offsets ?? []).length > 0 &&
        Math.max(...(flick.flick?.offsets ?? [0])) < 2.32 &&
        flick.rest?.position === 0,
      detail:
        flick.flick === null
          ? 'the page could not drive a flick'
          : `offsets under the finger ${flick.flick.offsets.map((value) => value.toFixed(3)).join(' \u2192 ')} over ${flick.flick.ms} ms, never past the 0.32 commit point \u2192 rest pane ${flick.rest?.position} on ${flick.rest?.route}`,
    });
  }
  const ring = steps.ring ?? [];
  if (ring.length === 4) {
    const [toSpectrum, toLyrics, toPlaylist, backToLyrics] = ring;
    checks.push({
      label: 'the swipe map is the ring: playlist \u2192 spectrum \u2192 lyrics \u2192 playlist, and right again is the lyrics',
      ok:
        toSpectrum.position === 1 &&
        String(toSpectrum.route).startsWith('#/now') &&
        toLyrics.position === 2 &&
        toLyrics.route === '#/now/lyrics' &&
        toPlaylist.position === 0 &&
        String(toPlaylist.route).startsWith('#/playlist') &&
        backToLyrics.position === 2 &&
        backToLyrics.route === '#/now/lyrics',
      detail: ring.map((step) => `${step.from}\u2192${step.to}: pane ${step.position} on ${step.route}`).join(' · '),
    });
    checks.push({
      label: 'the two screens tile while they trade places: their edges meet exactly',
      ok: ring.every((step) => step.tilingWorstPx < 1),
      detail: `list.right vs now.left over the four ring drags: worst ${Math.max(...ring.map((step) => step.tilingWorstPx)).toFixed(2)} px`,
    });
  }
  return checks;
}

/** The device gesture run, as a report whose failures are the failed checks. */
export function formatDeviceGestures(sweep) {
  const lines = [];
  if (sweep?.device) {
    lines.push(`The v1.5 gestures, in this engine — ${sweep.device.width}x${sweep.device.height} CSS px, dpr ${sweep.device.devicePixelRatio}`);
    lines.push(`  input: ${sweep.input}`);
  }
  const checks = judgeDeviceGestures(sweep);
  let failures = 0;
  for (const check of checks) {
    if (!check.ok) failures += 1;
    lines.push(`${check.ok ? 'ok  ' : 'FAIL'}  ${check.label}`);
    if (check.detail) lines.push(`      ${check.detail}`);
  }
  lines.push('');
  lines.push(failures === 0 ? 'RESULT: the gestures do what Chrome says they do, in this engine too.' : `RESULT: ${failures} gesture check(s) failed.`);
  return { text: lines.join('\n'), failures };
}

/* ------------------------------------ the now screen's chrome and its seek bar (v1.8.1) */

/**
 * The v1.8.1 reading: how much screen the chrome takes, and where the seek bar senses a finger.
 *
 * The owner's two reports off v1.8.0 were one layout symptom and one alignment symptom, and neither
 * is visible to a width audit:
 *
 *   - *"there is a lot of empty space at the top bar and also at the bottom"* — the bands above the
 *     pills and below the transport row. Every one of them is `.now`'s own padding or a margin, and
 *     the platform insets (`env(safe-area-inset-*)`) are *not* part of the defect: the pills and the
 *     transport must still clear them. So the reading is per band, and the checks are "chrome got
 *     smaller" and "the insets still clear", not "the paddings are gone".
 *   - *"the seeking drag works but only if i drag around the region circled green (which is a few
 *     pixels above the seek bar)"* — the bar's own box was 4 px tall, exactly the line it painted,
 *     so the only part of the control a drag could start on was the engine's own 14 px thumb, whose
 *     box this repository does not position. The fix is geometry, and geometry is what is measured:
 *     the *region that accepts a gesture*, found by putting one finger at a time at a series of
 *     offsets from the rendered bar and asking whether the song moved.
 *
 * The gestures go through `window.__naviliteLayoutAudit.fingerDrag`, which is the same in-page touch
 * path the pager checks use — a real `touchstart`/`touchmove`/`touchend` on whatever element is
 * under the point — and the verdict is read off the *media element's* own clock, so "it seeked" is
 * the engine's answer and not the harness's.
 */
export function chromeBands(reading) {
  const { now, top, progress, bar, visualizer, title, sub, context, transport } = reading;
  // Everything on the now screen that is neither the album art, the spectrum nor the track text.
  const gaps = reading.gaps ?? {};
  const parts = [
    ['the pill row (with its padding)', top?.height],
    ['the gap above the spectrum', gaps.visualizer],
    ['the gap above the title', gaps.title],
    ['the gap above the artist line', gaps.sub],
    ['the gap above the "playing from" line', gaps.context],
    ['the gap above the seek row', gaps.progress],
    ['the seek row', progress?.row?.height],
    ['the transport row (including the home-indicator inset)', bar?.height],
  ].filter(([, value]) => typeof value === 'number');
  return {
    parts,
    total: Math.round(parts.reduce((sum, [, value]) => sum + value, 0) * 100) / 100,
    /** The track text itself, which is not chrome and must not be counted as a saving. */
    text: [title?.height, sub?.height, context?.height].filter((value) => typeof value === 'number'),
    /** The album art and the spectrum are what the chrome is spent on: neither is chrome. */
    art: reading.art?.height ?? null,
    spectrum: visualizer?.height ?? null,
  };
}

/** Where a finger starts a drag must be the bar, and the text above it must not be. */
const DRAG_OFFSETS = { onTheBar: 0, insideTheTarget: -18, onTheTrackText: -34 };

export async function runNowChrome(cdp, options) {
  const baseUrl = options.url;
  const read = async (expression) => await evaluate(cdp, expression);
  await navigate(cdp, baseUrl);
  await read(
    `(() => {
      localStorage.setItem('navilite.settings', JSON.stringify({ serverUrl: ${JSON.stringify(baseUrl)}, username: ${JSON.stringify(options.username ?? 'navidrome')}, playback: 'web' }));
      localStorage.setItem('navilite.subsonic-password', ${JSON.stringify(options.password ?? 'navidrome')});
      return true;
    })()`,
  );
  await navigate(cdp, baseUrl);
  const PATIENCE = 40000;
  await read(`window.__naviliteLayoutAudit.waitFor('Boolean(window.__navilite && window.__navilite.libraryReady())', 'the library to connect', ${PATIENCE})`);
  await read(`(location.hash = '#/playlist/pl-stress-ja', true)`);
  await read(`window.__naviliteLayoutAudit.waitFor("document.querySelectorAll('.row.song').length > 0", 'the stress playlist', ${PATIENCE})`);
  await read('window.__naviliteLayoutAudit.playRow(0)');
  await read(`window.__naviliteLayoutAudit.waitFor("location.hash === '#/now'", 'the now screen', ${PATIENCE})`);
  await read(`window.__naviliteLayoutAudit.waitFor("Boolean(document.querySelector('.now-canvas'))", 'the spectrum canvas', ${PATIENCE})`);
  await read('window.__naviliteLayoutAudit.settlePager()');
  // A route that has been walked is not always a route that has painted: the album art and the
  // spectrum arrive after it, and the readings below are about the boxes they end up in.
  await read(`window.__naviliteLayoutAudit.waitFor("(() => { const el = document.querySelector('.now-cover > *'); return el && el.naturalWidth > 0; })()", 'the album art', ${PATIENCE})`);
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const geometry = await read(`(() => {
    const box = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, width: r.width, height: r.height };
    };
    const input = document.querySelector('.now-progress .progress');
    const style = getComputedStyle(input);
    const rect = input.getBoundingClientRect();
    const margins = (selector) => {
      const el = document.querySelector(selector);
      const s = getComputedStyle(el);
      return Number.parseFloat(s.marginTop);
    };
    return {
      inset: window.__naviliteLayoutAudit.environment().safeAreaInsets,
      now: box('.now'),
      top: box('.now-top'),
      pill: box('.pill'),
      art: box('.now-cover > *'),
      visualizer: box('.now-visualizer'),
      title: box('.now-title'),
      sub: box('.now-sub'),
      context: box('.now-context'),
      bar: box('.now-bar'),
      transport: box('.now-bar .transport.big'),
      progress: { row: box('.now-progress'), input: { ...box('.now-progress .progress'), centre: rect.left + rect.width / 2, x: rect.left + rect.width * 0.35 } },
      gaps: {
        visualizer: margins('.now-visualizer'),
        title: margins('.now-title'),
        sub: margins('.now-sub'),
        context: margins('.now-context'),
        progress: margins('.now-progress'),
      },
      /** The painted bar: a band of this height, this far from the box's top, inside the target. */
      painted: {
        background: style.backgroundImage === 'none' ? style.backgroundColor : style.backgroundImage,
        size: style.backgroundSize,
        position: style.backgroundPosition,
      },
      innerHeight: window.innerHeight,
    };
  })()`);

  const centre = geometry.progress.input.top + geometry.progress.input.height / 2;
  const x = Math.round(geometry.progress.input.x);
  const clock = `(() => { const e = window.__naviliteMediaElement; return e ? Math.round(e.currentTime * 1000) / 1000 : null; })()`;
  /** The middle of the track, not its end: seeking to the last tenth rolls the queue on. */
  const rewind = `window.__naviliteLayoutAudit.seekAudio((window.__naviliteMediaElement ? window.__naviliteMediaElement.duration : 20) * 0.3)`;

  /*
   * The one thing the tall target could have cost: its lower half reaches into the transport row's
   * box, and a row that answered for its whole area would have stolen it. The container is
   * `pointer-events: none` and the buttons `auto`, so a finger on the play button must still land on
   * the button. Read here, straight after the geometry and before any gesture, so the screen being
   * measured is the screen being hit-tested.
   */
  const transportHit = await read(
    `(() => {
      const all = Array.from(document.querySelectorAll('.now-bar .transport.big'));
      const boxes = all.map((el) => { const r = el.getBoundingClientRect(); return { tag: el.tagName, cls: String(el.className), w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) }; });
      const button = all.find((el) => el.getBoundingClientRect().width > 0);
      if (!button) return { error: 'no play button with a box in the transport row', matches: boxes, route: location.hash };
      const r = button.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + r.height / 2);
      const el = document.elementFromPoint(x, y);
      if (!el) return { error: 'nothing at the play button centre', x: x, y: y, matches: boxes, route: location.hash };
      const owner = el.closest ? el.closest('button') : null;
      /* An SVG's className is an object, not a string: read the base value when there is one. */
      const name = el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className;
      return {
        x: x,
        y: y,
        matches: boxes,
        route: location.hash,
        selector: name ? String(name).split(' ')[0] : el.tagName,
        button: owner ? (owner.getAttribute('aria-label') || String(owner.className)) : null,
        insideBar: !!(el.closest && el.closest('.now-bar')),
      };
    })()`,
  );

  // Nothing is playing while the gestures run: the clock would otherwise drift under them, and a
  // drift is not a seek.
  await read('window.__naviliteLayoutAudit.pauseAudio()');
  await read(rewind);
  await new Promise((resolve) => setTimeout(resolve, 300));

  const gestureAt = async (dy, how) => {
    /*
     * The point and the element under it are read in *one* expression, so they belong to one layout:
     * a read taken earlier can be a read of a screen the album art has since pushed down, and a
     * finger aimed at where the bar *was* proves nothing about where it is.
     */
    const spot = await read(`(() => {
      const input = document.querySelector('.now-progress .progress');
      const r = input.getBoundingClientRect();
      const x = Math.round(r.left + r.width * 0.35);
      const y = Math.round(r.top + r.height / 2 + (${dy}));
      const el = document.elementFromPoint(x, y);
      const name = el && el.className && el.className.baseVal !== undefined ? el.className.baseVal : (el ? el.className : null);
      return { x: x, y: y, under: el ? (el.classList && el.classList.contains('progress') ? 'the seek bar' : (name ? String(name).split(' ')[0] : el.tagName)) : null };
    })()`);
    const { x: atX, y: atY, under } = spot;
    const before = await read(clock);
    if (how === 'tap') {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: atX, y: atY, button: 'left', clickCount: 1, pointerType: 'mouse' });
      }
    } else {
      await read(`window.__naviliteLayoutAudit.fingerDrag({ from: { x: ${atX}, y: ${atY} }, to: { x: ${atX + 80}, y: ${atY} }, steps: 4, gapMs: 10 })`);
    }
    /*
     * The seek is throttled to one round trip per 120 ms and the last position is committed on
     * release, so the clock moves a moment after the finger does — and under a loaded machine (this
     * check runs beside the pager's, which drives its own Chrome) that moment is longer than the
     * 120 ms it is on an idle one. Bounded, and generous.
     */
    let after = before;
    for (let i = 0; i < 14; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      after = await read(clock);
      if (after !== null && before !== null && Math.abs(after - before) > 0.05) break;
    }
    const seeked = before !== null && after !== null && Math.abs(after - before) > 0.05;
    if (seeked) {
      // put it back, so the next probe starts from the same clock
      await read(rewind);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return { dy, y: atY, under, before, after, seeked, route: await read('location.hash') };
  };

  const gestures = {
    tap: await gestureAt(DRAG_OFFSETS.onTheBar, 'tap'),
    drag: await gestureAt(0, 'drag'),
    above: await gestureAt(DRAG_OFFSETS.insideTheTarget, 'drag'),
    text: await gestureAt(DRAG_OFFSETS.onTheTrackText, 'drag'),
  };
  return { geometry, gestures, transportHit, centre, x, chrome: chromeBands(geometry) };
}

/** The checks v1.8.1 is signed off on, each one a number out of the reading above. */
export function judgeNowChrome(reading) {
  const g = reading.geometry;
  const painted = g.painted;
  const input = g.progress.input;
  const row = g.progress.row;
  const size = String(painted.size);
  const bandHeight = Number.parseFloat(size.split(/\s+/).pop() ?? '0');
  /*
   * Where the painted band actually is. `background-position: 50% 50%` with a band shorter than the
   * box means the band's top sits `(box - band) / 2` below the box's top, so its centre is the box's
   * centre — and that is the whole point of the change: the thing the eye aims at and the thing the
   * finger lands on are the same pixels.
   */
  const bandCentre = input.top + (input.height - bandHeight) / 2 + bandHeight / 2;
  const offCentre = Math.round((bandCentre - (input.top + input.height / 2)) * 100) / 100;
  const checks = [];
  checks.push({
    label: 'the seek bar is a 44 pt target, centred on the bar it paints',
    ok: input.height >= 44 && Math.abs(offCentre) <= 2,
    detail: `target ${input.height} px tall at ${Math.round(input.top)}–${Math.round(input.bottom)} · painted bar ${bandHeight} px (${size}, ${painted.position}) centred at ${bandCentre.toFixed(2)} vs the target's centre ${(input.top + input.height / 2).toFixed(2)} — off by ${offCentre} px · the row it sits in is ${row.height} px`,
  });
  checks.push({
    label: 'a drag on the bar seeks, and so does one inside the target above it',
    ok: reading.gestures.drag.seeked && reading.gestures.above.seeked,
    detail: `finger on the bar (y ${reading.gestures.drag.y}, under ${reading.gestures.drag.under}): ${reading.gestures.drag.before} → ${reading.gestures.drag.after} s · ${Math.abs(DRAG_OFFSETS.insideTheTarget)} px above it (y ${reading.gestures.above.y}, under ${reading.gestures.above.under}): ${reading.gestures.above.before} → ${reading.gestures.above.after} s`,
  });
  checks.push({
    label: 'a tap on the bar seeks',
    ok: reading.gestures.tap.seeked,
    detail: `y ${reading.gestures.tap.y} (under ${reading.gestures.tap.under}): ${reading.gestures.tap.before} → ${reading.gestures.tap.after} s`,
  });
  checks.push({
    label: 'a drag starting on the track text does not seek',
    ok: !reading.gestures.text.seeked,
    detail: `${Math.abs(DRAG_OFFSETS.onTheTrackText)} px above the bar (y ${reading.gestures.text.y}, under ${reading.gestures.text.under}): ${reading.gestures.text.before} → ${reading.gestures.text.after} s`,
  });
  const insetTop = Number.parseFloat(String(g.inset.top)) || 0;
  const insetBottom = Number.parseFloat(String(g.inset.bottom)) || 0;
  checks.push({
    label: 'the pills still clear the top inset, and the transport the bottom one',
    ok: g.pill.top >= insetTop && g.transport.bottom <= g.innerHeight - insetBottom,
    detail: `env(safe-area-inset-top) ${insetTop} px, the pills start at ${g.pill.top.toFixed(2)} · env(safe-area-inset-bottom) ${insetBottom} px, the transport ends at ${g.transport.bottom.toFixed(2)} of ${g.innerHeight}`,
  });
  /*
   * The reclaim, against the number v1.8.0 measured at this same 393 x 852 with the same insets.
   * Its chrome was 208.23 px: `now-top` 56.84 (10 px of its own padding on top of the inset), 8 px
   * above the spectrum, 8 above the title, 2 + 2 above the artist and "playing from" lines, 6 above
   * the seek row, that row's 17.39, and a 108 px transport row (6 + 58 + 44, the 44 being 10 px of
   * its own padding over the 34 px home-indicator inset).
   */
  checks.push({
    label: 'less screen goes to chrome than v1.8.0 spent (208.23 px)',
    ok: reading.chrome.total <= 190,
    detail: `${reading.chrome.total} px — ${reading.chrome.parts.map(([label, value]) => `${label} ${Math.round(value * 100) / 100}`).join(' · ')} · album art ${reading.chrome.art} px · spectrum ${reading.chrome.spectrum} px (v1.8.0's own reading of that same screen: chrome 208.23, art 357, spectrum 89.5)`,
  });
  /*
   * The one thing the tall target could have cost: its lower half reaches into the transport row's
   * box, and a row that answered for its whole area would have stolen it. The container is
   * `pointer-events: none` and the buttons `auto`, so a finger on the play button must still land on
   * the button.
   */
  checks.push({
    label: 'the transport buttons still own every tap they had',
    ok: !!reading.transportHit?.button && reading.transportHit?.insideBar === true,
    detail: reading.transportHit?.error
      ? `${reading.transportHit.error} — matches ${JSON.stringify(reading.transportHit.matches)} on ${reading.transportHit.route}`
      : `a finger at the centre of the play button (${reading.transportHit?.x}, ${reading.transportHit?.y}) lands on ${reading.transportHit?.selector ?? 'nothing'}, inside ${reading.transportHit?.button ?? 'no button'} in the transport row: ${reading.transportHit?.insideBar === true}`,
  });
  return checks;
}

export function formatNowChrome(reading) {
  const lines = [];
  lines.push('The now screen (v1.8.1) — the chrome, and where the seek bar senses a finger:');
  const checks = judgeNowChrome(reading);
  let failures = 0;
  for (const check of checks) {
    if (!check.ok) failures += 1;
    lines.push(`${check.ok ? 'ok  ' : 'FAIL'}  ${check.label}`);
    if (check.detail) lines.push(`      ${check.detail}`);
  }
  lines.push('');
  lines.push(failures === 0 ? 'RESULT: the chrome is smaller and the drag starts on the bar.' : `RESULT: ${failures} check(s) failed.`);
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
  if (argv.get('now-chrome')) {
    await withChromePage(async ({ cdp, safeArea }) => {
      const reading = await runNowChrome(cdp, { url });
      const { text, failures } = formatNowChrome(reading);
      process.stdout.write(`safe-area emulation: ${safeArea ?? 'NOT applied — env() would read 0 in this Chrome'}\n\n${text}\n`);
      if (jsonPath) {
        writeFileSync(jsonPath, JSON.stringify(reading, null, 2));
        process.stdout.write(`\nraw measurements: ${jsonPath}\n`);
      }
      process.exitCode = failures === 0 ? 0 : 1;
    });
    return;
  }
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
