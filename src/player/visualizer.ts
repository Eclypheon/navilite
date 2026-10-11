/**
 * The visualiser.
 *
 * Two modes, and they are deliberately *different* rather than one mode pretending
 * to be the other:
 *
 *   spectrum — real frames from the engine that is playing, drawn as log-spaced bands:
 *              `getByteFrequencyData()` frames on the web path, the 64 bands of the native
 *              audio tap (`NaviliteSpectrum.swift`) in the installed app.
 *   theme    — a slow, smooth album-art-coloured animation, used when there is **no track
 *              loaded at all**: a build with no tap on its native player, a suspended audio
 *              context, a stream that cannot be read. It moves to its own clock, not to the
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
 * v1.2 made each bar *only the current frame*, and everything that carried a memory of an
 * earlier frame is still gone: no peak caps, no fixed release ballistics, no vertical
 * gradient whose accent stop read as a second colour at the top of every bar, no reflection
 * under the baseline. What is drawn is one flat rectangle per band.
 *
 * v1.7.4 — the owner, having installed v1.7.3: *"the spectrum now is rather jittery and seems
 * laggy and the colors are also not matching the album art theme it seems to just be one blue
 * color no matter what. Pausing should cause the spectrum to gracefully all drop to zero but
 * the spectrum disappears and it shows the placeholder spectrum instead."* Three changes, and
 * each one is a rule rather than a tweak:
 *
 *   1. **The values are smoothed; the bars are not remembered.** A per-band attack/release
 *      envelope (`attack` fast, `release` to nothing inside half a second) is applied to *this
 *      frame's* magnitudes. The v1.2 rule stands where it matters — nothing on the canvas is a
 *      drawing of an earlier frame; the only thing carried across a frame is one number per band,
 *      and it is a filter on the input, not a copy of the output. A jittery frame now moves the bar
 *      by a fraction of the jitter, which is what removes the shimmer the owner saw; a silent one
 *      falls to the baseline over a third of a second instead of snapping, and settles at exactly
 *      zero.
 *   2. **The window is drawn at most once per display frame** (`FRAME_MS`), from a timestamp the
 *      frame callback carries, so a device that fires more often than it can paint does not pay
 *      for the extra paint — the frame budget is fixed, not the poll rate.
 *   3. **The bars wear the app's own palette.** `bandFills` is built from the palette once per
 *      palette (never per frame) as a low→high primary → secondary → accent ramp, so the spectrum
 *      is the album's colours rather than one flat tone, and `setPalette` — which the app calls
 *      whenever the track changes — is what re-arms it.
 *
 * And the placeholder is for **nothing loaded**, not for paused. When the engine has a track but
 * hands over no frame (paused, interrupted, ended, or a gap between measurements), the bars fall
 * to zero on the release envelope and stay on screen; the theme animation only appears when no
 * track is loaded at all.
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
 * of as half-height noise. It is applied to the *input*, before the envelope.
 */
const RESPONSE_CURVE = 1.35;
/**
 * The frame budget: at most one paint per display frame, whatever rate the callbacks arrive at.
 */
const FRAME_MS = 1000 / 60;
/** A hidden tab hands back a timestamp seconds later; a filter must not be integrated over that. */
const MAX_STEP_MS = 50;
/**
 * The envelope, as time constants rather than per-frame fractions so the motion is the same at
 * 60 Hz and at 120: a rise reaches ~90 % in `ATTACK_S`, and a drop falls to the `FLOOR` — i.e. to
 * nothing — in about 460 ms, inside the 250–500 ms the owner asked for on a pause. Slower would
 * read as a smear; faster would read as the snap he was already complaining about.
 */
const ATTACK_S = 0.045;
const RELEASE_S = 0.1;
/** Below this the bar is nothing, so the envelope settles at exactly zero rather than at 1 %. */
const FLOOR = 0.01;
/**
 * How close to its destination the envelope has to be for the destination to be its value.
 *
 * An exponential only approaches. Without this the same analyser frame would draw a *900th of a
 * pixel* differently forever, and "two identical frames draw identical rectangles" — the property
 * that says nothing on the canvas is an after image — would be unprovable rather than true.
 */
const SNAP = 1e-3;

export function attachVisualizer(canvas: HTMLCanvasElement, engine: AudioEngine, initialPalette: Palette): VisualizerHandle {
  let palette = initialPalette;
  let frame = 0;
  let running = false;
  let startTime = performance.now();
  let lastDrawnAt = -Infinity;

  // Everything below is created once per size/palette, never per frame.
  const ctx = canvas.getContext('2d', { alpha: true });
  let bandEdges: number[] = [];
  let edgesForBins = -1;
  let backdrop: CanvasGradient | null = null;
  let backdropKey = '';
  /** One colour per bar, low frequency → high, rebuilt only when the palette changes. */
  let bandFills: string[] = fillsFor(initialPalette);
  /** The envelope's state: one number per band, and the only thing a frame leaves behind. */
  const levels = new Float32Array(BAND_COUNT);

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

  /**
   * A track is loaded whenever the engine is holding one — paused, interrupted and ended included.
   *
   * That is the whole difference between "settle to zero" and "show the placeholder", so it is asked
   * of the engine rather than inferred from the frames: a paused player hands over no frame, and
   * reading that as "nothing is loaded" is exactly the bug the owner reported.
   */
  const trackLoaded = (): boolean => engine.currentTrack !== null;

  const draw = (timestamp?: number): void => {
    frame = requestAnimationFrame(draw);
    if (!ctx) return;
    const now = typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : performance.now();
    const elapsed = now - lastDrawnAt;
    // The frame budget: a callback that arrives early is not a paint.
    if (elapsed < FRAME_MS - 0.5) return;
    lastDrawnAt = now;
    const step = Math.min(MAX_STEP_MS, Math.max(0, elapsed === Infinity ? FRAME_MS : elapsed)) / 1000;
    const { width, height } = canvas;
    const spectrum = engine.readSpectrum();

    const back = ensureBackdrop(width, height);
    ctx.clearRect(0, 0, width, height);
    if (back) {
      ctx.fillStyle = back;
      ctx.fillRect(0, 0, width, height);
    }

    if (spectrum) {
      drawSpectrum(ctx, width, height, spectrum, step);
      return;
    }
    if (trackLoaded()) {
      // No frame this time, but a track is loaded: the bars fall to zero and stay put.
      drawSpectrum(ctx, width, height, null, step);
      return;
    }
    // Nothing loaded: the theme, and the envelope starts from nothing when a track arrives.
    levels.fill(0);
    drawTheme(ctx, width, height, palette, (now - startTime) / 1000);
  };

  return {
    setPalette(next) {
      palette = next;
      bandFills = fillsFor(next);
    },
    start() {
      if (running) return;
      running = true;
      startTime = performance.now();
      lastDrawnAt = -Infinity;
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

  /**
   * One band's *own* magnitude for this frame, 0..1, before the envelope.
   *
   * Two shapes, one reading: the analyser hands over the FFT's own bins (1024 of them), and the
   * native tap hands over the 64 bands it already folded them into (`NaviliteSpectrum.swift`
   * computes the same log spacing this file does, with vDSP). A frame that is already the width of
   * the canvas is used as-is rather than re-binned — re-binning 64 bands through the log curve
   * would throw away everything above ~38 and draw a spectrum of a spectrum.
   */
  function magnitude(spectrum: Uint8Array | null, band: number, banded: boolean, edgesForFrame: number[] | null): number {
    if (!spectrum) return 0;
    if (banded) return Math.pow(spectrum[band] / 255, RESPONSE_CURVE);
    const from = edgesForFrame![band];
    const to = Math.max(from + 1, edgesForFrame![band + 1]);
    let sum = 0;
    for (let bin = from; bin < to && bin < spectrum.length; bin += 1) sum += spectrum[bin];
    return Math.pow(sum / (to - from) / 255, RESPONSE_CURVE);
  }

  function drawSpectrum(c: CanvasRenderingContext2D, width: number, height: number, spectrum: Uint8Array | null, step: number): void {
    const banded = spectrum !== null && spectrum.length === BAND_COUNT;
    const edgesForFrame = spectrum !== null && !banded ? edges(spectrum.length) : null;
    const gap = Math.max(1, width / BAND_COUNT / 6);
    const bandWidth = width / BAND_COUNT - gap;
    const baseline = height * BASELINE;
    const ceiling = height * CEILING;
    const rise = 1 - Math.exp(-step / ATTACK_S);
    const fall = 1 - Math.exp(-step / RELEASE_S);
    c.globalAlpha = 1;

    for (let band = 0; band < BAND_COUNT; band += 1) {
      const target = magnitude(spectrum, band, banded, edgesForFrame);
      const level = levels[band];
      // Attack is fast, release is slow, and neither is a drawing of the frame before: the
      // envelope is a filter on this frame's own number.
      let next = target > level ? level + (target - level) * rise : level + (target - level) * fall;
      if (Math.abs(target - next) < SNAP) next = target;
      levels[band] = next < FLOOR ? 0 : next;
      const barHeight = Math.max(1, levels[band] * ceiling);
      // One flat colour per band, taken from the palette the rest of the UI is wearing. Set once
      // per bar and never composited with anything: a bar has no second segment.
      c.fillStyle = bandFills[band] ?? palette.primary;
      c.fillRect(band * (bandWidth + gap), baseline - barHeight, bandWidth, barHeight);
    }
  }
}

/**
 * The bars' colours: a low→high ramp through the palette the app has applied, in three even
 * stretches — the bass wears `primary`, the mids `secondary`, the top `accent`.
 *
 * Built once per palette (never per frame, and never with a canvas call), so every colour on the
 * spectrum is one of the three the UI itself is using and there is nothing to recompute between
 * frames.
 */
function fillsFor(palette: Palette): string[] {
  const stops = [palette.primary, palette.secondary, palette.accent];
  const result: string[] = [];
  for (let band = 0; band < BAND_COUNT; band += 1) {
    result.push(stops[Math.min(stops.length - 1, Math.floor((band / BAND_COUNT) * stops.length))]);
  }
  return result;
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
