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
 *   3. read the canvas on a schedule after that, and ask two different questions of it: *does the
 *      tail stop*, and *what shape is what is left*;
 *   4. compare frames byte for byte (PNG of identical pixels is an identical string): once the
 *      audio is silent the bars must reach one state and stay in it.
 *
 * Run the mock first (`node tools/mock-subsonic.mjs --port 4599 --stress`), then:
 *
 *   node tools/spectrum-proof.mjs --url http://127.0.0.1:4599
 *
 * Exit code is non-zero when a loud frame survives into the silent one.
 *
 * ## Why the window is where it is (re-baselined 2026-10-15, v1.9.19)
 *
 * This tool was written at v1.2, when a silent analyser frame collapsed the bars *on the very next
 * frame*, and the criterion was "t+160 ms and t+240 ms are byte-identical and both ≤ 10 % of the
 * loud frame". v1.7.4 deliberately replaced that with a per-band attack/release envelope —
 *
 *     ATTACK_S = 0.045, RELEASE_S = 0.1, FLOOR = 0.01   // src/player/visualizer.ts
 *
 * — because the owner asked for the opposite of the snap: *"Pausing should cause the spectrum to
 * gracefully all drop to zero"*. An envelope of that shape is, by construction, still moving
 * hundreds of milliseconds after the music stops: measured on v1.9.19, the lit pixels fall
 * 31220 → 7184 → 2501 → 1337 → 668 at +160 / +240 / +320 / +400 ms, an exponential with the
 * declared ~0.1 s time constant (ratio 1.9–2.9 per 80 ms reading), and the frame is byte-identical
 * from +480 ms on and stays so. So the old two-reading criterion could no longer be true of a
 * visualiser behaving exactly as designed.
 *
 * The criterion below is the same claim stated against the shape that replaced it: **the tail is a
 * decay and nothing but a decay, it stops inside the envelope's own window (the release needs
 * ~460 ms to reach the floor, plus the media pipeline's ~100 ms before the analyser has even seen
 * the silence), what is left after that is flat, and it is quiet.** The readings that used to be
 * the criterion are still taken and printed, so the v1.2 baseline in `docs/verification.md` §10.4
 * stays comparable.
 *
 * What this still catches — the tool was not weakened to make it pass. Run against the v1.1
 * visualiser (its `src/player/{visualizer,engine}.ts` checked out over v1.2 and rebuilt; the same
 * control §10.4 used, canvas 786×178) it fails on two independent counts:
 *
 *   - v1.1 never settles: its bars keep drifting (a cap sliding at 2 % of full height per frame),
 *     so no two of its readings are byte-identical — 1243 / 1246 / 979 / 922 lit pixels at +700 /
 *     +900 / +1200 / +1500 ms in one run, all different, and at +2 s it is still moving and then
 *     leaves the spectrum altogether (the app's own stale-frame guard falls back to the theme).
 *     v1.9.19 is identical from +700 ms to +2 s;
 *   - the frame v1.1 leaves behind is not made of flat bars: on its settled frame 118 of its lit
 *     columns hold two separated runs of lit pixels (the bar and the cap/reflection above it), and
 *     its loud frame has 60–84 lit pixels under the baseline. v1.9.19, v1.9.18, v1.7.4 and v1.2 all
 *     have **zero** of each on a settled frame — measured, not assumed.
 *
 * The per-frame shape claim itself (one flat rectangle per band, 64 of them, no caps and no
 * reflections) is asserted on every frame in `test/visualizer.test.ts`; what is asserted here is
 * what that test cannot see — that the shape survives a *silence* in a real browser, on the real
 * pixels, after the envelope has finished moving.
 *
 * The stream this reads is the mock's WAV through the **web** engine. The local-file path
 * (`playlistPath`/`localFile`, the v1.9.16/17 ground) is a different engine and is not exercised
 * here.
 */
import { navigate, evaluate, withChromePage } from './layout-audit.mjs';

/** The canvas reading. `true` adds the two shape facts this tool judges (see the probe's comment). */
const snap = (cdp, withShape = false) =>
  evaluate(cdp, `window.__naviliteLayoutAudit.spectrumSnapshot(${withShape ? 'true' : 'false'})`);

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

    const loud = await snap(cdp, true);
    if (!loud) throw new Error('no spectrum canvas to read');
    if (loud.lit <= 0) throw new Error('the spectrum drew nothing while the track was playing — nothing to prove');

    const silenced = await evaluate(cdp, 'window.__naviliteLayoutAudit.silenceAudio()');
    if (!silenced) throw new Error('the probe never captured the engine\u2019s media element');
    /*
     * A silent *analyser frame* is not instantaneous: the FFT window covers the previous 2048
     * samples (~46 ms), so the first frame or two after the audio goes quiet still carry the
     * signal physically, and the media pipeline adds its own latency on top of that.
     *
     * The +160 ms and +240 ms readings are kept because they are what the v1.2 baseline in
     * docs/verification.md was taken at; they are reported and only used for the "the tail only
     * falls" half of the criterion. The judgement lives at +900 ms and later: the release envelope
     * reaches its floor ~460 ms after the silence takes effect and the pipeline can hold that back
     * by ~100 ms, and on this machine the last pixel change after a mute was seen at +560 ms
     * (v1.9.18), so +900 ms leaves ~340 ms of margin and +1200/+1500 ms then prove it *stays* flat.
     */
    const after = async (ms, withShape = false) => {
      await evaluate(cdp, `new Promise((resolve) => setTimeout(() => resolve(true), ${ms}))`);
      return snap(cdp, withShape);
    };
    const t50 = await after(50);
    const t160 = await after(110);
    const t240 = await after(80);
    const t700 = await after(460, true);
    const t900 = await after(200);
    const t1200 = await after(300);
    const t1500 = await after(300, true);

    /** Reported, not asserted: how much of the loud frame was still on screen at +50 ms. */
    const survivors = Math.round(((t50.lit / loud.lit) * 100 + Number.EPSILON) * 10) / 10;
    /*
     * 1. **The tail only falls.** Every reading after the audio is quiet is at or below the one
     *    before it: nothing re-lights, no bar grows back, nothing of the loud frame is coming up
     *    from underneath. The slack (1 % of the loud frame, min 20 px) is for antialiasing on a
     *    fractional edge, not for a rising bar.
     */
    const slack = Math.max(20, Math.round(loud.lit * 0.01));
    const falls = t240.lit <= t160.lit + slack && t1200.lit <= t240.lit + slack;
    /*
     * 2. **It settles, and it stays settled.** Once the envelope has reached its floor, silence is
     *    one frame: the pixels stop changing entirely (not "almost" — a bar holding a memory of the
     *    loud frame keeps moving, and a cap sliding down at 2 % of full height per frame is still
     *    moving a second later). Three readings half a second apart, compared as PNGs, because a
     *    frame can have the same lit *count* and still be a different picture.
     */
    const settled =
      t900.png === t1200.png &&
      t1200.png === t1500.png &&
      Number(t900.checksum) === Number(t1500.checksum);
    /*
     * 3. **And what is left is quiet.** The 1–2 px rectangle per band that a zero frame legitimately
     *    draws is all that may survive: ≤ 10 % of the loud frame's lit pixels.
     */
    const quiet = t900.lit <= loud.lit * 0.1 && t1500.lit <= loud.lit * 0.1;
    /*
     * 4. **And it is made of flat bars.** The other half of the owner's sentence — "some separation
     *    of the colors at the top of each bar" — is a *shape*: read on the settled frame, where
     *    there is no fractional top edge and no antialiasing to argue with. One canvas column holds
     *    one separated run of lit pixels (a cap floating above the bar, or a reflection peeking out
     *    under it, is a second run) and no lit pixel sits below the bars' baseline.
     */
    const flatBars = t1500.columnsWithMoreThanOneRun === 0 && t1500.belowBaseline === 0;
    const passed = falls && settled && quiet && flatBars;

    const lines = [];
    lines.push(`Spectrum pixel proof — ${url}`);
    lines.push(`  canvas ${loud.canvas} · ${loud.bytes} bytes of pixels`);
    lines.push(`  media element: volume ${silenced.volume}, paused ${silenced.paused} (still playing, audibly silent)`);
    lines.push(`  playing:            ${loud.lit} lit pixels (checksum ${loud.checksum}) · ${loud.columnsWithMoreThanOneRun} columns with a second run of lit pixels · ${loud.belowBaseline} lit below the baseline`);
    lines.push(`  +50 ms:             ${t50.lit} lit pixels — ${survivors}% of the loud frame (informational: pipeline latency)`);
    lines.push(`  +160 ms:            ${t160.lit} lit pixels`);
    lines.push(`  +240 ms:            ${t240.lit} lit pixels · ${t160.png === t240.png ? 'byte-identical to +160 ms' : 'DIFFERENT from +160 ms'} (the v1.2 window, reported only)`);
    lines.push(`  +700 ms:            ${t700.lit} lit pixels`);
    lines.push(`  +900 ms:            ${t900.lit} lit pixels`);
    lines.push(`  +1200 ms:           ${t1200.lit} lit pixels · ${t700.png === t900.png && t900.png === t1200.png ? 'byte-identical to +700 ms and +900 ms' : 'still moving'}`);
    lines.push(`  +1500 ms:           ${t1500.lit} lit pixels · ${t900.png === t1200.png && t1200.png === t1500.png ? 'byte-identical to +900 ms and +1200 ms' : 'still moving'}`);
    lines.push(`  settled frame:      ${t1500.columnsWithMoreThanOneRun} columns with a second run of lit pixels (worst ${t1500.worstRunsInAColumn} runs) · ${t1500.belowBaseline} lit pixels below the baseline`);
    lines.push('');
    if (passed) {
      lines.push('RESULT: the tail is a decay that stops inside the envelope\u2019s own window, and what it leaves is one flat bar per band — no after image, no cap, no reflection.');
    } else {
      const why = [];
      if (!falls) why.push('the tail stopped falling before it settled (something of the loud frame came back)');
      if (!settled) why.push('the bars were still moving a second and a half after the audio went quiet');
      if (!quiet) why.push(`more than 10 % of the loud frame survived (${t1500.lit} lit pixels)`);
      if (!flatBars) why.push(`the frame left behind is not flat bars (${t1500.columnsWithMoreThanOneRun} columns with a second run, ${t1500.belowBaseline} lit pixels below the baseline)`);
      lines.push(`RESULT: FAIL — ${why.join('; ')}.`);
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    process.exitCode = passed ? 0 : 1;
  }, { width: 393, height: 852, deviceScaleFactor: 3 });
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 2;
});
