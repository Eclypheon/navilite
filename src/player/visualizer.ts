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
 *              is no music data to move to. The UI labels which mode is live.
 *
 * The band edges are logarithmic over the lower ~60% of the analyser's bins, which is
 * where music lives; the top bins of a 2048-point FFT are above the content of most
 * lossy streams.
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
const PEAK_DECAY = 0.008;

export function attachVisualizer(canvas: HTMLCanvasElement, engine: AudioEngine, initialPalette: Palette): VisualizerHandle {
  let palette = initialPalette;
  let frame = 0;
  let peaks = new Float32Array(BAND_COUNT);
  let running = false;
  let startTime = performance.now();

  const resize = () => {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  };

  const draw = () => {
    frame = requestAnimationFrame(draw);
    resize();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { width, height } = canvas;
    const spectrum = engine.spectrumData();

    ctx.clearRect(0, 0, width, height);
    const background = ctx.createLinearGradient(0, 0, 0, height);
    background.addColorStop(0, 'rgba(8, 8, 14, 0.0)');
    background.addColorStop(1, 'rgba(8, 8, 14, 0.75)');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);

    if (spectrum) drawSpectrum(ctx, width, height, spectrum, peaks, palette);
    else {
      peaks = new Float32Array(BAND_COUNT);
      drawTheme(ctx, width, height, palette, (performance.now() - startTime) / 1000);
    }
  };

  return {
    setPalette(next) {
      palette = next;
    },
    start() {
      if (running) return;
      running = true;
      startTime = performance.now();
      frame = requestAnimationFrame(draw);
    },
    stop() {
      running = false;
      cancelAnimationFrame(frame);
    },
  };
}

function bandEdges(binCount: number): number[] {
  const edges: number[] = [];
  const end = Math.max(8, Math.floor(binCount * OFFSET_BINS_END));
  const minLog = Math.log(2);
  const maxLog = Math.log(end);
  for (let i = 0; i <= BAND_COUNT; i += 1) {
    const t = i / BAND_COUNT;
    edges.push(Math.floor(Math.exp(minLog + (maxLog - minLog) * t)) - 1);
  }
  return edges;
}

function drawSpectrum(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  spectrum: Uint8Array,
  peaks: Float32Array,
  palette: Palette,
): void {
  const edges = bandEdges(spectrum.length);
  const gap = Math.max(1, width / BAND_COUNT / 6);
  const bandWidth = width / BAND_COUNT - gap;
  const gradient = ctx.createLinearGradient(0, height, 0, 0);
  gradient.addColorStop(0, palette.secondary);
  gradient.addColorStop(0.55, palette.primary);
  gradient.addColorStop(1, palette.accent);
  ctx.fillStyle = gradient;

  const floor = height * 0.96;
  for (let band = 0; band < BAND_COUNT; band += 1) {
    const from = edges[band];
    const to = Math.max(from + 1, edges[band + 1]);
    let sum = 0;
    for (let bin = from; bin < to && bin < spectrum.length; bin += 1) sum += spectrum[bin];
    const value = sum / (to - from) / 255;
    const magnitude = Math.pow(value, 1.35);
    const barHeight = Math.max(1, magnitude * height * 0.9);
    const x = band * (bandWidth + gap);

    ctx.globalAlpha = 0.55 + 0.45 * magnitude;
    ctx.fillRect(x, floor - barHeight, bandWidth, barHeight);
    // Reflection, so the bar reads as sitting on a surface rather than floating.
    ctx.globalAlpha = 0.14 + 0.2 * magnitude;
    ctx.fillRect(x, floor, bandWidth, Math.min(height - floor, barHeight * 0.28));

    peaks[band] = Math.max(magnitude, peaks[band] - PEAK_DECAY);
    if (peaks[band] > 0.02) {
      ctx.globalAlpha = 0.9;
      ctx.fillRect(x, floor - peaks[band] * height * 0.9 - 2, bandWidth, 2);
    }
  }
  ctx.globalAlpha = 1;
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
