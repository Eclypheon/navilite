/**
 * The visualiser.
 *
 * Two modes, and they are deliberately *different* rather than one mode pretending
 * to be the other:
 *
 *   spectrum — real `getByteFrequencyData()` frames from the playing stream, drawn
 *              as log-spaced bands with peak caps.
 *   theme    — a slow, smooth album-art-coloured animation, used when there are no
 *              samples to show (tainted stream, suspended audio context, native
 *              playback). It moves to its own clock, not to the music, because there
 *              is no music data to move to.
 *
 * The band edges are logarithmic over the lower ~60% of the analyser's bins, which is
 * where music lives; the top bins of a 2048-point FFT are above the content of most
 * lossy streams.
 *
 * v1.1 rewrote the frame loop for sharpness and cost, because the owner reported the
 * spectrum looked "draggy and laggy". Three things were wrong with it:
 *
 *   1. It drew from the engine's 100 ms meter buffer, so sixty frames a second showed the
 *      same ten measurements. Now it pulls its own frame per paint (`engine.readSpectrum`).
 *   2. It allocated on every frame — a band-edge array, two gradients — which is exactly
 *      the sort of thing that shows up as periodic jank. Everything that depends only on
 *      size or palette is now cached, and nothing is allocated in the loop.
 *   3. It read `canvas.clientWidth`/`clientHeight` every frame (a forced layout). A
 *      ResizeObserver replaces that: the canvas is only measured when it actually changes.
 *
 * The movement itself is now attack-immediate, decay-explicit: a band jumps to its value in
 * the frame it arrives and falls at a fixed fraction per frame, so peaks snap and then let
 * go visibly (~110 ms to a fifth of the height) instead of the analyser's old
 * `smoothingTimeConstant` of 0.8, which made every bar carry 80% of the previous frame.
 */
import type { AudioEngine } from './engine.ts';
import type { Palette } from './palette.ts';

export interface VisualizerHandle {
  setPalette(palette: Palette): void;
  start(): void;
  stop(): void;
}

const BAND_COUNT = 64;
const OFFSET_BINS_END = 0.6;
/** Peak caps fall by this much of full height per frame (~0.4 s from the top). */
const PEAK_DECAY = 0.02;
/** Bars fall to ~22% of their height in 7 frames (~115 ms), then keep falling. */
const BAR_FALLOFF = 0.78;

export function attachVisualizer(canvas: HTMLCanvasElement, engine: AudioEngine, initialPalette: Palette): VisualizerHandle {
  let palette = initialPalette;
  let frame = 0;
  let running = false;
  let startTime = performance.now();

  const display = new Float32Array(BAND_COUNT);
  const peaks = new Float32Array(BAND_COUNT);

  // Everything below is created once per size/palette, never per frame.
  const ctx = canvas.getContext('2d', { alpha: true });
  let bandEdges: number[] = [];
  let edgesForBins = -1;
  let barGradient: CanvasGradient | null = null;
  let barGradientKey = '';
  let backdrop: CanvasGradient | null = null;
  let backdropKey = '';

  const measure = (): void => {
    if (!ctx) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width;
    canvas.height = height;
    backdrop = null;
    barGradient = null;
  };

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => measure()).observe(canvas);
  } else {
    window.addEventListener('resize', measure);
  }

  const ensureBackdrop = (width: number, height: number): CanvasGradient | null => {
    if (!ctx) return null;
    const key = `${width}x${height}`;
    if (backdrop && backdropKey === key) return backdrop;
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(8, 8, 14, 0.0)');
    gradient.addColorStop(1, 'rgba(8, 8, 14, 0.75)');
    backdrop = gradient;
    backdropKey = key;
    return backdrop;
  };

  const ensureBarGradient = (height: number): CanvasGradient | null => {
    if (!ctx) return null;
    const key = `${height}:${palette.primary}:${palette.secondary}:${palette.accent}`;
    if (barGradient && barGradientKey === key) return barGradient;
    const gradient = ctx.createLinearGradient(0, height, 0, 0);
    gradient.addColorStop(0, palette.secondary);
    gradient.addColorStop(0.55, palette.primary);
    gradient.addColorStop(1, palette.accent);
    barGradient = gradient;
    barGradientKey = key;
    return barGradient;
  };

  const draw = () => {
    frame = requestAnimationFrame(draw);
    if (!ctx) return;
    const { width, height } = canvas;
    const spectrum = engine.readSpectrum();

    const back = ensureBackdrop(width, height);
    ctx.clearRect(0, 0, width, height);
    if (back) {
      ctx.fillStyle = back;
      ctx.fillRect(0, 0, width, height);
    }

    if (spectrum) drawSpectrum(ctx, width, height, spectrum, display, peaks);
    else {
      display.fill(0);
      peaks.fill(0);
      drawTheme(ctx, width, height, palette, (performance.now() - startTime) / 1000);
    }
  };

  return {
    setPalette(next) {
      palette = next;
      barGradient = null;
    },
    start() {
      if (running) return;
      running = true;
      startTime = performance.now();
      measure();
      frame = requestAnimationFrame(draw);
    },
    stop() {
      running = false;
      cancelAnimationFrame(frame);
    },
  };

  /** Log-spaced bin ranges, rebuilt only when the FFT bin count changes. */
  function edges(binCount: number): number[] {
    if (binCount === edgesForBins) return bandEdges;
    const result: number[] = [];
    const end = Math.max(8, Math.floor(binCount * OFFSET_BINS_END));
    const minLog = Math.log(2);
    const maxLog = Math.log(end);
    for (let i = 0; i <= BAND_COUNT; i += 1) {
      result.push(Math.floor(Math.exp(minLog + (maxLog - minLog) * (i / BAND_COUNT))) - 1);
    }
    bandEdges = result;
    edgesForBins = binCount;
    return bandEdges;
  }

  function drawSpectrum(
    c: CanvasRenderingContext2D,
    width: number,
    height: number,
    spectrum: Uint8Array,
    levels: Float32Array,
    caps: Float32Array,
  ): void {
    const edgesForFrame = edges(spectrum.length);
    const gap = Math.max(1, width / BAND_COUNT / 6);
    const bandWidth = width / BAND_COUNT - gap;
    const gradient = ensureBarGradient(height);
    if (gradient) c.fillStyle = gradient;

    const floor = height * 0.96;
    const ceiling = height * 0.9;
    for (let band = 0; band < BAND_COUNT; band += 1) {
      const from = edgesForFrame[band];
      const to = Math.max(from + 1, edgesForFrame[band + 1]);
      let sum = 0;
      for (let bin = from; bin < to && bin < spectrum.length; bin += 1) sum += spectrum[bin];
      const value = sum / (to - from) / 255;
      const magnitude = Math.pow(value, 1.35);

      // Attack is immediate, release is a fixed fraction per frame: the bar snaps to the
      // music and then falls visibly, which is what makes it read as sharp rather than
      // smoothed-through.
      const shown = magnitude >= levels[band] ? magnitude : levels[band] * BAR_FALLOFF;
      levels[band] = shown;
      const barHeight = Math.max(1, shown * ceiling);
      const x = band * (bandWidth + gap);

      c.globalAlpha = 0.55 + 0.45 * shown;
      c.fillRect(x, floor - barHeight, bandWidth, barHeight);
      // Reflection, so the bar reads as sitting on a surface rather than floating.
      c.globalAlpha = 0.14 + 0.2 * shown;
      c.fillRect(x, floor, bandWidth, Math.min(height - floor, barHeight * 0.28));

      caps[band] = Math.max(shown, caps[band] - PEAK_DECAY);
      if (caps[band] > 0.02) {
        c.globalAlpha = 0.9;
        c.fillRect(x, floor - caps[band] * ceiling - 2, bandWidth, 2);
      }
    }
    c.globalAlpha = 1;
  }
}

/**
 * The no-samples mode. Smooth, slow, seeded by nothing but time and the palette: it is
 * a theme, not a measurement.
 */
function drawTheme(ctx: CanvasRenderingContext2D, width: number, height: number, palette: Palette, seconds: number): void {
  const midX = width / 2;
  const midY = height * 0.72;
  const pulse = 0.5 + 0.5 * Math.sin(seconds * 0.6);

  const glow = ctx.createRadialGradient(midX, midY, 0, midX, midY, Math.max(width, height) * (0.35 + pulse * 0.12));
  glow.addColorStop(0, withAlpha(palette.primary, 0.35));
  glow.addColorStop(0.5, withAlpha(palette.secondary, 0.16));
  glow.addColorStop(1, 'rgba(8, 8, 14, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  const bars = 28;
  const gap = width / bars / 5;
  const barWidth = width / bars - gap;
  for (let i = 0; i < bars; i += 1) {
    const phase = seconds * 0.35 + i * 0.42;
    const wave = (Math.sin(phase) + Math.sin(phase * 0.53 + 1.7)) / 4 + 0.5;
    const barHeight = Math.max(4, wave * height * 0.34 * (0.6 + 0.4 * Math.sin(seconds * 0.2 + i)));
    const x = i * (barWidth + gap);
    ctx.fillStyle = withAlpha(i % 2 === 0 ? palette.secondary : palette.primary, 0.22 + wave * 0.2);
    ctx.fillRect(x, midY - barHeight, barWidth, barHeight);
  }
}

function withAlpha(color: string, alpha: number): string {
  if (color.startsWith('#')) {
    const value = color.slice(1);
    const r = parseInt(value.slice(0, 2), 16);
    const g = parseInt(value.slice(2, 4), 16);
    const b = parseInt(value.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  if (color.startsWith('hsl(')) {
    return color.replace('hsl(', 'hsla(').replace(')', ` / ${alpha})`);
  }
  return color;
}
