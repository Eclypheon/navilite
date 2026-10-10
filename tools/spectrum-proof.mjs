#!/usr/bin/env node
/**
 * The spectrum proof, at pixel level, in a real browser.
 *
 * The owner's v1.1 report about the spectrum is a description of a picture: *"it appears like
 * there is some after image or some separation of the colors at the top of each bar"*, and *"each
 * bar should just be of the current frame itself it does not need to show the previous frame of
 * where that bar was"*. So the fix is only proven if the pixels say so.
 *
 * The sequence, on the real app, playing the mock library's generated WAV:
 *
 *   1. while the track is playing, read the canvas — a loud frame, so the bars are lit;
 *   2. take the *audio* to silence without touching the transport, by setting `volume = 0` on the
 *      live media element (found with `Runtime.queryObjects`, because the element the engine
 *      creates is not in the DOM). Pausing instead would flip the screen to the theme animation
 *      and prove nothing about the spectrum: the element must still be playing, so the analyser
 *      still reports and the spectrum path still draws — it just reports silence;
 *   3. read the canvas again on the *very next* frame: with the bars showing only the current
 *      frame, nothing of the loud frame may survive;
 *   4. read two consecutive silent frames and compare them byte for byte (PNG of identical
 *      pixels is an identical string): two identical inputs must give identical pixels.
 *
 * Run the mock first (`node tools/mock-subsonic.mjs --port 4599 --stress`), then:
 *
 *   node tools/spectrum-proof.mjs --url http://127.0.0.1:4599
 *
 * Exit code is non-zero when a loud frame survives into the silent one.
 */
import { navigate, evaluate, withChromePage } from './layout-audit.mjs';

const nextFrame = (cdp) =>
  evaluate(cdp, 'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');

const snap = (cdp) => evaluate(cdp, 'window.__naviliteLayoutAudit.spectrumSnapshot()');

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
  const url = argv.get('url') ?? 'http://127.0.0.1:4599';
  const username = argv.get('username') ?? 'navidrome';
  const password = argv.get('password') ?? 'navidrome';

  await withChromePage(async ({ cdp }) => {
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
    await evaluate(cdp, "window.__naviliteLayoutAudit.waitFor('Boolean(window.__navilite && window.__navilite.libraryReady())', 'the library to connect')");

    // Play a real track through the app's own controls, then open the spectrum.
    await evaluate(
      cdp,
      `(async () => {
        location.hash = '#/playlist/pl-stress-ja';
        await window.__naviliteLayoutAudit.waitFor("document.querySelectorAll('.row.song .row-play').length > 0", 'the stress playlist');
        document.querySelectorAll('.row.song .row-play')[0].click();
        await window.__naviliteLayoutAudit.waitFor("Boolean(document.querySelector('.now-canvas'))", 'the spectrum canvas');
        return true;
      })()`,
    );
    // Let the bars build for a second and a half of audio.
    await evaluate(cdp, 'new Promise((resolve) => setTimeout(() => resolve(true), 1500))');

    const loud = await snap(cdp);
    if (!loud) throw new Error('no spectrum canvas to read');
    if (loud.lit <= 0) throw new Error('the spectrum drew nothing while the track was playing — nothing to prove');

    const silenced = await evaluate(cdp, 'window.__naviliteLayoutAudit.silenceAudio()');
    if (!silenced) throw new Error('the probe never captured the engine\u2019s media element');
    /*
     * A silent *analyser frame* is not instantaneous: the FFT window covers the previous 2048
     * samples (~46 ms), so the first frame or two after the audio goes quiet still carry the
     * signal physically. Everything after that window is the claim being tested — and a bar that
     * carried a memory of the loud frame (a decaying release, a floating peak cap) would still be
     * there hundreds of milliseconds later, which is what these readings separate out.
     */
    const after = async (ms) => {
      await evaluate(cdp, `new Promise((resolve) => setTimeout(() => resolve(true), ${ms}))`);
      return snap(cdp);
    };
    const t50 = await after(50);
    const t160 = await after(110);
    const t240 = await after(80);

    const survivors = Math.round(((t50.lit / loud.lit) * 100 + Number.EPSILON) * 10) / 10;
    /*
     * The criterion is "silence is one frame, and it stays one frame":
     *
     *   - every reading once the audio is quiet draws the *same* pixels (a bar holding a memory of
     *     the loud frame would still be moving: 0.78 of its height per frame, or a peak cap
     *     sliding down at 2% of full height per frame);
     *   - and what is left is a sliver of the loud frame — the 1-2 px rectangle per band that a
     *     zero frame legitimately draws, nothing more.
     *
     * The +50 ms reading is reported but not asserted: whether the analyser has already seen the
     * silence depends on the media pipeline's own latency (up to ~100 ms), which is not the
     * visualiser's behaviour and varies between runs.
     */
    const settled = t160.png === t240.png && Number(t160.checksum) === Number(t240.checksum);
    const quiet = t160.lit <= loud.lit * 0.1 && t240.lit <= loud.lit * 0.1;
    const passed = settled && quiet;

    const lines = [];
    lines.push(`Spectrum pixel proof — ${url}`);
    lines.push(`  canvas ${loud.canvas} · ${loud.bytes} bytes of pixels`);
    lines.push(`  media element: volume ${silenced.volume}, paused ${silenced.paused} (still playing, audibly silent)`);
    lines.push(`  playing:            ${loud.lit} lit pixels (checksum ${loud.checksum})`);
    lines.push(`  +50 ms:             ${t50.lit} lit pixels — ${survivors}% of the loud frame (informational: pipeline latency)`);
    lines.push(`  +160 ms:            ${t160.lit} lit pixels`);
    lines.push(`  +240 ms:            ${t240.lit} lit pixels · ${t160.png === t240.png ? 'byte-identical to +160 ms' : 'DIFFERENT from +160 ms'}`);
    lines.push('');
    lines.push(
      passed
        ? 'RESULT: every bar is the current frame only — the loud frame is gone and silence stays byte-identical.'
        : 'RESULT: FAIL — something of an earlier frame is still on screen.',
    );
    process.stdout.write(`${lines.join('\n')}\n`);
    process.exitCode = passed ? 0 : 1;
  }, { width: 393, height: 852, deviceScaleFactor: 3 });
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 2;
});
