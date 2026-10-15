#!/usr/bin/env node
/**
 * The shape of the tail after the audio is muted — the curve behind `spectrum-proof.mjs`'s window.
 *
 * `tools/spectrum-proof.mjs` judges a small number of readings; this measures the whole curve, so
 * the window it judges at can be *shown* rather than asserted. It plays the mock library's WAV
 * through the app's own transport, sets `volume = 0` on the engine's live media element (never a
 * pause: pausing swaps the screen to the theme animation), and then samples the canvas every 80–400
 * ms out to two seconds, reporting each reading's lit pixels, its share of the loud frame, the ratio
 * against the reading before it, and whether it is byte-identical to that reading.
 *
 * What it is for: separating "the bars are still showing the loud frame" from "the bars are obeying
 * an envelope". An exponential decay gives a constant ratio per interval — a 0.1 s time constant
 * shows up as a ratio near 2.5 per 80 ms reading, which is `RELEASE_S = 0.1` in
 * `src/player/visualizer.ts` (v1.7.4). A remembered frame instead of a filtered one does not decay at
 * one rate, and a frame that never settles keeps changing for seconds — see `docs/verification.md`
 * §16 and `DECISIONS.md` for both.
 *
 * Run the mock first (`node tools/mock-subsonic.mjs --port 4599 --stress`), then:
 *
 *   node tools/spectrum-tail.mjs --url http://127.0.0.1:4599
 *   node tools/spectrum-tail.mjs --url http://127.0.0.1:4599 --out tail.json
 *
 * Exit code is 0 whatever the curve looks like: this reports, it does not judge.
 */
import { writeFileSync } from 'node:fs';
import { navigate, evaluate, withChromePage } from './layout-audit.mjs';

const snap = (cdp) => evaluate(cdp, 'window.__naviliteLayoutAudit.spectrumSnapshot()');

/** Absolute offsets, in ms, after the audio is muted. */
const OFFSETS = [50, 160, 240, 320, 400, 480, 560, 640, 740, 860, 1000, 1200, 1500, 2000];

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
  const out = argv.get('out') ?? null;
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
    await evaluate(cdp, 'new Promise((resolve) => setTimeout(() => resolve(true), 1500))');

    const loud = await snap(cdp);
    if (!loud) throw new Error('no spectrum canvas to read');
    const silenced = await evaluate(cdp, 'window.__naviliteLayoutAudit.silenceAudio()');
    if (!silenced) throw new Error('the probe never captured the engine\u2019s media element');

    const samples = [];
    let elapsed = 0;
    for (const at of OFFSETS) {
      const wait = at - elapsed;
      elapsed = at;
      if (wait > 0) await evaluate(cdp, `new Promise((resolve) => setTimeout(() => resolve(true), ${wait}))`);
      const reading = await snap(cdp);
      samples.push({ at, lit: reading.lit, checksum: reading.checksum, png: reading.png });
    }

    const rows = samples.map((sample, index) => ({
      at: sample.at,
      lit: sample.lit,
      pct: Math.round((sample.lit / loud.lit) * 1000) / 10,
      ratioToPrevious: index === 0 ? null : Math.round((samples[index - 1].lit / sample.lit) * 100) / 100,
      identicalToPrevious: index === 0 ? null : sample.png === samples[index - 1].png,
    }));
    const settled = rows.find((row, index) => index > 0 && rows.slice(index).every((later) => later.identicalToPrevious === true));

    const lines = [];
    lines.push(`Spectrum tail — ${url}`);
    lines.push(`  canvas ${loud.canvas} · media element volume ${silenced.volume}, paused ${silenced.paused} (still playing, audibly silent)`);
    lines.push(`  playing: ${loud.lit} lit pixels`);
    for (const row of rows) {
      const ratio = row.ratioToPrevious === null ? '-' : `${row.ratioToPrevious}x`;
      const same = row.identicalToPrevious === null ? '' : row.identicalToPrevious ? 'identical to previous' : 'DIFFERENT';
      lines.push(`  +${String(row.at).padStart(4)} ms: ${String(row.lit).padStart(6)} lit px  ${String(row.pct).padStart(5)}%  ratio ${ratio.padStart(7)}  ${same}`);
    }
    lines.push('');
    lines.push(
      settled
        ? `  the frame stops changing at +${settled.at} ms and stays identical from there to +${OFFSETS[OFFSETS.length - 1]} ms`
        : `  the frame never stops changing within +${OFFSETS[OFFSETS.length - 1]} ms — every reading differs from the one before it`,
    );
    process.stdout.write(`${lines.join('\n')}\n`);

    if (out) {
      writeFileSync(
        out,
        JSON.stringify({ url, loud: { lit: loud.lit, checksum: loud.checksum }, silenced, rows: rows.map(({ png: _png, ...rest }) => rest) }, null, 2),
      );
    }
  }, { width: 393, height: 852, deviceScaleFactor: 3 });
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 2;
});
