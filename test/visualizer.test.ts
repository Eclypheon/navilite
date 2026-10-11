/**
 * The spectrum contract.
 *
 * v1.1: *"the spectrum is a lot more responsive … but it appears like there is some after image or
 * some separation of the colors at the top of each bar"* — four ways a bar carried a memory of an
 * earlier frame (peak caps, fixed release ballistics, a gradient whose accent stop read as a second
 * colour, a reflection under the baseline) were removed, and what is drawn is one flat rectangle per
 * band.
 *
 * v1.7.4: *"the spectrum now is rather jittery and seems laggy and the colors are also not matching
 * the album art theme it seems to just be one blue color no matter what. Pausing should cause the
 * spectrum to gracefully all drop to zero but the spectrum disappears and it shows the placeholder
 * spectrum instead."* Three of those are contracts this file now pins down, and the fourth — that
 * the bars are the album's colours — is the palette set.
 *
 * These tests drive the real `attachVisualizer` frame loop with a recording 2D context and a clock
 * they advance themselves, so they read what it actually draws: how the envelope moves, what a
 * paused player leaves on the canvas, which colours the bars wear, and which frames are not painted
 * at all.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { attachVisualizer } from '../src/player/visualizer.ts';
import type { AudioEngine } from '../src/player/engine.ts';
import { DEFAULT_PALETTE } from '../src/player/palette.ts';
import type { Palette } from '../src/player/palette.ts';

const PALETTE: Palette = DEFAULT_PALETTE;
/** A palette no album art would produce, for the "the bars wear *the* palette" claims. */
const OTHER: Palette = { primary: '#ff0000', secondary: '#00ff00', accent: '#ffdd00', fromArt: true };
/** 60 Hz, near enough: one step of the harness clock is one display frame. */
const STEP_MS = 16.7;

interface Op {
  type: string;
  args: number[];
  fillStyle: unknown;
  globalAlpha: number;
}

/** A canvas 2D context that records what it was asked to draw. */
function recorder() {
  const ops: Op[] = [];
  const state = { fillStyle: '#000' as unknown, globalAlpha: 1 };
  const gradient = { addColorStop: () => undefined };
  const ctx = {
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(value: unknown) {
      state.fillStyle = value;
    },
    get globalAlpha() {
      return state.globalAlpha;
    },
    set globalAlpha(value: number) {
      state.globalAlpha = value;
    },
    clearRect: (...args: number[]) => ops.push({ type: 'clearRect', args, fillStyle: state.fillStyle, globalAlpha: state.globalAlpha }),
    fillRect: (...args: number[]) => ops.push({ type: 'fillRect', args, fillStyle: state.fillStyle, globalAlpha: state.globalAlpha }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
  };
  return { ctx, ops };
}

/**
 * A visualiser wired to a clock the test drives: `nextFrame()` advances it by one display frame and
 * draws exactly one frame, from whatever `setFrame()` was last given. `setTrack()` is whether the
 * engine is holding a track — the difference between "settle to zero" and "the placeholder".
 */
function harness() {
  const { ctx, ops } = recorder();
  const canvas = {
    clientWidth: 200,
    clientHeight: 200,
    width: 0,
    height: 0,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;

  let pending: ((time: number) => void) | null = null;
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = {
    raf: globals.requestAnimationFrame,
    caf: globals.cancelAnimationFrame,
    observer: globals.ResizeObserver,
    window: globals.window,
  };
  globals.requestAnimationFrame = (callback: (time: number) => void) => {
    pending = callback;
    return 1;
  };
  globals.cancelAnimationFrame = () => {
    pending = null;
  };
  // No resize events in this test: the size is fixed for the whole run.
  globals.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globals.window = { devicePixelRatio: 2, addEventListener: () => undefined };

  let frame: Uint8Array | null = new Uint8Array(new ArrayBuffer(1024));
  let track: unknown = { id: 'track-1' };
  const engine = {
    readSpectrum: () => frame,
    get currentTrack() {
      return track;
    },
  } as unknown as AudioEngine;
  const handle = attachVisualizer(canvas, engine, PALETTE);
  let clock = 0;

  return {
    handle,
    ops,
    canvas,
    /** The last frame's own bars, as heights in canvas px. */
    heights(drawn: Op[]) {
      return bars(drawn, canvas).map((op) => op.args[3]);
    },
    setFrame(next: Uint8Array | null) {
      frame = next;
    },
    /** A loaded (possibly paused) player. `null` is "nothing is loaded at all". */
    setTrack(next: unknown) {
      track = next;
    },
    nextFrame(stepMs = STEP_MS) {
      ops.length = 0;
      const callback = pending;
      assert.ok(callback, 'the visualiser should have a frame queued');
      clock += stepMs;
      callback(clock);
      return ops.slice();
    },
    /** Draw `count` frames of the same input and hand back the last one. */
    frames(count: number, stepMs = STEP_MS) {
      let last = ops.slice();
      for (let index = 0; index < count; index += 1) last = this.nextFrame(stepMs);
      return last;
    },
    restore() {
      globals.requestAnimationFrame = previous.raf;
      globals.cancelAnimationFrame = previous.caf;
      globals.ResizeObserver = previous.observer;
      globals.window = previous.window;
    },
  };
}

/** One rectangle per band, i.e. everything except the full-canvas backdrop fill. */
function bars(ops: Op[], canvas: HTMLCanvasElement): Op[] {
  return ops.filter(
    (op) => op.type === 'fillRect' && !(op.args[0] === 0 && op.args[1] === 0 && op.args[2] === canvas.width && op.args[3] === canvas.height),
  );
}

/**
 * The spectrum's own bars, told apart from the placeholder's by where they stand: the spectrum bars
 * all end on the baseline (0.98 of the canvas height), and nothing the theme draws does.
 */
function spectrumBars(ops: Op[], canvas: HTMLCanvasElement): Op[] {
  return bars(ops, canvas).filter((op) => Math.abs(op.args[1] + op.args[3] - canvas.height * 0.98) < 1);
}

function uniform(level: number): Uint8Array {
  const data = new Uint8Array(new ArrayBuffer(1024));
  data.fill(level);
  return data;
}

/**
 * The canvas is 400 px tall at ratio 2 and the bars stop at the ceiling (0.9 of it), so a
 * full-scale band is 360 px. Every "how tall" claim below is quoted against that.
 */
const CEILING_PX = 360;

test('a full-scale frame is most of the way up within five frames — the attack is fast', () => {
  const h = harness();
  try {
    h.handle.start();
    h.setFrame(uniform(255));
    const first = h.heights(h.nextFrame())[0];
    assert.ok(first > 20, `the first frame after silence already draws a bar: got ${first} px`);
    assert.ok(first < CEILING_PX * 0.6, `and it does not jump straight to full scale: got ${first} px`);

    const settled = h.heights(h.frames(5))[0];
    assert.ok(
      settled > CEILING_PX * 0.8,
      `six frames of a full-scale input should be near the ceiling (got ${settled} px of ${CEILING_PX})`,
    );
  } finally {
    h.restore();
  }
});

test('a silent frame falls to the baseline on a release envelope, and settles at exactly zero', () => {
  const h = harness();
  try {
    h.handle.start();
    h.setFrame(uniform(255));
    const loud = h.heights(h.frames(12))[0];
    assert.ok(loud > CEILING_PX * 0.9, `the loud frame is at the ceiling first: ${loud} px`);

    h.setFrame(uniform(0));
    // It must not snap: the frame right after a loud one is still tall.
    const justAfter = h.heights(h.nextFrame())[0];
    assert.ok(justAfter > loud * 0.7, `the release is a fall, not a cut: ${loud} px → ${justAfter} px in one frame`);

    // ~300 ms: most of the way down but not there yet — the bars have visibly dropped.
    const at300 = h.heights(h.frames(17))[0];
    assert.ok(at300 < loud * 0.15, `300 ms of silence should be nearly down: ${at300} px of ${loud} px`);

    // ~500 ms: nothing left, and it is exactly nothing rather than 1 % of a bar.
    const at500 = h.heights(h.frames(12))[0];
    assert.ok(at500 <= 1, `half a second of silence leaves no bar: got ${at500} px`);
    const still = h.heights(h.frames(10))[0];
    assert.equal(still, at500, 'and it stays there');
  } finally {
    h.restore();
  }
});

test('a quiet frame is drawn from the quiet frame, not from the louder one before it', () => {
  const h = harness();
  try {
    h.handle.start();
    h.setFrame(uniform(255));
    const loud = h.heights(h.frames(12))[0];

    h.setFrame(uniform(64));
    const quiet = h.heights(h.frames(12))[0];
    // 64/255 through the response curve, not a fraction of the previous height.
    assert.ok(quiet < loud * 0.5, `a quiet frame should be much shorter than ${loud} px, got ${quiet} px`);
    assert.ok(
      Math.abs(quiet - loud * 0.78) > 1,
      'the bar must not be the previous frame decayed by a fixed fraction',
    );
  } finally {
    h.restore();
  }
});

test('a steady input converges and then draws byte-identical rectangles — no after image', () => {
  const h = harness();
  try {
    h.handle.start();
    h.setFrame(uniform(120));
    h.frames(20);
    const first = h.nextFrame();
    const second = h.nextFrame();
    // Only what reaches the pixels: a clear is a clear whatever the fill was left at.
    const pixels = (ops: Op[]) =>
      ops.map((op) => ({
        type: op.type,
        args: op.args,
        fill: op.type === 'fillRect' ? String(op.fillStyle) : null,
        alpha: op.globalAlpha,
      }));
    assert.deepEqual(pixels(second), pixels(first), 'the same analyser frame must draw the same pixels');
    assert.equal(bars(first, h.canvas).length, 64, 'one rectangle per band, and nothing else');
  } finally {
    h.restore();
  }
});

test('a 64-band native frame is drawn as the bars themselves, not re-binned', () => {
  const h = harness();
  try {
    h.handle.start();
    /*
     * The native tap hands over the 64 bands it has already computed (`NaviliteSpectrum.swift` does
     * the log spacing with vDSP); the analyser hands over 1024 bins. Both must draw as 64 bars, and
     * a banded frame must be a pure function of its own values: band 0 short, band 63 full.
     */
    const frame = new Uint8Array(new ArrayBuffer(64));
    frame.fill(40);
    frame[0] = 12;
    frame[63] = 255;
    h.setFrame(frame);
    const drawn = bars(h.frames(12), h.canvas);
    assert.equal(drawn.length, 64, 'one rectangle per band, from a 64-value frame too');

    const heights = drawn.map((bar) => bar.args[3]);
    assert.ok(heights.every((height) => height >= 1), 'every band is drawn, however quiet');
    assert.ok(heights[63] > heights[0] * 3, `the loud band draws the tall bar (band 63: ${heights[63]} px, band 0: ${heights[0]} px)`);
    assert.equal(Math.max(...heights), heights[63], 'and the loudest band is the tallest');
    // The uniform 40s in between must all be the same height — a re-binning through the log curve
    // would have made them fall away with frequency instead.
    const middles = heights.slice(1, 63);
    assert.equal(new Set(middles).size, 1, `equal bands draw equal bars (${[...new Set(middles)].join(', ')})`);

    // A flat native frame is a flat line, and it gets there by falling.
    const silent = new Uint8Array(new ArrayBuffer(64));
    h.setFrame(silent);
    const quiet = bars(h.frames(30), h.canvas);
    for (const bar of quiet) assert.ok(bar.args[3] <= 1, `digital silence draws no bar: got ${bar.args[3]} px`);
  } finally {
    h.restore();
  }
});

test('the bars wear the palette the rest of the UI is using, and a new palette recolours them', () => {
  const h = harness();
  try {
    h.handle.start();
    h.setFrame(uniform(180));
    const first = bars(h.frames(12), h.canvas);
    const fills = first.map((op) => String(op.fillStyle));
    const worn = new Set(fills);
    assert.equal(worn.size, 3, `the spectrum is the palette's three colours, got ${[...worn].join(', ')}`);
    for (const colour of worn) {
      assert.ok(
        [PALETTE.primary, PALETTE.secondary, PALETTE.accent].includes(colour),
        `${colour} is not one of the palette's colours`,
      );
    }
    // ...and it is a low→high ramp rather than three blocks in any order: the first bar is the
    // primary, the last is the accent.
    assert.equal(fills[0], PALETTE.primary, 'the lowest band wears the primary colour');
    assert.equal(fills[63], PALETTE.accent, 'the highest band wears the accent');
    for (const bar of first) assert.equal(bar.globalAlpha, 1, 'a per-bar alpha ramp is a second colour by another name');

    // Another track, another palette: the same frame of the same track in different colours.
    h.handle.setPalette(OTHER);
    const recoloured = bars(h.frames(12), h.canvas).map((op) => String(op.fillStyle));
    assert.notDeepEqual(recoloured, fills, 'a new palette must recolour the bars');
    assert.deepEqual([...new Set(recoloured)].sort(), [OTHER.accent, OTHER.primary, OTHER.secondary].sort());
  } finally {
    h.restore();
  }
});

test('a paused player settles to zero bars and never shows the placeholder', () => {
  const h = harness();
  try {
    h.handle.start();
    h.setFrame(uniform(255));
    h.frames(12);
    assert.equal(spectrumBars(h.frames(1), h.canvas).length, 64, 'the spectrum is up before the pause');

    // Paused: the engine hands over no frame, but it still has the track.
    h.setFrame(null);
    const duringFall = h.nextFrame();
    assert.equal(spectrumBars(duringFall, h.canvas).length, 64, 'the bars are still there while they fall');
    const falling = spectrumBars(duringFall, h.canvas)[0].args[3];
    assert.ok(falling > 1, `and they are still falling rather than already gone: ${falling} px`);

    const settled = h.frames(40);
    assert.equal(spectrumBars(settled, h.canvas).length, 64, 'and the visualiser is still in place, at rest');
    for (const bar of spectrumBars(settled, h.canvas)) {
      assert.ok(bar.args[3] <= 1, `settled bars are at the baseline: ${bar.args[3]} px`);
    }
    // Not one frame of the 41 since the pause may have been the placeholder.
    for (let index = 0; index < 40; index += 1) {
      const drawn = h.nextFrame();
      assert.equal(spectrumBars(drawn, h.canvas).length, 64, `frame ${index} after the pause was not the spectrum`);
    }

    // Nothing loaded at all: *now* it is the placeholder.
    h.setTrack(null);
    const theme = h.nextFrame();
    assert.equal(spectrumBars(theme, h.canvas).length, 0, 'no spectrum bars are drawn when no track is loaded');
    assert.ok(bars(theme, h.canvas).length > 0, 'the placeholder is what "nothing loaded" looks like');
  } finally {
    h.restore();
  }
});

test('the frame budget holds: a callback that arrives early is not a paint', () => {
  const h = harness();
  try {
    h.handle.start();
    h.setFrame(uniform(200));
    const painted = h.heights(h.nextFrame())[0];
    assert.ok(painted > 1, 'the first frame paints');

    const tooSoon = h.nextFrame(2);
    assert.equal(bars(tooSoon, h.canvas).length, 0, 'a callback 2 ms later must not paint a second time');
    assert.ok(painted > 1);
  } finally {
    h.restore();
  }
});
