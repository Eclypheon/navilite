/**
 * The spectrum contract: **a bar is the current frame and nothing else.**
 *
 * The owner's v1.1 report was "the spectrum is a lot more responsive … but it appears like there
 * is some after image or some separation of the colors at the top of each bar", and he was
 * right — the bars carried four separate memories of earlier frames: peak caps (a 2 px segment
 * drawn above the bar at a different alpha), a fixed per-frame release fall-off, a gradient
 * whose accent stop read as a second colour at the top, and a reflection under the baseline.
 *
 * These tests drive the real `attachVisualizer` frame loop with a recording 2D context, so they
 * read what it actually draws rather than what it is supposed to draw:
 *
 *   - a loud frame followed immediately by a silent one draws bars at the baseline on the very
 *     next frame (no ghost of the loud frame, no cap left floating above it);
 *   - a second identical frame draws a byte-identical set of rectangles (two identical frames
 *     cannot differ, which is what "no after image" means pixel-for-pixel);
 *   - every bar in a frame is the same fill and the same alpha, and no frame draws anything
 *     other than the backdrop plus one rectangle per band.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { attachVisualizer } from '../src/player/visualizer.ts';
import type { AudioEngine } from '../src/player/engine.ts';
import { DEFAULT_PALETTE } from '../src/player/palette.ts';
import type { Palette } from '../src/player/palette.ts';

const PALETTE: Palette = DEFAULT_PALETTE;

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
 * A visualiser wired to a hand-driven clock: `nextFrame()` draws exactly one frame, and the
 * analyser frame it draws from is whatever `setFrame()` was last given.
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

  let pending: (() => void) | null = null;
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = {
    raf: globals.requestAnimationFrame,
    caf: globals.cancelAnimationFrame,
    observer: globals.ResizeObserver,
    window: globals.window,
  };
  globals.requestAnimationFrame = (callback: () => void) => {
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
  const engine = { readSpectrum: () => frame } as unknown as AudioEngine;
  const handle = attachVisualizer(canvas, engine, PALETTE);

  return {
    handle,
    ops,
    canvas,
    setFrame(next: Uint8Array | null) {
      frame = next;
    },
    nextFrame() {
      ops.length = 0;
      const callback = pending;
      assert.ok(callback, 'the visualiser should have a frame queued');
      callback();
      return ops.slice();
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

function uniform(level: number): Uint8Array {
  const data = new Uint8Array(new ArrayBuffer(1024));
  data.fill(level);
  return data;
}

test('a loud frame followed by silence collapses to the bars\u2019 baseline on the very next frame', () => {
  const h = harness();
  try {
    h.handle.start();
    h.setFrame(uniform(255));
    const loud = h.nextFrame();
    const loudBars = bars(loud, h.canvas);
    assert.equal(loudBars.length, 64, 'one rectangle per band, and nothing else');
    const loudHeight = loudBars[0].args[3];
    assert.ok(loudHeight > 300, `a full-scale frame should draw tall bars (got ${loudHeight} px on a 400 px canvas)`);

    h.setFrame(uniform(0));
    const silent = h.nextFrame();
    const silentBars = bars(silent, h.canvas);
    assert.equal(silentBars.length, 64);
    for (const bar of silentBars) {
      assert.ok(bar.args[3] <= 1, `a silent frame draws no bar: got ${bar.args[3]} px`);
    }
    // The v1.1 release ballistics would have left the bars at 78% of the loud frame here; the
    // peak caps would have left a 2 px segment floating ~2 px above each bar. Neither is drawn.
    for (const bar of silentBars) {
      assert.notEqual(Math.round(bar.args[3]), Math.round(loudHeight * 0.78), 'no release fall-off remains');
    }
  } finally {
    h.restore();
  }
});

test('a quiet frame is drawn from the quiet frame, not from the louder one before it', () => {
  const h = harness();
  try {
    h.handle.start();
    h.setFrame(uniform(255));
    const loudHeight = bars(h.nextFrame(), h.canvas)[0].args[3];

    h.setFrame(uniform(64));
    const quiet = bars(h.nextFrame(), h.canvas);
    const quietHeight = quiet[0].args[3];
    // 64/255 through the response curve, not 78% of the previous height.
    assert.ok(quietHeight < loudHeight * 0.5, `quiet frame should be much shorter than ${loudHeight} px, got ${quietHeight} px`);
    assert.ok(
      Math.abs(quietHeight - loudHeight * 0.78) > 1,
      'the bar must not be the previous frame decayed by a fixed fraction',
    );
  } finally {
    h.restore();
  }
});

test('two identical frames draw byte-identical rectangles — no after image is possible', () => {
  const h = harness();
  try {
    h.handle.start();
    h.setFrame(uniform(120));
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
  } finally {
    h.restore();
  }
});

test('every bar in a frame is one flat colour at full alpha, and each frame is fully cleared', () => {
  const h = harness();
  try {
    h.handle.start();
    h.setFrame(uniform(180));
    const ops = h.nextFrame();
    const cleared = ops.filter((op) => op.type === 'clearRect');
    assert.equal(cleared.length, 1, 'each frame clears the canvas');
    assert.deepEqual(cleared[0].args, [0, 0, h.canvas.width, h.canvas.height]);

    const barOps = bars(ops, h.canvas);
    assert.equal(barOps.length, 64, 'no cap segment and no reflection: exactly one rect per band');
    const fills = new Set(barOps.map((op) => String(op.fillStyle)));
    assert.equal(fills.size, 1, `one colour for the whole frame, got ${[...fills].join(', ')}`);
    assert.equal([...fills][0], PALETTE.primary);
    for (const bar of barOps) {
      assert.equal(bar.globalAlpha, 1, 'a per-bar alpha ramp is a second colour by another name');
    }
    for (const op of ops) assert.equal(op.globalAlpha, 1, 'nothing may leave the context at a partial alpha');
  } finally {
    h.restore();
  }
});
