/**
 * The 393 px regression test.
 *
 * v1.1 was signed off "clean" at 390 and 360 CSS px while the owner's iPhone 15 Pro (393 px)
 * still scrolled sideways, so "we measured it once" is not good enough: this runs the real app in
 * a real browser at exactly 393 x 852 dpr 3, with safe-area insets, over a library that contains
 * a long Japanese artist name, long Japanese and unbroken-Latin track titles, long playlist names
 * and both now-playing modes — and fails if *any* of those states has a document wider than the
 * viewport.
 *
 * It needs Chrome and a built `dist/`, so it skips (with the reason printed) when either is
 * missing rather than passing on nothing. Run it alone with `npm run test:layout`.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const PORT = 4611;
const CHROME_CANDIDATES: string[] = [
  ...(process.env.CHROME_PATH ? [process.env.CHROME_PATH] : []),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function findChrome(): string | null {
  return CHROME_CANDIDATES.find((candidate) => existsSync(candidate)) ?? null;
}

function run(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out after ${timeoutMs} ms: ${command} ${args.join(' ')}`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

test('the app has no horizontal overflow at 393 x 852 on any route, in either now-playing mode', async (t) => {
  if (!findChrome()) {
    t.skip('no Chrome/Chromium binary found — set CHROME_PATH to run the 393 px audit');
    return;
  }
  if (!existsSync(new URL('../dist/index.html', import.meta.url))) {
    t.skip('dist/ is not built — run `npm run build` first');
    return;
  }

  const mock = spawn(process.execPath, ['tools/mock-subsonic.mjs', '--port', String(PORT), '--stress'], {
    cwd: new URL('..', import.meta.url),
    stdio: 'ignore',
  });
  try {
    // Wait for the mock to answer before driving a browser at it.
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        const response = await fetch(`http://127.0.0.1:${PORT}/rest/ping.view?u=navidrome&p=navidrome&v=1.16.1&c=Navilite&f=json`);
        if (response.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error('the mock library never came up');
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    const { code, output } = await run(
      process.execPath,
      ['tools/layout-audit.mjs', '--url', `http://127.0.0.1:${PORT}`, '--json', '/tmp/navilite-layout-393.json'],
      240_000,
    );
    const failed = output
      .split('\n')
      .filter((line) => line.startsWith('FAIL') || line.includes('OFFENDER:'))
      .join('\n');
    assert.equal(code, 0, `the 393 px audit found horizontal overflow:\n${failed || output}`);
    assert.match(output, /RESULT: no horizontal overflow anywhere\./);

    /*
     * The owner's settings report, in the one place a *width* audit cannot see it.
     *
     * Every focused step now records the control's computed font size and the visual viewport before
     * and after focus. A control under 16 px makes iOS Safari zoom the page in, which is what made
     * the settings screen pannable for him — and a zoomed page has no horizontal overflow of its own,
     * so a width-only audit calls it clean. Chrome does not perform the zoom, so the font size is the
     * reading that has to hold the line here; the zoom itself is measured in real WebKit by
     * `tools/device-probe.mjs --scenario focus`.
     */
    const report = JSON.parse(readFileSync('/tmp/navilite-layout-393.json', 'utf8')) as {
      results: Array<{ label: string; detail?: { selector?: string; fontSize?: string; zoom?: number } }>;
    };
    const focused = report.results.filter((step) => step.detail?.selector && typeof step.detail?.zoom === 'number');
    assert.ok(focused.length >= 3, `only ${focused.length} focus steps recorded — the settings screen may not be walked`);
    for (const step of focused) {
      const size = Number.parseFloat(String(step.detail?.fontSize));
      assert.ok(
        size >= 16,
        `${step.detail?.selector} takes focus at ${step.detail?.fontSize} on ${step.label} — iOS zooms the page in below 16 px`,
      );
      assert.equal(step.detail?.zoom, 1, `${step.label} zoomed its visual viewport`);
    }
  } finally {
    mock.kill('SIGKILL');
  }
});
