#!/usr/bin/env node
/**
 * Cold repro of the web path's honest-silence defect — kanban card `t_13b5cca0`.
 *
 * **The claim under test.** On the web path the chip's capability word `theme` is reachable from
 * `ZERO_FRAMES_BEFORE_THEME` (= 18, `src/player/engine.ts:510`) analyser frames of silence at the
 * meter's own cadence (`METER_INTERVAL_MS` = 100, line 637) — i.e. from **1.8 s of all-zero
 * analyser frames while the transport is playing**, with no distinction between *"this item cannot
 * be measured"* and *"this item's samples are real and this passage of it is genuinely silent"*.
 *
 * **How this proves it without any sound in the room.**
 *
 *   - The zeros are the *song's own PCM*. The harness renders a 22 s WAV whose middle 5 s are
 *     exactly zero samples (a real, honest silent passage in a file that plays perfectly well),
 *     and serves that file as the app's stream. Nothing is muted to make the analyser see zeros:
 *     the analyser's `getByteFrequencyData` returns 0 for a decoded all-zero window, which is what
 *     a real song's silent passage produces too.
 *   - Chrome is launched `--headless=new --mute-audio` (the standing rule on this box: nothing
 *     audible). Muting is at the output mixer, so the graph and the analyser data are unchanged —
 *     and the run says so by keeping the element *playing* (not paused, position advancing) while
 *     it measures. The exact argv is recorded in the run's verdict file.
 *   - No device, no simulator, no real audio.
 *
 * **What it logs.** Every ~100 ms (the meter's own cadence) it reads, in the page and in one CDP
 * round trip: the engine's word (`EngineStatus.visualiser.word`) and its fields, the chip's own
 * text, the media element's transport facts, **the live analyser's bytes read independently**
 * (`maxByte`, `sum`, `nonzeroBins` — through the analyser instance captured by the injected probe,
 * not through the app's own `spectrum()` seam, which returns null once the app has decided there is
 * nothing to show), and the fixture's own PCM at the position playing (peak, all-zero or not,
 * segment name).
 *
 * **Two fixtures, one harness.**
 *
 *   - `silent-gap` (the subject): loud 5 s → quiet-but-NONZERO 4 s → **5 s of true zero samples** →
 *     loud 5 s. The quiet-but-nonzero segment is the within-run control; the closing chord is the
 *     proof that the word is content-driven and not "the read trace died".
 *   - `quiet-only` (the control run): the same shape with no zero sample anywhere — every sample
 *     nonzero. Expected: the word never leaves `spectrum`.
 *
 * Usage (from the repo root):
 *
 *   node docs/repro/t_13b5cca0/silent-passage-probe.mjs --fixture silent-gap
 *   node docs/repro/t_13b5cca0/silent-passage-probe.mjs --fixture quiet-only
 *
 * Flags: --fixture <silent-gap|quiet-only>, --outdir <dir>, --hold <ms after the silence ends>.
 * Logs land in `<outdir>` (default `docs/repro/t_13b5cca0/logs`). Exit code 0 when the trace was
 * written, whatever it says — this reports, it does not judge.
 */
import { spawn } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const METER_INTERVAL_MS = 100;
const USER = 'navidrome';
const PASSWORD = 'navidrome';

/* ------------------------------------------------------------------ the song */

const SR = 44100;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const HEADER_BYTES = 44;
const WINDOW_SAMPLES = 2048; // the app's own analyser.fftSize (src/player/engine.ts:3679)

/** The fixture's own structure, in seconds — this is what "an honest silent passage" means here. */
const STRUCTURE = {
  'silent-gap': [
    { name: 'loud opening chord', from: 0, to: 5, kind: 'chord' },
    { name: 'quiet but NONZERO (control)', from: 5, to: 9, kind: 'chirp' },
    { name: 'TRUE DIGITAL SILENCE', from: 9, to: 14, kind: 'zero' },
    { name: 'loud closing chord', from: 14, to: 22, kind: 'chord' },
  ],
  'quiet-only': [
    { name: 'loud opening chord', from: 0, to: 5, kind: 'chord' },
    { name: 'quiet but NONZERO (control)', from: 5, to: 22, kind: 'chirp' },
  ],
};

const CHORD_PARTIALS = [110, 330, 1320];

/** The mock library's own chord shape (`tools/audio.mjs`), so the loud parts are a normal song. */
function chordSample(t) {
  const tremolo = 0.72 + 0.28 * Math.sin(2 * Math.PI * 1.7 * t);
  let sum = 0;
  for (const partial of CHORD_PARTIALS) sum += Math.sin(2 * Math.PI * partial * t);
  return Math.max(-1, Math.min(1, sum * (0.7 / CHORD_PARTIALS.length) * tremolo));
}

/**
 * The quiet-but-NONZERO passage: a single partial sweeping 180 → 620 Hz at 0.02 amplitude
 * (−34 dBFS), i.e. ~31 dB below the chord. Two reasons it is a *sweep* and not a steady tone: it is
 * unambiguously quiet, and its frames keep changing, so the app's frozen-frame rule
 * (`FROZEN_FRAMES_BEFORE_THEME`) cannot be what keeps the word alive here.
 */
function renderWav(kind) {
  const duration = STRUCTURE[kind][STRUCTURE[kind].length - 1].to;
  const frames = Math.floor(duration * SR);
  const dataBytes = frames * CHANNELS * BYTES_PER_SAMPLE;
  const buffer = Buffer.alloc(HEADER_BYTES + dataBytes);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SR, 24);
  buffer.writeUInt32LE(SR * CHANNELS * BYTES_PER_SAMPLE, 28);
  buffer.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);

  const segments = STRUCTURE[kind];
  let chirpPhase = 0;
  let zeroSamples = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    const t = frame / SR;
    const segment = segments.find((entry) => t >= entry.from && t < entry.to) ?? segments[segments.length - 1];
    let value;
    if (segment.kind === 'zero') {
      value = 0;
      zeroSamples += 1;
    } else if (segment.kind === 'chirp') {
      const frequency = 180 + 40 * (t - segment.from);
      chirpPhase += (2 * Math.PI * frequency) / SR;
      value = 0.02 * Math.sin(chirpPhase);
    } else {
      value = chordSample(t);
    }
    const pcm = Math.round(value * 32767);
    const offset = HEADER_BYTES + frame * CHANNELS * BYTES_PER_SAMPLE;
    buffer.writeInt16LE(pcm, offset);
    buffer.writeInt16LE(pcm, offset + 2);
  }
  return { buffer, duration, zeroSamples, samples: frames };
}

/** Which segment of the fixture a playback position is in, and what the file's PCM does there. */
function pcmAt(wav, seconds) {
  const segments = wav.segments;
  const segment = segments.find((entry) => seconds >= entry.from && seconds < entry.to) ?? null;
  const startSample = Math.max(0, Math.min(wav.samples - WINDOW_SAMPLES, Math.floor(seconds * SR)));
  let peak = 0;
  let nonzero = 0;
  let sumOfSquares = 0;
  for (let i = 0; i < WINDOW_SAMPLES; i += 1) {
    const value = wav.buffer.readInt16LE(HEADER_BYTES + (startSample + i) * CHANNELS * BYTES_PER_SAMPLE);
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
    if (value !== 0) nonzero += 1;
    sumOfSquares += value * value;
  }
  return {
    segment: segment ? segment.name : null,
    kind: segment ? segment.kind : null,
    pcmPeak: peak,
    pcmRms: Math.round(Math.sqrt(sumOfSquares / WINDOW_SAMPLES) * 10) / 10,
    pcmNonzeroSamples: nonzero,
    pcmAllZero: nonzero === 0,
    windowSamples: WINDOW_SAMPLES,
  };
}

/* ------------------------------------------------------------- the mock library */

function startMockLibrary() {
  const child = spawn(process.execPath, ['tools/mock-subsonic.mjs', '--port', '0', '--stress', '--dist', 'dist', '--user', USER, '--password', PASSWORD], {
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const port = new Promise((resolvePort, reject) => {
    const timer = setTimeout(() => reject(new Error(`the mock never reported a port:\n${output}`)), 15000);
    const scan = (chunk) => {
      output += String(chunk);
      const match = /^navilite-mock-port (\d+)$/m.exec(output);
      if (!match) return;
      clearTimeout(timer);
      resolvePort(Number(match[1]));
    };
    child.stdout.on('data', scan);
    child.stderr.on('data', scan);
    child.on('exit', (code) => reject(new Error(`the mock exited (code ${code}):\n${output}`)));
  });
  return { child, port, output: () => output };
}

/* ------------------------------------------------- the front: the app + the fixture's song */

/**
 * One origin for everything, which is what the app is built around: the mock serves the built app
 * and the Subsonic API (`dist/`), and this front proxies all of it — **except the stream**, which
 * it answers with the fixture. Same-origin, so the app never sets `crossOrigin` and the analyser
 * sees real samples (the tainted-cross-origin case is a *different* card and is already covered by
 * `test/chip-word-browser.test.ts`'s second run).
 */
function startFront(mockPort, wav) {
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    if (/\/rest\/(stream|download)\.view$/.test(path)) {
      const range = req.headers.range;
      const total = wav.buffer.length;
      if (range) {
        const match = /bytes=(\d*)-(\d*)/.exec(range);
        const start = match?.[1] ? Number(match[1]) : 0;
        const end = match?.[2] ? Number(match[2]) : total - 1;
        const slice = wav.buffer.subarray(start, end + 1);
        res.writeHead(206, {
          'content-type': 'audio/wav',
          'accept-ranges': 'bytes',
          'content-range': `bytes ${start}-${end}/${total}`,
          'content-length': String(slice.length),
        });
        res.end(slice);
        return;
      }
      res.writeHead(200, {
        'content-type': 'audio/wav',
        'accept-ranges': 'bytes',
        'content-length': String(total),
      });
      res.end(wav.buffer);
      return;
    }
    const proxied = httpRequest(
      { host: '127.0.0.1', port: mockPort, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${mockPort}` } },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    proxied.on('error', () => {
      res.writeHead(502);
      res.end('front: the mock did not answer');
    });
    req.pipe(proxied);
  });
  return new Promise((resolveFront, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolveFront({ server, port: server.address().port }));
  });
}

/* ------------------------------------------------------------------ the browser */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(`${message.error.message}`));
        else entry.resolve(message.result);
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
    });
  }

  send(method, params = {}) {
    const id = (this.seq += 1);
    return new Promise((resolveCall, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} went unanswered for 30000 ms`)), 30000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolveCall(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  once(method, timeoutMs = 20000) {
    return new Promise((resolveOnce, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), timeoutMs);
      const listener = (params) => {
        clearTimeout(timer);
        this.listeners.set(method, (this.listeners.get(method) ?? []).filter((item) => item !== listener));
        resolveOnce(params);
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

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/**
 * The capture: the engine's media element (`new Audio()`, never in the DOM) and the analyser it
 * builds, both taken from the constructors themselves — installed **before the app's bundle runs**
 * (`Page.addScriptToEvaluateOnNewDocument`). Independently of the app's own seam, this is what lets
 * every read quote the live analyser's bytes even when the app's `spectrum()` returns null.
 */
const INSTRUMENT = `(() => {
  const probe = (window.__silentProbe = { elements: [], analysers: [], contexts: [], args: null });
  const OrigAudio = window.Audio;
  if (typeof OrigAudio === 'function') {
    const WrappedAudio = function (...args) {
      const element = new OrigAudio(...args);
      probe.elements.push(element);
      return element;
    };
    WrappedAudio.prototype = OrigAudio.prototype;
    window.Audio = WrappedAudio;
  }
  const OrigCtx = window.AudioContext || window.webkitAudioContext;
  if (typeof OrigCtx === 'function') {
    const WrappedCtx = function (...args) {
      const ctx = new OrigCtx(...args);
      probe.contexts.push(ctx);
      return ctx;
    };
    WrappedCtx.prototype = OrigCtx.prototype;
    window.AudioContext = WrappedCtx;
    if (window.webkitAudioContext) window.webkitAudioContext = WrappedCtx;
    const proto = OrigCtx.prototype;
    const origCreateAnalyser = proto.createAnalyser;
    proto.createAnalyser = function (...args) {
      const analyser = origCreateAnalyser.apply(this, args);
      probe.analysers.push(analyser);
      return analyser;
    };
  }
  probe.element = () => probe.elements[probe.elements.length - 1] || null;
  probe.analyser = () => probe.analysers[probe.analysers.length - 1] || null;
  probe.buffer = null;
  /** One read: the transport, the live analyser's own bytes, and the engine's word. */
  probe.read = () => {
    const element = probe.element();
    const analyser = probe.analyser();
    const status = window.__navilite ? window.__navilite.status() : null;
    const chip = document.querySelector('.mode-chip');
    const out = {
      perf: performance.now(),
      wall: Date.now(),
      word: status && status.visualiser ? status.visualiser.word : null,
      tone: status && status.visualiser ? status.visualiser.tone : null,
      state: status ? status.state : null,
      backend: status ? status.backend : null,
      spectrum: status ? status.spectrum : null,
      arming: status ? status.spectrumArming : null,
      reason: status ? String(status.modeReason || '') : '',
      chip: chip ? chip.textContent : null,
      element: null,
      analyser: null,
    };
    if (element) {
      out.element = {
        currentTime: element.currentTime,
        duration: element.duration,
        paused: element.paused,
        ended: element.ended,
        volume: element.volume,
        muted: element.muted,
        readyState: element.readyState,
        src: String(element.currentSrc || '').replace(/^.*\\/rest\\//, '/rest/'),
      };
    }
    if (analyser) {
      if (!probe.buffer || probe.buffer.length !== analyser.frequencyBinCount) {
        probe.buffer = new Uint8Array(analyser.frequencyBinCount);
      }
      const bins = probe.buffer;
      bins.fill(0);
      analyser.getByteFrequencyData(bins);
      let max = 0;
      let sum = 0;
      let sumOfSquares = 0;
      let nonzero = 0;
      for (let i = 0; i < bins.length; i += 1) {
        const value = bins[i];
        if (value > max) max = value;
        sum += value;
        sumOfSquares += value * value;
        if (value > 0) nonzero += 1;
      }
      out.analyser = {
        bins: bins.length,
        maxByte: max,
        sumBytes: sum,
        nonzeroBins: nonzero,
        rmsByte: Math.sqrt(sumOfSquares / bins.length),
        fftSize: analyser.fftSize,
        smoothingTimeConstant: analyser.smoothingTimeConstant,
        minDecibels: analyser.minDecibels,
        maxDecibels: analyser.maxDecibels,
        contextState: analyser.context ? analyser.context.state : null,
        contextSampleRate: analyser.context ? analyser.context.sampleRate : null,
      };
    }
    return out;
  };
  return true;
})()`;

async function withChrome(fn) {
  if (!existsSyncSafe(CHROME)) throw new Error(`no Chrome at ${CHROME}`);
  const profile = mkdtempSync(join(tmpdir(), 'navilite-silent-probe-'));
  const args = [
    '--headless=new',
    '--mute-audio',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ];
  const child = spawn(CHROME, args, { stdio: 'ignore', detached: true });
  let cdp = null;
  try {
    const port = await (async () => {
      const file = join(profile, 'DevToolsActivePort');
      const deadline = Date.now() + 20000;
      for (;;) {
        try {
          const [first] = readFileSync(file, 'utf8').split('\n');
          const value = Number(first);
          if (Number.isInteger(value) && value > 0) return value;
        } catch {
          /* not written yet */
        }
        if (Date.now() > deadline) throw new Error('Chrome never reported a devtools port');
        await sleep(60);
      }
    })();
    const created = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const ws = new WebSocket(created.webSocketDebuggerUrl);
    await new Promise((resolveOpen, reject) => {
      ws.addEventListener('open', resolveOpen, { once: true });
      ws.addEventListener('error', () => reject(new Error('the devtools socket never opened')), { once: true });
    });
    cdp = new Cdp(ws);
    const version = await cdp.send('Browser.getVersion');
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
    const result = await fn({ cdp, version, args, chromePath: CHROME, profile });
    return result;
  } finally {
    cdp?.close();
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    rmSync(profile, { recursive: true, force: true });
  }
}

function existsSyncSafe(path) {
  return existsSync(path);
}

const evaluate = async (cdp, expression) => {
  const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) {
    throw new Error(`in-page error: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
  }
  return result.result.value;
};

const navigate = async (cdp, url) => {
  const loaded = cdp.once('Page.loadEventFired', 30000);
  await cdp.send('Page.navigate', { url });
  await loaded;
};

/* ------------------------------------------------------------------- the run */

function parseArgs(argv) {
  const map = new Map();
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      map.set(token.replace(/^--/, ''), next);
      i += 1;
    } else {
      map.set(token.replace(/^--/, ''), 'true');
    }
  }
  return map;
}

async function main() {
  const args = parseArgs(process.argv);
  const kind = args.get('fixture') ?? 'silent-gap';
  if (!STRUCTURE[kind]) throw new Error(`unknown --fixture ${kind}`);
  const outDir = resolve(REPO, args.get('outdir') ?? 'docs/repro/t_13b5cca0/logs');
  mkdirSync(outDir, { recursive: true });

  const rendered = renderWav(kind);
  const wav = { ...rendered, buffer: rendered.buffer, segments: STRUCTURE[kind] };
  const fixturePath = join(outDir, `fixture-${kind}.wav`);
  writeFileSync(fixturePath, wav.buffer);

  if (args.has('fixture-only')) {
    const report = STRUCTURE[kind].map((segment) => {
      const middle = (segment.from + segment.to) / 2;
      const at = pcmAt(wav, middle);
      return { segment: segment.name, from: segment.from, to: segment.to, kind: segment.kind, atMidpoint: at };
    });
    process.stdout.write(
      `${JSON.stringify({ fixture: kind, seconds: wav.duration, framesPerChannel: wav.samples, zeroSamples: wav.zeroSamples, zeroSeconds: wav.zeroSamples / SR, fixturePath, segments: report }, null, 2)}\n`,
    );
    return;
  }

  const mock = startMockLibrary();
  const mockPort = await mock.port;
  const front = await startFront(mockPort, wav);
  const base = `http://127.0.0.1:${front.port}`;

  const rows = [];
  let meta = null;
  try {
    meta = await withChrome(async ({ cdp, version, args: chromeArgs }) => {
      const url = base;
      await navigate(cdp, url);
      await evaluate(
        cdp,
        `(() => {
          localStorage.setItem('navilite.settings', JSON.stringify({ serverUrl: ${JSON.stringify(base)}, username: ${JSON.stringify(USER)}, playback: 'web' }));
          localStorage.setItem('navilite.subsonic-password', ${JSON.stringify(PASSWORD)});
          return true;
        })()`,
      );
      await navigate(cdp, url);
      const ready = await evaluate(
        cdp,
        `(async () => {
          for (let i = 0; i < 600; i += 1) {
            if (window.__navilite && window.__navilite.libraryReady()) return true;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          return false;
        })()`,
      );
      if (!ready) throw new Error('the library never connected');

      // Play the first song of the stress playlist through the app's own controls.
      await evaluate(
        cdp,
        `(async () => {
          location.hash = '#/playlist/pl-stress-ja';
          for (let i = 0; i < 400; i += 1) {
            const buttons = Array.from(document.querySelectorAll('.row.song .row-play'));
            if (buttons.length > 0) {
              buttons[0].click();
              return true;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          return false;
        })()`,
      );
      const playing = await evaluate(
        cdp,
        `(async () => {
          for (let i = 0; i < 600; i += 1) {
            if (window.__navilite.status().state === 'playing') return true;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          return false;
        })()`,
      );
      if (!playing) throw new Error('the transport never started');

      // The trace: the meter's own cadence, from the first frame to the end of the fixture.
      const startedAt = Date.now();
      let next = Date.now();
      const stopAfterMs = args.get('stopafter') ? Number(args.get('stopafter')) : 0;
      for (;;) {
        const raw = await evaluate(cdp, 'window.__silentProbe.read()');
        const position = raw.element ? raw.element.currentTime : 0;
        rows.push({
          n: rows.length + 1,
          wallMs: raw.wall,
          perfMs: Math.round(raw.perf),
          sinceStartMs: raw.wall - startedAt,
          positionMs: Math.round(position * 1000),
          word: raw.word,
          tone: raw.tone,
          state: raw.state,
          backend: raw.backend,
          spectrum: raw.spectrum,
          arming: raw.arming,
          reason: raw.reason,
          chip: raw.chip,
          element: raw.element,
          analyser: raw.analyser,
          file: pcmAt(wav, position),
        });
        if (position >= wav.duration - 0.3) break;
        if (Date.now() - startedAt > 60000) break;
        if (stopAfterMs > 0 && Date.now() - startedAt > stopAfterMs) break;
        next += METER_INTERVAL_MS;
        const wait = next - Date.now();
        if (wait > 0) await sleep(wait);
      }

      return {
        chrome: version,
        chromePath: CHROME,
        chromeArgs,
        cdp: (await cdp.send('Browser.getVersion')).userAgent ?? version.userAgent,
      };
    });
  } finally {
    front.server.close();
    mock.child.kill('SIGKILL');
  }

  /* ------------------------------------------------------------- the log files */

  const jsonl = join(outDir, `trace-${kind}.jsonl`);
  writeFileSync(jsonl, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);

  const transitions = [];
  for (const row of rows) {
    if (transitions.length === 0 || transitions[transitions.length - 1].word !== row.word) {
      transitions.push({ word: row.word, chip: row.chip, at: row.sinceStartMs, positionMs: row.positionMs, state: row.state, tone: row.tone, reason: row.reason });
    }
  }

  // The longest unbroken run of all-zero analyser reads while the transport was playing — the
  // measurement the app's own meter was making at the same cadence. (A one- or two-read run at the
  // very start of a track is the analyser's own first-frame window, not a silent passage; the
  // longest run is what a reader can check against ZERO_FRAMES_BEFORE_THEME.)
  let run = [];
  let longestRun = null;
  for (const row of rows) {
    const zero = Boolean(row.analyser) && row.analyser.maxByte === 0 && row.state === 'playing';
    if (!zero) {
      run = [];
      continue;
    }
    run.push(row);
    if (!longestRun || run.length > longestRun.length) longestRun = [...run];
  }
  const firstZero = longestRun ? longestRun[0] : null;
  const lastZero = longestRun ? longestRun[longestRun.length - 1] : null;
  const zeroStretchMs = firstZero && lastZero ? lastZero.sinceStartMs - firstZero.sinceStartMs : 0;
  const zeroFileAllZero = longestRun ? longestRun.filter((row) => row.file.pcmAllZero).length : 0;
  const themeRow = rows.find((row) => row.word === 'theme') ?? null;
  const afterThemeRow = themeRow ? (rows.find((row) => row.sinceStartMs > themeRow.sinceStartMs && row.word !== 'theme') ?? null) : null;

  const lines = [];
  lines.push(`# Cold repro — the web path's capability word from 1.8 s of all-zero frames`);
  lines.push(`fixture: ${kind}   ${JSON.stringify(STRUCTURE[kind].map((s) => `${s.from}-${s.to}s ${s.name}`))}`);
  lines.push(`fixture file: ${fixturePath}`);
  lines.push(`fixture: ${wav.duration} s, ${wav.samples} frames/channel, ${wav.zeroSamples} samples that are exactly 0 (${(wav.zeroSamples / SR).toFixed(3)} s of true digital silence)`);
  if (meta) {
    lines.push(`chrome: ${meta.chrome.product} (${meta.chrome.revision}) — ${meta.chromePath}`);
    lines.push(`chrome argv: ${meta.chromeArgs.join(' ')}`);
  }
  lines.push(`app: dist/ built from the working tree; served by the mock through the front at ${base}`);
  lines.push('');
  lines.push(`reads: ${rows.length} at ~${METER_INTERVAL_MS} ms`);
  lines.push('');
  lines.push('## the word, as the engine and the chip wore it');
  for (const transition of transitions) {
    lines.push(
      `  +${String(transition.at).padStart(6)} ms  pos ${String((transition.positionMs / 1000).toFixed(2)).padStart(5)} s  word "${transition.word}"  chip "${transition.chip}"  tone ${transition.tone}  state ${transition.state}`,
    );
    lines.push(`            reason: ${transition.reason}`);
  }
  lines.push('');
  lines.push('## the all-zero stretch the harness measured on the live analyser');
  if (firstZero && lastZero) {
    lines.push(`  longest unbroken run of all-zero reads:      ${longestRun.length} reads, +${firstZero.sinceStartMs} ms → +${lastZero.sinceStartMs} ms (${zeroStretchMs} ms)`);
    lines.push(`  playback position at its ends:               ${firstZero.positionMs} ms → ${lastZero.positionMs} ms (${((lastZero.positionMs - firstZero.positionMs) / 1000).toFixed(3)} s of playing item)`);
    lines.push(`  reads inside it whose file window is exactly zero: ${zeroFileAllZero} of ${longestRun.length} (segment: ${firstZero.file.segment})`);
    lines.push(`  the file's own PCM at the run's start read:  peak ${firstZero.file.pcmPeak}, RMS ${firstZero.file.pcmRms}, ${firstZero.file.pcmNonzeroSamples} of ${firstZero.file.windowSamples} samples nonzero`);
    lines.push(`  the analyser's own bytes at that read:       maxByte ${firstZero.analyser.maxByte}, nonzeroBins ${firstZero.analyser.nonzeroBins} of ${firstZero.analyser.bins}, RMS ${firstZero.analyser.rmsByte.toFixed(1)}`);
    lines.push(`  the transport at that read:                  state ${firstZero.state}, element paused ${firstZero.element.paused}, position ${firstZero.element.currentTime.toFixed(3)} s, context ${firstZero.analyser.contextState}, meter cadence ${METER_INTERVAL_MS} ms × ZERO_FRAMES_BEFORE_THEME 18 = ${METER_INTERVAL_MS * 18} ms`);
  } else {
    lines.push('  no all-zero analyser read during this run');
  }
  if (themeRow) {
    lines.push('');
    lines.push(`  word flipped to "theme" at +${themeRow.sinceStartMs} ms, ${themeRow.sinceStartMs - (firstZero ? firstZero.sinceStartMs : 0)} ms after the first all-zero read`);
    lines.push(`  the engine's own reason at that read: ${themeRow.reason}`);
    if (afterThemeRow) {
      lines.push(`  and it left "theme" again at +${afterThemeRow.sinceStartMs} ms (word "${afterThemeRow.word}"), ${afterThemeRow.analyser ? `analyser maxByte ${afterThemeRow.analyser.maxByte}` : 'no analyser data'}`);
    }
  } else {
    lines.push('');
    lines.push('  the word never reached "theme" in this run');
  }
  lines.push('');
  lines.push('## the trace (one line per read)');
  lines.push('    #   +ms   pos(s)  segment                          filePCM   maxByte  nzBins  rms    word       chip       state    spectrum  arm  ctx');
  for (const row of rows) {
    const analyser = row.analyser;
    lines.push(
      `  ${String(row.n).padStart(4)} ${String(row.sinceStartMs).padStart(7)} ${String((row.positionMs / 1000).toFixed(2)).padStart(6)}  ${String(row.file.segment ?? '-').slice(0, 32).padEnd(32)} ${String(row.file.pcmPeak).padStart(6)} ${String(analyser ? analyser.maxByte : '-').padStart(7)} ${String(analyser ? analyser.nonzeroBins : '-').padStart(6)}  ${String(analyser ? analyser.rmsByte.toFixed(1) : '-').padStart(5)}  ${String(row.word).padEnd(10)} ${String(row.chip).padEnd(10)} ${String(row.state).padEnd(8)} ${String(row.spectrum).padEnd(8)} ${String(row.arming).padEnd(5)} ${analyser ? analyser.contextState : '-'}`,
    );
  }
  const text = `${lines.join('\n')}\n`;
  const logPath = join(outDir, `trace-${kind}.log`);
  writeFileSync(logPath, text);

  const verdict = {
    fixture: kind,
    fixtureStructure: STRUCTURE[kind],
    fixtureFile: fixturePath,
    fixtureSeconds: wav.duration,
    fixtureZeroSamples: wav.zeroSamples,
    fixtureZeroSeconds: wav.zeroSamples / SR,
    chrome: meta ? meta.chrome : null,
    chromePath: CHROME,
    chromeArgs: meta ? meta.chromeArgs : null,
    reads: rows.length,
    meterIntervalMs: METER_INTERVAL_MS,
    zeroFramesBeforeTheme: 18,
    firstAllZeroReadMs: firstZero ? firstZero.sinceStartMs : null,
    firstAllZeroPositionMs: firstZero ? firstZero.positionMs : null,
    lastAllZeroReadMs: lastZero ? lastZero.sinceStartMs : null,
    lastAllZeroPositionMs: lastZero ? lastZero.positionMs : null,
    allZeroReadsInLongestRun: longestRun ? longestRun.length : 0,
    allZeroReadsWithZeroPcm: zeroFileAllZero,
    allZeroStretchMs: zeroStretchMs,
    allZeroStretchSecondsOfItem: firstZero && lastZero ? (lastZero.positionMs - firstZero.positionMs) / 1000 : 0,
    analyserAtFirstAllZeroRead: firstZero ? firstZero.analyser : null,
    elementAtFirstAllZeroRead: firstZero ? firstZero.element : null,
    fileAtFirstAllZeroRead: firstZero ? firstZero.file : null,
    themeAtMs: themeRow ? themeRow.sinceStartMs : null,
    themeAtPositionMs: themeRow ? themeRow.positionMs : null,
    themeReason: themeRow ? themeRow.reason : null,
    leftThemeAtMs: afterThemeRow ? afterThemeRow.sinceStartMs : null,
    wordTransitions: transitions,
    logPath,
    jsonlPath: jsonl,
  };
  const verdictPath = join(outDir, `verdict-${kind}.json`);
  writeFileSync(verdictPath, `${JSON.stringify(verdict, null, 2)}\n`);

  process.stdout.write(text);
  process.stdout.write(`\nwrote ${logPath}\nwrote ${jsonl}\nwrote ${verdictPath}\nwrote ${fixturePath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 2;
});
