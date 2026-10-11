/**
 * The visualiser.
 *
 * Two modes, and they are deliberately *different* rather than one mode pretending
 * to be the other:
 *
 *   spectrum — real frames from the engine that is playing, drawn as log-spaced bands:
 *              `getByteFrequencyData()` frames on the web path, the 64 bands of the native
 *              audio tap (`NaviliteSpectrum.swift`) in the installed app.
 *   theme    — a slow, smooth album-art-coloured animation, used when there are no
 *              samples to show (tainted stream, suspended audio context, a build with
 *              no tap on its native player). It moves to its own clock, not to the
 *              music, because there is no music data to move to.
 *
 * The band edges are logarithmic over the lower ~60% of the analyser's bins, which is
 * where music lives; the top bins of a 2048-point FFT are above the content of most
 * lossy streams.
 *
 * v1.1 rewrote the frame loop for sharpness and cost (per-paint analyser frames instead of
 * the engine's 10 Hz meter buffer, no per-frame allocations, a ResizeObserver instead of a
 * per-frame `clientWidth` read).
 *
 * v1.2 makes each bar *only the current frame* — that is the whole rule, and everything that
 * carried a memory of an earlier frame is gone:
 *
 *   - the peak caps (`peaks`, drawing a 2 px segment above the bar at 0.9 alpha while the bar
 *     itself was drawn anywhere from 0.55 to 1.0) — that floating, differently-bright segment
 *     is exactly the "after image … separation of the colors at the top of each bar" the owner
 *     reported;
 *   - the release ballistics (`BAR_FALLOFF`, a fixed fraction per frame) — a bar was still
 *     showing the previous frame's level for ~115 ms after the music had moved on;
 *   - the vertical gradient (`secondary → primary → accent`), whose accent stop read as a
 *     second colour at the top of every bar;
 *   - the reflection under the baseline, a second deliberate copy of the bar.
 *
 * What is left is a flat, single-colour rectangle per band whose height is a pure function of
 * the analyser frame just read. `test/visualizer.test.ts` pins that down: a loud frame then a
 * silent frame collapses to the baseline on the *next* frame, and two identical frames draw
 * byte-identical rectangles. The analyser's own smoothing is off too
 * (`smoothingTimeConstant = 0` in `engine.ts`) — the one memory left in the graph would be the
 * analyser averaging the previous frame into this one.
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
/** Bars stand on this fraction of the canvas height, so the spectrum reads as sitting on a line. */
const BASELINE = 0.98;
/** ...and stop at this fraction, leaving the top of the canvas clear. */
const CEILING = 0.9;
/**
 * The frame's shape, applied to the band's mean magnitude.
 *
 * A touch above 1 leans on the loud end, which is what makes quiet bands read as quiet instead
 * of as half-height noise. It is a pure function of the current frame — it carries nothing
 * forward, which is the point.
 */
const RESPONSE_CURVE = 1.35;

export function attachVisualizer(canvas: HTMLCanvasElement, engine: AudioEngine, initialPalette: Palette): VisualizerHandle {
  let palette = initialPalette;
  let frame = 0;
  let running = false;
  let startTime = performance.now();

  // Everything below is created once per size/palette, never per frame.
  const ctx = canvas.getContext('2d', { alpha: true });
  let bandEdges: number[] = [];
  let edgesForBins = -1;
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

    if (spectrum) drawSpectrum(ctx, width, height, spectrum);
    else drawTheme(ctx, width, height, palette, (performance.now() - startTime) / 1000);
  };

  return {
    setPalette(next) {
      palette = next;
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

  function drawSpectrum(c: CanvasRenderingContext2D, width: number, height: number, spectrum: Uint8Array): void {
    /*
     * Two shapes, one drawing: the analyser hands over the FFT's own bins (1024 of them), and the
     * native tap hands over the 64 bands it already folded them into (`NaviliteSpectrum.swift`
     * computes the same log spacing this file does, with vDSP). A frame that is already the width of
     * the canvas is used as-is rather than re-binned — re-binning 64 bands through the log curve
     * would throw away everything above ~38 and draw a spectrum of a spectrum.
     */
    const banded = spectrum.length === BAND_COUNT;
    const edgesForFrame = banded ? null : edges(spectrum.length);
    const gap = Math.max(1, width / BAND_COUNT / 6);
    const bandWidth = width / BAND_COUNT - gap;
    const baseline = height * BASELINE;
    const ceiling = height * CEILING;
    // One colour and one alpha for the whole frame, set once. Nothing per bar can differ from
    // its neighbours except its height, so nothing can read as a second segment or a ghost of
    // where the bar used to be.
    c.fillStyle = palette.primary;
    c.globalAlpha = 1;

    for (let band = 0; band < BAND_COUNT; band += 1) {
      let magnitude: number;
      if (banded) {
        magnitude = Math.pow(spectrum[band] / 255, RESPONSE_CURVE);
      } else {
        const from = edgesForFrame![band];
        const to = Math.max(from + 1, edgesForFrame![band + 1]);
        let sum = 0;
        for (let bin = from; bin < to && bin < spectrum.length; bin += 1) sum += spectrum[bin];
        magnitude = Math.pow(sum / (to - from) / 255, RESPONSE_CURVE);
      }
      const barHeight = Math.max(1, magnitude * ceiling);
      c.fillRect(band * (bandWidth + gap), baseline - barHeight, bandWidth, barHeight);
    }
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
