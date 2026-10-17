/**
 * The top gap on first run (owner, v2.0.0-beta.4): where the empty band comes from, measured.
 *
 * The report: "there always seem to be a large gap at the top on the first run of this app in live
 * container. i can get rid of it by closing it and then reopening it".
 *
 * The app has exactly one top inset in its CSS — `env(safe-area-inset-top)`, consumed by `.topbar`
 * (`max(10px, …)`) and by `.now` — and `capacitor.config.ts` asked UIKit for a **second** one
 * (`ios.contentInset: 'always'` → `UIScrollView.contentInsetAdjustmentBehavior = .always`, whose
 * default is `never`). With `.always` the web view's scroll content is shifted down by the same
 * safe-area the CSS already pads for, so the band above the app's own content is 2 × the inset.
 *
 * This script reads the shipped CSS (the built `dist/assets/index-*.css`) in real Chrome at
 * 393 x 852 with the iPhone 15 Pro's safe-area insets emulated by CDP, and measures the band two
 * ways: with the native scroll-view inset in play (the defect) and without it (the fix). Nothing
 * about the CSS changes, which is the point — the second source is what goes.
 *
 *   node tools/inset-gap.mjs            # reads dist/, skips if it has not been built
 */
import { readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { evaluate, navigate, withChromePage } from './layout-audit.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCREEN_HEIGHT = 852;

function builtCss() {
  const dir = join(root, 'dist', 'assets');
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => /^index-.*\.css$/.test(name));
  } catch {
    return null;
  }
  return names.length === 1 ? join(dir, names[0]) : null;
}

/**
 * The shell's own markup, with the classes the CSS targets. The measurement is a property of the
 * stylesheet (padding, boxes), not of the app's state, so the fixture is enough to read it — and it
 * keeps the reading independent of a library, a server or a login.
 */
function fixture(cssHref) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="stylesheet" href="${cssHref}">
<style>html,body{margin:0;background:#0b0b10}</style>
</head><body>
<div class="shell" id="shell">
  <header class="topbar" id="topbar"><button class="brand">Navilite</button><nav class="tabs"><button class="tab">Playlists</button></nav></header>
  <main class="page" id="page" style="height:600px">content</main>
</div>
<div class="now" id="now"><div class="now-top" id="nowtop"><div class="pill"><button class="seg">Now</button></div></div></div>
</body></html>`;
}

const READ = `(() => {
  const read = (id) => {
    const el = document.getElementById(id);
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return { top: Math.round(rect.top * 10) / 10, paddingTop: cs.paddingTop };
  };
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;top:0;left:0;width:0;height:0;padding:env(safe-area-inset-top) 0 0 0';
  document.body.appendChild(probe);
  const envTop = parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  return { envTop, topbar: read('topbar'), now: read('now'), nowTop: read('nowtop') };
})()`;

/** Reproduce `contentInsetAdjustmentBehavior = .always`: the whole scroll content, shifted down. */
const NATIVE_INSET = (px) => `(() => { document.documentElement.style.marginTop = '${px}px'; return true; })()`;

const option = process.argv.includes('--native-inset');
const css = builtCss();
if (!css) {
  console.log('inset-gap: no dist/assets/index-*.css — run `npm run build` first (skipped)');
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'inset-gap-'));
const page = join(dir, 'fixture.html');
writeFileSync(page, fixture(pathToFileURL(css).href));

const lines = [];
await withChromePage(async ({ cdp, safeArea }) => {
  await navigate(cdp, pathToFileURL(page).href);
  const plain = await evaluate(cdp, READ);
  if (option) await evaluate(cdp, NATIVE_INSET(plain.envTop));
  const reading = await evaluate(cdp, READ);
  const band = reading.topbar.top; // empty screen above the app's first painted box
  const contentStarts = reading.topbar.top + parseFloat(reading.topbar.paddingTop);
  lines.push(`inset-gap: 393x852 dpr 3, ${safeArea ?? 'NO safe-area emulation — reading means nothing'}`);
  lines.push(`  env(safe-area-inset-top)                   ${reading.envTop} px`);
  lines.push(`  .topbar padding-top                        ${reading.topbar.paddingTop}`);
  lines.push(`  .now padding-top                           ${reading.now.paddingTop}`);
  lines.push(`  empty band above the app's own content     ${band} px  (${((band / SCREEN_HEIGHT) * 100).toFixed(1)}% of 852)`);
  lines.push(`  first content pixel                        ${contentStarts} px`);
  lines.push(`  native scroll-view inset emulated          ${option ? `yes (+${plain.envTop} px)` : 'no'}`);
  if (!safeArea) process.exitCode = 1;
});
console.log(lines.join('\n'));
